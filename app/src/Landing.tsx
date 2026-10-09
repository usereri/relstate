import { useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  ChevronDown,
  FileLock2,
  Globe2,
  KeyRound,
  Landmark,
  Lock,
  Percent,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Logo } from "@/components/Brand";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  ["How it works", "#how"],
  ["Tenants", "#tenants"],
  ["Landlords", "#landlords"],
  ["Security", "#security"],
  ["FAQ", "#faq"],
] as const;

export function Landing() {
  return (
    <div className="min-h-dvh overflow-x-clip">
      <Nav />
      <Hero />
      <Facts />
      <Problem />
      <How />
      <Audiences />
      <Discount />
      <Security />
      <Faq />
      <Cta />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-transparent bg-background/80 backdrop-blur-md supports-[backdrop-filter]:border-border/60">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
          {NAV.map(([label, href]) => (
            <a key={href} href={href} className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href="#/signin" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-foreground")}>
            Sign in
          </a>
          <a href="#/signup" className={cn(buttonVariants({ size: "sm" }), "bg-ink text-white hover:bg-ink/90")}>
            Get started <ArrowRight />
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative">
      <div className="grid-paper pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" aria-hidden />
      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-14 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
        <div className="rise flex flex-col items-start gap-7">
          <a
            href="#discount"
            className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-sm text-muted-foreground shadow-card transition-colors hover:text-foreground"
          >
            <span className="rounded-full bg-brass-soft px-2 py-0.5 text-xs font-semibold text-warning">New</span>
            Proven tenants pay half the deposit
            <ArrowRight className="size-3.5" />
          </a>
          <h1 className="text-[clamp(2.75rem,6.2vw,5.25rem)] font-semibold leading-[0.95]">
            Your rent history,
            <br />
            <span className="text-[color-mix(in_oklab,var(--foreground)_45%,transparent)]">finally worth</span>{" "}
            <span className="relative whitespace-nowrap">
              something.
              <svg viewBox="0 0 300 14" className="tick-in absolute -bottom-2 left-0 h-3 w-full text-brass" preserveAspectRatio="none" aria-hidden>
                <path d="M2 10 C 80 2, 200 2, 298 8" stroke="currentColor" strokeWidth="4" fill="none" strokeLinecap="round" />
              </svg>
            </span>
          </h1>
          <p className="max-w-[34rem] text-lg leading-relaxed text-muted-foreground">
            Relstate holds your deposit in a neutral vault and writes every on-time payment to a record that belongs to you. Move cities, keep your
            reputation, and pay less to get the keys.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href="#/signup" className={cn(buttonVariants({ size: "lg" }), "bg-ink text-white hover:bg-ink/90")}>
              Create free account <ArrowRight />
            </a>
            <a href="#how" className={buttonVariants({ variant: "outline", size: "lg" })}>
              See how it works
            </a>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {["No bank account needed", "Deposit never held by the landlord", "Record you can take anywhere"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <BadgeCheck className="size-4 text-success" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

/** Product shot: a listing, the vault holding its deposit, and the tenant's record. Clearly illustrative. */
function HeroVisual() {
  return (
    <div className="rise relative mx-auto w-full max-w-[540px] [animation-delay:120ms]" aria-label="Example of a Relstate lease">
      <div className="overflow-hidden rounded-[22px] border bg-card shadow-[0_40px_80px_-40px_rgba(11,23,20,0.45)]">
        <div className="relative aspect-[16/10] bg-muted">
          <img src="/listings/kazimierz.jpg" alt="" className="size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/5 to-transparent" />
          <span className="absolute left-4 top-4 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-ink backdrop-blur">Kraków · Kazimierz</span>
          <div className="absolute inset-x-4 bottom-4 flex items-end justify-between text-white">
            <div>
              <p className="font-display text-2xl font-semibold leading-tight">Sunny 2-room near Plac Nowy</p>
              <p className="text-sm text-white/80">12-month lease · furnished</p>
            </div>
            <p className="text-right">
              <span className="font-display text-2xl font-semibold">1,850</span>
              <span className="block text-xs text-white/75">USDC / month</span>
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 divide-x border-t text-center">
          {[
            ["Deposit", "925", "50% off applied"],
            ["Paid on time", "11 / 11", "this lease"],
            ["Vault", "Locked", "until move-out"],
          ].map(([k, v, s]) => (
            <div key={k} className="px-3 py-3.5">
              <p className="eyebrow">{k}</p>
              <p className="mt-1 font-display text-lg font-semibold tabular-nums">{v}</p>
              <p className="text-[11px] text-muted-foreground">{s}</p>
            </div>
          ))}
        </div>
      </div>

      {/* floating record card */}
      <div className="absolute -bottom-10 -left-4 w-[230px] rounded-2xl border bg-card p-4 shadow-card sm:-left-12">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brass)_18%,white)] font-display font-semibold text-warning">
            MK
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">Maria K.</p>
            <p className="font-mono text-[11px] text-muted-foreground">7xKX…sAsU</p>
          </div>
          <ShieldCheck className="ml-auto size-5 text-success" />
        </div>
        <div className="mt-3 flex items-end gap-1" aria-hidden>
          {[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1].map((_, i) => (
            <span key={i} className="h-5 flex-1 rounded-[2px] bg-success/80" style={{ opacity: 0.45 + (i / 24) * 0.55 }} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          <b className="font-semibold text-foreground">24 payments</b> on time · 2 cities
        </p>
      </div>

      <div className="absolute -right-3 -top-5 hidden items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm shadow-card sm:flex">
        <Lock className="size-4 text-primary" /> Deposit in vault
      </div>
      <p className="mt-14 text-center text-xs text-muted-foreground">Illustrative example</p>
    </div>
  );
}

function Facts() {
  const items = [
    [Lock, "Deposits held by the protocol, not the landlord"],
    [Percent, "50% lower deposit for tenants with a clean record"],
    [FileLock2, "Signed contract fingerprinted with SHA-256"],
    [Globe2, "Reputation that travels across borders"],
    [Landmark, "Rent settled in USDC, on Solana"],
  ] as const;
  const row = [...items, ...items];
  return (
    <section className="border-y bg-card" aria-label="Product facts">
      <div className="overflow-hidden py-4 [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]">
        <ul className="marquee flex w-max gap-12">
          {row.map(([Icon, t], i) => (
            <li key={i} className="flex items-center gap-2.5 whitespace-nowrap text-sm text-muted-foreground" aria-hidden={i >= items.length}>
              <Icon className="size-4 text-primary" /> {t}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, text, id }: { eyebrow: string; title: string; text?: string; id?: string }) {
  return (
    <div id={id} className="flex max-w-2xl scroll-mt-24 flex-col gap-4">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="text-[clamp(2rem,4vw,3.25rem)] font-semibold leading-[1.02]">{title}</h2>
      {text && <p className="text-lg leading-relaxed text-muted-foreground">{text}</p>}
    </div>
  );
}

function Problem() {
  const pains = [
    ["The deposit is a hostage.", "Landlords hold the money and decide what comes back. Disputes over deposits are among the most common in renting."],
    ["Good history doesn't move.", "Ten years of paying on time vanish the day you cross a border. Every new landlord treats you as a stranger."],
    ["Newcomers get locked out.", "No local bank without an address, no address without a lease, no lease without a local bank."],
  ];
  return (
    <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8 lg:py-32">
      <SectionHead eyebrow="The problem" title="Renting runs on trust nobody can check." />
      <div className="mt-14 grid gap-px overflow-hidden rounded-[22px] border bg-border md:grid-cols-3">
        {pains.map(([t, d]) => (
          <div key={t} className="flex flex-col gap-3 bg-card p-7">
            <h3 className="text-xl font-semibold">{t}</h3>
            <p className="leading-relaxed text-muted-foreground">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function How() {
  const steps = [
    ["List & apply", "Landlords publish an apartment. Tenants apply, and their verified record travels with the application."],
    ["Sign & lock", "The landlord proposes a lease bound to the contract's fingerprint. The tenant accepts by funding the deposit into the vault."],
    ["Pay & build", "Each rent payment is stamped on time or late, by the program itself. Nobody can edit it afterwards."],
    ["Move out & carry it", "The deposit is released, or claimed by the tenant if the landlord goes silent. Both records update for the next city."],
  ];
  return (
    <section id="how" className="scroll-mt-16 bg-ink py-24 text-white lg:py-32">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="flex max-w-2xl flex-col gap-4">
          <p className="eyebrow text-white/50">How it works</p>
          <h2 className="text-[clamp(2rem,4vw,3.25rem)] font-semibold leading-[1.02]">From first viewing to deposit back, in four steps.</h2>
        </div>
        <ol className="mt-16 grid gap-10 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex flex-col gap-4 border-t border-white/15 pt-6">
              <span className="font-mono text-sm text-brass">0{i + 1}</span>
              <h3 className="text-2xl font-semibold">{t}</h3>
              <p className="leading-relaxed text-white/65">{d}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Audiences() {
  const cards = [
    {
      id: "tenants",
      icon: KeyRound,
      who: "For tenants",
      title: "Get the keys with half the deposit.",
      img: "/listings/planty.jpg",
      tone: "bg-[#0f5d4a]",
      points: [
        "Browse apartments and see each landlord's record before applying",
        "Your deposit sits in a vault the landlord can't touch",
        "Landlord silent at move-out? Claim the deposit back yourself",
        "Build a record that unlocks better terms in the next city",
      ],
    },
    {
      id: "landlords",
      icon: Building2,
      who: "For landlords",
      title: "Choose tenants on facts, not feelings.",
      img: "/listings/zablocie.jpg",
      tone: "bg-[#2b3a8f]",
      points: [
        "Every applicant arrives with a payment history no one can fake",
        "Contracts bound to the lease, so nobody can swap the paperwork",
        "Unpaid rent is settled from the deposit by clear on-chain rules",
        "Your own record proves you return deposits in full",
      ],
    },
  ];
  return (
    <section className="mx-auto grid max-w-7xl gap-6 px-5 py-24 sm:px-8 lg:grid-cols-2 lg:py-32">
      {cards.map((c) => (
        <article id={c.id} key={c.id} className="flex scroll-mt-24 flex-col overflow-hidden rounded-[22px] border bg-card shadow-card">
          <div className="relative h-56">
            <img src={c.img} alt="" className="size-full object-cover" />
            <div className={cn("absolute inset-0 opacity-55 mix-blend-multiply", c.tone)} />
            <span className="absolute left-5 top-5 inline-flex items-center gap-2 rounded-full bg-white/95 px-3 py-1.5 text-sm font-medium text-ink">
              <c.icon className="size-4" /> {c.who}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-6 p-7">
            <h3 className="text-3xl font-semibold leading-tight">{c.title}</h3>
            <ul className="flex flex-col gap-3">
              {c.points.map((p) => (
                <li key={p} className="flex gap-3 text-muted-foreground">
                  <BadgeCheck className="mt-0.5 size-5 shrink-0 text-success" /> {p}
                </li>
              ))}
            </ul>
            <a href="#/signup" className={cn(buttonVariants({ variant: "outline" }), "mt-auto self-start")}>
              Start as a {c.id === "tenants" ? "tenant" : "landlord"} <ArrowRight />
            </a>
          </div>
        </article>
      ))}
    </section>
  );
}

function Discount() {
  // typical rent 1,200 → discount applies up to 1.5x = 1,800
  const rows = [
    { rent: 1100, ok: true },
    { rent: 1650, ok: true },
    { rent: 2400, ok: false },
  ];
  const max = 2600;
  return (
    <section className="border-y bg-card">
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 py-24 sm:px-8 lg:grid-cols-2 lg:py-32">
        <SectionHead
          id="discount"
          eyebrow="Rewarding reliability"
          title="A clean record cuts your deposit in half."
          text="Tenants with at least one finished lease, no late payments and no defaults pay 50% of the standard deposit. The rule is enforced by the protocol, so the landlord can't skip it, and capped at 1.5× your typical rent so it can't be gamed."
        />
        <div className="rounded-[22px] border bg-background p-6 sm:p-8">
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">Example · typical rent 1,200 USDC</p>
            <p className="font-mono text-xs text-muted-foreground">cap 1,800</p>
          </div>
          <div className="relative mt-6 flex flex-col gap-5">
            <div className="pointer-events-none absolute inset-y-[-8px] border-l-2 border-dashed border-brass" style={{ left: `${(1800 / max) * 100}%` }} aria-hidden />
            {rows.map((r) => (
              <div key={r.rent} className="flex flex-col gap-1.5">
                <div className="flex justify-between text-sm">
                  <span className="tabular-nums">{r.rent.toLocaleString("en")} USDC rent</span>
                  <span className={r.ok ? "font-medium text-success" : "text-muted-foreground"}>
                    {r.ok ? `deposit ${(r.rent / 2).toLocaleString("en")}` : `full deposit ${r.rent.toLocaleString("en")}`}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-muted">
                  <div className={cn("tick-in h-full rounded-full", r.ok ? "bg-success" : "bg-muted-foreground/40")} style={{ width: `${(r.rent / max) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 flex items-start gap-2 text-sm text-muted-foreground">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-brass" /> The discount applied is stored on the lease, visible to both sides.
          </p>
        </div>
      </div>
    </section>
  );
}

function Security() {
  const items = [
    [Lock, "Vault-held deposits", "Funds move only by the lease rules: release, default or claim. No admin key, no back door."],
    [ShieldCheck, "Records nobody can edit", "Payments, defaults and deductions are counted by the program. Not by us, not by the landlord."],
    [FileLock2, "Private contracts", "Only the contract's fingerprint goes on-chain. The document itself never leaves your device."],
    [BadgeCheck, "Security by design", "Every path from listing to deposit claim is enforced by the program and verified before release. Strict checks guard each step."],
  ] as const;
  return (
    <section id="security" className="mx-auto max-w-7xl scroll-mt-16 px-5 py-24 sm:px-8 lg:py-32">
      <SectionHead eyebrow="Security" title="Built so nobody has to trust anybody." text="Not even us. The rules live in an open-source Solana program anyone can read." />
      <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(([Icon, t, d]) => (
          <div key={t} className="flex flex-col gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
              <Icon className="size-5" />
            </span>
            <h3 className="text-lg font-semibold">{t}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Faq() {
  const qs = [
    ["Do I need crypto experience?", "You need a Solana wallet such as Phantom or Solflare. Rent and deposits are paid in USDC, a dollar-backed stablecoin. Sign-up takes about a minute."],
    ["Who holds my deposit?", "A vault account controlled only by the Relstate program. Neither the landlord nor Relstate can move it outside the lease rules."],
    ["What happens if the landlord disappears at move-out?", "After the claim window, the tenant can take the deposit back without the landlord's signature."],
    ["Is my contract public?", "No. Only its SHA-256 fingerprint is stored, which proves both sides signed the same file without revealing it."],
    ["Can a record be faked or deleted?", "No. Only the program writes to a profile, and only as a result of real lease events."],
  ];
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="scroll-mt-16 border-t bg-card">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-24 sm:px-8 lg:grid-cols-[1fr_1.4fr] lg:py-32">
        <SectionHead eyebrow="FAQ" title="Questions, answered." />
        <div className="divide-y border-y">
          {qs.map(([q, a], i) => (
            <div key={q}>
              <button
                className="flex w-full items-center justify-between gap-6 py-5 text-left text-lg font-medium"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? -1 : i)}
              >
                {q}
                <ChevronDown className={cn("size-5 shrink-0 text-muted-foreground transition-transform", open === i && "rotate-180")} />
              </button>
              {open === i && <p className="-mt-1 max-w-prose pb-6 leading-relaxed text-muted-foreground">{a}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="px-5 py-20 sm:px-8">
      <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[28px] bg-primary px-8 py-16 text-primary-foreground sm:px-14">
        <div className="grid-paper absolute inset-0 opacity-30 invert" aria-hidden />
        <div className="relative flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="max-w-xl text-[clamp(2rem,4vw,3rem)] font-semibold leading-[1.02]">Start building the record you deserve.</h2>
          <div className="flex flex-wrap gap-3">
            <a href="#/signup" className={cn(buttonVariants({ size: "lg" }), "bg-white text-ink hover:bg-white/90")}>
              Create free account <ArrowRight />
            </a>
            <a href="#/signin" className={cn(buttonVariants({ size: "lg", variant: "ghost" }), "text-primary-foreground hover:bg-white/10 hover:text-white")}>
              Sign in
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-10 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <Logo />
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          {NAV.map(([l, h]) => (
            <a key={h} href={h} className="hover:text-foreground">
              {l}
            </a>
          ))}
        </nav>
        <p>© 2026 Relstate · Built on Solana</p>
      </div>
    </footer>
  );
}
