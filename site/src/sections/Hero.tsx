import { ArrowRight, BadgeCheck, CreditCard, Lock } from "lucide-react";
import { btn } from "@/components/ui";
import { appHref } from "@/lib/links";
import { cn } from "@/lib/utils";

export function Hero() {
  return (
    <section className="relative">
      <div className="grid-paper pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" aria-hidden />
      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-12 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
        <div className="rise flex flex-col items-start gap-7">
          <p className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-sm text-muted-foreground shadow-card">
            <span className="rounded-full bg-jade-soft px-2 py-0.5 text-xs font-semibold text-jade">Kraków</span>
            Built for the week you land
          </p>

          <h1 className="text-[clamp(2.5rem,6vw,4.75rem)] font-semibold leading-[0.98]">
            New city, no local bank account.{" "}
            <span className="relative whitespace-nowrap">
              Rent anyway.
              <svg viewBox="0 0 300 14" className="absolute -bottom-1.5 left-0 h-3 w-full text-brass" preserveAspectRatio="none" aria-hidden>
                <path d="M2 10 C 80 2, 200 2, 298 8" stroke="currentColor" strokeWidth="4" fill="none" strokeLinecap="round" />
              </svg>
            </span>
          </h1>

          <p className="max-w-[36rem] text-lg leading-relaxed text-muted-foreground">
            You arrive with a job offer and two suitcases. The landlord asks for a local bank account, a local ID and a reference from a local
            landlord — and the six years of rent you paid on time somewhere else count for nothing here. Relstate gives you a way in: verify who you
            are once, pay with the card already in your pocket, and start a rental record that travels with you.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <a href={appHref()} className={btn({ size: "lg" })}>
              Find a home <ArrowRight />
            </a>
            <a href="#how" className={btn({ variant: "outline", size: "lg" })}>
              See how it works
            </a>
          </div>

          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {["No wallet to install", "Nothing to buy before you can pay", "Identity checked once, by a specialist"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <BadgeCheck className="size-4 shrink-0 text-success" /> {t}
              </li>
            ))}
          </ul>
        </div>

        <ChainView />
      </div>
    </section>
  );
}

/**
 * The pitch in one picture: the fiat side a tenant actually touches, and the public record
 * underneath it with the rent amount encrypted. Every claim here is the one in docs/privacy.md --
 * the payment, the parties and the date are public; only the amount is hidden.
 */
function ChainView() {
  const rows = [
    ["Event", <span key="e">Rent paid · period 3 of 12</span>],
    ["From", <span key="f" className="font-mono text-[13px]">7xKX…sAsU</span>],
    ["To", <span key="t" className="font-mono text-[13px]">9mQe…Rk2f</span>],
    ["Date", <span key="d">1 Oct 2026, 09:14</span>],
    ["On time", <span key="o" className="font-medium text-success">Yes</span>],
  ] as const;

  return (
    <div className="rise relative mx-auto w-full max-w-[520px] [animation-delay:120ms]">
      {/* what the tenant sees */}
      <div className="relative z-10 ml-auto w-[min(100%,330px)] rounded-2xl border bg-card p-5 shadow-card">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary">
            <CreditCard className="size-5" />
          </span>
          <div className="leading-tight">
            <p className="eyebrow">What you do</p>
            <p className="text-sm font-medium">Pay rent · October</p>
          </div>
        </div>
        <p className="mt-4 font-display text-3xl font-semibold tabular-nums">2,400.00 PLN</p>
        <p className="mt-1 text-sm text-muted-foreground">Card ending 4242 · one tap</p>
      </div>

      {/* what the chain keeps */}
      <div className="-mt-4 overflow-hidden rounded-[22px] border bg-card shadow-[0_40px_80px_-40px_rgba(11,23,20,0.45)]">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/60 px-5 py-3">
          <p className="eyebrow">What the chain keeps</p>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">devnet</span>
        </div>
        <dl className="divide-y">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 bg-secondary/40 px-5 py-3 text-sm">
            <dt className="flex items-center gap-1.5 font-medium">
              <Lock className="size-3.5 text-primary" /> Amount
            </dt>
            <dd className="flex items-center gap-2">
              <span className={cn("ciphered h-3.5 w-24 rounded")} aria-hidden />
              <span className="text-xs font-medium text-primary">encrypted</span>
            </dd>
          </div>
        </dl>
        <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          Not on the chain at all: your name, your ID document, and the text of your contract.
        </p>
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground">Illustrative example</p>
    </div>
  );
}
