import { dataset } from "@/lib/data";
import { CHOICES } from "@/lib/feedback";
import { appendFeedback } from "@/lib/feedbackStore";

export const runtime = "nodejs";

/**
 * Anonymous route feedback. Rows go to the internal store, and to the Google Sheet too when one is
 * configured (lib/feedbackStore.ts); /admin shows them and exports CSV.
 *
 * Privacy: no IP, no exact points. Start and end are rounded to 0.01° (about 1 km), so a row can
 * say "Sector 18 to Sector 62" but not which building. Nothing free-text is accepted.
 */
type Choice<K extends keyof typeof CHOICES> = (typeof CHOICES)[K][number];

const COMPONENTS = ["activity", "gaps", "light", "roads", "help", "cameras", "transit"] as const;

interface RouteSummary {
  score: number | null;
  duration: number;
  components?: Partial<Record<(typeof COMPONENTS)[number], number | null>>;
}

// Crude per-instance rate limit; enough to stop accidental double submits and casual spam.
const recent = new Map<string, number[]>();
function limited(key: string): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length > 5;
}

const round2 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pick = <K extends keyof typeof CHOICES>(k: K, v: unknown): Choice<K> | null =>
  (CHOICES[k] as readonly string[]).includes(String(v)) ? (v as Choice<K>) : null;

export function GET() {
  return Response.json({ enabled: true });
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return Response.json({ error: "Too many submissions; try again in a minute." }, { status: 429 });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const routes = (Array.isArray(b.routes) ? b.routes : []).slice(0, 4) as RouteSummary[];
  const metro = (b.metro ?? null) as RouteSummary | null;
  const chosen = typeof b.chosen === "string" && /^(r[0-3]|metro|none)$/.test(b.chosen) ? b.chosen : null;
  const priority = pick("priority", b.priority);
  const feel = pick("feel", b.feel);
  const from = Array.isArray(b.from) ? b.from : [];
  const to = Array.isArray(b.to) ? b.to : [];
  const depart = typeof b.depart === "string" && !Number.isNaN(Date.parse(b.depart)) ? new Date(b.depart) : null;
  if (!chosen || !routes.length || !depart || (b.mode !== "walk" && b.mode !== "drive")) {
    return Response.json({ error: "Incomplete answer." }, { status: 400 });
  }

  const chosenRoute: RouteSummary | null =
    chosen === "metro" ? metro : chosen === "none" ? null : routes[Number(chosen.slice(1))] ?? null;
  const scores = routes.map((r) => num(r.score) ?? -1);
  const durations = routes.map((r) => num(r.duration) ?? Infinity);
  const fastestIdx = durations.indexOf(Math.min(...durations));
  const bestIdx = scores.indexOf(Math.max(...scores));
  const ist = new Date(depart.getTime() + 330 * 60_000);

  const row = {
    submitted_at: new Date().toISOString(),
    data_build: dataset().meta.built,
    mode: b.mode,
    teen_mode: b.teen === true,
    depart_ist: ist.toISOString().slice(0, 16).replace("T", " "),
    depart_hour_ist: ist.getUTCHours(),
    from_area: `${round2(from[1])},${round2(from[0])}`,
    to_area: `${round2(to[1])},${round2(to[0])}`,
    routes_shown: routes.length,
    metro_shown: Boolean(metro),
    chosen,
    chosen_score: chosenRoute ? num(chosenRoute.score) : null,
    chosen_minutes: chosenRoute ? Math.round((num(chosenRoute.duration) ?? 0) / 60) : null,
    chosen_is_fastest: chosen === `r${fastestIdx}`,
    chosen_is_highest_score: chosen === `r${bestIdx}`,
    fastest_score: scores[fastestIdx],
    highest_score: scores[bestIdx],
    priority,
    area_feel: feel,
    ...Object.fromEntries(COMPONENTS.map((c) => [`chosen_${c}`, num(chosenRoute?.components?.[c])])),
  };

  try {
    await appendFeedback(row);
  } catch (e) {
    return Response.json({ error: `Could not save feedback (${(e as Error).message}).` }, { status: 502 });
  }
  return Response.json({ ok: true });
}
