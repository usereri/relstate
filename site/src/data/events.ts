import raw from "./events.json";

/**
 * Sample data behind the events page. `city` must match the `city` on a listing exactly
 * ("Kraków", "Warsaw" -- see scripts/setup-demo.ts), because it is passed straight to the app
 * as `?city=`.
 */
export interface EventEntry {
  id: string;
  kind: "university" | "event";
  /** The occasion, e.g. "Autumn semester starts". */
  name: string;
  /** Where it happens: an institution or a venue. */
  venue: string;
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

export const EVENTS_NOTE = raw._note;
export const EVENTS: EventEntry[] = (raw.items as EventEntry[]).slice().sort((a, b) => a.starts.localeCompare(b.starts));
export const CITIES = [...new Set(EVENTS.map((e) => e.city))];

const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "20–23 Oct 2026" for a range, "1 Oct 2026" for a single day. */
export function dateLabel(e: EventEntry) {
  const from = new Date(`${e.starts}T00:00:00Z`);
  if (!e.ends) return fmt.format(from);
  const to = new Date(`${e.ends}T00:00:00Z`);
  const sameMonth = from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear();
  return sameMonth ? `${from.getUTCDate()}–${fmt.format(to)}` : `${fmt.format(from)} – ${fmt.format(to)}`;
}
