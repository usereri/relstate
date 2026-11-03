import { FileLock2, FlaskConical, Fingerprint, ShieldCheck, UserCheck } from "lucide-react";
import { Section, SectionHead } from "@/components/ui";

const ITEMS = [
  [
    UserCheck,
    "Identity checked by a specialist",
    "Know-your-customer checks are run by a dedicated identity-verification vendor whose business this is — not by us. They examine the document and hold it. Relstate receives a result and a level, and never the document.",
  ],
  [
    Fingerprint,
    "No personal data on the chain",
    "A blockchain cannot forget, so nothing that identifies you is put on one. What goes on chain is a one-way hash of the verified subject plus the level. It cannot be turned back into your name, your document number or your address.",
  ],
  [
    FileLock2,
    "The contract stays yours",
    "Only the SHA-256 fingerprint of the signed contract is recorded. That is enough to prove both sides signed the same file, and it reveals nothing about what the file says.",
  ],
  [
    ShieldCheck,
    "One person, one record",
    "The verification result is bound to the account that carries your rental record. That is what stops someone abandoning a bad record and starting over as a stranger — the problem a pseudonymous address has on its own.",
  ],
] as const;

export function Trust() {
  return (
    <Section id="trust" tone="card">
      <SectionHead
        eyebrow="Trust & compliance"
        title="Identity checks by people whose job that is."
        text="Renting is a regulated, high-value relationship between strangers. Pseudonymous addresses are not enough for it, and neither is asking you to trust us."
      />

      <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {ITEMS.map(([Icon, t, d]) => (
          <div key={t} className="flex flex-col gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
              <Icon className="size-5" />
            </span>
            <h3 className="text-lg font-semibold">{t}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{d}</p>
          </div>
        ))}
      </div>

      {/* The limits, stated where they are inconvenient rather than in a footnote. */}
      <div className="mt-14 rounded-[22px] border border-warning/30 bg-warning-soft/60 p-7">
        <h3 className="flex items-center gap-2.5 text-lg font-semibold text-warning">
          <FlaskConical className="size-5 shrink-0" aria-hidden /> What this is, exactly
        </h3>
        <ul className="mt-4 grid gap-3 text-sm leading-relaxed text-muted-foreground sm:grid-cols-2">
          <li>
            Relstate is a prototype built for a hackathon demo. It runs on <strong className="font-medium text-foreground">Solana devnet with test
            money</strong>, and card payments run in a payment provider&rsquo;s test mode. Nothing you do here moves real money.
          </li>
          <li>
            Relstate is <strong className="font-medium text-foreground">not a bank, not a payment institution and not a licensed financial
            service</strong> in any country, and holds no licence or registration of any kind.
          </li>
          <li>
            For the demo, identity verification runs in the vendor&rsquo;s sandbox. Real verification of real people is a production step, not
            something this demo has done.
          </li>
          <li>
            The program has <strong className="font-medium text-foreground">not been audited</strong>. The deposit vault, the discount rule and the
            payment record are enforced by code you can read, and code that has not been audited can be wrong.
          </li>
        </ul>
      </div>
    </Section>
  );
}
