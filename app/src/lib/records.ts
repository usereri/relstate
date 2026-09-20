import * as chain from "@/lib/chain";
import { ProfileView, Role, typicalRent } from "@/lib/chain";
import { useChain } from "@/lib/useChain";
import { usdc } from "@/lib/utils";

export const unique = (xs: string[]) => [...new Set(xs)];
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The record of each wallet in `addresses`, keyed by address (undefined while it loads). */
export function useRecords(addresses: string[]) {
  return (
    useChain(
      async () => Object.fromEntries(await Promise.all(addresses.map(async (a) => [a, await chain.loadProfile(a)] as const))) as Record<string, ProfileView | null>,
      [addresses.join()],
    ) ?? {}
  );
}

/** One line about a counterparty's record. */
export const recordLine = (counterparty: Role, p: ProfileView | null | undefined) => {
  if (p === undefined) return "Loading their record…";
  if (!p) return "No record yet: their first lease.";
  if (counterparty === "tenant") {
    const paid = p.paidOnTime + p.paidLate;
    return `${count(p.leasesCompleted, "lease")} completed · ${paid ? `${Math.round((p.paidOnTime / paid) * 100)}% paid on time` : "no rent paid yet"} · typical rent ${typicalRent(p) ? usdc(typicalRent(p)) : "—"} USDC`;
  }
  return `${count(p.leasesCompleted, "lease")} completed · ${count(p.depositsReturnedFull, "deposit")} returned in full · ${p.depositsClaimed} claimed by tenants`;
};
