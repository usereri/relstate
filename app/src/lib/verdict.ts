// The appraiser's verdict, client half (docs/contracts/dispute-mediation.md §4 phase 3).
//
// There is no console and no backend-held key any more. The appraiser signs with the wallet their
// own sign-in created, the one both parties confirmed on chain, and `chain.submitVerdict` sends it.
// So nothing here talks to a backend: what is left is the arithmetic and the guard rails that made
// the old console safe to put a deposit behind, which are worth keeping whoever holds the key.
//
//   * the number is parsed exactly, never coerced (`parseAmountInput`, lib/utils.ts);
//   * the bounds and the state are checked before anything is signed (`verdictProblem`);
//   * the split is previewed from §6 before the confirm, and editing the number disarms the
//     confirm, so a confirmation is never a second, unreviewed decision (`confirmGate`).
//
// Free of React and of web3.js, so all of it is testable without a DOM.
import { usdc } from "@/lib/utils";

/**
 * Why this verdict must not be sent, checked before anything is signed.
 *
 * The program enforces all of it — `0 <= deduction <= deposit`, `Status::Mediation`, and that the
 * signer is the bound wallet — so this is not the guard. It is the appraiser not having to learn
 * the rules from a failed transaction, on the one screen that moves somebody's deposit.
 */
export function verdictProblem(args: {
  deductionBase: number;
  deposit: number;
  status: string;
  /** `dispute.appraiser`: the wallet both parties confirmed. */
  appraiser: string;
  /** The signed-in wallet, when the caller knows it. Omitted means "do not check whose case it is". */
  mine?: string;
}): string | null {
  const { deductionBase, deposit, status, appraiser, mine = "" } = args;
  if (status !== "mediation")
    return `This lease is ${status === "closed" ? "already finished" : `"${status}"`}, not in mediation, so there is no verdict to give.`;
  if (!appraiser) return "No appraiser has been confirmed on this lease yet, so nobody is entitled to decide it.";
  if (mine && appraiser !== mine) return "This case is not yours to decide: the two parties confirmed a different account.";
  if (deductionBase > deposit)
    return `A verdict cannot be more than the deposit: ${usdc(deductionBase)} USDC is above the ${usdc(deposit)} USDC this lease holds.`;
  return null;
}

/** The question a confirmation answers: one lease and one exact number of base units. */
export const asked = (lease: string, deductionBase: number): string => `${lease}:${deductionBase}`;

/** Why the submit button is or is not armed. */
export type ConfirmGate =
  | { armed: true }
  /** Nothing has been confirmed yet: the appraiser has not seen the split. */
  | { armed: false; reason: "none" }
  /** The number changed after the split was shown, so what was reviewed is not what would be sent. */
  | { armed: false; reason: "stale" };

/**
 * Whether a held confirmation authorises submitting this lease and this amount.
 *
 * The preview is the whole safety story now that the app's own `verdictSplit` is the only
 * arithmetic on screen: the appraiser is shown what each side receives, confirms *that*, and
 * then — and only then — the submit is live. Editing the number afterwards disarms it, because a
 * confirmation carried over to a different number would be approval borrowed from a decision
 * nobody made.
 */
export function confirmGate(confirmed: string | null | undefined, lease: string, deductionBase: number): ConfirmGate {
  if (!confirmed) return { armed: false, reason: "none" };
  if (confirmed !== asked(lease, deductionBase)) return { armed: false, reason: "stale" };
  return { armed: true };
}
