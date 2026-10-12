# Events-driven demand: "find me a home near this"

Workstream H. Someone arriving for the start of a semester or a four-night conference does not
know Kraków's districts; they know the address of the thing they are arriving for. This turns that
into a listing search, from the marketing site's events page (`docs/site.md`) and from a strip of
cards inside the app.

**No on-chain change.** The program, the IDL and the seeded listings are untouched. Everything here
is arithmetic over two files and a URL.

```
site /events  --?city=&near=&radius=&label=-->  app Apartments tab
                                                  │
in-app "Arriving for something?" strip ───────────┘
                                                  │
                           app/public/listings-geo.json  (where each listing is)
```

## Why a geo file exists

`Listing` on chain carries a title, a city, a blurb, a photo and the money; it has no latitude or
longitude, and adding one is a program change this workstream is not allowed to make. So positions
live in **`app/public/listings-geo.json`**, which the app fetches once per page load.

| Property | Decision |
|---|---|
| Location | `app/public/`, so it is served as a static asset and can be corrected **without a rebuild** |
| Key | `title` + `city`, folded (case- and diacritic-insensitive). `listingId` + `city` is a fallback |
| Precision | District-level centroids rounded to ~100 m. Real neighbourhoods, **not street addresses** — nobody's home is being published |
| Missing listing | Location-unknown: it still appears in the ordinary list, just with no distance, and it is held back (and counted) while a venue filter is on |
| A bad row | Skipped. A typo in the file must not take the Apartments tab down, so `geoIndex` validates every row and throws nothing |

Why not key on the listing's PDA address? Because it changes with the landlord and the deploy: the
same four listings get new addresses every time `scripts/setup-demo.ts` runs against a fresh chain.
`listing_id` is only unique per landlord, which is why it is the fallback and not the key.

The seeded four, plus whatever a landlord adds in a demo window:

| Listing | District | Approx. centroid |
|---|---|---|
| Sunlit 1-bedroom, Kazimierz | Kazimierz, Kraków | 50.0512, 19.9447 |
| Studio by the Planty | Planty / Old Town, Kraków | 50.0614, 19.9366 |
| Brick loft with a view, Praga | Praga-Północ, Warsaw | 52.2560, 21.0330 |
| Garden flat, Zabłocie | Zabłocie, Kraków | 50.0472, 19.9611 |

To add one: append an entry with the listing's exact title and city. Nothing else needs changing.

## The link from the site

The contract is `docs/site.md`'s table; this is what the app does with it. Parameters are read from
**both** places a hash-routed app can carry them — before the hash (`/?city=…#/app`, which is what
the site emits) and inside it (`#/app?city=…`, which is what the app itself writes). The hash wins.

| Param | Accepted | Rejected or clamped to |
|---|---|---|
| `city` | letters, digits, marks, `.'’-`, ≤ 64 chars, markup runs removed whole | anything with no letter in it → ignored |
| `near` | `"lat,lng"`, plain decimals, lat ∈ [−90, 90], lng ∈ [−180, 180] | `""`, `",19.9"`, `"50"`, `"50,19,3"`, `"NaN,19"`, `"1e2,0"`, out of range → no anchor |
| `radius` | km, plain decimal | ≤ 0 or junk → **3 km**; clamped to [0.25, 50] |
| `label` | letters, digits, marks, ` .,'’&()/:+–—-`, ≤ 60 chars | markup, control characters, punctuation-only → no label |

Three rules worth stating, because each one is a test:

1. **No coercion.** `Number("")` is `0`, so `near=,19.9` would otherwise become a point on the
   equator. Every number is shape-checked before it is parsed, and only plain decimals pass —
   `radius=1e9` is junk, not 50 km, and falls back to the 3 km default.
2. **Diacritics fold both ways.** `Krakow`, `KRAKÓW` and `kraków ` all match the listing's
   `Kraków`. `ł` has no NFD decomposition, so there is a small table for stroked letters: without
   it `Zablocie` would never match `Zabłocie`.
3. **`label` is a name, not markup.** It is reduced to a short run of printable characters and
   rendered as text. Tag-shaped runs are removed whole, because stripping `<` and `>` character by
   character turns `<b>Warsaw</b>` into `bWarsawb` — worse than either the original or nothing.

With no usable parameter and nothing picked in the strip, `useNearby().filter` is `null` and the
Apartments tab behaves exactly as it did before this workstream.

## What the filter does

Given an anchor, the list is reduced to the listings in the city (when one was given) within
`radiusKm` of the anchor, **nearest first**, and each card gains a line:

> 13 min walk · 1.0 km from AGH University of Krakow · Planty / Old Town

