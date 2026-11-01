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
 * built from current OSM data. They allow light, non-commercial use with an identifying UA. When
 * they fail, requests go to OpenRouteService (ORS_API_KEY, below). For real traffic, run your own
 * OSRM and point OSRM_CAR_URL / OSRM_FOOT_URL at it.
 */
const PROFILES: Record<Mode, string> = {
  drive: process.env.OSRM_CAR_URL ?? "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  walk: process.env.OSRM_FOOT_URL ?? "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
};

const UA = process.env.ROUTER_USER_AGENT ?? "ghartak/0.1 (night-safety route comparison; NCR)";

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: LngLat[] };
  legs: { summary: string }[];
}

/**
 * Backup router: OpenRouteService, used only when the public OSRM servers fail or refuse. Its free
 * key allows 2,000 directions a day. Without ORS_API_KEY there is no backup.
 */
const ORS_KEY = process.env.ORS_API_KEY ?? "";
const ORS_PROFILES: Record<Mode, string> = { drive: "driving-car", walk: "foot-walking" };

// After OSRM fails, go straight to the backup for a minute instead of waiting on more timeouts.
let osrmDownUntil = 0;

// Recent answers, per server instance: the same search (or the timeline right after it) reuses them.
const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 400;
const cache = new Map<string, { at: number; routes: OsrmRoute[] }>();

function cached(key: string): OsrmRoute[] | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) return null;
  cache.delete(key);
  cache.set(key, hit); // most recently used last
  return hit.routes;
}

function remember(key: string, routes: OsrmRoute[]) {
  cache.set(key, { at: Date.now(), routes });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** One retry after a short pause for timeouts, network errors, 429 and 5xx from the shared router. */
async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt > 0) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function osrmServer(mode: Mode, points: LngLat[], alternatives: boolean): Promise<OsrmRoute[]> {
  const coords = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  const url =
    `${PROFILES[mode]}/${coords}?overview=full&geometries=geojson&steps=true` +
    (alternatives ? "&alternatives=3" : "") +
    (points.length > 2 ? "&continue_straight=true" : "");
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await res.json();
  if (body.code !== "Ok") {
    if (body.code === "NoRoute" || body.code === "NoSegment") return [];
    throw new Error(`router ${body.code}`);
  }
  return body.routes as OsrmRoute[];
}

interface OrsFeature {
  geometry: { coordinates: LngLat[] };
  properties: {
    summary: { distance?: number; duration?: number };
    segments?: { steps?: { name?: string; distance?: number }[] }[];
  };
}

/** OpenRouteService's answer in OSRM's shape; the leg summary is its two longest named roads. */
export function fromOrs(f: OrsFeature): OsrmRoute {
  const byName = new Map<string, number>();
  for (const seg of f.properties.segments ?? []) {
    for (const st of seg.steps ?? []) {
      const n = (st.name ?? "").trim();
      if (n && n !== "-") byName.set(n, (byName.get(n) ?? 0) + (st.distance ?? 0));
    }
  }
  const summary = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n).join(", ");
  return {
    distance: f.properties.summary.distance ?? 0,
    duration: f.properties.summary.duration ?? 0,
    geometry: { coordinates: f.geometry.coordinates },
    legs: [{ summary }],
  };
}

