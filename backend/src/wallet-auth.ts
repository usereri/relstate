// Wallet-signature login (AUTH_MODE=wallet): the only way a live backend learns who a caller is.
//
//   POST /api/auth/challenge {wallet}            -> a one-time message bound to this app's origin
//   POST /api/auth/verify    {wallet, signature} -> ed25519 over that exact message -> session token
//
// The session wallet is whichever key actually signed; nothing a client sends afterwards can change
// it. Challenges live in memory (single instance, like limits.ts), expire in minutes, are consumed
// on the first success, and a wrong guess does not burn the real user's challenge but is capped.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { getAddressEncoder, isAddress, type Address } from "@solana/kit";
import { AuthError, createSessionToken } from "./auth.ts";
import { env } from "./env.ts";

type Pending = { message: string; expiresAt: number; attempts: number };

export type WalletAuthOptions = {
  origin?: string;
  challengeTtlMs?: number;
  sessionTtlSeconds?: number;
  maxAttempts?: number;
  maxPending?: number;
  now?: () => number;
};

// DER prefix of an ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(wallet: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || !isAddress(wallet)) return false;
  const raw = Buffer.from(getAddressEncoder().encode(wallet as Address));
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function createWalletAuth(options: WalletAuthOptions = {}) {
  const now = options.now ?? Date.now;
  const origin = (options.origin ?? new URL(env.appUrl).origin).replace(/\/$/, "");
  const host = new URL(origin).host;
  const challengeTtlMs = options.challengeTtlMs ?? env.challengeTtlSeconds * 1000;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? env.walletSessionTtlSeconds;
  const maxAttempts = options.maxAttempts ?? 5;
  const maxPending = options.maxPending ?? 10_000;
  const pending = new Map<string, Pending>(); // wallet -> its one open challenge

  const sweep = () => {
    const t = now();
    for (const [wallet, p] of pending) if (p.expiresAt <= t) pending.delete(wallet);
  };

  function challenge(wallet: unknown): { message: string; expiresAt: number } {
    if (typeof wallet !== "string" || !isAddress(wallet)) throw new AuthError("wallet must be a base58 Solana address");
    sweep();
    if (pending.size >= maxPending && !pending.has(wallet)) throw new AuthError("too many pending logins; try again shortly");
    const issued = now();
    const expiresAt = issued + challengeTtlMs;
    const message = [
      `${host} wants you to sign in with your Solana account:`,
      wallet,
      "",
      "Sign in to relstate. This proves you control the wallet and costs nothing.",
      "",
      `URI: ${origin}`,
      `Nonce: ${randomBytes(24).toString("base64url")}`,
      `Issued At: ${new Date(issued).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    pending.set(wallet, { message, expiresAt, attempts: 0 });
    return { message, expiresAt };
  }

  function verifyLogin(wallet: unknown, signatureB64: unknown): { token: string; wallet: string; expiresAt: number } {
    // One undifferentiated failure for "no challenge", "expired" and "bad signature": no oracle.
    const fail = () => new AuthError("login failed: request a new challenge and sign it");
    if (typeof wallet !== "string" || !isAddress(wallet) || typeof signatureB64 !== "string") throw fail();
    const p = pending.get(wallet);
    if (p === undefined) throw fail();
    if (p.expiresAt <= now()) {
      pending.delete(wallet);
      throw fail();
    }
    const signature = Buffer.from(signatureB64, "base64");
    if (!verifyEd25519(wallet, Buffer.from(p.message, "utf8"), signature)) {
      if (++p.attempts >= maxAttempts) pending.delete(wallet);
      throw fail();
    }
    pending.delete(wallet); // single use
    const { token, expiresAt } = createSessionToken(wallet, { ttlSeconds: sessionTtlSeconds, now: now() });
    return { token, wallet, expiresAt };
  }

  return { challenge, verifyLogin, pendingCount: () => pending.size, origin };
}

export type WalletAuth = ReturnType<typeof createWalletAuth>;

/** Fixed-window per-key limiter for the unauthenticated login routes. */
export function createIpLimiter(perMinute: number, now: () => number = Date.now, maxKeys = 50_000) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (key: string): void => {
    const t = now();
    const h = hits.get(key);
    if (h === undefined || t - h.windowStart >= 60_000) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) if (t - v.windowStart >= 60_000) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear(); // under attack: fail open on memory, not on the limit itself
      }
      hits.set(key, { windowStart: t, count: 1 });
      return;
    }
    if (++h.count > perMinute) throw new RateLimited();
  };
}

export class RateLimited extends Error {
  constructor() {
    super("too many login requests; slow down");
  }
}
