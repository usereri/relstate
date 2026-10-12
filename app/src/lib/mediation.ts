// Mediation, app half (docs/contracts/dispute-mediation.md).
//
// Every number the Mediation screens show — which round the lease is on, which step each side
// still owes, when the two windows close, who pays the appraiser and what each side is left with —
// is derived here, as pure functions over a `DisputeView`. No chain, no React, so each branch is
// testable without a validator.
//
// `verdictSplit` is deliberately a MIRROR of the program's own `verdict_split` (§6), because the
// fee line has to say what the payout will be before the appraiser signs. It is a preview, not a
// second authority: the program decides, and the only thing a drift here can cost is a wrong
// number on screen. The two live and die together — change §6 and change this.
import type { Role } from "@/lib/wallet";
import type { DisputeView } from "@/lib/chain";

/**
 * How many appraisers one side may put forward.
 *
 * Not a `#[constant]`, so it cannot come from the IDL like the window lengths do. The real cap is
 * the instruction's own shape: `propose_appraisers` has exactly three `Appraiser` slots, one
 * required and two optional (docs/contracts/dispute-mediation.md §4). Proposing fewer is always
 * allowed, so a program that grew a fourth slot would leave this merely conservative.
 */
export const MAX_CANDIDATES = 3;

/** The all-zero pubkey, which the program writes for "not set yet". */
export const UNSET_KEY = "11111111111111111111111111111111";

/**
 * A pubkey the program has actually written, or `""` for its all-zero "unset" marker.
 *
 * `Dispute.landlord_pick`, `.tenant_pick` and `.appraiser` all start all-zero and the convention
 * cannot collide with a real appraiser: `register_appraiser` refuses that key (§3).
 */
export const setKey = (base58: string): string => (base58 === UNSET_KEY ? "" : base58);

/** Where a mediation stands, and therefore which exits are open. */
export type MediationPhase =
  /** Nobody is bound yet: the two sides propose and pick, and past the selection deadline anyone may bind the default. */
  | "selecting"
  /** An appraiser is bound and still inside their window. */
  | "bound"
  /** The verdict window has passed: no verdict can land, and either party may end the mediation. */
  | "expired";

export function phase(d: DisputeView, now: number): MediationPhase {
  if (now >= d.verdictDeadline) return "expired";
  return d.appraiser ? "bound" : "selecting";
}

// ---- the rounds before mediation ------------------------------------------------------

/**
 * What the tenant's rejection of the current proposal does.
 *
 * `abandon` voids the proposal and returns the lease to `Active` so the landlord may propose once
 * more; `escalate` is the last rejection, which enters `Mediation`. `exhausted` means the rounds
 * are already spent, so there is nothing left to reject (the program would refuse a further
 * deduction with `DisputeRoundsExhausted`).
 */
export function rejection(disputeRounds: number, maxRounds: number): "abandon" | "escalate" | "exhausted" {
  if (disputeRounds + 1 < maxRounds) return "abandon";
  if (disputeRounds + 1 === maxRounds) return "escalate";
  return "exhausted";
}

/** "Round 1 of 2": the rejection being decided now, or the last one once they are spent. */
export const roundLabel = (disputeRounds: number, maxRounds: number): string =>
  `Round ${Math.min(disputeRounds + 1, maxRounds)} of ${maxRounds}`;

// ---- candidates and picks -------------------------------------------------------------

export interface CandidateState {
  wallet: string;
  /** Which sides put this appraiser forward. Overlap across sides is how the two converge (§4). */
  proposedBy: Role[];
  landlordPicked: boolean;
  tenantPicked: boolean;
  /** Both sides picked this one, so the program bound it on the second pick. */
  agreed: boolean;
}

/**
 * Every appraiser either side proposed, in the landlord's order then the tenant's additions.
 *
 * A pick must come from this union (`CandidateNotProposed`), including the other side's half:
 * picking from the other list is the intended way to converge.
 */
export function candidates(d: DisputeView): CandidateState[] {
  const union = [...d.landlordCandidates, ...d.tenantCandidates.filter((w) => !d.landlordCandidates.includes(w))];
  return union.map((wallet) => {
    const landlordPicked = wallet === d.landlordPick;
    const tenantPicked = wallet === d.tenantPick;
    return {
      wallet,
      proposedBy: [
        ...(d.landlordCandidates.includes(wallet) ? (["landlord"] as Role[]) : []),
        ...(d.tenantCandidates.includes(wallet) ? (["tenant"] as Role[]) : []),
      ],
      landlordPicked,
      tenantPicked,
      agreed: landlordPicked && tenantPicked,
    };
  });
}

export const candidatesOf = (d: DisputeView, role: Role): string[] =>
  role === "landlord" ? d.landlordCandidates : d.tenantCandidates;

export const pickOf = (d: DisputeView, role: Role): string => (role === "landlord" ? d.landlordPick : d.tenantPick);

export const other = (role: Role): Role => (role === "landlord" ? "tenant" : "landlord");

/** A side proposes once and only while nothing is bound (`CandidatesAlreadyProposed`, `AppraiserAlreadyBound`). */
export const canPropose = (d: DisputeView, role: Role): boolean => !d.appraiser && candidatesOf(d, role).length === 0;