async function orsServer(mode: Mode, points: LngLat[], alternatives: boolean): Promise<OsrmRoute[]> {
  const body: Record<string, unknown> = {
    coordinates: points.map((p) => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))]),
    instructions: true,
  };
  if (alternatives && points.length === 2) body.alternative_routes = { target_count: 3, share_factor: 0.6, weight_factor: 1.6 };
  if (points.length > 2) body.continue_straight = true;
  const res = await fetch(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILES[mode]}/geojson`, {
    method: "POST",
    headers: { Authorization: ORS_KEY, "content-type": "application/json", accept: "application/geo+json", "User-Agent": UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const json = await res.json().catch(() => ({}));
  // 2004/2009/2010: points too far apart, no route, or no road near a point.
  const code = json?.error?.code;
  if (code === 2004 || code === 2009 || code === 2010) return [];
  if (!res.ok) throw new Error(`backup router ${res.status}`);
  return ((json.features ?? []) as OrsFeature[]).map(fromOrs);
}

/**
 * Routes from OSRM, falling back to OpenRouteService when OSRM is down or refusing. "No route"
 * from OSRM is an answer, not a failure, so it does not trigger the backup.
 */
async function osrm(mode: Mode, points: LngLat[], alternatives: boolean): Promise<OsrmRoute[]> {
  const key = `${mode}|${alternatives ? 1 : 0}|${points.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(";")}`;
  const hit = cached(key);
  if (hit) return hit;
  let routes: OsrmRoute[];
  if (Date.now() < osrmDownUntil && ORS_KEY) {
    routes = await orsServer(mode, points, alternatives);
  } else {
    try {
      routes = await osrmServer(mode, points, alternatives);
    } catch (e) {
      if (!ORS_KEY) throw e;
      osrmDownUntil = Date.now() + 60_000;
      routes = await orsServer(mode, points, alternatives);
    }
  }
  remember(key, routes);
  return routes;
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
  const cap = mode === "walk" ? 700 : 3000;
  const out: LngLat[] = [];
  // Two distances on each side of the straight line: a near and a wider detour.
  for (const share of [0.2, 0.38]) {
    const off = Math.min(straight * share, cap * (share / 0.2));
    for (const side of [1, -1]) {
      const x = fx + (tx - fx) * 0.5 + nx * off * side;
      const y = fy + (ty - fy) * 0.5 + ny * off * side;
      const p = snap([x / M_PER_DEG_LON, y / M_PER_DEG_LAT]);
      if (p && !out.some((q) => haversine(p, q) < 150)) out.push(p);
    }
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
    if (d.status === "fulfilled" && d.value[0]) pool.push(removeSpurs(toCandidate(d.value[0], "via")));
  }

  const fastest = Math.min(...pool.map((c) => c.duration));
  const slack = mode === "walk" ? 1.45 : 1.5;
  const kept: Candidate[] = [];
  for (const c of pool.sort((a, b) => a.duration - b.duration)) {
    if (c.duration > fastest * slack + 120) continue;
    // Loop and overshoot checks are only for our own via-point detours. The router's routes keep
    // their loops: a car on a divided road often has to pass the start or the destination and
    // U-turn, and rejecting that left driving trips with no route at all.
    if (c.origin === "via" && (hasLoop(c.coords) || overshoots(c.coords, from, to))) continue;
    // Different enough if either route has >15% of its length away from the other.
    if (kept.some((k) => overlap(c.coords, k.coords) > 0.85 && overlap(k.coords, c.coords) > 0.85)) continue;
    kept.push(c);
    if (kept.length === max) break;
  }
  return kept;
}

/**
 * Forcing a route through a via point often adds an out-and-back spur or a loop round a block (a
 * car on a divided road has to U-turn to reach the point). When the route comes back within ~20 m
 * of where it already was, within 2.5 km of travel, the part in between is cut out. What remains is
 * still a continuous path on real roads; distance and time are reduced in proportion.
 */
function removeSpurs(c: Candidate): Candidate {
  const cell = (p: LngLat) => `${Math.round(p[0] / 0.0002)},${Math.round(p[1] / 0.0002)}`;
  const out: LngLat[] = [];
  const at: number[] = []; // distance along the original route for each kept point
  const seen = new Map<string, number>(); // cell -> index in out
  let along = 0;
  let cut = false;
  for (let i = 0; i < c.coords.length; i++) {
    const p = c.coords[i];
    if (i > 0) along += haversine(c.coords[i - 1], p);
    const k = cell(p);
    const j = seen.get(k);
    if (j !== undefined && j < out.length - 1 && along - at[j] > 60 && along - at[j] < 2500) {
      for (let q = j + 1; q < out.length; q++) if (seen.get(cell(out[q])) === q) seen.delete(cell(out[q]));
      out.length = j + 1;
      at.length = j + 1;
      cut = true;
      continue;
    }
    out.push(p);
    at.push(along);
    if (!seen.has(k)) seen.set(k, out.length - 1);
  }
  if (!cut || out.length < 2) return c;
  // Scale distance and time by the length actually kept (measured on the final path, so
  // spurs removed in several steps are not counted twice).
  let kept = 0;
  for (let i = 1; i < out.length; i++) kept += haversine(out[i - 1], out[i]);
  const ratio = Math.min(1, kept / Math.max(1, along));
  return { ...c, coords: out, distance: c.distance * ratio, duration: c.duration * ratio };
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