- Distance is great-circle (haversine, mean Earth radius). At city scale the error is far below the
  precision of a district centroid.
- Walking time is 5 km/h, i.e. 12 min/km, floored at 1 minute. Above 5 km the walk clause is
  dropped and only the distance is shown — "92 min walk" is not useful advice.
- A listing with no position cannot be shown to be near anything, so it is held back and counted
  separately in the banner. It is not silently deleted.

A banner says what is going on and offers the way out:

> **Showing homes near AGH University of Krakow**
> 2 homes within 3 km · 3 other apartments hidden, 1 for want of a location on file
> [Show all] [×]

**Show all** drops the filter and restores every listing; **×** hides the banner only, and the strip
keeps its own "Show all apartments" link, so the escape is never more than one click away.

The chosen venue is written back into the address bar (`history.replaceState`, only the four
parameters above — `role` and `tab` are left alone), so a reload, or a link pasted to someone
mid-demo, reproduces the same filtered list. The URL the visitor arrived on is never rewritten.

The filter is off in the landlord's **My listings** tab (`useNearby(false)`): that tab shares the
`Listings` component, and a stray `?city=` in the address bar must not quietly hide half of a
landlord's own properties.

## The in-app strip

`app/src/events/events.json` is a **byte-for-byte copy** of `site/src/data/events.json`. The site is
a separate package with its own build and no dependency on the app, so the file is duplicated by
design, exactly as the brand files are (`docs/site.md`). Keep them in sync:

```bash
cp site/src/data/events.json app/src/events/events.json
```

It is **sample data**: the institutions and venues are real places and the coordinates are
approximate, but the occasions and the dates are invented for the demo, and nothing listed is a
partner of Relstate. The strip says so in two places — a `sample` tag on every card and a line
under the row — and the full `_note` is the tooltip on that line. Replace the file wholesale before
any of this is shown as anything other than a demo.

Clicking a card applies the filter through `toFilter()`, which runs the same sanitisers as the URL
path, so the in-app shortcut and the link from the site cannot drift apart. Clicking the active card
again clears the filter. `upcoming()` shows the next six occasions and falls back to the whole list
once every sample date is in the past — a stale strip is better than an empty one that looks broken.

## Files

| File | What it is |
|---|---|
| `app/public/listings-geo.json` | Where the listings are. Editable without a rebuild |
| `app/src/events/geo.ts` | Haversine, walking minutes, distance formatting |
| `app/src/events/params.ts` | The URL contract, parsed defensively; diacritic folding |
| `app/src/events/listings.ts` | The geo index, listing lookup, filter and sort |
| `app/src/events/events.ts` | The sample events, typed; `toFilter`, `upcoming`, `dateLabel` |
| `app/src/events/useNearby.ts` | The one piece of state: URL in, URL out |
| `app/src/events/EventsStrip.tsx` | The "Arriving for something?" row |
| `app/src/events/NearbyBanner.tsx` | The banner and the per-listing distance line |
| `app/src/events/preview.tsx`, `app/events-preview.html` | Developer page: the real browse view, no chain |

Everything above `useNearby` is pure and has no DOM access, which is why the hostile inputs are
unit tests rather than browser experiments: `app/src/events/__tests__/` (114 cases), run with

```bash
npm run app:test
```

Two edits outside the module, both in `app/src/views.tsx` → `Listings`: the `useNearby` call with
the rows it returns in place of the raw listing array, and the strip, banner and `NearbyNote` in the
browse branch. `App.tsx` needed nothing — the site's parameters live in `location.search`, which the
hash router never touches.

## Looking at it without a chain

```bash
npm run app            # http://localhost:5177/events-preview.html
```

The preview renders the real `Listings` browse view against five invented listings — four placed,
one deliberately absent from the geo file — with no validator, wallet or funded account. Add the
site's hand-off to arrive pre-filtered:

```
/events-preview.html?city=Krak%C3%B3w&near=50.0647,19.9229&radius=3&label=AGH+University+of+Krakow
```

It is not an entry in `vite.config.ts`, so it never ships in the app bundle.

Screenshots (desktop 1440 and phone 390): `docs/screenshots/events/`.

## Deliberately not done

- **No geocoding and no map.** A district centroid per listing is enough to sort by walking distance
  and keeps the demo offline; a map tile provider would be a new dependency and a new API key.
- **No coordinates on chain.** That is a program change, and the honest version of it (a geohash on
  `Listing`, validated) belongs with whoever next opens `programs/relstate`.
- **No travel time by transport.** "N min walk" is straight-line distance at a walking pace, not a
  routed journey. It is labelled as a walk, and the distance it is derived from is shown next to it.
