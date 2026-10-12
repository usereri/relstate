/**
 * Badges, derived from the same on-chain counters as the levels. Nothing here is stored.
 *
 * An unearned badge is still listed, greyed out, with the counter that would earn it: the point is
 * to show what the record is missing, not to hide it.
 */
import { DISCOUNT_PCT, goodStanding } from "@/lib/chain";
import type { ProfileView, Role } from "@/lib/chain";

export type BadgeId =
  | "first-rent"
  | "on-time-run"
  | "deposit-returned"
  | "cross-border"
  | "discount"
  | "first-lease"
  | "no-claims";

export interface BadgeState {
  id: BadgeId;
  label: string;
  /** what it means, or what is still missing */
  hint: string;
  earned: boolean;
}

export function badgesFor(role: Role, profile: ProfileView | null, countries: string[] = []): BadgeState[] {
  const p = profile;
  const onTime = p?.paidOnTime ?? 0;
  const late = p?.paidLate ?? 0;
  const completed = p?.leasesCompleted ?? 0;
  const returnedFull = p?.depositsReturnedFull ?? 0;
  const claimed = p?.depositsClaimed ?? 0;
  const places = countries.length;

  const crossBorder: BadgeState = {
    id: "cross-border",
    label: "Cross-border",
    hint: places >= 2 ? `Finished leases in ${places} countries: ${countries.join(", ")}.` : "A finished lease in a second country.",
    earned: places >= 2,
  };

  if (role === "landlord")
    return [
      {
        id: "first-lease",
        label: "First lease completed",
        hint: completed >= 1 ? "A lease seen through to the end." : "Release the deposit at the end of a lease.",
        earned: completed >= 1,
      },
      {
        id: "deposit-returned",
        label: "Deposit returned in full",
        hint: returnedFull >= 1 ? `${returnedFull} returned with no deduction.` : "Release a deposit with no deduction.",
        earned: returnedFull >= 1,
      },
      {
        id: "no-claims",
        label: "No tenant had to claim",
        hint:
          claimed > 0
            ? `${claimed} deposit${claimed === 1 ? "" : "s"} had to be claimed by the tenant.`
            : completed >= 1
              ? "Every deposit released without the tenant having to claim it."
              : "Earned on your first finished lease, if the tenant never has to claim.",
        earned: completed >= 1 && claimed === 0,
      },
      crossBorder,
    ];

  return [
    {
      id: "first-rent",
      label: "First rent paid",
      hint: onTime + late >= 1 ? "Rent paid on-chain." : "Pay your first rent.",
      earned: onTime + late >= 1,
    },
    {
      // The counters hold no order, so a true streak is not knowable. `paid_late == 0` with three
      // or more on time does mean every payment so far was on time, which is a run of at least
      // three; a profile with a late payment somewhere simply cannot prove the run, and the badge
      // stays unearned rather than being guessed at.
      id: "on-time-run",
      label: "3 on time in a row",
      hint:
        late > 0
          ? "A late payment is on the record, so a clean run cannot be shown."
          : onTime >= 3
            ? `${onTime} payments, every one on time.`
            : `${3 - onTime} more on time, with no late payment.`,
      earned: onTime >= 3 && late === 0,
    },
    {
      id: "deposit-returned",
      label: "Deposit returned in full",
      hint: returnedFull >= 1 ? `${returnedFull} returned with nothing deducted.` : "Finish a lease with no deduction from the deposit.",
      earned: returnedFull >= 1,
    },
    crossBorder,
    {
      id: "discount",
      label: `${DISCOUNT_PCT}% deposit discount unlocked`,
      hint: goodStanding(p)
        ? "The program applies it on your next lease, for a comparable rent."
        : "Needs a finished lease, with no late payment and no default.",
      earned: goodStanding(p),
    },
  ];
}
