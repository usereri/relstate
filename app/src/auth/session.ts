// The backend session every sponsored transaction needs.
//
// `POST /api/sponsor` spends our SOL, so the backend requires a bearer session token and attributes
// the call to one wallet — that is what makes its per-wallet caps mean anything (backend/src/auth.ts).
// Nothing in the app asked for one before this workstream, which is why sponsored mode answered 401
// for every wallet; the fix belongs here rather than in the embedded path alone, because the
// extension and built-in test wallets need exactly the same token.
//
// In the backend's mock auth mode `POST /api/auth/mock` hands a real HMAC session to any wallet that
// asks. That is the only issuance endpoint that exists today: the identity-bound one arrives with the
// KYC workstream, and will return this same token shape, so only `requestSession` changes.

import { API } from "@/lib/sponsor";

/** A bearer token for `POST /api/sponsor`, valid for one wallet until `expiresAt` (unix seconds). */
export interface BackendSession {
  token: string;
  wallet: string;
  expiresAt: number;
}

/** Renew this far before the real expiry, so a token cannot die mid-flight. */
const SKEW_SECS = 60;

const storageKey = (wallet: string) => `relstate.session.${wallet}`;
const nowSecs = () => Math.floor(Date.now() / 1000);

const isFresh = (s: BackendSession) => s.expiresAt - nowSecs() > SKEW_SECS;

/** Shape-checks a stored session: localStorage survives deploys, this code does not have to. */
function parseSession(raw: string, wallet: string): BackendSession | null {
  try {
    const s = JSON.parse(raw) as Partial<BackendSession>;
    if (typeof s.token !== "string" || s.token === "") return null;
    if (typeof s.expiresAt !== "number" || !Number.isFinite(s.expiresAt)) return null;
    // A token minted for a different wallet would be rejected by the backend anyway.
    if (s.wallet !== wallet) return null;
    return { token: s.token, wallet, expiresAt: s.expiresAt };
  } catch {
    return null;
  }
}

