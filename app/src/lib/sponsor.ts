// Contract 2 client: the app never pays fees. It builds a transaction whose fee payer is the
// backend's sponsor key, signs it as the user, and posts it; the backend validates it, co-signs
// as fee payer and submits.
//
// "Fee payer slot empty" means the signature slot, not the address: the fee payer's address is
// part of what the user signs, so the app has to know it up front. It comes from VITE_FEE_PAYER,
// or from `GET /api/sponsor` when the backend is reachable and the env var is unset.
//
// Deliberately free of web3.js and of @solana/kit, so both the existing flows and the
// confidential-transfer island can post through it.

/** Where the backend lives, or null when the app runs without one (local test mode). */
export const API: string | null = import.meta.env.VITE_API ?? null;

/** True when transactions should be sponsored rather than paid for by the connected wallet. */
export const SPONSORED = !!API;

const CONFIGURED_FEE_PAYER: string | null = import.meta.env.VITE_FEE_PAYER ?? null;

const fail = async (res: Response, what: string): Promise<never> => {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `${what} failed (${res.status})`);
};

/**
 * How `postSponsored` gets a bearer token for the connected wallet.
 *
 * `POST /api/sponsor` is session-authenticated — it spends our SOL, so the backend attributes every
 * call to one wallet and caps it. Obtaining the token is identity work, so it lives in
 * `app/src/auth/session.ts` and is injected here: this module stays free of both Solana stacks and
 * of the auth layer, and the confidential island posts through the same path.
 *
 * Null means "no session layer registered", which is the correct state for an unsponsored local run.
 */
export type SessionTokenSource = () => Promise<string>;
let sessionToken: SessionTokenSource | null = null;
export function setSessionTokenSource(source: SessionTokenSource | null): void {
  sessionToken = source;
}

let discovering: Promise<string> | null = null;
let health: Promise<BackendInfo> | null = null;

/** The subset of `GET /health` the app needs. Every field here is a public key or a public flag. */
export interface BackendInfo {
  treasury: string;
  rusdcMint: string | null;
  auditorConfigured: boolean;
}

/**
 * Asks the backend who it is. Public and unauthenticated, because the answer is public keys.
 *
 * The treasury address matters to the client: a first-use confidential-account setup must name the
 * treasury as its fee payer, since that route checks the fee payer is the key it is about to
 * co-sign with. The app cannot guess it, and unlike the sponsor's fee payer there is no VITE_
 * override to fall back on.
 */
export function backendInfo(): Promise<BackendInfo> {
  if (!API) return Promise.reject(new Error("No backend configured (VITE_API), so there is nothing to ask."));
  health ??= (async () => {
    const res = await fetch(`${API}/health`);
    if (!res.ok) return fail(res, "backend health");
    const body = (await res.json()) as { treasury?: string; rusdcMint?: string | null; auditorConfigured?: boolean };
    if (!body.treasury) throw new Error(`${API}/health did not report a treasury address.`);
    return { treasury: body.treasury, rusdcMint: body.rusdcMint ?? null, auditorConfigured: body.auditorConfigured === true };
  })().catch((e) => {
    health = null;
    throw e;
  });
  return health;
}

/**
 * The address that pays for everything: fees, and the rent for the proof context-state accounts
 * a confidential transfer stages. Resolved once per session.
 */
export function sponsorFeePayer(): Promise<string> {
  if (CONFIGURED_FEE_PAYER) return Promise.resolve(CONFIGURED_FEE_PAYER);
  if (!API)
    return Promise.reject(
      new Error("No sponsor configured: set VITE_API to a backend that sponsors fees, or VITE_FEE_PAYER to its fee-payer address."),
    );
  discovering ??= (async () => {
    const res = await fetch(`${API}/api/sponsor`);
    if (!res.ok) return fail(res, "sponsor discovery");
    const { feePayer } = (await res.json()) as { feePayer?: string };
    if (!feePayer) throw new Error(`${API}/api/sponsor did not report a feePayer. Set VITE_FEE_PAYER instead.`);
    return feePayer;
  })().catch((e) => {
    discovering = null;
    throw e;
  });
  return discovering;
}

/** Posts a user-signed transaction to a co-signing route and returns the submitted signature. */
async function postForCosigning(path: string, txBase64: string, what: string): Promise<string> {
  if (!API) throw new Error("No backend configured (VITE_API), so there is nobody to pay the fee.");
  if (!sessionToken)
    throw new Error("No session layer is registered, so this transaction cannot be authenticated to the sponsor. This is a bug: report it.");
  const token = await sessionToken();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ txBase64 }),
  });
  if (!res.ok) return fail(res, what);
  // The backend simulates before co-signing and reports simulation failures as { error },
  // so a 200 without a signature is still a failure.
  const body = (await res.json()) as { signature?: string; error?: string };
  if (!body.signature) throw new Error(body.error ?? `${what} returned no signature`);
  return body.signature;
}

/** Posts a user-signed, fee-payer-unsigned transaction. Returns the submitted signature. */
export const postSponsored = (txBase64: string): Promise<string> => postForCosigning("/api/sponsor", txBase64, "sponsor");

/**
 * The one flow that cannot go through `/api/sponsor`: creating a wallet's confidential token
 * account. Somebody has to fund the account's rent, and the sponsor refuses outright any
 * transaction that references the fee payer inside an instruction — a rule with no exception
 * carved into it. So first-use setup is co-signed by the **treasury** key instead, under its own
 * narrower bounds (docs/contracts/treasury.md, "Why the setup path uses the treasury key").
 */
export const postConfidentialAccountSetup = (txBase64: string): Promise<string> =>
  postForCosigning("/api/treasury/confidential-account", txBase64, "confidential account setup");
