// Fiat in and out, app half (workstream E, docs/contracts/stripe.md).
//
// Everything here is HTTP against the backend; nothing in this file can move
// money. A top-up is credited by the provider's signed webhook, so the only
// thing the browser does on return from the hosted page is poll until the
// backend says the credit landed — the redirect itself proves nothing and is
// trivially forgeable by hand-editing the URL.
//
// Deliberately free of React so it can be tested without a DOM, and free of
// web3.js so the top-up screen does not pull in the chain stack.
import { API } from "@/lib/sponsor";

export type OnrampConfig = {
  provider: "mock" | "stripe";
  /** True when no card is involved: the checkout page is served by our own backend. */
  simulated: boolean;
  plnPerUsdc: string;
  minPln: string;
  maxPln: string;
  maxUsdcPerWalletPerDay: string;
};

export type Checkout = {
  url: string;
  intent: string;
  provider: "mock" | "stripe";
  amountPln: string;
  amountUsdc: string;
  plnPerUsdc: string;
  publicHoldback: string;
  simulated: boolean;
};

export type OnrampCredit = {
  ref: string;
  wallet: string;
  amountUsdc: string;
  amountPln: string;
  publicHoldback: string;
  confidentialAmount: string;
  confidentialPending: boolean;
  status: "credited" | "rejected";
  reason?: string;
  signatures: string[];
  at: number;
};

export type OnrampStatus = {
  intent: string;
  wallet: string;
  amountPln: string;
  amountUsdc: string;
  plnPerUsdc: string;
  state: "pending" | "credited" | "rejected";
  credit: OnrampCredit | null;
  remainingToday: string;
};

export type PayoutReceipt = {
  simulated: true;
  reference: string;
  wallet: string;
  amountUsdc: string;
  amountPln: string;
  plnPerUsdc: string;
  method: string;
  destination: string | null;
  status: "paid-simulated";
  unwrap: { burned: boolean; signatures: string[]; note: string };
  at: number;
};

export type PayoutHistory = {
  simulated: true;
  plnPerUsdc: string;
  remainingToday: string;
  receipts: PayoutReceipt[];
};

/** True when a backend is configured at all; without one the fiat screens explain themselves instead. */
export const FIAT_AVAILABLE = !!API;

const noBackend = () =>
  new Error("No backend configured (VITE_API), so there is no fiat rail. Start the backend and set VITE_API in app/.env.local.");

async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `${what} failed (${res.status})`);
}

/**
 * Session token for the backend's authenticated routes.
 *
 * `POST /api/auth/mock` exists only while `AUTH_MODE=mock` and hands a real
 * HMAC session to any wallet that asks — fine locally, refused outright in live
 * mode. Workstream B replaces this with the embedded-wallet login, which issues
 * the same token shape, so only this function changes.
 *
 * Cached per wallet for the process. A token that has expired surfaces as a 401,
 * and `withSession` retries once with a fresh one rather than making the user
 * reload the page.
 */
const sessions = new Map<string, Promise<string>>();

