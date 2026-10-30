import crypto from "node:crypto";

/**
 * Admin access for /admin. The password comes from the ADMIN_PASSWORD environment variable and is
 * never stored in the repository. A successful login sets a signed, HttpOnly cookie that lasts
 * 12 hours; changing ADMIN_PASSWORD (or ADMIN_SESSION_SECRET) invalidates every session.
 */
const COOKIE = "ghartak_admin";
const TTL_S = 12 * 3600;

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD);

function key(): Buffer {
  return crypto
    .createHash("sha256")
    .update(`ghartak-admin:${process.env.ADMIN_PASSWORD ?? ""}:${process.env.ADMIN_SESSION_SECRET ?? ""}`)
    .digest();
}

const sign = (payload: string) => crypto.createHmac("sha256", key()).update(payload).digest("base64url");

export function checkPassword(given: string): boolean {
  const want = process.env.ADMIN_PASSWORD;
  if (!want) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export function sessionCookie(): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  const value = `${exp}.${sign(String(exp))}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_S}${secure}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function isAdmin(req: Request): boolean {
  if (!adminConfigured()) return false;
  const raw = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false;
  const want = sign(exp);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

// Login throttling: 5 attempts per IP per 10 minutes, per server instance.
const attempts = new Map<string, number[]>();
export function loginThrottled(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) attempts.clear();
  return recent.length > 5;
}

export const unauthorized = () => Response.json({ error: "Not signed in." }, { status: 401 });