/**
 * Picking stays open until something is bound, past the selection deadline included, and a side
 * may change its pick: a side that picked badly must not be able to deadlock out of pride (§4).
 */
export const canPick = (d: DisputeView, role: Role): boolean =>
  !d.appraiser && candidates(d).some((c) => c.wallet !== pickOf(d, role));

/** After the selection deadline with nothing bound, anyone may bind the registry's default (`SelectionWindowOpen`). */
export const canBindDefault = (d: DisputeView, now: number): boolean => !d.appraiser && now >= d.selectionDeadline;

/** After the verdict deadline either party ends the mediation, bound appraiser or not (`VerdictWindowOpen`). */
export const canExpire = (d: DisputeView, now: number): boolean => now >= d.verdictDeadline;

/** What this side still owes in the selection step. */
export function step(d: DisputeView, role: Role, now: number): "propose" | "pick" | "waiting" | "bound" | "expired" {
  if (now >= d.verdictDeadline) return "expired";
  if (d.appraiser) return "bound";
  if (candidates(d).length === 0) return "propose";
  if (!pickOf(d, role)) return "pick";
  return "waiting";
}

// ---- the fee, and what the payout would be --------------------------------------------

/** The most the appraiser can take from this deposit: the per-lease cap, integer division (§6). */
export const feeCap = (deposit: number, divisor: number): number => Math.floor(deposit / divisor);

/** `fee = min(appraiser.fee, deposit / APPRAISER_FEE_CAP_DIVISOR)`. */
export const feeFor = (deposit: number, appraiserFee: number, divisor: number): number =>
  Math.min(appraiserFee, feeCap(deposit, divisor));

/**
 * The highest fee among the appraisers still in play, which is what the appraisal can cost at
 * worst while nobody is bound yet. 0 for an empty list, so the fee line reads as a bound either way.
 */
export const topFee = (fees: number[]): number => fees.reduce((most, f) => Math.max(most, f), 0);

/** Which side the fee comes out of: the one the verdict went against. A tie (`2d == deposit`) is the tenant's win. */
export const feePayer = (deposit: number, deduction: number): Role => (2 * deduction > deposit ? "tenant" : "landlord");

export interface Split {
  toTenant: number;
  toLandlord: number;
  /** What the appraiser actually receives: `fee`, or less when the losing refund cannot cover it. */
  feePaid: number;
}

/**
 * The program's `verdict_split` (§6): loser pays, out of the deposit, and the vault drains to zero.
 *
 * `toTenant + toLandlord + feePaid === deposit` in both branches, which is the conservation
 * invariant the program's own tests pin.
 */
export function verdictSplit(deposit: number, deduction: number, fee: number): Split {
  if (2 * deduction > deposit) {
    // The landlord won: the tenant pays, and never more than their refund holds.
    const feePaid = Math.min(fee, deposit - deduction);
    return { toTenant: deposit - deduction - feePaid, toLandlord: deduction, feePaid };
  }
  // The tenant won: the landlord pays as far as their share reaches, the remainder comes last
  // out of the tenant's refund. A verdict of 0 is a total win that the tenant still pays for —
  // the known limitation §6 states, because the landlord's share is zero.
  const fromLandlord = Math.min(fee, deduction);
  const fromTenant = fee - fromLandlord;
  return { toTenant: deposit - deduction - fromTenant, toLandlord: deduction - fromLandlord, feePaid: fee };
}

// ---- the timeline -------------------------------------------------------------------

export interface TimelineStep {
  key: "opened" | "selection" | "verdict";
  label: string;
  /** Unix seconds: when it happened, or the deadline it runs to. 0 when there is no date to show. */
  at: number;
  state: "done" | "now" | "later";
}

/**
 * The three dated points of a mediation, for the status timeline.
 *
 * `openedAt` is `lease.disputed_at`, which `escalate_to_mediation` re-stamps: the `Dispute`
 * account deliberately keeps no second copy of it (§3). Binding has no timestamp on chain, so a
 * step that is already over carries no date rather than the deadline it beat.
 */
export function timeline(d: DisputeView, openedAt: number, now: number): TimelineStep[] {
  const p = phase(d, now);
  const selection: TimelineStep = d.appraiser
    ? { key: "selection", label: "Appraiser agreed", at: 0, state: "done" }
    : p === "expired"
      ? { key: "selection", label: "No appraiser was agreed", at: d.selectionDeadline, state: "done" }
      : now >= d.selectionDeadline
        ? { key: "selection", label: "Fallback appraiser can be bound", at: d.selectionDeadline, state: "now" }
        : { key: "selection", label: "Both sides agree on an appraiser", at: d.selectionDeadline, state: "now" };
  return [
    { key: "opened", label: "Mediation opened", at: openedAt, state: "done" },
    selection,
    {
      key: "verdict",
      label: p === "expired" ? "Verdict window closed" : "The appraiser decides",
      at: d.verdictDeadline,
      state: p === "expired" ? "done" : p === "bound" ? "now" : "later",
    },
  ];
}