export function sessionToken(wallet: string, { refresh = false } = {}): Promise<string> {
  if (!API) return Promise.reject(noBackend());
  if (refresh) sessions.delete(wallet);
  let pending = sessions.get(wallet);
  if (pending === undefined) {
    pending = (async () => {
      const res = await fetch(`${API}/api/auth/mock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      if (!res.ok) return fail(res, "sign-in");
      const { token } = (await res.json()) as { token?: string };
      if (!token) throw new Error("the backend issued no session token");
      return token;
    })().catch((e) => {
      sessions.delete(wallet);
      throw e;
    });
    sessions.set(wallet, pending);
  }
  return pending;
}

/** Clears the cached session, e.g. on sign-out. */
export const forgetSession = (wallet?: string) => (wallet === undefined ? sessions.clear() : sessions.delete(wallet));

export type Req = { path: string; method?: "GET" | "POST"; body?: unknown; what: string };

export async function withSession<T>(wallet: string, { path, method = "GET", body, what }: Req): Promise<T> {
  if (!API) throw noBackend();
  const send = async (token: string) =>
    fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let res = await send(await sessionToken(wallet));
  // One retry on 401: the only expected cause is an expired or restart-invalidated
  // token, and a second 401 is a real failure worth showing.
  if (res.status === 401) res = await send(await sessionToken(wallet, { refresh: true }));
  if (!res.ok) return fail(res, what);
  return (await res.json()) as T;
}

export async function onrampConfig(): Promise<OnrampConfig> {
  if (!API) throw noBackend();
  const res = await fetch(`${API}/api/onramp/config`);
  if (!res.ok) return fail(res, "top-up configuration");
  return (await res.json()) as OnrampConfig;
}

/**
 * Prices a top-up and returns the hosted checkout to open.
 *
 * `amountPln` is a decimal string so the user's typing survives the trip
 * unrounded; `depositHoldbackUsdc` is base units to keep public for
 * `fund_deposit` (docs/contracts/treasury.md), which the lease flow sets and the
 * plain top-up leaves at zero.
 */
export const startTopUp = (wallet: string, amountPln: string, depositHoldbackUsdc?: string): Promise<Checkout> =>
  withSession(wallet, {
    path: "/api/onramp/checkout",
    method: "POST",
    body: { amountPln, ...(depositHoldbackUsdc === undefined ? {} : { depositHoldbackUsdc }) },
    what: "checkout",
  });

export const topUpStatus = (wallet: string, intent: string): Promise<OnrampStatus> =>
  withSession(wallet, { path: `/api/onramp/status?intent=${encodeURIComponent(intent)}`, what: "top-up status" });

/**
 * Polls until the webhook has credited the top-up, or until `timeoutMs`.
 *
 * The provider's webhook and the browser's redirect race, and in test mode the
 * webhook usually wins — but not always, and a tunnelled webhook in a demo can
 * be seconds behind. A `pending` status is therefore normal, not an error.
 */
export async function awaitTopUp(
  wallet: string,
  intent: string,
  { timeoutMs = 90_000, pollMs = 1500, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<OnrampStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: OnrampStatus | undefined;
  for (;;) {
    last = await topUpStatus(wallet, intent);
    if (last.state !== "pending") return last;
    if (Date.now() >= deadline) return last;
    await sleep(pollMs);
  }
}

export const requestPayout = (wallet: string, amountUsdc: string, opts: { method?: string; destination?: string } = {}): Promise<PayoutReceipt> =>
  withSession(wallet, { path: "/api/offramp/payout", method: "POST", body: { amountUsdc, ...opts }, what: "payout" });

export const payoutHistory = (wallet: string): Promise<PayoutHistory> =>
  withSession(wallet, { path: "/api/offramp/history", what: "payout history" });

// --- display helpers, shared by both fiat screens -----------------------------

/** Base units (6 decimals) -> "93.02". Backend amounts arrive as strings; never parse them into floats for arithmetic. */
export const usdcFromBase = (base: string): string => {
  const n = BigInt(base || "0");
  const whole = n / 1_000_000n;
  const cents = (n % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
};

/** Grosz -> "400.00". */
export const plnFromMinor = (minor: string): string => {
  const n = BigInt(minor || "0");
  return `${(n / 100n).toLocaleString("en-US")}.${(n % 100n).toString().padStart(2, "0")}`;
};

/**
 * What the user typed, as a decimal the backend will accept, or null.
 *
 * Rejects what `parseScaled` on the backend rejects — exponent form, a minus
 * sign, more than two decimal places — so the error appears next to the input
 * rather than coming back from the server.
 */
export function normalisePln(input: string): string | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

/** The demo rate applied client-side, for the live "you'll receive" line. Display only. */
export function previewUsdc(amountPln: string, plnPerUsdc: string): string | null {
  const pln = normalisePln(amountPln);
  const rate = Number(plnPerUsdc);
  if (pln === null || !Number.isFinite(rate) || rate <= 0) return null;
  // Floor, to match the backend's integer arithmetic rather than disagree with it by a cent.
  return (Math.floor((Number(pln) / rate) * 100) / 100).toFixed(2);
}

/** Reads `#/app?topup=done&intent=…` left by the hosted page's return. */
export function topUpReturn(hash = globalThis.location?.hash ?? ""): { outcome: "done" | "cancelled"; intent: string } | null {
  const query = hash.slice(hash.indexOf("?") + 1);
  if (!hash.includes("?")) return null;
  const params = new URLSearchParams(query);
  const outcome = params.get("topup");
  const intent = params.get("intent") ?? "";
  if ((outcome !== "done" && outcome !== "cancelled") || intent === "") return null;
  return { outcome, intent };
}

/** Drops the top-up query from the hash so a reload does not replay the return. */
export function clearTopUpReturn(): void {
  try {
    const hash = globalThis.location?.hash ?? "";
    const base = hash.split("?")[0] ?? "#/app";
    history.replaceState(null, "", `${globalThis.location.pathname}${globalThis.location.search}${base}`);
  } catch {
    /* no history API: the banner simply shows again on reload */
  }
}
