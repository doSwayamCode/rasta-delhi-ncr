import { createLive, liveEnabled } from "@/lib/live";

export const runtime = "nodejs";

// At most 20 new live links per IP per hour, per server instance: keeps the free Redis quota safe.
const recent = new Map<string, number[]>();
function tooMany(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const list = (recent.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.size > 10_000) recent.clear();
  recent.set(ip, [...list, now]);
  return list.length >= 20;
}

/** Is live sharing available on this server? (It needs Redis.) */
export async function GET() {
  return Response.json({ enabled: liveEnabled });
}

/** Starts a live link for a trip. Returns the public id and the phone's private update key. */
export async function POST(req: Request) {
  if (!liveEnabled) return Response.json({ error: "Live sharing is not set up on this server." }, { status: 503 });
  if (tooMany(req)) return Response.json({ error: "Too many trips started. Try again later." }, { status: 429 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Bad request" }, { status: 400 });
  try {
    const made = await createLive(body);
    if (!made) return Response.json({ error: "That trip could not be shared." }, { status: 400 });
    return Response.json(made, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Live sharing is unavailable right now." }, { status: 502 });
  }
}
