import { duration } from "./utils";

// The lease term the landlord chooses in propose_lease, counted in rent periods.
//
// The program only requires `term_periods > 0` (u16) and `term_periods * period_secs <=
// MAX_LEASE_SECS` (5 years in a release build, 100 in the demo build; not in the IDL, so it is not
// mirrored here). 60 periods is the app's own ceiling: with the longest period the app ever sends
// (30 days) it is 1800 days, under both builds' bound, so the program cannot refuse a term this
// form accepted for being too long.
export const MIN_TERM_PERIODS = 1;
export const MAX_TERM_PERIODS = 60;
export const DEFAULT_TERM_PERIODS = 3;

const MONTH_SECS = 30 * 86_400;

export type TermInput = { ok: true; value: number } | { ok: false; error: string };

/** A term typed into the form: a whole number of periods inside the app's limits. */
export function parseTerm(raw: string): TermInput {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return { ok: false, error: "Enter a whole number of periods." };
  const value = Number(s);
  if (value < MIN_TERM_PERIODS) return { ok: false, error: `The term is at least ${MIN_TERM_PERIODS} period.` };
  if (value > MAX_TERM_PERIODS) return { ok: false, error: `The term is at most ${MAX_TERM_PERIODS} periods.` };
  return { ok: true, value };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What one rent period is, in the words the screen uses: "month" when it is 30 days, else its length. */
export const periodWord = (periodSecs: number) => (periodSecs === MONTH_SECS ? "month" : `period of ${duration(periodSecs)}`);

/**
 * The term in clear words: "3 months" when a period is 30 days (a local run), otherwise
 * "3 periods of 45s" (the compressed devnet period), because that is what is true of the lease.
 */
export function termLabel(term: number, periodSecs: number): string {
  return periodSecs === MONTH_SECS
    ? plural(term, "month", "months")
    : `${plural(term, "period", "periods")} of ${duration(periodSecs)}`;
}
