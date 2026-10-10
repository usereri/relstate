# Public site (`site/`)

The marketing site: a landing page in demo-day pitch order and an `/events` page that turns "I am
arriving for a semester" into a listing search. Standalone from `app/` — its own `package.json`,
its own build, no Solana dependency, no wasm.

```bash
cd site
npm install
npm run dev        # http://localhost:5173 is the app, so Vite picks another port here
npm run build      # tsc --noEmit && vite build  ->  site/dist
npm run preview
```

## Configuration

One variable, read at **build time** (so a change needs a rebuild). Copy `site/.env.example` to
`site/.env.local`:

| Variable | Default | What it does |
|---|---|---|
| `SITE_APP_URL` | `http://localhost:5173` | Where "Find a home", "Open the app as a …" and every "Book nearby" button point. |

`vite.config.ts` sets `envPrefix: ["VITE_", "SITE_"]`, which is why the variable does not need a
`VITE_` prefix. Every link that leaves the site is built in `site/src/lib/links.ts`; nothing else
hard-codes the app's address.

## Links into the app

`appHref()` builds `${SITE_APP_URL}/?<params>`. The parameters are a **contract with the app's
listing search** — the app reads them from `location.search`, exactly as it already reads `?role=`.
Params sit before the hash, so they survive the app's hash router.

| Param | Type | Example | Meaning |
|---|---|---|---|
| `role` | `tenant` \| `landlord` | `tenant` | Which side the visitor arrived as. **The app already reads this.** |
| `city` | string | `Krak%C3%B3w` | Matches `Listing.city` **exactly**. Seeded listings use `Kraków` and `Warsaw` (`scripts/setup-demo.ts`). |
| `near` | `"lat,lng"` | `50.0647,19.9229` | Anchor point, decimal degrees, WGS84. The venue the visitor is arriving for. |
| `radius` | number (km) | `3` | How far from `near` still counts as nearby. |
| `label` | string | `AGH%20University%20of%20Krakow` | Human-readable name of the anchor, so the app can say *what* "nearby" means. |

A full example, from the AGH card:

```
http://localhost:5173/?role=tenant&city=Krak%C3%B3w&near=50.0647%2C19.9229&radius=3&label=AGH+University+of+Krakow
```

### Notes for whoever implements the filter (workstream H)

- **The shape above is agreed and implemented.** The app reads all five parameters; `docs/events.md`
  is the other half of this contract and says what it does with each one. Changing the shape means
  changing `AppParams` in `site/src/lib/links.ts`, this table and `app/src/events/params.ts`
  together.
- The app reads them from **both** `location.search` (what this site emits) and the hash query
  (`#/app?city=…`, which the app writes back as the user picks a venue in its own events strip).
- Listings still have no `lat`/`lng` on chain: the app places them itself from
  `app/public/listings-geo.json`, keyed by title and city. A listing missing from that file shows
  without a distance. Nothing on the site depends on this.
- Every value is treated as hostile on the far side — numbers shape-checked, the radius clamped to
  0.25–50 km (default 3), the label reduced to a short run of printable text. A link that fails
  validation degrades to a narrower filter or none, never an error.
- Unknown parameters must stay harmless: the site may emit a param the app does not read yet.

Screenshots (light/dark, desktop 1440 and phone 390): `docs/screenshots/site/`.

## Pages and structure

```
site/
  index.html              home        -> src/main.tsx
  events/index.html       /events/    -> src/events-main.tsx
  src/
    index.css             brand tokens (light + dark), copied from app/src/index.css
    lib/links.ts          every link that leaves the site
    components/           Nav, Footer, Brand, Theme, SkipLink, ui helpers
    sections/             the landing page, one file per section
    data/events.json      sample events and universities
    data/events.ts        the typed view of that JSON
```

The landing page runs in the demo-day pitch order:

