/**
 * Every link that leaves the marketing site for the app, in one place.
 *
 * The app is a separate deployment, so its address is configuration: set `SITE_APP_URL` at build
 * time (see `site/.env.example`). The default is the local dev app.
 *
 * The query parameters below are a contract with the app's listing search -- it reads them from
 * `location.search`, exactly as it already reads `?role=`. Documented in `docs/site.md`.
 */
const APP_URL = (import.meta.env.SITE_APP_URL || "http://localhost:5173").replace(/\/+$/, "");

export type AppParams = {
  /** Which side of a lease the visitor arrived as. The app already reads this one. */
  role?: "tenant" | "landlord";
  /** City name as it appears on a listing, e.g. "Kraków". */
  city?: string;
  /** Anchor point as "lat,lng" in decimal degrees (WGS84), e.g. "50.0647,19.9229". */
  near?: string;
  /** Search radius around `near`, in kilometres. */
  radius?: number;
  /** Human-readable name of the anchor, so the app can say what "nearby" means. */
  label?: string;
};

/** A link into the app. Unknown parameters are harmless: the app ignores what it does not read. */
export function appHref(params: AppParams = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${APP_URL}/?${s}` : `${APP_URL}/`;
}

/** Links between the site's own pages, base-path aware so a subpath deploy still works. */
const base = import.meta.env.BASE_URL;
export const HOME = base;
export const EVENTS = `${base}events/`;
