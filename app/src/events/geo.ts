/**
 * Distance arithmetic for the "near an event" filter. Pure, no DOM, no network.
 *
 * Everything here works on plain `{ lat, lng }` degrees (WGS84) and kilometres. The app never
 * puts coordinates on chain -- a listing's position comes from `app/public/listings-geo.json`
 * (see `./listings.ts`), so this module is the only place that knows any geometry.
 */

export interface Point {
  lat: number;
  lng: number;
}

/** Mean Earth radius, km. Good to ~0.3% at city scale, which is far below the precision of a
 *  district centroid. */
const R_KM = 6371.0088;

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in kilometres. Returns `NaN` for a non-finite input rather than a
 * plausible-looking number, so a caller that forgets to validate gets an obvious result.
 */
export function haversineKm(a: Point, b: Point): number {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every((n) => typeof n === "number" && Number.isFinite(n))) return NaN;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  // clamp: floating point can push h a hair above 1 for antipodal points, and asin would be NaN
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Walking pace used for the "N min walk" hint: 5 km/h, i.e. 12 minutes per kilometre. */
export const WALK_MIN_PER_KM = 12;

/** Beyond this, "walk" stops being the honest word and only the distance is shown. */
export const WALKABLE_KM = 5;

/** Whole minutes on foot, never less than 1 (0 min reads like a bug). */
export function walkMinutes(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 1;
  return Math.max(1, Math.round(km * WALK_MIN_PER_KM));
}

/** "0.4 km", "1.2 km", "12 km" -- one decimal while it matters, none once it does not. */
export function formatKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "";
  // round first, then choose the branch: 9.96 is "10 km", never "10.0 km"
  const one = Math.round(km * 10) / 10;
  return one < 10 ? `${one.toFixed(1)} km` : `${Math.round(one)} km`;
}

/**
 * The line shown under a listing: "14 min walk · 1.2 km from AGH University of Krakow".
 * `label` is already sanitised by `safeLabel` (see `./params.ts`) and is rendered as text.
 */
export function distanceLabel(km: number, label?: string): string {
  const dist = formatKm(km);
  if (!dist) return "";
  const from = label ? ` from ${label}` : "";
  return km <= WALKABLE_KM ? `${walkMinutes(km)} min walk · ${dist}${from}` : `${dist}${from}`;
}
