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
//   - a wallet has at most one live plan, with a cap on preparation transactions and a short TTL;
//   - the final transaction's closes consume the registry entries, so a context is spent once and a
//     replay of an old preparation transaction after completion no longer references a registered
//     context.
//
// In-memory on purpose: a restart loses the registry, which fails closed (the client replans).
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

export function createRentPlanRegistry(now: () => number = Date.now) {
  const plans = new Map<string, Plan>();
  const owner = new Map<Address, string>();

  function drop(wallet: string) {
    const plan = plans.get(wallet);
    if (plan) for (const c of plan.contexts) if (owner.get(c) === wallet) owner.delete(c);
    plans.delete(wallet);
  }
  function sweep() {
    for (const [wallet, plan] of plans) if (now() - plan.startedAt > PLAN_TTL_MS) drop(wallet);
  }

  /**
   * Validates the transaction against the wallet's plan and applies it. Returns an `undo` that
   * restores the exact prior state; the caller invokes it if cosigning or sending fails.
   */
  function admit(wallet: string, use: ContextUse, walletSigns: boolean): () => void {
    sweep();
    if (!walletSigns && use.created.length + use.touched.length === 0) {
      throw new RejectedTransaction("a transaction the session wallet does not sign must create or verify a proof context", "no-wallet-relation");
    }
    const existing = plans.get(wallet);
    const createdHere = new Set(use.created);
    for (const c of use.created) {
      if (owner.has(c)) throw new RejectedTransaction(`context ${c} is already part of a plan`, "context-reused");
    }
    for (const c of use.touched) {
      if (createdHere.has(c)) continue;
      if (owner.get(c) !== wallet || !existing?.contexts.has(c)) {
        throw new RejectedTransaction(`context ${c} was not created for this wallet's rent payment`, "foreign-context");
      }
    }
    if (!walletSigns && existing !== undefined && existing.preparations >= MAX_PREPARATION_TXS) {
      throw new RejectedTransaction("this rent payment already used its preparation transactions", "plan-full");
    }

    const before = existing && { startedAt: existing.startedAt, preparations: existing.preparations, contexts: new Set(existing.contexts) };
    const plan = existing ?? { startedAt: now(), preparations: 0, contexts: new Set<Address>() };
    plans.set(wallet, plan);
    if (!walletSigns) plan.preparations++;
    for (const c of use.created) {
      plan.contexts.add(c);
      owner.set(c, wallet);
    }
    const spent: Address[] = [];
    for (const c of use.closed) {
      if (plan.contexts.delete(c)) {
        owner.delete(c);
        spent.push(c);
      }
    }
    if (walletSigns && plan.contexts.size === 0) plans.delete(wallet);

    return () => {
      for (const c of use.created) owner.delete(c);
      for (const c of spent) owner.set(c, wallet);
      if (before === undefined) plans.delete(wallet);
      else plans.set(wallet, { ...before });
      if (before) for (const c of before.contexts) owner.set(c, wallet);
    };
  }

  return { admit, size: () => plans.size, contextsOf: (w: string) => [...(plans.get(w)?.contexts ?? [])] };
}
export type RentPlanRegistry = ReturnType<typeof createRentPlanRegistry>;
