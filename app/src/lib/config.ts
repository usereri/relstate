import idl from "@target/idl/relstate.json";

// Network + lease timing.
//
// Reads go through the backend's read-only proxy (`POST /api/rpc`) whenever a backend is configured:
// the browser then needs no RPC key, and nothing talks to the rate-limited public endpoint. VITE_RPC
// still overrides it, e.g. `VITE_RPC=http://localhost:8899` for a local validator, or a keyed URL
// in local development only (a key set here ends up in the bundle).
const API_BASE: string | undefined = import.meta.env.VITE_API;
export const RPC: string =
  import.meta.env.VITE_RPC ||
  (API_BASE ? `${API_BASE.replace(/\/$/, "")}/api/rpc` : `http://${globalThis.location?.hostname ?? "localhost"}:8899`);

// Local Surfpool can jump the clock, so a local run can show a realistic 30-day rent period.
// On devnet the clock is real, so periods are compressed (say so out loud). The proxy's URL says
// nothing about which cluster is behind it, so a proxied app is on a real network unless VITE_LOCAL=1.
export const IS_LOCAL = /\/api\/rpc\/?$/.test(RPC) ? import.meta.env.VITE_LOCAL === "1" : !/devnet|mainnet|testnet/.test(RPC);
export const CAN_FAST_FORWARD = IS_LOCAL;
export const PERIOD_SECS = IS_LOCAL ? 30 * 86_400 : 45;
export const GRACE_SECS = IS_LOCAL ? 3 * 86_400 : 20;
export const TERM_PERIODS = 3;
// Read from the program's IDL (the build the app is built against), never mirrored: the demo
// build is 3 s and the release build 14 days.
export const CLAIM_WINDOW_SECS: number = Number(idl.constants.find((c) => c.name === "CLAIM_WINDOW_SECS")!.value);
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

/**
 * Whether this build serves the operator verdict console at `#/appraiser`.
 *
 * Off unless explicitly set to 1. The console itself holds no key — the appraiser's key is the
 * backend's, behind its own token — so this is not what protects the deposit. What it does is keep
 * an operator tool out of a public build entirely: the route stops resolving, and because the flag
 * is inlined at build time the branch is dead code that the bundler drops with the screen behind
 * it. See docs/env-checklist.md.
 */
export const APPRAISER_CONSOLE: boolean = import.meta.env.VITE_APPRAISER_CONSOLE === "1";

/**
 * Base units of a plain top-up (no lease in view) that stay public, so the tenant can always fund a
 * deposit afterwards. Default 100 rUSDC covers the demo's deposits; a top-up smaller than it keeps
 * the whole amount public. Override with VITE_DEFAULT_PUBLIC_HOLDBACK. (docs/contracts/treasury.md)
 */
export const DEFAULT_PUBLIC_HOLDBACK: number = Number(import.meta.env.VITE_DEFAULT_PUBLIC_HOLDBACK ?? 100_000_000) || 0;
