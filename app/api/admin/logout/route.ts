import { clearCookie } from "@/lib/admin";

export const runtime = "nodejs";

export function POST() {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
}
