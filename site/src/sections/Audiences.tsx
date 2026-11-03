import { ArrowRight, BadgeCheck, Building2, KeyRound } from "lucide-react";
import { btn } from "@/components/ui";
import { appHref } from "@/lib/links";
import { cn } from "@/lib/utils";

const CARDS = [
  {
    id: "tenants",
    role: "tenant" as const,
    icon: KeyRound,
    who: "For tenants",
    title: "Arriving with nothing local.",
    tint: "bg-jade-soft text-jade",
    points: [
      "Apply the week you land — no local bank account and no local credit file to produce first",
      "Your deposit goes into a vault the landlord cannot reach into, not into their account",
      "Deposit and rent are paid by card, in local money, with the fees on us",
      "Every payment on time is written to a record that belongs to your account, not to Relstate",
      "Build that record and the deposit on your next lease is half — a rule the landlord cannot skip",
    ],
  },
  {
    id: "landlords",
    role: "landlord" as const,
    icon: Building2,
    who: "For landlords",
    title: "Letting to someone with no local file.",
    tint: "bg-secondary text-primary",
    points: [
      "A verified identity and a payment history, instead of a guess about a stranger",
      "Late is marked late by the program, on a schedule neither side can edit afterwards",
      "Unpaid rent is settled out of the deposit by the rules both sides accepted up front",
      "A deduction is recorded on both records, so returning deposits in full becomes an asset",
      "You are paid out in local money",
    ],
  },
];

export function Audiences() {
  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-20 sm:px-8 lg:grid-cols-2 lg:py-28">
      {CARDS.map((c) => (
        <article id={c.id} key={c.id} className="flex scroll-mt-24 flex-col overflow-hidden rounded-[22px] border bg-card shadow-card">
          <div className={cn("flex items-center gap-3 px-7 py-5", c.tint)}>
            <c.icon className="size-5 shrink-0" />
            <p className="text-sm font-semibold">{c.who}</p>
          </div>
          <div className="flex flex-1 flex-col gap-6 p-7">
            <h3 className="text-3xl font-semibold leading-tight">{c.title}</h3>
            <ul className="flex flex-col gap-3">
              {c.points.map((p) => (
                <li key={p} className="flex gap-3 text-muted-foreground">
                  <BadgeCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden /> {p}
                </li>
              ))}
            </ul>
            <a href={appHref({ role: c.role })} className={cn(btn({ variant: "outline" }), "mt-auto self-start")}>
              Open the app as a {c.role} <ArrowRight />
            </a>
          </div>
        </article>
      ))}
    </section>
  );
}
