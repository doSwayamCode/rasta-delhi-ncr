import { verify } from "@/lib/admin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const r = verify(req, typeof body.password === "string" ? body.password : null);
  if (r === "throttled") return Response.json({ error: "Too many wrong passwords. Try again in 10 minutes." }, { status: 429 });
  if (r === "wrong") return Response.json({ error: "Wrong password." }, { status: 401 });
  return Response.json({ ok: true });
}
