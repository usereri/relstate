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

type Pending = { wallet: string; message: string; expiresAt: number; attempts: number };

export type WalletAuthOptions = {
  origin?: string;
  challengeTtlMs?: number;
  sessionTtlSeconds?: number;
  maxAttempts?: number;
  maxPending?: number;
  maxPendingPerWallet?: number;
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
  const maxPendingPerWallet = options.maxPendingPerWallet ?? 3;
  // Keyed by nonce, so nobody but the holder of a challenge can burn its attempts, and a third
  // party asking for a challenge for someone's address cannot invalidate the one they already hold.
  // Map order is insertion order, which is what makes "evict the oldest" cheap.
  const pending = new Map<string, Pending>();
  const byWallet = new Map<string, string[]>();

  const drop = (nonce: string) => {
    const p = pending.get(nonce);
    if (p === undefined) return;
    pending.delete(nonce);
    const rest = (byWallet.get(p.wallet) ?? []).filter((n) => n !== nonce);
    if (rest.length === 0) byWallet.delete(p.wallet);
    else byWallet.set(p.wallet, rest);
  };
  const sweep = () => {
    const t = now();
    for (const [nonce, p] of pending) if (p.expiresAt <= t) drop(nonce);
  };

  function challenge(wallet: unknown): { message: string; nonce: string; expiresAt: number } {
    if (typeof wallet !== "string" || !isAddress(wallet)) throw new AuthError("wallet must be a base58 Solana address");
    sweep();
    // Full store or too many for one wallet: evict the oldest rather than refuse, so a flood
    // degrades the flooder's own entries first and never locks a new user out.
    while (pending.size >= maxPending) drop(pending.keys().next().value as string);
    // Re-read each pass: drop() installs a new array, so a hoisted reference would never shrink.
    for (let mine = byWallet.get(wallet); mine !== undefined && mine.length >= maxPendingPerWallet; mine = byWallet.get(wallet)) {
      drop(mine[0] as string);
    }
    const issued = now();
    const expiresAt = issued + challengeTtlMs;
    const nonce = randomBytes(24).toString("base64url");
    const message = [
      `${host} wants you to sign in with your Solana account:`,
      wallet,
      "",
      "Sign in to relstate. This proves you control the wallet and costs nothing.",
      "",
      `URI: ${origin}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(issued).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    pending.set(nonce, { wallet, message, expiresAt, attempts: 0 });
    byWallet.set(wallet, [...(byWallet.get(wallet) ?? []), nonce]);
    return { message, nonce, expiresAt };
  }

  function verifyLogin(wallet: unknown, nonce: unknown, signatureB64: unknown): { token: string; wallet: string; expiresAt: number } {
    // One undifferentiated failure for "no challenge", "expired" and "bad signature": no oracle.
    const fail = () => new AuthError("login failed: request a new challenge and sign it");
    if (typeof wallet !== "string" || !isAddress(wallet) || typeof nonce !== "string" || typeof signatureB64 !== "string") throw fail();
    const p = pending.get(nonce);
    if (p === undefined || p.wallet !== wallet) throw fail();
    if (p.expiresAt <= now()) {
      drop(nonce);
      throw fail();
    }
    const signature = Buffer.from(signatureB64, "base64");
    if (!verifyEd25519(wallet, Buffer.from(p.message, "utf8"), signature)) {
      if (++p.attempts >= maxAttempts) drop(nonce);
      throw fail();
    }
    drop(nonce); // single use
    const { token, expiresAt } = createSessionToken(wallet, { ttlSeconds: sessionTtlSeconds, now: now() });
    return { token, wallet, expiresAt };
  }

  return { challenge, verifyLogin, pendingCount: () => pending.size, origin };
}

export type WalletAuth = ReturnType<typeof createWalletAuth>;

/**
 * Fixed-window per-key limiter for the unauthenticated login routes. At `maxKeys` it evicts the
 * oldest window instead of clearing the table, so key churn cannot reset an exhausted bucket.
 */
export function createIpLimiter(perMinute: number, now: () => number = Date.now, maxKeys = 50_000) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (key: string): void => {
    const t = now();
    const h = hits.get(key);
    if (h === undefined || t - h.windowStart >= 60_000) {
      hits.delete(key); // re-insert so Map order stays oldest-window-first
      while (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
      hits.set(key, { windowStart: t, count: 1 });
      return;
    }
    if (++h.count > perMinute) throw new RateLimited();
  };
}

/**
 * The caller's address for rate limiting. `fly-client-ip` is trusted only when we are behind Fly's
 * proxy (or the operator says so); anywhere else it is attacker-controlled input.
 */
export function clientIpOf(header: (name: string) => string | undefined, socketAddress: string | undefined, trustProxyHeader: boolean): string {
  if (trustProxyHeader) {
    const fly = header("fly-client-ip");
    if (fly !== undefined && fly !== "") return fly;
  }
  return socketAddress ?? "unknown";
}

export class RateLimited extends Error {
  constructor() {
    super("too many login requests; slow down");
  }
}
