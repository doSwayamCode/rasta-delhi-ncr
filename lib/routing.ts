import { LngLat, M_PER_DEG_LAT, M_PER_DEG_LON, haversine, resample } from "./geo";

export type Mode = "walk" | "drive";

export interface Candidate {
  coords: LngLat[];
  distance: number; // m
  duration: number; // s
  /** Main roads OSRM names for this route, e.g. "Golf Course Road, MG Road". */
  via: string;
  /** How the candidate was generated: the router's own alternatives, or a detour through a via point. */
  origin: "osrm" | "via";
}

/**
 * FOSSGIS's public OSRM instances (routing.openstreetmap.de) serve separate car and foot graphs
 * built from current OSM data. They allow light, non-commercial use with an identifying UA; for
 * real traffic, run your own OSRM and point OSRM_CAR_URL / OSRM_FOOT_URL at it.
 */
const PROFILES: Record<Mode, string> = {
  drive: process.env.OSRM_CAR_URL ?? "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  walk: process.env.OSRM_FOOT_URL ?? "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
};

const UA = process.env.ROUTER_USER_AGENT ?? "rasta/0.1 (night-safety route comparison; NCR)";

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: LngLat[] };
  legs: { summary: string }[];
}

async function osrm(mode: Mode, points: LngLat[], alternatives: boolean): Promise<OsrmRoute[]> {
  const coords = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  const url =
    `${PROFILES[mode]}/${coords}?overview=full&geometries=geojson&steps=true` +
    (alternatives ? "&alternatives=3" : "") +
    (points.length > 2 ? "&continue_straight=true" : "");
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await res.json();
  if (body.code !== "Ok") {
    if (body.code === "NoRoute" || body.code === "NoSegment") return [];
    throw new Error(`router ${body.code}`);
  }
  return body.routes as OsrmRoute[];
}

function toCandidate(r: OsrmRoute, origin: Candidate["origin"]): Candidate {
  const via = [...new Set(r.legs.flatMap((l) => l.summary.split(",").map((s) => s.trim())).filter(Boolean))]
    .slice(0, 3)
    .join(", ");
  return { coords: r.geometry.coordinates, distance: r.distance, duration: r.duration, via, origin };
}

/** The router's single best route between two points, or null if there is none. */
export async function singleRoute(mode: Mode, from: LngLat, to: LngLat): Promise<Candidate | null> {
  const r = (await osrm(mode, [from, to], false))[0];
  return r ? toCandidate(r, "osrm") : null;
}

/** Share of a's length lying within tolM of b. Used to drop near-duplicate candidates. */
function overlap(a: LngLat[], b: LngLat[], tolM = 35): number {
  const sa = resample(a, 40);
  const sb = resample(b, 20);
  const cell = 0.0005;
  const grid = new Map<string, LngLat[]>();
  for (const p of sb) {
    const k = `${Math.floor(p.lon / cell)},${Math.floor(p.lat / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push([p.lon, p.lat]);
  }
  let hit = 0;
  for (const p of sa) {
    const cx = Math.floor(p.lon / cell);
    const cy = Math.floor(p.lat / cell);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = Math.hypot((q[0] - p.lon) * M_PER_DEG_LON, (q[1] - p.lat) * M_PER_DEG_LAT);
          if (d < tolM) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) hit++;
  }
  return sa.length ? hit / sa.length : 1;
}

/**
 * Points either side of the straight line between from and to, to coax out genuinely different
 * routes. `snap` moves each onto a nearby main road; a via point left in the middle of a sector
 * tends to land on a dead-end lane and produce an out-and-back detour nobody would take.
 */
function viaPoints(from: LngLat, to: LngLat, mode: Mode, snap: (p: LngLat) => LngLat | null): LngLat[] {
  const straight = haversine(from, to);
  const fx = from[0] * M_PER_DEG_LON, fy = from[1] * M_PER_DEG_LAT;
  const tx = to[0] * M_PER_DEG_LON, ty = to[1] * M_PER_DEG_LAT;
  const len = Math.hypot(tx - fx, ty - fy) || 1;
  const nx = -(ty - fy) / len, ny = (tx - fx) / len;
  const off = Math.min(straight * 0.2, mode === "walk" ? 700 : 3000);
  const out: LngLat[] = [];
  for (const side of [1, -1]) {
    const x = fx + (tx - fx) * 0.5 + nx * off * side;
    const y = fy + (ty - fy) * 0.5 + ny * off * side;
    const p = snap([x / M_PER_DEG_LON, y / M_PER_DEG_LAT]);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Up to `max` distinct candidate routes: the router's own alternatives first, then detours
 * through via points. Candidates much slower than the fastest are dropped -- the point is to
 * surface a few realistic trade-offs, not every possible path.
 */
export async function candidates(
  from: LngLat, to: LngLat, mode: Mode, snap: (p: LngLat) => LngLat | null, max = 3,
): Promise<Candidate[]> {
  const primary = (await osrm(mode, [from, to], true)).map((r) => toCandidate(r, "osrm"));
  if (!primary.length) return [];
  const detours = await Promise.allSettled(
    viaPoints(from, to, mode, snap).map((v) => osrm(mode, [from, v, to], false)),
  );
  const pool = [...primary];
  for (const d of detours) {
    if (d.status === "fulfilled" && d.value[0]) pool.push(toCandidate(d.value[0], "via"));
  }

  const fastest = Math.min(...pool.map((c) => c.duration));
  const slack = mode === "walk" ? 1.45 : 1.5;
  const kept: Candidate[] = [];
  for (const c of pool.sort((a, b) => a.duration - b.duration)) {
    if (c.duration > fastest * slack + 120) continue;
    if (hasLoop(c.coords) || overshoots(c.coords, from, to)) continue;
    // Different enough if either route has >20% of its length away from the other.
    if (kept.some((k) => overlap(c.coords, k.coords) > 0.8 && overlap(k.coords, c.coords) > 0.8)) continue;
    kept.push(c);
    if (kept.length === max) break;
  }
  return kept;
}

/** Via-point detours sometimes go out and back along the same street; those are not real options. */
function hasLoop(coords: LngLat[]): boolean {
  const s = resample(coords, 30);
  const seen = new Map<string, number>();
  let back = 0;
  for (let i = 0; i < s.length; i++) {
    const k = `${Math.round(s[i].lon / 0.0003)},${Math.round(s[i].lat / 0.0003)}`;
    const j = seen.get(k);
    if (j !== undefined && i - j > 6) back++;
    else if (j === undefined) seen.set(k, i);
  }
  return back * 30 > 250;
}

/** A detour that passes the destination (or the start) and then doubles back to it. */
function overshoots(coords: LngLat[], from: LngLat, to: LngLat): boolean {
  const s = resample(coords, 25);
  const total = s[s.length - 1].at;
  return s.some(
    (p) =>
      (p.at < total - 400 && haversine([p.lon, p.lat], to) < 120) ||
      (p.at > 400 && haversine([p.lon, p.lat], from) < 120),
  );
}
