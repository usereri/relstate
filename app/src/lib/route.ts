// Where you are in the app, as a URL.
//
// A hash router, so the whole app is one static file with no server rewrites: the route is
// `#/app`, and the screen state inside a route is the hash's own query, `#/app?tab=wallet`.
//
// `location.search` is deliberately left alone. It carries the page's own parameters — the demo-only `?role=` override (lib/role.ts),
// and the "near an event" filter (events/useNearby.ts) — so the two never collide: selecting a tab
// keeps `?role=landlord` exactly where it was, and vice versa.
//
// Free of React (the `useRoute` hook lives in components/Brand.tsx) and of the DOM wherever the
// hash can be passed in, so both halves can be tested without a document.

/**
 * The routes. `appraiser` is the operator verdict console. It is reachable only by typing the URL
 * and is deliberately linked from nowhere in either role's app (`screens/Verdict.tsx`); the screen
 * itself only exists in a build with `VITE_APPRAISER_CONSOLE` set (`App.tsx`).
 */
export type Route = "home" | "signup" | "signin" | "app" | "appraiser";

export const parseRoute = (hash: string): Route => {
  const h = hash.replace(/^#\/?/, "").split(/[?#]/)[0];
  return h === "signup" || h === "signin" || h === "app" || h === "appraiser" ? h : "home";
};

/** Goes to a route, dropping whatever query the old one carried. */
export const go = (r: Route) => {
  location.hash = r === "home" ? "/" : `/${r}`;
};

/** `#/app?tab=wallet&topup=done` → the `tab=wallet&topup=done` half. */
export function hashQuery(hash: string): URLSearchParams {
  const q = hash.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));
}

/** The hash that applying `change` to that query produces, route kept, `?` dropped when empty. */
export function withHashQuery(hash: string, change: (q: URLSearchParams) => void): string {
  const q = hash.indexOf("?");
  const base = (q === -1 ? hash : hash.slice(0, q)) || "#/";
  const params = hashQuery(hash);
  change(params);
  const query = params.toString();
  return `${base}${query ? `?${query}` : ""}`;
}

/**
 * Rewrites the hash's query in the address bar.
 *
 * A plain write pushes a history entry, so the tab a click selected is somewhere back and forward
 * can reach. `replace` edits the current entry instead, for a change the user never asked for —
 * naming the tab that is already on screen, or dropping a return query that must not be replayed
 * on reload.
 *
 * `history.replaceState` does not fire `hashchange` by itself, so it is dispatched here: every
 * listener then hears about the change the same way, whichever path wrote it.
 */
export function updateHash(change: (q: URLSearchParams) => void, { replace = false } = {}): void {
  const current = globalThis.location?.hash ?? "";
  const next = withHashQuery(current, change);
  if (next === current) return;
  try {
    if (!replace) {
      location.hash = next;
      return;
    }
    history.replaceState(history.state, "", `${location.pathname}${location.search}${next}`);
    dispatchEvent(new Event("hashchange"));
  } catch {
    // No history API, or no document at all: the hash itself is still the source of truth.
    if (globalThis.location) location.hash = next;
  }
}
