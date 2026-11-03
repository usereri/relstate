/**
 * Where a listing is, and which listings are near a venue. Pure: the caller supplies both the
 * listings and the parsed geo file.
 *
 * **Listings have no coordinates on chain.** `Listing` carries a title, a city, a blurb and a
 * photo and nothing else, and adding a field would be a program change this workstream is not
 * allowed to make. So positions live in `app/public/listings-geo.json`, a file the app fetches at
 * runtime, keyed by what a listing *does* carry. A listing missing from that file is
 * location-unknown: it still appears in the ordinary list, just without a distance.
 */
import { haversineKm } from "./geo";
import { fold, sameName } from "./params";
import type { NearFilter, Point } from "./params";

/** One row of `app/public/listings-geo.json`. */
export interface GeoEntry {
  /** The on-chain `listing_id`, as a string. Per-landlord, so only a fallback key. */
  listingId?: string;
  title: string;
  city: string;
  /** Neighbourhood, for the UI. Not used for matching. */
  area?: string;
  lat: number;
  lng: number;
}

export interface Located {
  point: Point;
  area?: string;
}

/** Folded key -> position. Built once per geo-file load. */
export type GeoIndex = Map<string, Located>;

/** The little a listing has to carry to be placed. `ListingView` satisfies it. */
export interface ListingLike {
  id: string;
  title: string;
  city: string;
}

const titleKey = (title: string, city: string) => `t:${fold(title)}|${fold(city)}`;
const idKey = (id: string, city: string) => `i:${fold(id)}|${fold(city)}`;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Builds the lookup from the parsed JSON. Hand-maintained data, so every row is checked and a bad
 * one is skipped rather than throwing: a typo in the file must not take the Apartments tab down.
 */
export function geoIndex(raw: unknown): GeoIndex {
  const index: GeoIndex = new Map();
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return index;
  for (const row of items) {
    const e = row as Partial<GeoEntry>;
    const lat = num(e?.lat);
    const lng = num(e?.lng);
    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    if (typeof e.city !== "string" || !e.city.trim()) continue;
    const located: Located = { point: { lat, lng }, ...(typeof e.area === "string" && e.area.trim() ? { area: e.area.trim() } : {}) };
    if (typeof e.title === "string" && e.title.trim()) index.set(titleKey(e.title, e.city), located);
    if (e.listingId != null && String(e.listingId).trim()) index.set(idKey(String(e.listingId), e.city), located);
  }
  return index;
}

/** The listing's position, or null when the file does not mention it. Title first, then id. */
export function locate(l: ListingLike, index: GeoIndex): Located | null {
  return index.get(titleKey(l.title, l.city)) ?? index.get(idKey(l.id, l.city)) ?? null;
}

export interface NearbyRow<T> {
  listing: T;
  /** Kilometres from the filter's anchor, or null when either side has no position. */
  km: number | null;
  /** Neighbourhood from the geo file, when it has one. */
  area?: string;
}

export interface NearbyResult<T> {
  rows: NearbyRow<T>[];
  /** How many listings the filter removed, so the UI can offer them back. */
  hidden: number;
  /** Of those, how many were removed only because nobody knows where they are. */
  unplaced: number;
}

/** Every listing, in the order given, annotated with whatever the geo file knows. No filtering. */
export function placeAll<T extends ListingLike>(listings: T[], index: GeoIndex): NearbyRow<T>[] {
  return listings.map((listing) => {
    const at = locate(listing, index);
    return { listing, km: null, ...(at?.area ? { area: at.area } : {}) };
  });
}

/**
 * Apply a filter: keep the city's listings, then those within `radiusKm` of the venue, nearest
 * first. A listing with no position cannot be shown to be near anything, so it is held back and
 * counted in `unplaced` -- the UI says so, and "Show all" brings it back.
 */
export function nearby<T extends ListingLike>(listings: T[], index: GeoIndex, filter: NearFilter): NearbyResult<T> {
  const inCity = filter.city ? listings.filter((l) => sameName(l.city, filter.city)) : listings.slice();

  if (!filter.point) {
    const rows = inCity.map((listing) => {
      const at = locate(listing, index);
      return { listing, km: null, ...(at?.area ? { area: at.area } : {}) };
    });
    return { rows, hidden: listings.length - rows.length, unplaced: 0 };
  }

  const anchor = filter.point;
  let unplaced = 0;
  const rows: NearbyRow<T>[] = [];
  for (const listing of inCity) {
    const at = locate(listing, index);
    if (!at) {
      unplaced++;
      continue;
    }
    const km = haversineKm(anchor, at.point);
    if (!Number.isFinite(km) || km > filter.radiusKm) continue;
    rows.push({ listing, km, ...(at.area ? { area: at.area } : {}) });
  }
  rows.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
  return { rows, hidden: listings.length - rows.length, unplaced };
}
