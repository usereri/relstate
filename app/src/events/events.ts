/**
 * The sample events behind the in-app "Near an event" strip.
 *
 * `events.json` is a **byte-for-byte copy** of `site/src/data/events.json` -- the marketing site
 * and the app show the same occasions, and the site is a separate package with its own build, so
 * the file is duplicated rather than imported across the boundary (`docs/site.md` says the same of
 * the brand files). Keep them in sync: `cp site/src/data/events.json app/src/events/events.json`.
 *
 * It is **sample data**. The institutions and venues are real places and the coordinates are
 * approximate, but the occasions and dates are invented for the demo, and nothing listed is a
 * partner of Relstate. The strip says so on screen; `EVENTS_NOTE` is the full wording.
 */
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, MIN_RADIUS_KM, safeCity, safeLabel } from "./params";
import type { NearFilter } from "./params";
import raw from "./events.json";

export interface EventEntry {
  id: string;
  kind: "university" | "event";
  /** The occasion, e.g. "Autumn semester starts". */
  name: string;
  /** Where it happens: an institution or a venue. */
  venue: string;
  /** Must match `Listing.city` exactly -- "Kraków", "Warsaw" (see scripts/setup-demo.ts). */
  city: string;
  /** District, for a human reading the card. */
  area: string;
  /** ISO date. `ends` is absent for a single-day occasion. */
  starts: string;
  ends?: string;
  lat: number;
  lng: number;
  /** How far around the venue counts as "nearby", in kilometres. */
  radiusKm: number;
  blurb: string;
}

export const EVENTS_NOTE: string = raw._note;
export const EVENTS: EventEntry[] = (raw.items as EventEntry[]).slice().sort((a, b) => a.starts.localeCompare(b.starts));
export const EVENT_CITIES = [...new Set(EVENTS.map((e) => e.city))];

/** The last day an occasion is still on. */
const lastDay = (e: EventEntry) => e.ends ?? e.starts;

/**
 * The next few occasions, soonest first. The sample dates will eventually all be in the past, and
 * an empty strip would look broken rather than stale, so a run with nothing upcoming falls back to
 * the whole list.
 */
export function upcoming(events: EventEntry[] = EVENTS, today = new Date(), limit = 6): EventEntry[] {
  const iso = today.toISOString().slice(0, 10);
  const ahead = events.filter((e) => lastDay(e) >= iso);
  return (ahead.length ? ahead : events).slice(0, limit);
}

/**
 * The filter a card applies when clicked. It goes through the same sanitisers as the URL
 * hand-off, so the in-app path and the link from the site cannot diverge.
 */
export function toFilter(e: EventEntry): NearFilter {
  const radius = Number.isFinite(e.radiusKm) ? Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, e.radiusKm)) : DEFAULT_RADIUS_KM;
  const filter: NearFilter = { radiusKm: radius, point: { lat: e.lat, lng: e.lng } };
  const city = safeCity(e.city);
  if (city) filter.city = city;
  const label = safeLabel(e.venue);
  if (label) filter.label = label;
  return filter;
}

const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "20–23 Oct 2026" for a range, "1 Oct 2026" for a single day. */
export function dateLabel(e: EventEntry): string {
  const from = new Date(`${e.starts}T00:00:00Z`);
  if (!e.ends) return fmt.format(from);
  const to = new Date(`${e.ends}T00:00:00Z`);
  const sameMonth = from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear();
  return sameMonth ? `${from.getUTCDate()}–${fmt.format(to)}` : `${fmt.format(from)} – ${fmt.format(to)}`;
}
