import { MetroOption, outsideServiceHours, planMetro } from "@/lib/metro";
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
  const routes = cands.map((c, i) => scoreRoute(ds, c, trip.mode, trip.depart, i, trip.teen));

  // On foot, also offer walk + metro + walk when it beats walking and the metro is running. It is
  // optional: a router hiccup on the station legs should not fail the whole response. Outside metro
  // hours the option is dropped, and the reason is sent so the app can say why.
  let metro: MetroOption | null = null;
  let metroClosed: string | null = null;
  if (trip.mode === "walk") {
    const fastest = Math.min(...cands.map((c) => c.duration));
    metro = await planMetro(ds, trip.from, trip.to, trip.depart, fastest, trip.teen).catch(() => null);
    metroClosed = metro && outsideServiceHours(metro);
    if (metroClosed) metro = null;
  }

  return Response.json({
    mode: trip.mode,
    teen: trip.teen,
    depart: trip.depart.toISOString(),
    routes,
    metro,
    metroClosed,
    timingMs: Math.round(performance.now() - t0),
  });
}
