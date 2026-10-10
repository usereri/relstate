/**
 * The site -> app hand-off, parsed defensively. Pure, no DOM access (the caller passes the
 * strings in), so every hostile input below is a unit test rather than a browser experiment.
 *
 * The contract is documented in `docs/site.md`: `?role=&city=&near=lat,lng&radius=km&label=`.
 * `role` is not ours -- `App.tsx` has always read it. Nothing here is trusted: the link can be
 * typed, shared, truncated or hand-edited, so every value is parsed, bounded, and in `label`'s
 * case reduced to a short run of printable characters that is only ever rendered as text.
 */

/** URL keys this module owns. `role` is deliberately absent: it belongs to `App.tsx`. */
export const PARAM_KEYS = ["city", "near", "radius", "label"] as const;

export interface Point {
  lat: number;
  lng: number;
}

/** A resolved "show me homes near here". At least one of `city` / `point` is always set. */
export interface NearFilter {
  /** City as written on the listing, e.g. "Kraków". Matched diacritic-insensitively. */
  city?: string;
  /** The venue. Absent when the link carried only a city. */
  point?: Point;
  /** Always set, so callers never have to re-apply the default. */
  radiusKm: number;
  /** What to call the anchor in the UI. Sanitised; may be absent. */
  label?: string;
}

export const DEFAULT_RADIUS_KM = 3;
export const MIN_RADIUS_KM = 0.25;
export const MAX_RADIUS_KM = 50;
export const MAX_LABEL_CHARS = 60;
export const MAX_CITY_CHARS = 64;

/**
 * `ł`, `ø` and friends have no NFD decomposition, so folding combining marks alone would leave
 * "Zabłocie" unmatched by "Zablocie". Only letters that actually turn up in the demo's data and
 * its neighbours are listed; this is a convenience, not a transliteration library.
 */
const STROKES: Record<string, string> = { ł: "l", đ: "d", ø: "o", ħ: "h", ŧ: "t", ı: "i", ß: "ss", æ: "ae", œ: "oe" };

/**
 * A comparison key: lower-cased, combining marks removed, stroked letters flattened, whitespace
 * collapsed. "Kraków", "KRAKOW" and "krakow " all fold to "krakow".
 */
export function fold(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[Ā-ɏÀ-ÿ]/g, (c) => STROKES[c] ?? c)
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two place names are the same name written differently. Empty never matches. */
export const sameName = (a: string | undefined, b: string | undefined) => {
  const x = fold(a ?? "");
  return x.length > 0 && x === fold(b ?? "");
};

/**
 * A number from a URL, with no coercion games: `Number("")` is 0 and `Number(" 1 ")` is 1, both of
 * which would let a malformed link through, so the shape is checked first.
 *
 * Plain decimals only. Exponent notation (`1e9`), hex and `Infinity` are not a spelling the site
 * emits, so they count as junk -- `radius=1e9` falls back to the 3 km default rather than widening
 * the search to the clamp.
 */
function strictNumber(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** `"50.0647,19.9229"` -> a point, or null for anything else (NaN, out of range, extra fields). */
export function parseLatLng(raw: string | null | undefined): Point | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const lat = strictNumber(parts[0]);
  const lng = strictNumber(parts[1]);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Kilometres, clamped to something a walk-from-a-venue filter can mean. Junk -> the default. */
export function parseRadiusKm(raw: string | null | undefined): number {
  const n = raw == null ? null : strictNumber(raw);
  if (n === null || n <= 0) return DEFAULT_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, n));
}

/**
 * The shared reduction: strip markup, drop anything not in `keep`, collapse, trim, truncate.
 *
 * Tag- and entity-shaped runs go whole, before the character filter: dropping `<` and `>` one
 * character at a time would turn `<b>Warsaw</b>` into "bWarsawb", which is worse than either the
 * original or nothing.
 */
function clean(raw: string, keep: RegExp, max: number): string {
  return raw
    .normalize("NFC")
    .replace(/\p{C}/gu, " ") // control, format and unassigned code points, newlines included
    .replace(/<[^>]*>?/g, " ")
    .replace(/&#?[a-z0-9]{1,8};/gi, " ")
    .replace(keep, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * A venue name reduced to something safe to show. Keeps letters (with their diacritics), digits
 * and the punctuation real venue names use; drops everything else, markup and control characters
 * included. The result is rendered as text -- this is a second line of defence and a way to keep
 * a 4 kB "label" out of a heading, not the only one.
 */
export function safeLabel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = clean(raw, /[^\p{L}\p{N}\p{M} .,'’&()/:+–—-]/gu, MAX_LABEL_CHARS);
  // a label made only of punctuation is noise, not a name
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : undefined;
}

/** Same treatment for the city, which is additionally matched against listing data. */
export function safeCity(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = clean(raw, /[^\p{L}\p{N}\p{M} .'’-]/gu, MAX_CITY_CHARS);
  return /[\p{L}]/u.test(cleaned) ? cleaned : undefined;
}

/**
 * The query string of a URL that may carry it in either place: the app uses hash routes, so the
 * site puts its parameters before the hash (`/?city=…#/app`) while an in-app link puts them
 * inside it (`#/app?city=…`). Both are read; the hash wins, because it is the one the app itself
 * rewrites as the user moves around.
 */
export function readParams(location: { search?: string; hash?: string }): URLSearchParams {
  const merged = new URLSearchParams();
  const take = (query: string) => {
    for (const [k, v] of new URLSearchParams(query)) merged.set(k, v);
  };
  try {
    take(location.search ?? "");
    const hash = location.hash ?? "";
    const q = hash.indexOf("?");
    if (q >= 0) take(hash.slice(q + 1));
  } catch {
    /* a malformed query string is simply no filter */
  }
  return merged;
}

/**
 * The whole hand-off in one call. Returns null when the link says nothing about location, which
 * is the ordinary case: the app then behaves exactly as it did before this workstream.
 */
export function parseNearParams(location: { search?: string; hash?: string }): NearFilter | null {
  const p = readParams(location);
  const city = safeCity(p.get("city"));
  const point = parseLatLng(p.get("near"));
  if (!city && !point) return null;
  const filter: NearFilter = { radiusKm: parseRadiusKm(p.get("radius")) };
  if (city) filter.city = city;
  if (point) filter.point = point;
  const label = safeLabel(p.get("label"));
  if (label) filter.label = label;
  return filter;
}

/** What the banner calls the filter when the link gave no label. */
export const filterTitle = (f: NearFilter) => f.label ?? f.city ?? "your pin";
