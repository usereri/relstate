import { createContext, useContext, useEffect, useRef, useState } from "react";

/** Bumped after every transaction and on a timer; every useChain read reloads when it changes. */
export const Tick = createContext(0);

/** Where failed reads are reported, so a broken RPC shows a message instead of a list that never loads. */
export const ReadErrors = createContext<(message: string) => void>(() => {});

/**
 * Load something from the chain, reload on each tick, and drop the value when `deps` change.
 * A read slower than the tick is left to finish (never cancelled, never duplicated), so a slow
 * RPC shows data late instead of never.
 */
export function useChain<T>(load: () => Promise<T>, deps: unknown[]): T | undefined {
  const tick = useContext(Tick);
  const report = useContext(ReadErrors);
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string; value: T }>();
  const current = useRef(key);
  const inFlight = useRef<string | null>(null);
  current.current = key;

  useEffect(() => {
    if (inFlight.current === key) return;
    inFlight.current = key;
    load()
      .then(
        (value) => current.current === key && setState({ key, value }),
        (e) => report(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        if (inFlight.current === key) inFlight.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, key]);

  return state?.key === key ? state.value : undefined;
}

/**
 * The chain clock, every second instead of every tick.
 *
 * `now` is read from the Clock sysvar on the five-second tick, which is fine for "term ends in
 * 3d 4h" and useless for a window measured in seconds: a countdown that jumps 5 at a time reads as
 * broken, and on the demo build the tenant's answer window is 45 s long.
 *
 * So the polled value is the baseline and the wall clock fills in between polls. Every new `now`
 * re-bases it, which is what keeps this honest on a local chain whose clock is time-travelled:
 * after a jump the next poll corrects the estimate within the tick, rather than counting down from
 * a figure that no longer exists.
 */
export function useChainClock(now: number | undefined): number | undefined {
  const base = useRef<{ chain: number; wall: number }>(undefined);
  const shown = useRef<number>(undefined);
  const [, redraw] = useState(0);
  // Refs are written during render here. That is safe because both writes are idempotent for a given
  // `now` and instant: re-rendering (StrictMode, a discarded concurrent render) recomputes the same
  // base and a `max` that cannot move further. Do not put anything non-idempotent in this body.
  if (now !== undefined && base.current?.chain !== now) base.current = { chain: now, wall: Date.now() };

  useEffect(() => {
    if (now === undefined) return;
    const t = setInterval(() => redraw((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [now === undefined]);

  if (now === undefined || !base.current) return undefined;
  const estimate = base.current.chain + Math.floor((Date.now() - base.current.wall) / 1000);
  return (shown.current = monotonicClock(shown.current, estimate));
}

/** A re-base that lands this far behind what was shown is a real clock change, not read-lag jitter. */
export const CLOCK_JITTER_SECS = 5;

/**
 * The next clock value to show: never behind the last one by read-lag jitter, so a countdown built
 * on it only ever runs down (a bar that refills at each poll reads as broken).
 *
 * A larger step back is believed. A local chain that was reset, or a clock that really moved, must
 * not leave every window-gate stuck on a figure the chain no longer has.
 */
export const monotonicClock = (previous: number | undefined, estimate: number): number =>
  previous !== undefined && estimate < previous && previous - estimate <= CLOCK_JITTER_SECS ? previous : estimate;
