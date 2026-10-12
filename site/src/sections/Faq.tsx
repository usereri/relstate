import { ChevronDown } from "lucide-react";
import { Section, SectionHead } from "@/components/ui";
import { EVENTS } from "@/lib/links";

const QS: [string, React.ReactNode][] = [
  [
    "Do I need a crypto wallet?",
    "No. You sign up with an email address. The account that holds your rental record is created with it and operated for you — there is no extension to install and no seed phrase to keep safe.",
  ],
  [
    "Do I need to buy SOL, or any token, before I can pay rent?",
    "No. Relstate pays the network fees. You pay with a card, in local money, the same way you would pay for anything else.",
  ],
  [
    "Is this real money?",
    "No. This is a demo running on Solana devnet with test money only. Card payments go through a payment provider's test mode, and the landlord payout is a mock screen. Nothing here moves real funds.",
  ],
  [
    "I just moved and have no local bank account. Can I still rent?",
    "That is the case this is built for. Verification is based on your identity document rather than a local bank relationship, and you pay with a card you already have.",
  ],
  [
    "Is my ID document stored on the blockchain?",
    "No, and it is not stored by Relstate either. The identity-verification vendor holds it. What reaches the chain is a one-way hash plus a level, which cannot be turned back into your name or document.",
  ],
  [
    "Are my rent payments really private?",
    "The amount of each monthly rent payment is encrypted on the chain. The fact that a payment happened, the accounts involved and the date are public — and so is everything about the deposit, including the amount. The agreed rent on the lease is public too.",
  ],
  [
    "What happens if the landlord does not return my deposit?",
    "The deposit is not theirs to withhold. It sits in a vault the program controls, and once the claim window has passed without the landlord releasing it, you take it back yourself. Their record shows that it had to be claimed.",
  ],
  [
    "Why would a landlord agree to a lower deposit?",
    "Because the record in front of them is one the program wrote, not one the tenant typed. A tenant with finished leases, no late payments and a comparable rent pays half the standard deposit — and the landlord's own record of returning deposits in full is what makes good tenants apply to them.",
  ],
  [
    "Which cities does this cover?",
    <>
      The demo is seeded with apartments in Kraków and Warsaw, and the{" "}
      <a href={EVENTS} className="font-medium text-foreground underline underline-offset-4 hover:no-underline">
        events page
      </a>{" "}
      shows how arriving for a semester or a conference leads to apartments nearby.
    </>,
  ],
];

export function Faq() {
  return (
    <Section id="faq" tone="card">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
        <SectionHead eyebrow="FAQ" title="Questions, answered." />
        <div className="divide-y border-y">
          {QS.map(([q, a]) => (
            <details key={q} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-lg font-medium [&::-webkit-details-marker]:hidden">
                {q}
                <ChevronDown className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <p className="-mt-1 max-w-prose pb-6 leading-relaxed text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
