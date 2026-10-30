import { Dataset, dataset, nearestRoadPoint } from "./data";
import { LngLat } from "./geo";
import { Candidate, Mode, candidates } from "./routing";

export interface Trip {
  from: LngLat;
  to: LngLat;
  mode: Mode;
  depart: Date;
  /** Teen mode: stricter scoring weights (lib/score.ts). */
  teen: boolean;
}

function point(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lon, lat] = v.map(Number);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lon, lat]
    : null;
}

const COVERAGE_ERROR =
  "Ghar Tak covers Delhi and the NCR cities around it (Gurugram, Manesar, Faridabad, Noida, Greater Noida, " +
  "Ghaziabad, Sonipat, Bahadurgarh, Bhiwadi). Both points need to be inside that area.";

/** Validates a request body into a Trip, or returns an error Response. */
export async function parseTrip(req: Request): Promise<{ trip: Trip; ds: Dataset } | Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const from = point(body.from);
  const to = point(body.to);
  const mode: Mode = body.mode === "walk" ? "walk" : "drive";
  const depart = body.depart ? new Date(String(body.depart)) : new Date();
  if (!from || !to) return Response.json({ error: "from and to must be [lon, lat]." }, { status: 400 });
  if (Number.isNaN(depart.getTime())) return Response.json({ error: "depart is not a valid time." }, { status: 400 });

  const ds = dataset();
  const [W, S, E, N] = ds.meta.bbox;
  if ([from, to].some(([lon, lat]) => lon < W || lon > E || lat < S || lat > N)) {
    return Response.json({ error: COVERAGE_ERROR }, { status: 422 });
  }
  return { trip: { from, to, mode, depart, teen: body.teen === true }, ds };
}

/**
 * Routes do not depend on the departure time, so the timeline and repeated time changes reuse
 * them for a while instead of hitting the shared router again.
 */
const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { at: number; value: Promise<Candidate[]> }>();

export function tripCandidates(ds: Dataset, trip: Trip): Promise<Candidate[]> {
  const key = [trip.mode, ...trip.from, ...trip.to].map((v) => (typeof v === "number" ? v.toFixed(5) : v)).join(",");
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  // Via points snap to a main road: motorway..tertiary for cars, primary..tertiary on foot.
  const cls = ds.meta.roadClasses;
  const minClass = trip.mode === "walk" ? cls.indexOf("primary") : 0;
  const maxClass = cls.indexOf("tertiary");
  const value = candidates(trip.from, trip.to, trip.mode, (p) =>
    nearestRoadPoint(ds, p, minClass, maxClass, trip.mode === "walk" ? 1000 : 1500),
  );
  value.catch(() => cache.delete(key));
  cache.set(key, { at: now, value });
  if (cache.size > 300) {
    for (const [k, v] of cache) if (now - v.at >= CACHE_MS || cache.size > 300) cache.delete(k);
  }
  return value;
}

export function routerError(e: unknown): Response {
  return Response.json(
    { error: `The routing service did not respond (${(e as Error).message}). Try again in a moment.` },
    { status: 502 },
  );
}
