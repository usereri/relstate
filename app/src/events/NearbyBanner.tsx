import { MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { distanceLabel } from "./geo";
import { filterTitle } from "./params";
import type { NearFilter } from "./params";

/**
 * The line that explains why the Apartments list is shorter than usual, with the way out.
 *
 * `filter.label` arrives from a URL, so it has been through `safeLabel`; it is interpolated as
 * text (React escapes it) and never as markup.
 */
export function NearbyBanner({
  filter,
  count,
  hidden,
  unplaced,
  onShowAll,
  onDismiss,
}: {
  filter: NearFilter;
  /** How many listings survived the filter. */
  count: number;
  /** How many it held back. */
  hidden: number;
  /** Of those, how many had no position on file. */
  unplaced: number;
  onShowAll: () => void;
  onDismiss: () => void;
}) {
  const place = filterTitle(filter);
  const homes = count === 1 ? "home" : "homes";
  const others = hidden === 1 ? "apartment" : "apartments";
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-accent/30 bg-secondary/60 px-4 py-3">
      <MapPin className="size-4 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Showing homes near {place}</p>
        <p className="text-xs text-muted-foreground">
          {count} {homes} within {filter.radiusKm} km
          {hidden > 0 && (
            <>
              {" · "}
              {hidden} other {others} hidden
              {unplaced > 0 && `, ${unplaced} for want of a location on file`}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={onShowAll}>
          Show all
        </Button>
        <button
          onClick={onDismiss}
          aria-label="Hide this notice"
          className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** The per-listing distance: "14 min walk · 1.2 km from AGH University of Krakow · Kazimierz". */
export function NearbyNote({ km, area, label }: { km: number | null; area?: string; label?: string }) {
  if (km === null) return null;
  return (
    <p className="text-xs font-medium text-accent">
      {distanceLabel(km, label)}
      {area && <span className="font-normal text-muted-foreground"> · {area}</span>}
    </p>
  );
}
