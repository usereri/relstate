// Persistence: the one thing between "the demo is running" and "the demo was restarted".
//
// Everything this backend knows that is not on chain used to live in a `Map` for the length of one
// process: who claimed an appraiser invitation, which Stripe event was already credited, which
// wallet already took its rent dust, how much of today's budget is spent. A redeploy or an
// OOM-killed machine lost all of it, and the two that matter are not inconveniences — a lost
// idempotency key mints rUSDC twice for one payment, and a lost once-per-wallet marker hands out
// the rent grant again.
//
// So there is exactly ONE interface here, and it is deliberately small:
//
//     store.collection<T>("name")  ->  get / has / set / delete / values / entries / size / prune
//
// A named collection of JSON records keyed by a string, with an optional expiry. That is the whole
// contract. It is what a `Map` already was, plus a TTL, which is why the modules above it keep the
// shape of the code they had: they still own what a record means, when it expires, and which
// concurrent request wins. Swapping SQLite for Postgres is this file and nothing else — no route
// and no service signature mentions a table, a column or a connection.
//
// **Synchronous on purpose.** Several of the stores exist precisely to settle a race, and they do
// it by writing before the first `await` ("marked synchronously, before the first await" in
// treasury.ts, "no await between admit and the map write" in rentplan.ts). An async store would
// quietly reintroduce every one of those races. `node:sqlite`'s `DatabaseSync` is synchronous, this
// is one machine, and the writes are single small rows — so the interface is sync and the call
// sites stay provably atomic. A Postgres adapter would have to earn that back (a write-behind
// queue, or awaiting at the call sites); the point of the interface is that it is the only place
// that question arises.
//
// `node:sqlite` rather than a dependency: it is in the runtime from Node 22.5 and needs no flag
// from 22.13 on (checked on 22.18, the version `engines` pins, and on 26), so the container stays
// `node:22-slim` with no build step and the dependency list stays as short as it was.
//
// **What deliberately does NOT come through here**, so that the next person does not have to work
// out whether it was forgotten:
//
//   * the per-minute per-IP windows on the login routes and the `/api/rpc` proxy
//     (`wallet-auth.ts`, `rpcproxy.ts`). A restart grants a fresh minute, which is worth nothing to
//     an attacker and not worth a write per proxied read.
//   * unsigned login challenges (`wallet-auth.ts`). They live for minutes and losing one costs the
//     user a re-click; sessions themselves are stateless HMAC tokens and already survive, as long
//     as `SESSION_SECRET` is set.
//   * the rent-payment context registry (`rentplan.ts`). It describes a five-transaction plan that
//     is live for minutes, and losing it fails *closed* — the client replans, and
//     `scripts/reclaim-contexts.ts` recovers the rent left behind.
//   * `inFlight` in the on-ramp and the KYC service. Those hold promises of work happening inside
//     this process; the row that covers the same event arriving after a restart is the credit or
//     the record, and both are persisted.
//   * the loaded-key cache (`keys.ts`) and the mock treasury reserve (`treasury.ts`). The first is
//     a memo of a file read; the second is seeded from the mint's on-chain supply, so it starts at
//     zero headroom and every wrap still has to be backed by a fresh credit.
//   * listing photos (`uploads.ts`). Already on the same volume, under `UPLOADS_DIR`.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.ts";

/** The in-memory database SQLite opens when no `DATABASE_PATH` is configured. */
export const MEMORY = ":memory:";

/**
 * One named, string-keyed collection of records. The same operations a `Map` offers, plus an
 * expiry the owner chooses and a `prune` the owner calls: the store never reads the clock itself,
 * because every module above it takes `now()` as a dependency and the tests drive it.
 */
export type Collection<T> = {
  readonly name: string;
  get(key: string): T | undefined;
  has(key: string): boolean;
  /** `expiresAt` is unix **milliseconds**, or null for "keeps until something deletes it". */
  set(key: string, value: T, expiresAt?: number | null): void;
  delete(key: string): boolean;
  values(): T[];
  /** Insertion order, as a `Map` iterates: re-setting a key keeps its place. */
  entries(): Array<[string, T]>;
  size(): number;
  /** Drops the rows whose expiry has passed. Returns how many. */
  prune(now: number): number;
};

export type Store = {
  collection<T>(name: string): Collection<T>;
  /** Every collection at once: cheap, and what boot does for whatever expired while we were down. */
  prune(now: number): number;
  /**
   * Runs `fn` with every write in one transaction, so a crash cannot leave two rows that only make
   * sense together half-written. Nested calls run inline on the outermost transaction.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** `:memory:` or the file. */
  readonly path: string;
  readonly persistent: boolean;
};

