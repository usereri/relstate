// Mediation, app half (docs/contracts/dispute-mediation.md, revision 2).
//
// Everything the Mediation screens show — which round the lease is on, which of the two selection
// phases is live, which step each side still owes, when the one deadline closes, who pays the
// appraiser and what each side is left with — is derived here, as pure functions over a
// `DisputeView`. No chain, no React, so each branch is testable without a validator.
//
// **The phases key on `appraiser` and `agreed_name_hash`, NEVER on `verdict_deadline`.** That
// field is 0 until a binding writes it (§3), so reading it as a deadline renders every fresh
// mediation as already expired and offers an expiry the program answers with `SelectionWindowOpen`
// — which is exactly what the revision-1 app did, and the first thing review G2 asks to fix.
//
// `verdictSplit` is deliberately a MIRROR of the program's own `verdict_split` (§6), because the
// fee line has to say what the payout will be before the appraiser signs. It is a preview, not a
// second authority: the program decides, and the only thing a drift here can cost is a wrong
// number on screen. The two live and die together — change §6 and change this.
import idl from "@target/idl/relstate.json";
import type { Role } from "@/lib/wallet";
import type { CandidateView, DisputeView } from "@/lib/chain";

/**
 * How many times ONE party may (re)propose the appraiser's wallet, from the IDL.
 *
 * A `#[constant]` since review G4, which is what lets the screen say "one proposal left" instead
 * of hard-coding a number the program could change. The budget is per party, so one side can never
 * burn the other's: whatever the first party does, the other can always counter-propose.
 */
export const MAX_KEY_PROPOSALS_PER_PARTY = Number(idl.constants.find((c) => c.name === "MAX_KEY_PROPOSALS_PER_PARTY")!.value);

/** The all-zero pubkey, which the program writes for "not set yet". */
export const UNSET_KEY = "11111111111111111111111111111111";

/**
 * A pubkey the program has actually written, or `""` for its all-zero "unset" marker.
 *
 * `Dispute.proposed_key`, `.key_proposer` and `.appraiser` all start all-zero and the convention
 * cannot collide with a real wallet: `propose_appraiser_key` refuses that key outright
 * (`InvalidAppraiserKey`, §3).
 */
export const setKey = (base58: string): string => (base58 === UNSET_KEY ? "" : base58);

/**
 * Which of the three structural states a mediation is in. Deliberately no `now`: this is where the
 * selection *stands*, not whether its window is still open ({@link selectionOpen}).
 *
 *   `names`   nothing agreed yet — each side names companies and picks one
 *   `wallet`  a company is agreed; one party proposes a wallet for it and the other confirms
 *   `bound`   a wallet is bound and the verdict window is running
 */
export type MediationPhase = "names" | "wallet" | "bound";

export const phase = (d: DisputeView): MediationPhase => (d.appraiser ? "bound" : d.agreedNameHash ? "wallet" : "names");

/**
 * Whether anything may still be proposed, picked or confirmed.
 *
 * One deadline covers both phases (§2), and the program's guard is exactly `!bound && now <
 * selection_deadline` — the precise complement of the unbound `expire_mediation`, so no
 * confirmation can land once expiry is available and a lapsed mediation can never be re-armed.
 */
export const selectionOpen = (d: DisputeView, now: number): boolean => !d.appraiser && now < d.selectionDeadline;

/** Selection ran out with nothing bound: the only moves left are expiry and a settlement. */
export const lapsed = (d: DisputeView, now: number): boolean => !d.appraiser && now >= d.selectionDeadline;

/** The bound appraiser is still inside their window, so a verdict can still land. */
export const verdictOpen = (d: DisputeView, now: number): boolean => !!d.appraiser && now < d.verdictDeadline;

/**
 * When either party may end the mediation (§2).
 *
 * Unbound it is the SELECTION deadline; bound it is the verdict deadline. One branch each, because
 * `verdict_deadline` is 0 while nothing is bound and a single `now >= verdictDeadline` would
 * therefore be true from the first second (G2).
 */
export const canExpire = (d: DisputeView, now: number): boolean =>
  d.appraiser ? now >= d.verdictDeadline : now >= d.selectionDeadline;

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

// ---- phase 1: companies by name ------------------------------------------------------

export interface CandidateRow {
  /** The normalised display name the program stored, which is what a person reads. */
  name: string;
  /** `sha256(canonical(name))`, the only thing the program compares. The row's identity. */
  nameHashHex: string;
  /**
   * The fee that would be agreed for this company: the LOWEST either side quoted for it.
   *
   * Mirrors `lowest_fee` (§4) — if both sides proposed the same company at different fees, the
   * lower one wins, so this is the number to show before the pick as well as after it.
   */
  fee: number;
  /** Which sides put this company forward. Overlap across sides is agreement arriving early. */
  proposedBy: Role[];
  landlordPicked: boolean;
  tenantPicked: boolean;
  /** This is the agreed company: both picks named it, so the name and the fee are settled. */
  agreed: boolean;
}

