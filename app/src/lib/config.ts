// Network + lease timing. Point the app at devnet with VITE_RPC in app/.env.local, for example
//   VITE_RPC=https://api.devnet.solana.com
export const RPC: string =
  import.meta.env.VITE_RPC ??
  `http://${globalThis.location?.hostname ?? "localhost"}:8899`;

// Local Surfpool can jump the clock, so a local run can show a realistic 30-day rent period.
// On devnet the clock is real, so periods are compressed (say so out loud).
export const IS_LOCAL = !/devnet|mainnet|testnet/.test(RPC);
export const CAN_FAST_FORWARD = IS_LOCAL;
export const PERIOD_SECS = IS_LOCAL ? 30 * 86_400 : 45;
export const GRACE_SECS = IS_LOCAL ? 3 * 86_400 : 20;
export const TERM_PERIODS = 3;
export const CLAIM_WINDOW_SECS = 10;
export const USDC = 1_000_000;
// The test-USDC mint `make demo-setup` creates: derived from the payer wallet
// (~/.config/solana/id.json) with seed "relstate-test-usdc", so it is the same in every worktree.
// Someone with a different payer sets VITE_MINT to the address demo-setup prints.
export const MINT: string = import.meta.env.VITE_MINT ?? "Gco8ivBzZTq9U4iBLEApWxy8bcHbtenNP6crmYQcPCXH";

/**
 * The Token-2022 confidential mint rent is settled in (`scripts/make-rusdc.ts` creates it and the
 * backend reports it). Empty until that mint exists, which is why `confidential.ts` only asks for
 * it when a private operation is actually requested.
 */
export const RUSDC_MINT: string = import.meta.env.VITE_RUSDC_MINT ?? "";
export const MAX_TEXT = { title: 60, city: 40, blurb: 120, photo: 120 };