/**
 * JSON with bigints.
 *
 * Half of these records are amounts — `agreedFee`, `amountUsdc`, `lamports` — and `JSON.stringify`
 * throws on a bigint rather than guessing. So a bigint is written as `{"$bigint":"123"}` and read
 * back as a bigint. Nothing a user types can be mistaken for the tag: it is an object with exactly
 * one key, and every user-supplied field in every record here is a string.
 */
const BIGINT_TAG = "$bigint";

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? { [BIGINT_TAG]: v.toString() } : v));
}

function decode<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const keys = Object.keys(v);
    const tagged = (v as Record<string, unknown>)[BIGINT_TAG];
    if (keys.length !== 1 || keys[0] !== BIGINT_TAG || typeof tagged !== "string") return v;
    return BigInt(tagged);
  }) as T;
}

/**
 * Opens a store. A path creates the file and its directory; {@link MEMORY} is a private database
 * that dies with the process, which is what every test and `npm run dev` get.
 *
 * One table, because the interface is one shape. `expires_at` is indexed so a prune is a single
 * delete, and the primary key is upserted rather than replaced so a re-`set` keeps the row's
 * `rowid` — that is what makes `entries()` iterate in insertion order like the `Map` it replaced.
 */
export function openStore(path: string = MEMORY): Store {
  if (path !== MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      collection TEXT    NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (collection, key)
    );
    CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at);
  `);
  if (path !== MEMORY) {
    // WAL so a reader never blocks the writer, FULL so a machine that is killed mid-demo has
    // already fsynced the row that said "this payment was credited". The writes are a handful of
    // small rows per user action, so the cost of FULL is not worth optimising away.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
  }

  const get = db.prepare("SELECT value FROM kv WHERE collection = ? AND key = ?");
  const has = db.prepare("SELECT 1 AS present FROM kv WHERE collection = ? AND key = ?");
  const upsert = db.prepare(
    `INSERT INTO kv (collection, key, value, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
  );
  const remove = db.prepare("DELETE FROM kv WHERE collection = ? AND key = ?");
  const all = db.prepare("SELECT key, value FROM kv WHERE collection = ? ORDER BY rowid");
  const count = db.prepare("SELECT COUNT(*) AS n FROM kv WHERE collection = ?");
  const pruneOne = db.prepare("DELETE FROM kv WHERE collection = ? AND expires_at IS NOT NULL AND expires_at <= ?");
  const pruneAll = db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?");

  let depth = 0;

  const store: Store = {
    path,
    persistent: path !== MEMORY,

    collection<T>(name: string): Collection<T> {
      return {
        name,
        get(key) {
          const row = get.get(name, key) as { value: string } | undefined;
          return row === undefined ? undefined : decode<T>(row.value);
        },
        has(key) {
          return has.get(name, key) !== undefined;
        },
        set(key, value, expiresAt = null) {
          upsert.run(name, key, encode(value), expiresAt ?? null);
        },
        delete(key) {
          return remove.run(name, key).changes > 0;
        },
        values() {
          return (all.all(name) as Array<{ key: string; value: string }>).map((r) => decode<T>(r.value));
        },
        entries() {
          return (all.all(name) as Array<{ key: string; value: string }>).map((r) => [r.key, decode<T>(r.value)] as [string, T]);
        },
        size() {
          return Number((count.get(name) as { n: number | bigint }).n);
        },
        prune(now) {
          return Number(pruneOne.run(name, now).changes);
        },
      };
    },

    prune(now) {
      return Number(pruneAll.run(now).changes);
    },

    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN");
      depth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },

    close() {
      db.close();
    },
  };

  // Whatever expired while the machine was down, gone before the first request sees it.
  if (store.persistent) store.prune(Date.now());
  return store;
}

/**
 * The process's store.
 *
 * With a `DATABASE_PATH` there is **one** connection to that file, shared by every service, which
 * is the single-machine deployment. With none, every caller gets its own private in-memory store —
 * so `npm run dev` needs no file and each test builds a service with a store of its own, exactly
 * as each one used to get its own `Map`.
 */
let shared: Store | undefined;

export function defaultStore(): Store {
  if (env.databasePath === "") return openStore(MEMORY);
  return (shared ??= openStore(env.databasePath));
}