/**
 * Every company either side named, as one list, in the landlord's order then the tenant's
 * additions.
 *
 * A pick must come from this union (`CandidateNotProposed`), the other side's half included:
 * picking from the other list is the intended way for the two to converge. Rows are keyed by
 * `name_hash`, so the same company spelled with different case or spacing on the two lists is ONE
 * row — which is what the program does too. The spelling shown is the first one encountered (the
 * landlord's, when both named it), and the fee is the lower of the two.
 */
export function candidates(d: DisputeView): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const add = (role: Role) => (c: CandidateView) => {
    const held = rows.find((r) => r.nameHashHex === c.nameHashHex);
    if (held) {
      if (!held.proposedBy.includes(role)) held.proposedBy.push(role);
      held.fee = Math.min(held.fee, c.fee);
      return;
    }
    rows.push({
      name: c.name,
      nameHashHex: c.nameHashHex,
      fee: c.fee,
      proposedBy: [role],
      // Guarded against the unset marker: an unpicked side's `pick` is "", and so is a row's hash
      // only if the chain ever stored an empty candidate, which it cannot.
      landlordPicked: !!d.landlordPick && d.landlordPick === c.nameHashHex,
      tenantPicked: !!d.tenantPick && d.tenantPick === c.nameHashHex,
      agreed: !!d.agreedNameHash && d.agreedNameHash === c.nameHashHex,
    });
  };
  d.landlordCandidates.forEach(add("landlord"));
  d.tenantCandidates.forEach(add("tenant"));
  return rows;
}

export const candidatesOf = (d: DisputeView, role: Role): CandidateView[] =>
  role === "landlord" ? d.landlordCandidates : d.tenantCandidates;

/** This side's pick, as a `name_hash`; `""` until they pick. */
export const pickOf = (d: DisputeView, role: Role): string => (role === "landlord" ? d.landlordPick : d.tenantPick);

/** The row this side picked, or undefined when they have not picked (or the row has gone). */
export const pickedRow = (d: DisputeView, role: Role): CandidateRow | undefined => {
  const hash = pickOf(d, role);
  return hash ? candidates(d).find((c) => c.nameHashHex === hash) : undefined;
};

/** The agreed company's name, or `""` while phase 1 is still running. */
export const agreedName = (d: DisputeView): string =>
  (d.agreedNameHash ? candidates(d).find((c) => c.nameHashHex === d.agreedNameHash)?.name : "") ?? "";

export const other = (role: Role): Role => (role === "landlord" ? "tenant" : "landlord");

/** Which side of this lease a wallet is, or `""` for anybody else. */
export const roleOf = (parties: Parties, wallet: string): Role | "" =>
  wallet && wallet === parties.landlord ? "landlord" : wallet && wallet === parties.tenant ? "tenant" : "";

/** The two wallets the program recognises on a lease. `LeaseView` satisfies it. */
export interface Parties {
  landlord: string;
  tenant: string;
}

/**
 * A side names its companies once (`CandidatesAlreadyProposed`), only before the company is agreed
 * (`NameAlreadyAgreed`), and only while the selection window is open (`SelectionWindowClosed`).
 */
export const canProposeNames = (d: DisputeView, role: Role, now: number): boolean =>
  selectionOpen(d, now) && !d.agreedNameHash && candidatesOf(d, role).length === 0;

/**
 * Picking stays open until the company is agreed, and a side may change its pick: a side that
 * picked badly must not be able to deadlock the selection out of pride (§4). There has to be
 * something new to pick, which is why a list holding only this side's own pick does not count.
 */
export const canPick = (d: DisputeView, role: Role, now: number): boolean =>
  selectionOpen(d, now) && !d.agreedNameHash && candidates(d).some((c) => c.nameHashHex !== pickOf(d, role));

// ---- phase 2: the appraiser's wallet --------------------------------------------------

export const keyProposalsOf = (d: DisputeView, role: Role): number =>
  role === "landlord" ? d.landlordKeyProposals : d.tenantKeyProposals;

/** This side's own remaining proposals; the other side's budget is untouched by them (G4). */
export const keyProposalsLeft = (d: DisputeView, role: Role): number =>
  Math.max(0, MAX_KEY_PROPOSALS_PER_PARTY - keyProposalsOf(d, role));

/** Which side proposed the wallet now on the table, or `""` when none is proposed. */
export const proposerRole = (d: DisputeView, parties: Parties): Role | "" =>
  d.proposedKey ? roleOf(parties, d.keyProposer) : "";

/**
 * A party may propose a wallet once the company is agreed (`NameNotAgreed`), while the selection
 * window is open, and while their own budget holds (`KeyProposalsExhausted`).
 */
export const canProposeKey = (d: DisputeView, role: Role, now: number): boolean =>
  selectionOpen(d, now) && !!d.agreedNameHash && keyProposalsLeft(d, role) > 0;

