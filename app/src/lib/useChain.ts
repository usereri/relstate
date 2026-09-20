import { createContext, useContext, useEffect, useRef, useState } from "react";

/** Bumped after every transaction and on a timer; every useChain read reloads when it changes. */
export const Tick = createContext(0);

/**
 * Load something from the chain, reload on each tick, and drop the value when `deps` change.
 * A read slower than the tick is left to finish (never cancelled, never duplicated), so a slow
 * RPC shows data late instead of never.
 */
export function useChain<T>(load: () => Promise<T>, deps: unknown[]): T | undefined {
  const tick = useContext(Tick);
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
        () => {}, // the shell reports an unreachable network once
      )
      .finally(() => {
        if (inFlight.current === key) inFlight.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, key]);

  return state?.key === key ? state.value : undefined;
}
