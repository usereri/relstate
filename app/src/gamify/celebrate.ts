/**
 * The level-up moment: noticing that the on-chain counters moved since this browser last looked.
 *
 * The comparison is against what was last *seen* for that wallet, kept in localStorage, so the
 * celebration fires once for a given change and not again on the next poll, the next tab switch or
 * the next reload. The first time a wallet is seen nothing is celebrated — opening an established
 * profile should not throw a party for history — it is only recorded.
 *
 * A counter moving the wrong way (a late payment, a default, a deposit the tenant had to claim) is
 * recorded silently. There is nothing to celebrate there, and a toast saying otherwise would be a
 * lie about the record.
 */
import { levelNames, levelOf } from "./levels";
import type { ProfileView, Role } from "@/lib/chain";

/** The last-seen counters for one wallet in one role. */
export interface Seen {
  level: number;
  leasesCompleted: number;
  paidOnTime: number;
  paidLate: number;
  defaults: number;
  depositsReturnedFull: number;
  depositsClaimed: number;
}

export interface Celebration {
  kind: "level-up" | "progress";
  title: string;
  detail: string;
}

export const snapshot = (profile: ProfileView | null, role: Role): Seen => ({
  level: levelOf(profile, role),
  leasesCompleted: profile?.leasesCompleted ?? 0,
  paidOnTime: profile?.paidOnTime ?? 0,
  paidLate: profile?.paidLate ?? 0,
  defaults: profile?.defaults ?? 0,
  depositsReturnedFull: profile?.depositsReturnedFull ?? 0,
  depositsClaimed: profile?.depositsClaimed ?? 0,
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What changed for the better, in the words the toast uses. */
function gains(before: Seen, after: Seen): string[] {
  const out: string[] = [];
  const onTime = after.paidOnTime - before.paidOnTime;
  const leases = after.leasesCompleted - before.leasesCompleted;
  const returned = after.depositsReturnedFull - before.depositsReturnedFull;
  if (onTime > 0) out.push(onTime === 1 ? "Rent paid on time" : `${onTime} rent payments on time`);
  if (leases > 0) out.push(leases === 1 ? "Lease completed" : plural(leases, "lease completed", "leases completed"));
  if (returned > 0) out.push(returned === 1 ? "Deposit returned in full" : plural(returned, "deposit returned in full", "deposits returned in full"));
  return out;
}

const setback = (before: Seen, after: Seen) =>
  after.paidLate > before.paidLate || after.defaults > before.defaults || after.depositsClaimed > before.depositsClaimed;

/** What to celebrate about the move from `before` to `after`, or null when there is nothing. */
export function celebration(before: Seen, after: Seen, role: Role): Celebration | null {
  if (setback(before, after)) return null;
  const good = gains(before, after);
  if (good.length === 0) return null;
  if (after.level > before.level)
    return { kind: "level-up", title: `${levelNames(role)[after.level] ?? "Next level"} unlocked`, detail: good.join(" · ") };
  return { kind: "progress", title: good[0]!, detail: good.slice(1).join(" · ") || "Written to your record by the program." };
}

// ---- what this browser has already seen ----------------------------------------------------

export interface Store {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const key = (address: string, role: Role) => `relstate.gamify.seen.${role}.${address}`;

const browserStore = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode, or a sandboxed frame
  }
};

const NUMBERS: (keyof Seen)[] = [
  "level",
  "leasesCompleted",
  "paidOnTime",
  "paidLate",
  "defaults",
  "depositsReturnedFull",
  "depositsClaimed",
];

/** The last-seen counters, or null when this wallet has never been seen (or the record is unusable). */
export function readSeen(address: string, role: Role, store = browserStore()): Seen | null {
  try {
    const raw = store?.getItem(key(address, role));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (NUMBERS.some((k) => typeof parsed[k] !== "number")) return null; // an older or hand-edited shape
    return parsed as unknown as Seen;
  } catch {
    return null;
  }
}

export function writeSeen(address: string, role: Role, seen: Seen, store = browserStore()) {
  try {
    store?.setItem(key(address, role), JSON.stringify(seen));
  } catch {
    /* storage full or blocked: the next change is simply not celebrated */
  }
}
