/**
 * Events-driven demand: "I am arriving for this, find me a home near it."
 *
 * Nothing here touches the chain or the program. A listing has no coordinates on chain, so the
 * demo's listings are placed by `app/public/listings-geo.json` and everything else is arithmetic
 * on top of that: parse the link from the marketing site, measure great-circle distances, sort.
 * See `docs/events.md`.
 *
 * The app uses exactly three of these:
 *   - `useNearby`, the filter's state (URL in, URL out);
 *   - `NearbyBanner` and `NearbyNote`, the explanation and the per-listing distance;
 *   - `EventsStrip`, the in-app shortcut.
 */
export { EventsStrip } from "./EventsStrip";
export { NearbyBanner, NearbyNote } from "./NearbyBanner";
export { useNearby } from "./useNearby";
export type { Nearby } from "./useNearby";
export { EVENTS, EVENTS_NOTE, EVENT_CITIES, dateLabel, toFilter, upcoming } from "./events";
export type { EventEntry } from "./events";
export { distanceLabel, formatKm, haversineKm, walkMinutes } from "./geo";
export type { Point } from "./geo";
export { geoIndex, locate, nearby, placeAll } from "./listings";
export type { GeoEntry, GeoIndex, ListingLike, NearbyResult, NearbyRow } from "./listings";
export { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, PARAM_KEYS, filterTitle, fold, parseNearParams, sameName } from "./params";
export type { NearFilter } from "./params";