/**
 * Only the party that did NOT propose may confirm (`CannotConfirmOwnProposal`), which is what makes
 * a one-sided sockpuppet impossible: binding needs both wallets to have named the same one.
 */
export const canConfirmKey = (d: DisputeView, parties: Parties, role: Role, now: number): boolean => {
  const by = proposerRole(d, parties);
  return selectionOpen(d, now) && !!d.agreedNameHash && !!d.proposedKey && !!by && by !== role;
};

/** What this side still owes, as one word, for the step indicator and the primary button. */
export type MediationStep =
  /** Phase 1: nobody has anything to pick from until this side (or the other) names companies. */
  | "propose-names"
  /** Phase 1: a list exists and this side has not picked from it. */
  | "pick"
  /** Phase 2: the company is agreed and nobody has put a wallet forward — invite the company. */
  | "invite"
  /** Phase 2: the other side proposed a wallet and this side is the one that may confirm it. */
  | "confirm-key"
  /** The move is the other side's. */
  | "waiting"
  /** A wallet is bound; the appraiser is deciding. */
  | "bound"
  /** The selection window closed with nothing bound: expire it, or settle together. */
  | "lapsed";

export function step(d: DisputeView, parties: Parties, role: Role, now: number): MediationStep {
  if (d.appraiser) return "bound";
  if (now >= d.selectionDeadline) return "lapsed";
  if (!d.agreedNameHash) {
    if (candidates(d).length === 0) return "propose-names";
    if (!pickOf(d, role)) return "pick";
    return "waiting";
  }
  if (d.proposedKey) return canConfirmKey(d, parties, role, now) ? "confirm-key" : "waiting";
  return keyProposalsLeft(d, role) > 0 ? "invite" : "waiting";
}

// ---- the fee, and what the payout would be --------------------------------------------

/** The most the appraiser can take from this deposit: the per-lease cap, integer division (§6). */
export const feeCap = (deposit: number, divisor: number): number => Math.floor(deposit / divisor);

/** `fee = min(agreed_fee, deposit / APPRAISER_FEE_CAP_DIVISOR)`, which is what the verdict applies. */
export const feeFor = (deposit: number, agreedFee: number, divisor: number): number =>
  Math.min(agreedFee, feeCap(deposit, divisor));

/**
 * What the appraisal can cost as things stand: the agreed fee once there is one, otherwise the
 * highest quote still in play. 0 for an empty list, so the fee line reads as a bound either way.
 */
export const feeInPlay = (d: DisputeView): number =>
  d.agreedNameHash ? d.agreedFee : candidates(d).reduce((most, c) => Math.max(most, c.fee), 0);

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
  key: "opened" | "company" | "wallet" | "verdict";
  label: string;
  /** Unix seconds: when it happened, or the deadline it runs to. 0 when there is no date to show. */
  at: number;
  state: "done" | "now" | "later";
}

/**
 * The dated points of a mediation, for the status timeline.
 *
 * `openedAt` is `lease.disputed_at`, which `escalate_to_mediation` re-stamps: the `Dispute` account
 * deliberately keeps no second copy of it (§3). Both selection phases run to the SAME deadline, so
 * the same date appears on whichever of them is live — there is no second window to show. And the
 * verdict step carries **no date at all** until a binding writes one, because `verdict_deadline` is
 * 0 before that and printing it would read as a deadline in 1970 (G2).
 */
export function timeline(d: DisputeView, openedAt: number, now: number): TimelineStep[] {
  const bound = !!d.appraiser;
  const agreed = !!d.agreedNameHash;
  const closed = now >= d.selectionDeadline;
  const company: TimelineStep = agreed
    ? { key: "company", label: "You agreed on a company", at: 0, state: "done" }
    : closed
      ? { key: "company", label: "No company was agreed", at: d.selectionDeadline, state: "done" }
      : { key: "company", label: "Agree on an appraisal company", at: d.selectionDeadline, state: "now" };
  const wallet: TimelineStep = bound
    ? { key: "wallet", label: "The appraiser's account is confirmed", at: 0, state: "done" }
    : closed
      ? { key: "wallet", label: "The appraiser's account was never confirmed", at: d.selectionDeadline, state: "done" }
      : { key: "wallet", label: "Confirm the appraiser's account", at: d.selectionDeadline, state: agreed ? "now" : "later" };
  const verdict: TimelineStep = bound
    ? now < d.verdictDeadline
      ? { key: "verdict", label: "The appraiser decides", at: d.verdictDeadline, state: "now" }
      : { key: "verdict", label: "The appraiser's window closed with no answer", at: d.verdictDeadline, state: "done" }
    : closed
      ? { key: "verdict", label: "No appraiser was bound, so there is no verdict", at: 0, state: "done" }
      : { key: "verdict", label: "The appraiser decides", at: 0, state: "later" };
  return [{ key: "opened", label: "Mediation opened", at: openedAt, state: "done" }, company, wallet, verdict];
}
