import { Ban } from "lucide-react";
import { Section } from "@/components/ui";

const STEPS = [
  [
    "Sign up with an email",
    "No wallet to install, no seed phrase to write down, no 44-character address to copy anywhere. Relstate creates the account behind the sign-up form and operates it for you.",
  ],
  [
    "Verify who you are, once",
    "An identity-verification provider checks your passport or ID. They keep the document; Relstate gets a yes and a level, and the chain gets a one-way hash that cannot be turned back into you.",
  ],
  [
    "Find a place and sign",
    "Apply, agree the terms, and accept the lease by attaching the contract both sides signed. Only its SHA-256 fingerprint is stored — the file itself never leaves your device.",
  ],
  [
    "Pay by card, in local money",
    "Your card funds the deposit and then each month's rent. Relstate pays the network fees, so there is never a token to buy before you can pay your landlord.",
  ],
];

const NEVER = ["install a wallet", "write down a seed phrase", "buy a token to pay a fee", "find out what “gas” means", "read a block explorer"];

export function How() {
  return (
    <Section id="how" tone="panel">
      <div className="flex max-w-2xl flex-col gap-4">
        <p className="eyebrow text-panel-foreground/55">How it works</p>
        <h2 className="text-[clamp(1.9rem,4vw,3.25rem)] font-semibold leading-[1.02]">From landing in the city to paying rent, in four steps.</h2>
        <p className="text-lg leading-relaxed text-panel-foreground/75">
          Relstate settles on Solana. You will not notice, and that is the point.
        </p>
      </div>

      <ol className="mt-14 grid gap-10 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        {STEPS.map(([t, d], i) => (
          <li key={t} className="flex flex-col gap-4 border-t border-panel-foreground/15 pt-6">
            <span className="font-mono text-sm text-brass">0{i + 1}</span>
            <h3 className="text-2xl font-semibold">{t}</h3>
            <p className="leading-relaxed text-panel-foreground/70">{d}</p>
          </li>
        ))}
      </ol>

      <div className="mt-14 flex flex-col gap-4 rounded-[22px] border border-panel-foreground/15 bg-panel-foreground/[0.04] p-7 sm:flex-row sm:items-center sm:gap-8">
        <p className="shrink-0 font-display text-lg font-semibold">Things you never have to do</p>
        <ul className="flex flex-wrap gap-x-5 gap-y-2.5">
          {NEVER.map((n) => (
            <li key={n} className="flex items-center gap-2 text-panel-foreground/70">
              <Ban className="size-4 shrink-0 text-panel-foreground/35" aria-hidden /> {n}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
