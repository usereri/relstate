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

let discovering: Promise<string> | null = null;

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

/** Posts a user-signed, fee-payer-unsigned transaction. Returns the submitted signature. */
export async function postSponsored(txBase64: string): Promise<string> {
  if (!API) throw new Error("No backend configured (VITE_API), so there is nobody to pay the fee.");
  const res = await fetch(`${API}/api/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txBase64 }),
  });
  if (!res.ok) return fail(res, "sponsor");
  // The backend simulates before co-signing and reports simulation failures as { error },
  // so a 200 without a signature is still a failure.
  const body = (await res.json()) as { signature?: string; error?: string };
  if (!body.signature) throw new Error(body.error ?? "sponsor returned no signature");
  return body.signature;
}
