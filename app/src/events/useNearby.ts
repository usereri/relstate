/**
 * The one piece of state behind "book nearby": which venue, if any, the Apartments list is
 * currently centred on.
 *
 * It starts from the URL (the hand-off from the marketing site, `docs/site.md`), can be changed by
 * the in-app events strip, and writes itself back into the URL so a reload -- or a link pasted to
 * a colleague mid-demo -- lands on the same filtered list. Positions come from
 * `app/public/listings-geo.json`, fetched once per page load: a public file, so the demo's
 * coordinates can be corrected without a rebuild.
 *
 * With no parameters and no selection, `filter` is null and `apply()` returns every listing
 * unchanged, which is exactly how the Apartments tab behaved before this workstream.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PARAM_KEYS, parseNearParams } from "./params";
import type { NearFilter } from "./params";
import { geoIndex, nearby, placeAll } from "./listings";
import type { GeoIndex, ListingLike, NearbyResult } from "./listings";

const GEO_FILE = "listings-geo.json";

const EMPTY: GeoIndex = new Map();

/** One fetch per page load, shared by every mount. A missing or broken file is simply no geo. */
let pending: Promise<GeoIndex> | null = null;
function loadGeo(): Promise<GeoIndex> {
  if (!pending)
    pending = fetch(`${import.meta.env.BASE_URL}${GEO_FILE}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => geoIndex(json))
      .catch(() => EMPTY);
  return pending;
}

/** Puts the current filter in the address bar, or takes it out. Never touches `role` or `tab`. */
function syncUrl(filter: NearFilter | null) {
  try {
    const url = new URL(location.href);
    for (const k of PARAM_KEYS) url.searchParams.delete(k);
    // the app uses hash routes, so the parameters can also be inside the hash: clear both
    const q = url.hash.indexOf("?");
    if (q >= 0) {
      const inHash = new URLSearchParams(url.hash.slice(q + 1));
      for (const k of PARAM_KEYS) inHash.delete(k);
      const rest = inHash.toString();
      url.hash = url.hash.slice(0, q) + (rest ? `?${rest}` : "");
    }
    if (filter) {
      if (filter.city) url.searchParams.set("city", filter.city);
      if (filter.point) url.searchParams.set("near", `${filter.point.lat},${filter.point.lng}`);
      url.searchParams.set("radius", String(filter.radiusKm));
      if (filter.label) url.searchParams.set("label", filter.label);
    }
    history.replaceState(history.state, "", url.toString());
  } catch {
    /* no history API (or a URL the browser will not parse): the filter still works in memory */
  }
}

export interface Nearby {
  /** The active filter, or null for the unfiltered list. */
  filter: NearFilter | null;
  /** Whether the geo file has been loaded (or failed). Before that, distances are unknown. */
  ready: boolean;
  /** True once the user has hidden the banner for this filter. */
  dismissed: boolean;
  /** Filter and sort a set of listings. Identity-preserving when there is no filter. */
  apply: <T extends ListingLike>(listings: T[]) => NearbyResult<T>;
  /** Pick a venue (the events strip), or pass null to show everything. */
  select: (filter: NearFilter | null) => void;
  /** The escape hatch: back to every listing. */
  clear: () => void;
  /** Hide the banner but keep the filter; the strip still offers "Show all". */
  dismiss: () => void;
}

/**
 * @param enabled pass false where the filter must not apply -- the landlord's own "My listings"
 * tab shares the `Listings` component, and a `?city=` in the address bar should not quietly hide
 * half of a landlord's properties.
 */
export function useNearby(enabled = true): Nearby {
  // read once: later changes come from `select`, which rewrites the URL itself
  const [chosen, setFilter] = useState<NearFilter | null>(() => {
    try {
      return parseNearParams(location);
    } catch {
      return null;
    }
  });
  const filter = enabled ? chosen : null;
  const [index, setIndex] = useState<GeoIndex>(EMPTY);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    loadGeo().then((i) => {
      if (!live) return;
      setIndex(i);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // the URL is only rewritten for choices made in the app; the link the user arrived on is left
  // exactly as it was, so a reload reproduces it verbatim
  const select = useCallback((next: NearFilter | null) => {
    setFilter(next);
    setDismissed(false);
    syncUrl(next);
  }, []);
  const clear = useCallback(() => select(null), [select]);
  const dismiss = useCallback(() => setDismissed(true), []);

  const apply = useMemo(() => {
    return <T extends ListingLike>(listings: T[]): NearbyResult<T> =>
      filter ? nearby(listings, index, filter) : { rows: placeAll(listings, index), hidden: 0, unplaced: 0 };
  }, [filter, index]);

  return { filter, ready, dismissed, apply, select, clear, dismiss };
}
