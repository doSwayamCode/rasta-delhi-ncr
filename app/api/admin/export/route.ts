import { adminConfigured, isAdmin, unauthorized } from "@/lib/admin";
import { readFeedback, toCsv } from "@/lib/feedbackStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The full feedback table as CSV, read fresh on every download. */
export async function GET(req: Request) {
  if (!adminConfigured()) return Response.json({ error: "Admin is not set up." }, { status: 503 });
  if (!isAdmin(req)) return unauthorized();
  const { rows } = await readFeedback();
  const stamp = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ghar-tak-feedback-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
