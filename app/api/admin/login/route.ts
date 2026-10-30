import { adminConfigured, checkPassword, loginThrottled, sessionCookie } from "@/lib/admin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!adminConfigured()) {
    return Response.json({ error: "Admin is not set up: the server has no ADMIN_PASSWORD environment variable." }, { status: 503 });
  }
  if (loginThrottled(req)) return Response.json({ error: "Too many attempts. Try again in 10 minutes." }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.password !== "string" || !checkPassword(body.password)) {
    return Response.json({ error: "Wrong password." }, { status: 401 });
  }
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie() } });
}
