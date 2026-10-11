// Binds the proof context-state accounts of a confidential rent payment to the session wallet that
// paid for them.
//
// The real plan has 5 transactions and only the last one (transfer + pay_rent) is signed by the
// tenant; the four before it are signed by throwaway context-account keypairs and the treasury, so
// the wallet is not a signer of them. A per-transaction "wallet must sign" rule therefore cannot
// hold. What binds them instead is this registry:
//
//   - a transaction the wallet does not sign is accepted only as a PREPARATION transaction: it must
//     create or verify a proof context, and every context it touches must either be created in that
//     same transaction or already be registered to THIS wallet by an earlier accepted transaction;
//   - an account that is registered to any wallet cannot be created again by another, and one
//     wallet's contexts cannot be verified or closed by another wallet's session;
//   - a wallet has at most one live plan, with a cap on preparation transactions (any transaction that
//     creates a context counts, whoever signs it) and a short TTL;
//   - the final transaction's closes consume the registry entries, so a context is spent once and a
//     replay of an old preparation transaction after completion no longer references a registered
//     context.
//
// In-memory on purpose: a restart loses the registry, which fails closed (the client replans); see
// docs/contracts/treasury.md for the funds left behind and scripts/reclaim-contexts.ts.
import type { Address } from "@solana/kit";
import { SYSTEM_PROGRAM, ZK_ELGAMAL_PROOF_PROGRAM } from "./contracts.ts";
import { RejectedTransaction, type InspectedTransaction } from "./txinspect.ts";

export const PLAN_TTL_MS = 5 * 60_000;
/** The real plan has four preparation transactions; two spare absorb a retry. */
export const MAX_PREPARATION_TXS = 6;

export type ContextUse = { created: Address[]; touched: Address[]; closed: Address[] };

/** Which context-state accounts a (shape-checked) transaction creates, verifies into, or closes. */
export function contextUse(tx: InspectedTransaction): ContextUse {
  const use: ContextUse = { created: [], touched: [], closed: [] };
  for (const ix of tx.instructions) {
    if (ix.programAddress === SYSTEM_PROGRAM) {
      const created = ix.accounts[1]?.address;
      if (created !== undefined) use.created.push(created);
    } else if (ix.programAddress === ZK_ELGAMAL_PROOF_PROGRAM) {
      const ctx = ix.accounts[0]?.address;
      if (ctx === undefined) continue;
      use.touched.push(ctx);
      if (ix.data[0] === 0) use.closed.push(ctx);
    }
  }
  return use;
}

type Plan = { startedAt: number; preparations: number; contexts: Set<Address> };

/** Wallets with a live plan at once. A plan costs a treasury-funded create to start; this bounds memory regardless. */
export const MAX_LIVE_PLANS = 2_000;

export function createRentPlanRegistry(now: () => number = Date.now) {
  // The ONLY store: wallet -> plan. Ownership of a context is derived by scanning it (a handful of
  // entries per wallet, bounded by MAX_LIVE_PLANS), so there is no second map to fall out of step.
  const plans = new Map<string, Plan>();

  const ownerOf = (c: Address): string | undefined => {
    for (const [wallet, plan] of plans) if (plan.contexts.has(c)) return wallet;
    return undefined;
  };
  function sweep() {
    for (const [wallet, plan] of plans) if (now() - plan.startedAt > PLAN_TTL_MS) plans.delete(wallet);
  }

  /**
   * Validates the transaction against the wallet's plan and applies it, atomically (no await).
   * `preparing` is true for any transaction that is not the wallet's final one: one the wallet does
   * not sign, or one that creates a context whoever signs it. Those count against the plan cap.
   *
   * Returns an `undo` that reverses exactly this call's delta and nothing else, once: it never
   * restores a snapshot, so a concurrent request's writes survive it, and calling it twice is a no-op.
   */
  function admit(wallet: string, use: ContextUse, walletSigns: boolean): () => void {
    sweep();
    const preparing = !walletSigns || use.created.length > 0;
    if (!walletSigns && use.created.length + use.touched.length === 0) {
      throw new RejectedTransaction("a transaction the session wallet does not sign must create or verify a proof context", "no-wallet-relation");
    }
    const existing = plans.get(wallet);
    const createdHere = new Set(use.created);
    for (const c of use.created) {
      if (ownerOf(c) !== undefined) throw new RejectedTransaction(`context ${c} is already part of a plan`, "context-reused");
    }
    for (const c of use.touched) {
      if (createdHere.has(c)) continue;
      if (!existing?.contexts.has(c)) throw new RejectedTransaction(`context ${c} was not created for this wallet's rent payment`, "foreign-context");
    }
    if (preparing && existing !== undefined && existing.preparations >= MAX_PREPARATION_TXS) {
      throw new RejectedTransaction("this rent payment already used its preparation transactions", "plan-full");
    }
    if (existing === undefined && use.created.length > 0 && plans.size >= MAX_LIVE_PLANS) {
      throw new RejectedTransaction("too many rent payments in progress", "registry-full");
    }

    const plan = existing ?? { startedAt: now(), preparations: 0, contexts: new Set<Address>() };
    const planWasNew = existing === undefined;
    if (planWasNew && (use.created.length > 0 || preparing)) plans.set(wallet, plan);
    if (preparing) plan.preparations++;
    // A context created and closed in the same transaction nets out to nothing.
    const closedHere = new Set(use.closed);
    const added = use.created.filter((c) => !closedHere.has(c));
    for (const c of added) plan.contexts.add(c);
    const spent = use.closed.filter((c) => !createdHere.has(c) && plan.contexts.delete(c));
    let removedPlan = false;
    if (walletSigns && plan.contexts.size === 0 && plans.get(wallet) === plan) {
      plans.delete(wallet);
      removedPlan = true;
    }

    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      let live = plans.get(wallet);
      if (live === undefined) {
        // Absent: either this call's own final-transaction removal (bring the plan back) or the sweep (leave it gone).
        if (!removedPlan) return;
        plans.set(wallet, plan);
        live = plan;
      } else if (live !== plan && !removedPlan) {
        return; // the plan expired and a newer one took its place: this delta belongs to the old one
      }
      for (const c of added) live.contexts.delete(c);
      // Re-register what this call consumed, unless another wallet has since claimed the address.
      for (const c of spent) if (ownerOf(c) === undefined) live.contexts.add(c);
      if (preparing && live.preparations > 0) live.preparations--;
      if (live.contexts.size === 0 && live.preparations === 0) plans.delete(wallet);
    };
  }

  return { admit, size: () => plans.size, contextsOf: (w: string) => [...(plans.get(w)?.contexts ?? [])], ownerOf };
}
export type RentPlanRegistry = ReturnType<typeof createRentPlanRegistry>;