export function loadStoredSession(wallet: string): BackendSession | null {
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    const parsed = raw ? parseSession(raw, wallet) : null;
    return parsed && isFresh(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeSession(s: BackendSession): void {
  try {
    localStorage.setItem(storageKey(s.wallet), JSON.stringify(s));
  } catch {
    /* private mode: a new session is simply requested on the next reload */
  }
}

export function clearSession(wallet: string): void {
  cache.delete(wallet);
  inFlight.delete(wallet);
  try {
    localStorage.removeItem(storageKey(wallet));
  } catch {
    /* nothing was stored */
  }
}

type Signer = (message: Uint8Array) => Promise<Uint8Array>;
const signers = new Map<string, Signer>();

/**
 * Tells the session layer how to sign the login challenge for a wallet. Only the wallet's generic
 * `signMessage` is ever passed here, which already refuses the confidential-balance derivation
 * message, so a login prompt can never be turned into that key material.
 */
export function registerSigner(wallet: string, sign: Signer | undefined): void {
  if (sign) signers.set(wallet, sign);
  else signers.delete(wallet);
}

/** The backend's auth mode from /health. Cached for the page's life; unknown reads as "mock". */
let authModeCache: Promise<string> | null = null;
async function backendAuthMode(): Promise<string> {
  authModeCache ??= fetch(`${API}/health`)
    .then((r) => r.json() as Promise<{ authMode?: string }>)
    .then((b) => b.authMode ?? "mock")
    .catch(() => {
      authModeCache = null;
      return "mock";
    });
  return authModeCache;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `${path} failed (${res.status})`);
  return parsed;
}

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** Wallet-signature login: sign the backend's one-time challenge, trade the signature for a session. */
async function requestWalletSession(wallet: string): Promise<BackendSession> {
  const sign = signers.get(wallet);
  if (!sign) throw new Error("This wallet cannot sign messages, so it cannot log in to the backend.");
  const { message } = await postJson<{ message?: string }>("/api/auth/challenge", { wallet });
  if (typeof message !== "string") throw new Error("The backend sent no login challenge.");
  // Phishing guard: sign only a challenge that names this wallet and the origin we are running on.
  const lines = message.split("\n");
  if (lines[1] !== wallet || !lines.includes(`URI: ${window.location.origin}`))
    throw new Error("The login challenge does not match this wallet and site, so it was not signed.");
  const signature = await sign(new TextEncoder().encode(message));
  const body = await postJson<{ token?: string; wallet?: string; expiresAt?: number }>("/api/auth/verify", {
    wallet,
    signature: toBase64(signature),
  });
  if (!body.token || typeof body.expiresAt !== "number") throw new Error("The backend did not return a session token.");
  if (body.wallet !== wallet) throw new Error(`The backend issued a session for ${body.wallet} instead of ${wallet}.`);
  return { token: body.token, wallet, expiresAt: body.expiresAt };
}

/** Asks the backend for a session: wallet-signature login when it offers one, else the mock endpoint. */
async function requestSession(wallet: string): Promise<BackendSession> {
  if (!API) throw new Error("No backend configured (VITE_API), so there is no session to obtain.");
  if ((await backendAuthMode()) === "wallet") return requestWalletSession(wallet);
  return requestMockSession(wallet);
}

async function requestMockSession(wallet: string): Promise<BackendSession> {
  if (!API) throw new Error("No backend configured (VITE_API), so there is no session to obtain.");
  const res = await fetch(`${API}/api/auth/mock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  if (res.status === 404)
    throw new Error(
      `${API} has no mock session endpoint, so it is not running in mock auth mode. Start it with AUTH_MODE=mock, or point VITE_API at a backend that issues sessions.`,
    );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `session request failed (${res.status})`);
  }
  const body = (await res.json()) as { token?: string; wallet?: string; expiresAt?: number };
  if (!body.token || typeof body.expiresAt !== "number") throw new Error(`${API}/api/auth/mock did not return a session token.`);
  // Never stamp the wallet we asked for onto a token minted for another one: the caps the backend
  // enforces are per wallet, so a mismatch is a backend bug worth surfacing, not papering over.
  if (typeof body.wallet === "string" && body.wallet !== wallet)
    throw new Error(`The backend issued a session for ${body.wallet} instead of ${wallet}.`);
  return { token: body.token, wallet, expiresAt: body.expiresAt };
}

const cache = new Map<string, BackendSession>();
const inFlight = new Map<string, Promise<BackendSession>>();

/**
 * The session for a wallet: the cached one while it is fresh, otherwise a new one. Concurrent
 * callers share one request, and a failure is not cached, so the next attempt retries.
 */
export function obtainSession(wallet: string): Promise<BackendSession> {
  const held = cache.get(wallet) ?? loadStoredSession(wallet);
  if (held && isFresh(held)) {
    cache.set(wallet, held);
    return Promise.resolve(held);
  }
  const pending = inFlight.get(wallet);
  if (pending) return pending;
  // `clearSession` drops the in-flight entry, which is how a sign-out that lands mid-request wins:
  // the request still resolves for whoever asked, but it is not written to the cache or to storage,
  // so signing out during sign-in cannot resurrect the account that was just abandoned.
  const fresh: Promise<BackendSession> = requestSession(wallet)
    .then((s) => {
      if (inFlight.get(wallet) !== fresh) return s;
      inFlight.delete(wallet);
      cache.set(wallet, s);
      storeSession(s);
      return s;
    })
    .catch((e) => {
      if (inFlight.get(wallet) === fresh) inFlight.delete(wallet);
      throw e;
    });
  inFlight.set(wallet, fresh);
  return fresh;
}

/** The token for a wallet if one is already held, without touching the network. */
export const heldToken = (wallet: string): string | null => {
  const held = cache.get(wallet) ?? loadStoredSession(wallet);
  return held && isFresh(held) ? held.token : null;
};
