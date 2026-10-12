import { Eye, EyeOff, KeyRound, SlashSquare } from "lucide-react";
import { Section, SectionHead } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Every row here is `docs/privacy.md`, in the same words. The deposit line is the one that must
 * never be softened: deposits are public by design, and the pitch says so out loud.
 */
const ROWS = [
  ["The amount of each monthly rent payment", "hidden"],
  ["That a payment happened, between which accounts, and when", "public"],
  ["The deposit: funding it, releasing it, claiming it, a default payout", "public"],
  ["The listing price, the agreed rent, the deposit amount, the term", "public"],
  ["The text of your signed contract", "never"],
  ["Your identity document and personal details", "never"],
] as const;

const VISIBILITY = {
  hidden: { label: "Encrypted", icon: EyeOff, className: "bg-jade-soft text-jade" },
  public: { label: "Public", icon: Eye, className: "bg-secondary text-secondary-foreground" },
  never: { label: "Not on chain", icon: SlashSquare, className: "bg-brass-soft text-warning" },
} as const;

export function Privacy() {
  return (
    <Section id="privacy">
      <div className="grid gap-14 lg:grid-cols-[1fr_1.15fr] lg:gap-20">
        <div className="flex flex-col gap-6">
          <SectionHead
            eyebrow="Privacy"
            title="What you pay each month is between you and your landlord."
            text="Monthly rent is settled with an encrypted amount: the transfer is on the public chain, and the number in it is not readable. That is a real guarantee, and it is narrower than “everything is private”. The whole of it is on the right."
          />
          <div className="flex flex-col gap-3 rounded-2xl border bg-card p-6 text-sm leading-relaxed text-muted-foreground shadow-card">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <KeyRound className="size-4 shrink-0 text-primary" aria-hidden /> Who can read an amount
            </p>
            <p>
              Your landlord can read the payments they receive — they are the recipient. Relstate holds an auditor key for the same reason a bank
              keeps records: so a payment can be checked against the rent that was agreed. Nobody else can read it.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <table className="w-full border-collapse overflow-hidden rounded-2xl border bg-card text-left shadow-card">
            <caption className="sr-only">What is visible on the chain and what is not</caption>
            <thead>
              <tr className="border-b bg-muted/60">
                <th scope="col" className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  What
                </th>
                <th scope="col" className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  On chain
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ROWS.map(([what, kind]) => {
                const v = VISIBILITY[kind];
                return (
                  <tr key={what}>
                    <th scope="row" className="px-5 py-4 pr-3 text-[15px] font-normal leading-snug">
                      {what}
                    </th>
                    <td className="px-5 py-4 text-right align-middle">
                      <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold", v.className)}>
                        <v.icon className="size-3.5" aria-hidden />
                        {v.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="text-sm leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">Why the deposit is public.</strong> It sits in a vault account that the program itself
            controls, and an account like that cannot hold the keys that encrypt a balance. So deposit movements are visible, by design. We would
            rather say that than claim more privacy than we have.
          </p>
        </div>
      </div>
    </Section>
  );
}
