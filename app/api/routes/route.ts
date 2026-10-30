import { scoreRoute } from "@/lib/score";
import { parseTrip, routerError, tripCandidates } from "@/lib/trip";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const parsed = await parseTrip(req);
  if (parsed instanceof Response) return parsed;
  const { trip, ds } = parsed;

  let cands;
  try {
    cands = await tripCandidates(ds, trip);
  } catch (e) {
    return routerError(e);
  }
  if (!cands.length) return Response.json({ error: "No route found between these points." }, { status: 404 });

  const t0 = performance.now();
  const routes = cands.map((c, i) => scoreRoute(ds, c, trip.mode, trip.depart, i));
  return Response.json({
    mode: trip.mode,
    depart: trip.depart.toISOString(),
    routes,
    timingMs: Math.round(performance.now() - t0),
  });
}
