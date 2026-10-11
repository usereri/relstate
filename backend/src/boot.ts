// Boot-time checks that need the network, kept apart from the pure env checks in env.ts.
import { env, type Env } from "./env.ts";

/** Genesis hash of Solana devnet. A URL substring proves nothing; the cluster's own answer does. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Live mode may run the mock KYC verifier only against devnet. `assertEnvConsistent` has already
 * required ALLOW_MOCK_KYC=devnet; this asks the configured RPC which cluster it really is.
 */
export async function assertMockKycAllowed(
  getGenesisHash: () => Promise<string>,
  warn: (line: string) => void = console.warn,
  e: Env = env,
): Promise<void> {
  if (e.mode !== "live" || e.kyc.provider !== "mock") return;
  if (e.kyc.allowMock !== "devnet") throw new Error("KYC_PROVIDER=mock in live mode needs ALLOW_MOCK_KYC=devnet");
  let hash: string;
  try {
    hash = await getGenesisHash();
  } catch {
    throw new Error("cannot confirm the RPC is devnet (getGenesisHash failed); refusing to run the mock KYC verifier");
  }
  if (hash !== DEVNET_GENESIS_HASH) {
    throw new Error("the configured RPC is not devnet (genesis hash mismatch); refusing to run the mock KYC verifier");
  }
  warn("!!! WARNING: ALLOW_MOCK_KYC=devnet — live backend is using the MOCK KYC verifier (no document check). Anyone who signs in can obtain a real on-chain attestation. DEVNET ONLY; never use on mainnet.");
}
