// How much of a top-up stays PUBLIC (docs/contracts/treasury.md, "Keep the deposit public").
//
// `fund_deposit` moves a public amount into the vault, and the browser's "Securing your balance" step
// moves everything above the holdback into the private balance. A top-up with no holdback therefore
// leaves a tenant unable to accept any lease (Token-2022 InsufficientFunds inside fund_deposit).
// All amounts are base units (1 rUSDC = 1_000_000), as numbers: they are demo-sized.

/** The public amount a plain top-up (no lease in view) keeps: config.ts DEFAULT_PUBLIC_HOLDBACK. */
export function defaultHoldback(configured: number, topUpBase: number): number {
  return Math.max(0, Math.min(configured, topUpBase));
}

/** What a lease still needs on the public side: the deposit minus what is already public. 0 when covered. */
export function depositShortfall(publicBalance: number | null, deposit: number): number {
  return Math.max(0, deposit - (publicBalance ?? 0));
}

export interface TopUpNeed {
  /** Base units that must be added to the PUBLIC balance for the deposit. */
  shortfall: number;
  /** One rent period, so the suggested top-up also covers the first payment. */
  rent: number;
}

/** The holdback to send for a top-up of `topUpBase`: the shortfall when a lease needs it, else the default. */
export function holdbackFor(topUpBase: number, need: TopUpNeed | null, configuredDefault: number): number {
  return need ? Math.min(need.shortfall, topUpBase) : defaultHoldback(configuredDefault, topUpBase);
}

/** Whole złoty (rounded up) that buys at least `baseUnits` rUSDC at `plnPerUsdc`, never below `minPln`. */
export function plnToCover(baseUnits: number, plnPerUsdc: number, minPln: number): number {
  if (!(plnPerUsdc > 0)) return minPln;
  return Math.max(minPln, Math.ceil((baseUnits / 1e6) * plnPerUsdc));
}

/** The backend takes the holdback as a decimal USDC string, six places. */
export const holdbackParam = (base: number): string => (Math.max(0, Math.floor(base)) / 1e6).toFixed(6);

/** True for the Token-2022 "insufficient funds" (custom error 0x1) that fund_deposit raises on a short public balance. */
export function isShortPublicBalance(text: string): boolean {
  return /TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1\b/.test(text) || /Not enough public balance for the deposit/.test(text);
}
