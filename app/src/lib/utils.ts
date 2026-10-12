import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export const usdc = (baseUnits: number) =>
  (baseUnits / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function duration(secs: number) {
  const s = Math.max(0, Math.round(secs));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** A web address, a path served by the app, or just a file name from app/public/listings (".jpg" optional). */
export const photoUrl = (p: string) => {
  const s = p.trim();
  if (!s || /^(https?:)?\/\//.test(s)) return s;
  if (s.startsWith("/")) return import.meta.env.BASE_URL + s.slice(1); // works under a subpath like GitHub Pages
  return `${import.meta.env.BASE_URL}listings/${/\.[a-z0-9]{2,5}$/i.test(s) ? s : `${s}.jpg`}`;
};

/**
 * A base58 transaction signature, and nothing else.
 *
 * Checked before a signature becomes an `href`: signatures reach the app from a backend response,
 * and a value that is not one has no business being interpolated into a URL. Base58 excludes
 * `0OIl`, so a signature cannot contain a slash, a quote or a colon even before the length check.
 */
export const isSignature = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(s);

/** The invisible characters that let a display string lie about its own direction or contents. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * An untrusted string made safe to show next to money.
 *
 * Appraiser names come from an off-chain directory, so they are input, not content: bidi overrides
 * (U+202E and friends) can make `Rzeczoznawca A` render as something else entirely next to an
 * amount, and an unbounded name can push the amount off a card. Strips every control and format
 * character, collapses whitespace and truncates.
 *
 * Note for callers that verify a name against the chain's `name_hash`: hash the RAW string. The
 * commitment is to what was registered, so sanitising first would fail a legitimate name.
 */
export function safeName(raw: string, max = 48): string {
  const clean = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** `JSON.stringify` that survives the bigints kit puts in transaction errors (instruction error codes). */
export const jsonSafe = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
