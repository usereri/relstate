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
export function sessionSecret(): Buffer {
  if (env.sessionSecret !== "") return Buffer.from(env.sessionSecret, "utf8");
  return (ephemeralSecret ??= randomBytes(32));
}

function sign(payload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createSessionToken(
  wallet: string,
  { secret = sessionSecret(), ttlSeconds = env.sessionTtlSeconds, now = Date.now() } = {},
): { token: string; expiresAt: number } {
  if (wallet.trim() === "") throw new AuthError("wallet is required");
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const payload = b64url(Buffer.from(JSON.stringify({ w: wallet, exp: expiresAt }), "utf8"));
  return { token: `${payload}.${b64url(sign(payload, secret))}`, expiresAt };
}

export function verifySessionToken(token: string, { secret = sessionSecret(), now = Date.now() } = {}): Session {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined || payload === "" || signature === "") {
    throw new AuthError("malformed session token");
  }
  const expected = sign(payload, secret);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AuthError("bad session signature");

  let claims: { w?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
  } catch {
    throw new AuthError("malformed session payload");
  }
  if (typeof claims.w !== "string" || claims.w === "" || typeof claims.exp !== "number") {
    throw new AuthError("malformed session payload");
  }
  if (claims.exp * 1000 <= now) throw new AuthError("session expired");
  return { wallet: claims.w, expiresAt: claims.exp };
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
