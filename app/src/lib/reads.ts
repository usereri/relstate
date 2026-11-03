// Shared, short-lived cache for the program-account scans.
//
// Several components read the same list (listings, a tenant's leases, a tenant's applications) on
// the app's 5 s tick. Each `getProgramAccounts` costs the shared RPC budget 50 units, so five
// independent pollers cost ~60 scans a minute per open tab. Here the same query is run once per
// TTL no matter how many components ask, concurrent askers share one in-flight request, and a
// transaction (or a manual refresh) drops the cache so the next read is fresh.

const TTL_MS = 10_000;

const entries = new Map<string, { at: number; value?: unknown; pending?: Promise<unknown> }>();

export function sharedRead<T>(key: string, load: () => Promise<T>, ttlMs = TTL_MS, now: () => number = Date.now): Promise<T> {
  const hit = entries.get(key);
  if (hit?.pending) return hit.pending as Promise<T>;
  if (hit && "value" in hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  const pending = load().then(
    (value) => {
      // Only keep it if nothing invalidated the entry while it was loading.
      if (entries.get(key)?.pending === pending) entries.set(key, { at: now(), value });
      return value;
    },
    (e) => {
      if (entries.get(key)?.pending === pending) entries.delete(key);
      throw e;
    },
  );
  entries.set(key, { at: now(), pending });
  return pending;
}

/** Forget everything: called after a transaction, when what was read is no longer true. */
export const invalidateReads = (): void => entries.clear();
