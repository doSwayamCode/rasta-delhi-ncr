import { adminConfigured, isAdmin, unauthorized } from "@/lib/admin";
import { readFeedback } from "@/lib/feedbackStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!adminConfigured()) return Response.json({ error: "Admin is not set up." }, { status: 503 });
  if (!isAdmin(req)) return unauthorized();
  try {
    const { rows, source } = await readFeedback();
    return Response.json({ rows: rows.slice().reverse(), source }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: `Could not read feedback (${(e as Error).message}).` }, { status: 502 });
  }
}
