import { liveEnabled, readLive, updateLive, validId } from "@/lib/live";

export const runtime = "nodejs";

const noStore = { "cache-control": "no-store" };

/** The live trip as contacts see it. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!liveEnabled || !validId(id)) return Response.json({ error: "Not found" }, { status: 404, headers: noStore });
  try {
    const trip = await readLive(id);
    if (!trip) return Response.json({ error: "This trip has ended or the link has expired." }, { status: 404, headers: noStore });
    return Response.json(trip, { headers: noStore });
  } catch {
    return Response.json({ error: "Live sharing is unavailable right now." }, { status: 502, headers: noStore });
  }
}

/** Position and status updates from the phone, which holds the trip's private key. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!liveEnabled || !validId(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Bad request" }, { status: 400 });
  try {
    const r = await updateLive(id, body);
    if (r === null) return Response.json({ error: "This trip has ended." }, { status: 404 });
    if (r === "forbidden") return Response.json({ error: "Forbidden" }, { status: 403 });
    return Response.json({ ok: true, status: r.status }, { headers: noStore });
  } catch {
    return Response.json({ error: "Live sharing is unavailable right now." }, { status: 502 });
  }
}
