// Fiat <-> rUSDC arithmetic for the demo on-ramp. Pure, integer-only, and in its
// own module because every rounding decision here is a decision about how much
// rUSDC gets minted.
//
// Nothing in the money path uses a JS number: PLN is carried in grosz, rUSDC in
// base units (6 decimals) and the rate as a fixed-point integer, all `bigint`.
// Floats would be fine at demo sizes and wrong in a way that only shows up in
// the reserve invariant months later.

export const PLN_DECIMALS = 2;
export const USDC_DECIMALS = 6;
/** Fixed-point scale for `DEMO_PLN_PER_USDC`. Six places is far past any quoted FX rate. */
export const RATE_DECIMALS = 6;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * A non-negative decimal from untrusted input, as an integer scaled by
 * `decimals`. Rejects anything that is not plain decimal notation — including
 * exponent form, `NaN`, `Infinity` and a minus sign — rather than coercing it.
 */
export function parseScaled(value: string | number, decimals: number, field: string): bigint {
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new Error(`${field} must be a plain non-negative decimal number, got ${JSON.stringify(String(value))}`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`${field} has ${fraction.length} decimal places; at most ${decimals} are allowed`);
  }
  return BigInt(match[1] + fraction.padEnd(decimals, "0"));
}

/** Renders a scaled integer back as a decimal string, keeping every place. */
export function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** `12.5` PLN -> `1250` grosz. Stripe's `unit_amount` is in exactly these units. */
export const parsePln = (value: string | number, field = "amountPln"): bigint => parseScaled(value, PLN_DECIMALS, field);
/** `"4.30"` -> `4300000`. */
export const parseRate = (value: string | number, field = "DEMO_PLN_PER_USDC"): bigint => parseScaled(value, RATE_DECIMALS, field);
/** `"93.5"` USDC -> `93500000` base units. */
export const parseUsdc = (value: string | number, field = "amountUsdc"): bigint => parseScaled(value, USDC_DECIMALS, field);

export const formatPln = (grosz: bigint): string => formatScaled(grosz, PLN_DECIMALS);
export const formatUsdc = (base: bigint): string => formatScaled(base, USDC_DECIMALS);

/**
 * Grosz -> rUSDC base units at `rateScaled` PLN per USDC.
 *
 * Floored, deliberately: the quotient is what we mint against a reserve credit,
 * so rounding up would mint a fraction of a unit the fiat never covered and
 * push `supply <= reserve` by one base unit per top-up.
 */
export function plnToUsdc(grosz: bigint, rateScaled: bigint): bigint {
  if (rateScaled <= 0n) throw new Error("DEMO_PLN_PER_USDC must be greater than zero");
  if (grosz < 0n) throw new Error("PLN amount cannot be negative");
  return (grosz * pow10(USDC_DECIMALS) * pow10(RATE_DECIMALS)) / (pow10(PLN_DECIMALS) * rateScaled);
}

/**
 * rUSDC base units -> grosz, rounded to nearest. Used only to show a payout in
 * PLN on the mocked off-ramp screen, never to decide what moves on chain.
 */
export function usdcToPln(base: bigint, rateScaled: bigint): bigint {
  if (rateScaled <= 0n) throw new Error("DEMO_PLN_PER_USDC must be greater than zero");
  if (base < 0n) throw new Error("USDC amount cannot be negative");
  const denominator = pow10(USDC_DECIMALS) * pow10(RATE_DECIMALS);
  return (base * rateScaled * pow10(PLN_DECIMALS) + denominator / 2n) / denominator;
}
