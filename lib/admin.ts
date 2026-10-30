import crypto from "node:crypto";

/**
 * Admin access for /admin: the page asks for the password and sends it with each admin request
 * (x-admin-password header, over HTTPS). There are no sessions to forge.
 *
 * The repository holds only a salted scrypt hash of the password, never the password itself.
 * Setting ADMIN_PASSWORD on the server overrides it (use this to change the password).
 */
const DEFAULT_HASH = "scrypt$15$8$1$9rdiUHyNkpTbUi82V2MvvA$s1QymQioqJHsafJZCJ_M0-kkBajyMQ0St_zvw0kX0M0";

function checkAgainstHash(given: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(given, Buffer.from(salt, "base64url"), want.length, {
    N: 2 ** Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(got, want);
}

// scrypt is deliberately slow (~0.1 s); remember recent correct passwords for 10 minutes.
const verified = new Map<string, number>();

export function checkPassword(given: string): boolean {
  if (!given || given.length > 200) return false;
  const env = process.env.ADMIN_PASSWORD;
  if (env) {
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(env).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const key = crypto.createHash("sha256").update(given).digest("base64");
  const until = verified.get(key);
  if (until && until > Date.now()) return true;
  const ok = checkAgainstHash(given, DEFAULT_HASH);
  if (ok) verified.set(key, Date.now() + 10 * 60_000);
  return ok;
}

// Throttle wrong passwords: 5 per IP per 10 minutes, per server instance.
const failures = new Map<string, number[]>();
const ipOf = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

export function throttled(req: Request): boolean {
  const now = Date.now();
  const recent = (failures.get(ipOf(req)) ?? []).filter((t) => now - t < 10 * 60_000);
  failures.set(ipOf(req), recent);
  return recent.length >= 5;
}

function recordFailure(req: Request) {
  const list = failures.get(ipOf(req)) ?? [];
  list.push(Date.now());
  failures.set(ipOf(req), list);
  if (failures.size > 10_000) failures.clear();
}

/** Checks a password from a login form or the x-admin-password header; counts failures. */
export function verify(req: Request, password: string | null): "ok" | "wrong" | "throttled" {
  if (throttled(req)) return "throttled";
  if (password !== null && checkPassword(password)) return "ok";
  recordFailure(req);
  return "wrong";
}

export function guard(req: Request): Response | null {
  const r = verify(req, req.headers.get("x-admin-password"));
  if (r === "ok") return null;
  return r === "throttled"
    ? Response.json({ error: "Too many wrong passwords. Try again in 10 minutes." }, { status: 429 })
    : Response.json({ error: "Wrong password." }, { status: 401 });
}
