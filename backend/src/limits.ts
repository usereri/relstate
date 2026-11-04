// Spend caps for the sponsor. Per deployment rather than per process since Phase 2: the windows
// live in the store (store.ts), so a redeploy no longer hands everyone a fresh daily budget. Still
// one machine — a multi-instance deployment would move them into Redis behind this same interface.
//
// Reservations are two-phase on purpose. A request reserves its *worst case*
// cost before the transaction is signed, so two concurrent requests cannot both
// read a below-cap total and then both spend. The reservation is rewritten to
// the real cost on commit, or dropped on cancel.
import { randomUUID } from "node:crypto";
import { env } from "./env.ts";
import { defaultStore, type Collection, type Store } from "./store.ts";

export class LimitError extends Error {
  readonly scope: "wallet" | "global";
  constructor(message: string, scope: "wallet" | "global") {
    super(message);
    this.scope = scope;
  }
}

export type LimitConfig = {
  maxPerWalletPerHour: number;
  maxGlobalPerHour: number;
  maxLamportsPerWalletPerDay: bigint;
  maxLamportsGlobalPerDay: bigint;
};

export const defaultLimitConfig: LimitConfig = {
  maxPerWalletPerHour: env.sponsor.maxPerWalletPerHour,
  maxGlobalPerHour: env.sponsor.maxGlobalPerHour,
  maxLamportsPerWalletPerDay: env.sponsor.maxLamportsPerWalletPerDay,
  maxLamportsGlobalPerDay: env.sponsor.maxLamportsGlobalPerDay,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * One booked spend. `id` is what a reservation holds on to: the entry is a row in a store now, not
 * an object two arrays share, so `commit` and `cancel` find it by id instead of by identity.
 */
type Entry = { id: string; at: number; lamports: bigint; open: boolean };

export type Reservation = {
  commit(actualLamports: bigint): void;
  cancel(): void;
};

export type UsageSnapshot = {
  walletLastHour: number;
  walletLamportsLastDay: bigint;
  globalLastHour: number;
  globalLamportsLastDay: bigint;
};

export type RateLimiterDeps = {
  store?: Store;
  /**
   * Which limiter this is. Four of them share one database — the sponsor's, and the treasury's
   * confidential-setup, rent-payment and rent-dust budgets — so each needs its own collection or
   * they would spend each other's.
   */
  namespace?: string;
};

export function createRateLimiter(config: LimitConfig = defaultLimitConfig, deps: RateLimiterDeps = {}) {
  const store = deps.store ?? defaultStore();
  // One row per wallet holding that wallet's entries, keyed by the wallet. The global totals are a
  // fold over those rows rather than a second array of the same objects: nothing can be in one and
  // not the other, which is the bug the old shared-entry splice existed to avoid.
  const byWallet: Collection<Entry[]> = store.collection(`limits:${deps.namespace ?? "sponsor"}`);

  /** A day is the longest window we read, so anything older is dead weight. */
  const live = (entries: Entry[], now: number): Entry[] => entries.filter((e) => now - e.at <= DAY_MS);

  const write = (wallet: string, entries: Entry[]): void => {
    if (entries.length === 0) byWallet.delete(wallet);
    // The row dies a day after its newest entry, so a wallet that never comes back is pruned
    // rather than kept forever.
    else byWallet.set(wallet, entries, Math.max(...entries.map((e) => e.at)) + DAY_MS);
  };

  function snapshot(wallet: string, now = Date.now()): UsageSnapshot {
    const mine = live(byWallet.get(wallet) ?? [], now);
    let globalLastHour = 0;
    let globalLamportsLastDay = 0n;
    for (const [, entries] of byWallet.entries()) {
      for (const e of entries) {
        if (now - e.at <= HOUR_MS) globalLastHour++;
        if (now - e.at <= DAY_MS) globalLamportsLastDay += e.lamports;
      }
    }
    return {
      walletLastHour: mine.reduce((n, e) => (now - e.at <= HOUR_MS ? n + 1 : n), 0),
      walletLamportsLastDay: mine.reduce((n, e) => (now - e.at <= DAY_MS ? n + e.lamports : n), 0n),
      globalLastHour,
      globalLamportsLastDay,
    };
  }

  /**
   * Throws `LimitError` when the worst-case cost would breach a cap. On success
   * the cost is already booked; the caller must `commit` or `cancel`.
   */
  function reserve(wallet: string, worstCaseLamports: bigint, now = Date.now()): Reservation {
    const usage = snapshot(wallet, now);
    if (usage.walletLastHour >= config.maxPerWalletPerHour) {
      throw new LimitError(`wallet sponsored ${usage.walletLastHour} transactions in the last hour (cap ${config.maxPerWalletPerHour})`, "wallet");
    }
    if (usage.globalLastHour >= config.maxGlobalPerHour) {
      throw new LimitError(`backend sponsored ${usage.globalLastHour} transactions in the last hour (cap ${config.maxGlobalPerHour})`, "global");
    }
    if (usage.walletLamportsLastDay + worstCaseLamports > config.maxLamportsPerWalletPerDay) {
      throw new LimitError(`wallet daily lamport cap ${config.maxLamportsPerWalletPerDay} would be exceeded`, "wallet");
    }
    if (usage.globalLamportsLastDay + worstCaseLamports > config.maxLamportsGlobalPerDay) {
      throw new LimitError(`global daily lamport cap ${config.maxLamportsGlobalPerDay} would be exceeded`, "global");
    }

    const id = randomUUID();
    // Dead rows go now, not on a timer: this is the one path that is always hit before a spend.
    byWallet.prune(now);
    write(wallet, [...live(byWallet.get(wallet) ?? [], now), { id, at: now, lamports: worstCaseLamports, open: true }]);

    /** Re-read, change this one entry, write back: a concurrent request's entries survive. */
    const close = (change: (entries: Entry[], mine: Entry) => Entry[]): void => {
      const entries = byWallet.get(wallet) ?? [];
      const mine = entries.find((e) => e.id === id);
      if (mine === undefined || !mine.open) return;
      write(wallet, change(entries, mine));
    };
    return {
      commit(actualLamports: bigint) {
        close((entries, mine) => entries.map((e) => (e.id === id ? { ...mine, lamports: actualLamports, open: false } : e)));
      },
      cancel() {
        close((entries) => entries.filter((e) => e.id !== id));
      },
    };
  }

  return { reserve, snapshot, config };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
