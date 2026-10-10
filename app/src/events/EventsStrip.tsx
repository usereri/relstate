import { CalendarDays, GraduationCap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EVENTS_NOTE, dateLabel, toFilter, upcoming } from "./events";
import type { EventEntry } from "./events";
import { sameName } from "./params";
import type { NearFilter } from "./params";

/** Two filters point at the same venue when the anchor and the radius agree. */
const isActive = (filter: NearFilter | null, e: EventEntry) =>
  !!filter?.point &&
  Math.abs(filter.point.lat - e.lat) < 1e-6 &&
  Math.abs(filter.point.lng - e.lng) < 1e-6 &&
  sameName(filter.city, e.city);

/**
 * "Near an event": the in-app version of the marketing site's events page, one row of cards above
 * the apartments. Clicking one applies exactly the filter a link from the site would have applied
 * (`toFilter` runs the same sanitisers), which is what makes the nomad story work from inside the
 * app: someone arriving for a conference or the start of a semester picks the occasion and sees
 * the homes within walking distance of it.
 *
 * The data is **sample data** -- real venues, invented occasions and dates. Said on the cards and
 * under the strip, and in full in `EVENTS_NOTE`.
 */
export function EventsStrip({
  filter,
  onPick,
  onShowAll,
}: {
  filter: NearFilter | null;
  onPick: (filter: NearFilter) => void;
  onShowAll: () => void;
}) {
  const events = upcoming();
  return (
    <section aria-labelledby="near-an-event" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="near-an-event" className="text-sm font-semibold">
          Arriving for something? Find a home near it
        </h2>
        {filter && (
          <button onClick={onShowAll} className="text-xs font-medium text-accent underline-offset-4 hover:underline">
            Show all apartments
          </button>
        )}
      </div>
      <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
        {events.map((e) => {
          const active = isActive(filter, e);
          const Icon = e.kind === "university" ? GraduationCap : CalendarDays;
          return (
            <li key={e.id} className="snap-start">
              <button
                onClick={() => (active ? onShowAll() : onPick(toFilter(e)))}
                aria-pressed={active}
                className={cn(
                  "flex h-full w-60 flex-col gap-1.5 rounded-2xl border bg-card p-3 text-left transition-colors hover:border-accent/50",
                  active && "border-accent bg-secondary/70 ring-1 ring-accent/40",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className="size-3.5 shrink-0 text-accent" aria-hidden />
                  <span className="truncate">{e.city}</span>
                  <Badge variant="outline" className="ml-auto shrink-0 py-0 text-[10px] font-medium">
                    sample
                  </Badge>
                </span>
                <span className="text-sm font-semibold leading-tight">{e.venue}</span>
                <span className="text-xs text-muted-foreground">
                  {e.name} · {dateLabel(e)}
                </span>
                <span className={cn("mt-auto pt-1 text-xs font-medium", active ? "text-accent" : "text-muted-foreground")}>
                  {active ? "Showing homes within" : "Homes within"} {e.radiusKm} km
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" title={EVENTS_NOTE}>
        Sample data: the venues are real places and the coordinates approximate, but the occasions and dates are invented for this demo.
      </p>
    </section>
  );
}
