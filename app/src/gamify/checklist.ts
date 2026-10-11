/**
 * The new tenant's onboarding checklist.
 *
 * Every step is answered by something real: a connected wallet, a token balance, an application or
 * lease on chain, a payment counter on the profile. Nothing is remembered locally to make a step
 * look done. The one step with no answer yet is identity verification, which belongs to the KYC
 * workstream; until that lands it is shown as "coming soon" and is deliberately not counted as
 * work the tenant can do, so the list can still be completed.
 */

export type StepState = "done" | "todo" | "soon";

export interface Step {
  id: "account" | "identity" | "topup" | "apply" | "rent";
  label: string;
  /** what to do, or what happened */
  detail: string;
  state: StepState;
}

export interface OnboardingState {
  /** a wallet is connected, so there is an account to attach a record to */
  signedIn: boolean;
  /** public lease-mint balance in base units, or null when the wallet has no token account yet (a private top-up leaves it at 0) */
  balance: number | null;
  /** an application or a lease exists for this wallet */
  applied: boolean;
  /** the profile counters show at least one rent payment */
  rentPaid: boolean;
  /** KYC is workstream D; "soon" until it lands */
  identity?: StepState;
}

const state = (done: boolean): StepState => (done ? "done" : "todo");

export function checklist(s: OnboardingState): Step[] {
  // The token account exists once the top-up has minted to it. Its PUBLIC balance can legitimately be 0
  // afterwards, because the browser moves the credit into the private balance, so a balance check
  // would never tick for exactly the people who completed the flow.
  const funded = s.balance !== null;
  return [
    {
      id: "account",
      label: "Create your account",
      detail: s.signedIn ? "Your wallet holds the record. Nobody else can edit it." : "Sign in to get a wallet. No bank account needed.",
      state: state(s.signedIn),
    },
    {
      id: "identity",
      label: "Verify your identity",
      detail:
        s.identity === "done"
          ? "Verified. Only a level and an expiry are recorded, never your documents."
          : s.identity === "todo"
            ? "One quick check, reusable with every landlord. Open the Verify tab."
            : "Coming soon: one check, reusable with every landlord.",
      state: s.identity ?? "soon",
    },
    {
      id: "topup",
      label: "Top up your balance",
      detail: funded ? "Ready to cover a deposit." : "Add funds by card, so the deposit can go into the vault.",
      state: state(funded),
    },
    {
      id: "apply",
      label: "Apply to a listing",
      detail: s.applied ? "Applied. The landlord sees your record with it." : "Browse the apartments below and apply in one click.",
      state: state(s.applied),
    },
    {
      id: "rent",
      label: "Pay your first rent",
      detail: s.rentPaid ? "On the record, written by the program." : "Your first payment starts the record that follows you.",
      state: state(s.rentPaid),
    },
  ];
}

/** Steps the tenant can actually act on right now. "Coming soon" is not one of them. */
export const openSteps = (steps: Step[]) => steps.filter((s) => s.state === "todo");

/** True once nothing is left to do, which is when the checklist stops being shown. */
export const onboarded = (steps: Step[]) => openSteps(steps).length === 0;

const key = (address: string) => `relstate.gamify.onboarded.${address}`;

/**
 * Once a wallet has finished the list, remember it, so an established tenant's browser does not
 * keep polling the chain for an answer it already has. It is a cache of a chain-derived fact, never
 * the source of one: with it unset the steps are read from the chain as usual.
 */
export const wasOnboarded = (address: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(key(address)) === "1";
  } catch {
    return false;
  }
};

export const rememberOnboarded = (address: string) => {
  try {
    globalThis.localStorage?.setItem(key(address), "1");
  } catch {
    /* private mode: the list is simply derived again next time */
  }
};
