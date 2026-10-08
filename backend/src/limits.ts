// Spend caps for the sponsor. In-memory and per-process, which is the right
// shape for a single demo backend; a multi-instance deployment would move the
// windows into Redis behind this same interface.
//
// Reservations are two-phase on purpose. A request reserves its *worst case*
// cost before the transaction is signed, so two concurrent requests cannot both
// read a below-cap total and then both spend. The reservation is rewritten to
// the real cost on commit, or dropped on cancel.
import { env } from "./env.ts";

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

type Entry = { at: number; lamports: bigint; open: boolean };

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

export function createRateLimiter(config: LimitConfig = defaultLimitConfig) {
  const byWallet = new Map<string, Entry[]>();
  const global: Entry[] = [];

  const prune = (entries: Entry[], now: number): Entry[] => {
    // A day is the longest window we read, so anything older is dead weight.
    let i = 0;
    while (i < entries.length && now - (entries[i] as Entry).at > DAY_MS) i++;
    if (i > 0) entries.splice(0, i);
    return entries;
  };
  const countSince = (entries: Entry[], now: number, windowMs: number): number =>
    entries.reduce((n, e) => (now - e.at <= windowMs ? n + 1 : n), 0);
  const lamportsSince = (entries: Entry[], now: number, windowMs: number): bigint =>
    entries.reduce((n, e) => (now - e.at <= windowMs ? n + e.lamports : n), 0n);

  function snapshot(wallet: string, now = Date.now()): UsageSnapshot {
    const walletEntries = prune(byWallet.get(wallet) ?? [], now);
    prune(global, now);
    return {
      walletLastHour: countSince(walletEntries, now, HOUR_MS),
      walletLamportsLastDay: lamportsSince(walletEntries, now, DAY_MS),
      globalLastHour: countSince(global, now, HOUR_MS),
      globalLamportsLastDay: lamportsSince(global, now, DAY_MS),
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

    const entry: Entry = { at: now, lamports: worstCaseLamports, open: true };
    const walletEntries = byWallet.get(wallet) ?? [];
    walletEntries.push(entry);
    byWallet.set(wallet, walletEntries);
    global.push(entry);

    const close = () => {
      entry.open = false;
    };
    return {
      commit(actualLamports: bigint) {
        if (!entry.open) return;
        entry.lamports = actualLamports;
        close();
      },
      cancel() {
        if (!entry.open) return;
        const removeFrom = (entries: Entry[]) => {
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
        };
        removeFrom(byWallet.get(wallet) ?? []);
        removeFrom(global);
        if ((byWallet.get(wallet) ?? []).length === 0) byWallet.delete(wallet);
        close();
      },
    };
  }

  return { reserve, snapshot, config };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
