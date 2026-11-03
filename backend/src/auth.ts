// Session tokens for /api/sponsor. The sponsor spends our SOL, so every call
// must be attributable to one wallet — that is what makes the per-user caps in
// limits.ts mean anything.
//
// `AUTH_MODE=mock` only changes how a session is *obtained* (POST /api/auth/mock
// hands one out for any wallet, for local work with no identity provider).
// Verification is the same real HMAC either way, so a forged token is rejected
// in both modes and the caps cannot be bypassed by inventing a wallet id.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.ts";

export type Session = { wallet: string; expiresAt: number };

export class AuthError extends Error {}

const b64url = (b: Buffer): string => b.toString("base64url");

/**
 * With no `SESSION_SECRET` configured we use a per-process random secret:
 * tokens stay unforgeable, they just do not survive a restart. That keeps mock
 * mode free of required secrets without weakening verification.
 */
let ephemeralSecret: Buffer | undefined;

/**
 * A secret for one purpose, derived from `SESSION_SECRET` (or the per-process random one) by
 * domain. Two purposes never share a key, so a token minted for one is not a token for the other
 * even though both are HMAC-SHA256 over the same shape.
 */
export function hmacSecret(domain: string): Buffer {
  const base = env.sessionSecret !== "" ? Buffer.from(env.sessionSecret, "utf8") : (ephemeralSecret ??= randomBytes(32));
  return createHmac("sha256", base).update(domain).digest();
}

/**
 * Domain-separated by auth mode: a token minted by a mock-mode instance is not valid in wallet mode
 * even if an operator reuses SESSION_SECRET across the two (mock mode hands out sessions for any
 * wallet, so it must never be able to speak to a live deployment).
 */
export const sessionSecret = (): Buffer => hmacSecret(`relstate/session/v1/${env.authMode}`);

function sign(payload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/**
 * `<base64url(JSON claims)>.<base64url(HMAC)>`, with `exp` in unix seconds. One implementation for
 * every bearer token this backend mints — the session and the appraiser invitation — so the
 * signature check, the constant-time compare and the expiry check cannot drift apart between them.
 */
export function createHmacToken<T extends object>(claims: T, { secret, ttlSeconds, now = Date.now() }: { secret: Buffer; ttlSeconds: number; now?: number }): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const payload = b64url(Buffer.from(JSON.stringify({ ...claims, exp: expiresAt }), "utf8"));
  return { token: `${payload}.${b64url(sign(payload, secret))}`, expiresAt };
}

/**
 * Verifies the signature and the expiry and returns the raw claims. The caller validates their
 * shape: an unforgeable token still carries whatever was put in it, and `what` names the token in
 * the error so a 401 says which one was wrong.
 */
export function verifyHmacToken(token: string, { secret, now = Date.now(), what = "session" }: { secret: Buffer; now?: number; what?: string }): Record<string, unknown> {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined || payload === "" || signature === "") {
    throw new AuthError(`malformed ${what} token`);
  }
  const expected = sign(payload, secret);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AuthError(`bad ${what} signature`);

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new AuthError(`malformed ${what} payload`);
  }
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) throw new AuthError(`malformed ${what} payload`);
  const exp = (claims as { exp?: unknown }).exp;
  if (typeof exp !== "number") throw new AuthError(`malformed ${what} payload`);
  if (exp * 1000 <= now) throw new AuthError(`${what} expired`);
  return claims as Record<string, unknown>;
}

export function createSessionToken(
  wallet: string,
  { secret = sessionSecret(), ttlSeconds = env.sessionTtlSeconds, now = Date.now() } = {},
): { token: string; expiresAt: number } {
  if (wallet.trim() === "") throw new AuthError("wallet is required");
  return createHmacToken({ w: wallet }, { secret, ttlSeconds, now });
}

export function verifySessionToken(token: string, { secret = sessionSecret(), now = Date.now() } = {}): Session {
  const claims = verifyHmacToken(token, { secret, now, what: "session" });
  if (typeof claims.w !== "string" || claims.w === "") throw new AuthError("malformed session payload");
  return { wallet: claims.w, expiresAt: claims.exp as number };
}

/** Pulls the bearer token out of an `Authorization` header. */
export function sessionFromAuthorizationHeader(header: string | undefined | null, options?: { now?: number }): Session {
  const value = (header ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (match?.[1] === undefined) throw new AuthError("missing bearer session token");
  return verifySessionToken(match[1], options);
}

/** Guards the operator-only treasury routes. Constant-time, and never enabled by default. */
export function assertAdmin(header: string | undefined | null): void {
  if (env.adminToken === "") throw new AuthError("ADMIN_TOKEN is not configured; admin routes are disabled");
  const value = (header ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const provided = Buffer.from(match?.[1] ?? "", "utf8");
  const expected = Buffer.from(env.adminToken, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new AuthError("bad admin token");
}
