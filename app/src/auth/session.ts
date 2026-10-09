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

/** Asks the backend for a session. Separated out so the real issuance endpoint can replace it. */
async function requestSession(wallet: string): Promise<BackendSession> {
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
  const fresh = requestSession(wallet)
    .then((s) => {
      cache.set(wallet, s);
      storeSession(s);
      inFlight.delete(wallet);
      return s;
    })
    .catch((e) => {
      inFlight.delete(wallet);
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
