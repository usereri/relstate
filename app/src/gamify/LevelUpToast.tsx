import { useEffect, useRef } from "react";
import { PartyPopper, Trophy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Celebration } from "./celebrate";
import type { Standing } from "./levels";
import { ProgressRing } from "./ProgressRing";
import "./gamify.css";

const DISMISS_AFTER_MS = 8000;

/**
 * The level-up moment: a short, self-dismissing note that the on-chain record just changed.
 *
 * It sits under the header rather than above the bottom edge, where the lease screens keep their
 * primary action on a phone.
 */
export function LevelUpToast({
  celebration,
  standing,
  onDismiss,
}: {
  celebration: Celebration;
  standing: Standing;
  onDismiss: () => void;
}) {
  const levelUp = celebration.kind === "level-up";
  const latest = useRef(onDismiss);
  latest.current = onDismiss;

  // one timer per celebration: the app re-renders every few seconds, and a timer restarted on
  // every render would never fire
  useEffect(() => {
    const t = setTimeout(() => latest.current(), DISMISS_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-4 top-20 z-50 flex justify-center sm:inset-x-auto sm:right-6">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "gamify-pop pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-[18px] border bg-card p-4 shadow-card",
          levelUp && "border-brass/50",
        )}
      >
        {levelUp && (
          <span
            className="gamify-sweep pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-brass/20 to-transparent"
            aria-hidden
          />
        )}
        <div className="relative flex items-start gap-3.5">
          {levelUp ? (
            <div className="relative text-brass">
              <span className="gamify-halo absolute inset-0 rounded-full bg-brass/30" aria-hidden />
              <ProgressRing value={standing.next ? standing.progress : 100} size={52} stroke={4} label="Progress to the next level">
                <Trophy className="size-5" />
              </ProgressRing>
            </div>
          ) : (
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-success-soft text-success">
              <PartyPopper className="size-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{levelUp ? "Level up" : "On-chain record"}</p>
            <p className="mt-0.5 font-display text-lg font-semibold leading-tight">{celebration.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{celebration.detail}</p>
            {standing.next && (
              <p className="mt-2 text-xs text-muted-foreground">
                {standing.progress}% of the way to <span className="font-medium text-foreground">{standing.next.name}</span>
              </p>
            )}
          </div>
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-m-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