| Section | Pitch beat |
|---|---|
| Hero | The nomad story: a new city, no local bank account, no local rental history. |
| How it works | Invisible blockchain: email sign-up, identity check, sign, pay by card. Ends with "things you never have to do". |
| For tenants / for landlords | The same story from each side. |
| Trust & compliance | KYC by a vendor, no personal data on chain — and the limits, stated plainly. |
| Privacy | `docs/privacy.md`, in the same words. |
| FAQ | The questions the pitch raises, answered without crypto vocabulary. |

## Relationship to the app's own landing page

`app/src/Landing.tsx` is a **different page with a different job** and the two must not be merged:

- the app's landing is the sign-up funnel, and pitches the reputation record and the 50% deposit
  discount to someone who has already arrived at the product;
- this site pitches *getting into a city you have no record in*, plus the compliance and privacy
  story, and hands off to the app for anything transactional.

They share the brand (`app/src/components/Brand.tsx`, the tokens in `app/src/index.css`) but not
code: the site is a separate package, so `Brand.tsx` and the button classes are **duplicated by
design** rather than imported across the boundary. If the brand changes in the app, mirror it in
`site/src/index.css`, `site/src/components/Brand.tsx` and `site/src/components/ui.tsx`.

> **Known inconsistency.** The app's landing FAQ currently says "You need a Solana wallet such as
> Phantom or Solflare", and its sign-up is wallet-first. This site says the opposite — email
> sign-up, no wallet — because that is the demo-day pitch and what workstream B is building. The
> two have to agree before the demo; the site is written for the target state.

## Sample data on `/events`

`site/src/data/events.json` is **invented**. The institutions and venues are real places and the
coordinates are approximate, but the occasions and the dates are placeholders. That is stated three
times on purpose: a banner at the top of the page, a `sample` tag on every card, and the `_note`
field printed in full at the bottom of the page. No organisation listed is a partner of Relstate.

Replace the file wholesale before the page is shown as anything other than a demo. The shape is in
`EventEntry` (`site/src/data/events.ts`); `city` is the field that must match listing data exactly.

## Claims policy

The site makes no claim that Relstate is regulated, licensed or audited, uses no invented partner
logos and no testimonials. Three things have to stay true of any edit:

1. **The devnet disclaimer stays visible.** "Demo on Solana devnet, test money only" is in the
   footer of every page, plus a fuller statement of the limits in "Trust & compliance".
2. **The privacy claim stays narrow.** Only the *amount* of each monthly rent payment is encrypted.
   Deposits are public, the agreed rent on the lease is public, and the fact, parties and date of a
   payment are public. The pitch line is "what you pay each month is between you and your landlord",
   never "lease terms are secret". `docs/privacy.md` is the source of truth.
3. **KYC is described as a vendor's work**, in their sandbox for the demo — not as a licence or a
   regulatory status Relstate holds.

## Theme and accessibility

- Light and dark. With no stored choice the site follows `prefers-color-scheme`; the toggle in the
  nav writes `relstate.theme` and sets `data-theme` on `<html>`. A tiny script in each page's
  `<head>` applies it before first paint. The app has no dark theme yet, so the dark tokens are the
  site's own — the light ones are the app's, unchanged.
- Semantic landmarks, a skip link, one `h1` per page and a real heading order; the FAQ is
  `<details>/<summary>`, so it works with JavaScript off; the privacy table is a real table with
  scoped headers; the city filter uses `aria-pressed` and announces the count with `aria-live`.
- Body and muted text meet WCAG AA against their backgrounds in both themes. Brass is used for
  graphics only — brass-coloured *text* uses `--warning`, which passes.
- `prefers-reduced-motion` disables the entrance animation and smooth scrolling.

## Build notes

`react` and `react-dom` are aliased to `preact/compat` in `vite.config.ts`. The source is ordinary
React — same idiom as `app/` — but the shipped runtime is ~11 kB gzip instead of ~72 kB, which is
worth it for a page whose only interactivity is a theme toggle and a city filter. Nothing here uses
more than `useState`/`useEffect`/`createRoot`, so deleting the three alias lines reverts to React
with no source change.
