import { dataset, nearestRoadPoint } from "@/lib/data";
import { LngLat } from "@/lib/geo";
import { Mode, candidates } from "@/lib/routing";
import { scoreRoute } from "@/lib/score";

export const runtime = "nodejs";

function point(v: unknown): LngLat | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lon, lat] = v.map(Number);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lon, lat]
    : null;
}

export async function POST(req: Request) {
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
  const outside = [from, to].some(([lon, lat]) => lon < W || lon > E || lat < S || lat > N);
  if (outside) {
    return Response.json(
      { error: "Rasta covers Delhi and the NCR cities around it (Gurugram, Manesar, Faridabad, Noida, Greater Noida, Ghaziabad, Sonipat, Bahadurgarh, Bhiwadi). Both points need to be inside that area." },
      { status: 422 },
    );
  }

  let cands;
  try {
    // Via points snap to a main road: motorway..tertiary for cars, primary..tertiary on foot.
    const cls = ds.meta.roadClasses;
    const minClass = mode === "walk" ? cls.indexOf("primary") : 0;
    const maxClass = cls.indexOf("tertiary");
    cands = await candidates(from, to, mode, (p) =>
      nearestRoadPoint(ds, p, minClass, maxClass, mode === "walk" ? 600 : 1500),
    );
  } catch (e) {
    return Response.json(
      { error: `The routing service did not respond (${(e as Error).message}). Try again in a moment.` },
      { status: 502 },
    );
  }
  if (!cands.length) return Response.json({ error: "No route found between these points." }, { status: 404 });

  const t0 = performance.now();
  const routes = cands.map((c, i) => scoreRoute(ds, c, mode, depart, i));
  return Response.json({
    mode,
    depart: depart.toISOString(),
    routes,
    timingMs: Math.round(performance.now() - t0),
  });
}
