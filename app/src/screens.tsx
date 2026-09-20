import { useState } from "react";
import { Clock, FastForward, Gavel, Handshake, HandCoins, KeyRound, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DocPicker } from "@/components/DocPicker";
import { ProfileCard } from "@/components/ProfileCard";
import { Terms, termRows } from "@/components/Terms";
import { Doc } from "@/lib/hash";
import { DISCOUNT_PCT, Role, Snapshot, LeaseView, actors, goodStanding, maxDiscountRent, qualifiesForDiscount } from "@/lib/chain";
import { CAN_FAST_FORWARD, CLAIM_WINDOW_SECS, GRACE_SECS, ListingData, PERIOD_SECS, TERM_PERIODS, USDC } from "@/lib/config";
import { duration, short, usdc } from "@/lib/utils";

/** Big primary action pinned above the bottom edge on phones. */
export function StickyAction({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
      <div className="mx-auto flex max-w-md flex-col gap-2">{children}</div>
    </div>
  );
}

export interface Handlers {
  busy: string | null;
  propose: (doc: Doc) => void;
  fund: (doc: Doc) => void;
  pay: () => void;
  release: (deduction: number) => void;
  markDefault: () => void;
  claim: () => void;
  jump: (secs: number) => void;
  next: () => void;
}

/** The lifecycle as seen from the lease's clock. */
function timing(l: LeaseView, now: number) {
  const due = l.startTs + l.paidCount * l.periodSecs;
  const end = l.startTs + l.termPeriods * l.periodSecs;
  const allPaid = l.paidCount >= l.termPeriods;
  return {
    due,
    end,
    allPaid,
    canPay: !allPaid && now >= due,
    late: !allPaid && now > due + l.graceSecs,
    canDefault: !allPaid && now > due + l.graceSecs + l.periodSecs,
    canRelease: allPaid && now >= end,
    canClaim: allPaid && now >= end + CLAIM_WINDOW_SECS,
  };
}

function Waiting({ title, text }: { title: string; text: string }) {
  return (
    <Card className="rise">
      <CardHeader>
        <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
          <Clock className="size-5" />
        </span>
        <CardTitle className="mt-2">{title}</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
    </Card>
  );
}

// ---- landlord: propose a lease ---------------------------------------------------------

export function ProposeLease({ snap, listing, h }: { snap: Snapshot; listing: ListingData; h: Handlers }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const discount = qualifiesForDiscount(snap.profiles.tenant, listing.rent);
  const tenantRecord = snap.profiles.tenant;
  const tooBig = goodStanding(tenantRecord) && !discount;
  const deposit = discount ? (listing.deposit * (100 - DISCOUNT_PCT)) / 100 : listing.deposit;

  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">{snap.profiles.tenant?.leasesCompleted ? "Next lease" : "Propose a lease"}</h2>
          <p className="text-sm text-muted-foreground">
            Attach the signed lease. Its fingerprint is stored on-chain, so both sides are bound to this exact document.
          </p>
        </div>

        {snap.profiles.tenant && (
          <div className="flex flex-col gap-2">
            <ProfileCard role="tenant" address={actors.tenant.key.toBase58()} profile={snap.profiles.tenant} />
            {tooBig && (
              <p className="rounded-xl bg-secondary p-3 text-sm text-muted-foreground">
                No discount here: this rent is above {usdc(maxDiscountRent(tenantRecord))} USDC, the most the tenant's
                typical rent of past leases covers.
              </p>
            )}
            {discount && (
              <p className="flex items-start gap-2 rounded-xl bg-[#eef2e4] p-3 text-sm text-success">
                <Sparkles className="mt-0.5 size-4 shrink-0" />
                Good standing: no late payments, no defaults. The program takes {DISCOUNT_PCT}% off the deposit when the lease is created.
              </p>
            )}
          </div>
        )}

        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <DocPicker
              label="Lease document"
              hint="PDF or scan, signed off-chain"
              doc={doc}
              onDoc={setDoc}
            />
            <Terms
              rows={termRows({ rent: listing.rent, deposit, term: TERM_PERIODS, periodSecs: PERIOD_SECS, region: listing.country, discountPct: discount ? DISCOUNT_PCT : 0 })}
            />
            <p className="text-xs text-muted-foreground">
              Tenant: <span className="font-mono">{short(actors.tenant.key.toBase58(), 6)}</span>
            </p>
          </CardContent>
        </Card>
      </div>
      <StickyAction>
        <Button size="lg" disabled={!doc || !!h.busy} onClick={() => doc && h.propose(doc)}>
          <Handshake /> {h.busy ?? "Propose lease"}
        </Button>
      </StickyAction>
    </>
  );
}

// ---- tenant: review + accept ----------------------------------------------------------

export function AcceptLease({ lease, h }: { lease: LeaseView; h: Handlers }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const ok = doc?.hex === lease.hashHex;
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Review and accept</h2>
          <p className="text-sm text-muted-foreground">
            Attach the lease you received. Funding the deposit only works if it is the same document.
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <Terms rows={termRows({ ...lease, term: lease.termPeriods, hashHex: lease.hashHex })} />
            <DocPicker
              label="Your copy of the lease"
              hint="Same file the landlord signed"
              doc={doc}
              onDoc={setDoc}
              expectedHex={lease.hashHex}
            />
          </CardContent>
        </Card>
      </div>
      <StickyAction>
        <Button size="lg" disabled={!ok || !!h.busy} onClick={() => doc && h.fund(doc)}>
          <KeyRound /> {h.busy ?? `Accept and pay ${usdc(lease.deposit)} USDC deposit`}
        </Button>
      </StickyAction>
    </>
  );
}

export const ProposedWaiting = () => (
  <Waiting title="Waiting for the tenant" text="The tenant reviews the lease and funds the deposit to accept. Switch to Tenant to continue." />
);

// ---- active lease ---------------------------------------------------------------------

function Periods({ lease }: { lease: LeaseView }) {
  return (
    <div className="flex gap-2">
      {Array.from({ length: lease.termPeriods }, (_, i) => (
        <div
          key={i}
          className={`h-2.5 flex-1 rounded-full transition-colors ${i < lease.paidCount ? "bg-primary" : "bg-secondary"}`}
        />
      ))}
    </div>
  );
}

function TimeControls({ lease, now, h }: { lease: LeaseView; now: number; h: Handlers }) {
  if (!CAN_FAST_FORWARD) return null;
  const t = timing(lease, now);
  const steps: [string, number][] = t.allPaid
    ? [
        ["Term ends", t.end],
        ["Landlord window over", t.end + CLAIM_WINDOW_SECS + 1],
      ]
    : [
        ["Rent due", t.due],
        ["Rent late", t.due + lease.graceSecs + 1],
        ["Default possible", t.due + lease.graceSecs + lease.periodSecs + 1],
      ];
  const upcoming = steps.filter(([, ts]) => ts > now);
  if (!upcoming.length) return null;
  return (
    <div className="rounded-2xl border border-dashed border-input p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <FastForward className="size-3.5" /> Demo clock (local network only)
      </p>
      <div className="flex flex-wrap gap-2">
        {upcoming.map(([label, ts]) => (
          <Button key={label} size="sm" variant="outline" disabled={!!h.busy} onClick={() => h.jump(ts - now)}>
            → {label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ActiveLease({ lease, snap, role, h }: { lease: LeaseView; snap: Snapshot; role: Role; h: Handlers }) {
  const [deduction, setDeduction] = useState("0");
  const t = timing(lease, snap.now);
  const dueIn = t.due - snap.now;
  const deductionBase = Math.round((Number(deduction) || 0) * USDC);
  const badDeduction = deductionBase < 0 || deductionBase > lease.deposit;

  const status = t.allPaid ? (
    <Badge variant="success">All rent paid</Badge>
  ) : t.canDefault ? (
    <Badge variant="danger">Seriously overdue</Badge>
  ) : t.late ? (
    <Badge variant="warning">Late</Badge>
  ) : t.canPay ? (
    <Badge variant="warning">Due now</Badge>
  ) : (
    <Badge variant="success">On track</Badge>
  );

  return (
    <>
      <div className="rise flex flex-col gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>
                Rent {Math.min(lease.paidCount + 1, lease.termPeriods)} of {lease.termPeriods}
              </CardTitle>
              <CardDescription>
                {t.allPaid
                  ? t.canRelease
                    ? "Term finished"
                    : `Term ends in ${duration(t.end - snap.now)}`
                  : t.canPay
                    ? t.late
                      ? `Overdue by ${duration(snap.now - t.due)}`
                      : "Payable now"
                    : `Opens in ${duration(dueIn)}`}
              </CardDescription>
            </div>
            {status}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Periods lease={lease} />
            <Terms
              rows={[
                ["Rent paid", `${usdc(lease.paidCount * lease.rent)} of ${usdc(lease.termPeriods * lease.rent)} USDC`],
                ["Deposit in vault", `${usdc(lease.deposit)} USDC${lease.discountPct ? ` (−${lease.discountPct}% good standing)` : ""}`],
                ["Grace period", duration(lease.graceSecs)],
              ]}
            />
          </CardContent>
        </Card>

        {role === "landlord" && t.canRelease && (
          <Card>
            <CardContent className="flex flex-col gap-2 p-5">
              <label htmlFor="deduction" className="text-sm font-semibold">
                Deduction from the deposit (USDC)
              </label>
              <Input
                id="deduction"
                inputMode="decimal"
                value={deduction}
                onChange={(e) => setDeduction(e.target.value)}
                aria-invalid={badDeduction}
              />
              <p className="text-xs text-muted-foreground">
                The tenant gets {usdc(Math.max(0, lease.deposit - deductionBase))} USDC back. Leave at 0 to return it in full; deductions are visible on both records.
              </p>
            </CardContent>
          </Card>
        )}

        <TimeControls lease={lease} now={snap.now} h={h} />
      </div>

      <StickyAction>
        {role === "tenant" && !t.allPaid && (
          <Button size="lg" disabled={!t.canPay || !!h.busy} onClick={h.pay}>
            <HandCoins /> {h.busy ?? (t.canPay ? `Pay ${usdc(lease.rent)} USDC rent` : `Next rent opens in ${duration(dueIn)}`)}
          </Button>
        )}
        {role === "tenant" && t.allPaid && (
          <Button
            size="lg"
            variant={t.canClaim ? "default" : "secondary"}
            disabled={!t.canClaim || !!h.busy}
            onClick={h.claim}
          >
            <KeyRound />{" "}
            {h.busy ??
              (t.canClaim
                ? "Landlord did not respond: claim my deposit"
                : "Waiting for the landlord to release the deposit")}
          </Button>
        )}
        {role === "landlord" && t.allPaid && (
          <Button size="lg" disabled={!t.canRelease || badDeduction || !!h.busy} onClick={() => h.release(deductionBase)}>
            <KeyRound /> {h.busy ?? (t.canRelease ? "Release deposit" : `Release opens in ${duration(t.end - snap.now)}`)}
          </Button>
        )}
        {role === "landlord" && !t.allPaid && (
          <>
            <Button
              size="lg"
              variant={t.canDefault ? "destructive" : "secondary"}
              disabled={!t.canDefault || !!h.busy}
              onClick={h.markDefault}
            >
              <Gavel /> {h.busy ?? (t.canDefault ? "Declare default" : "Waiting for tenant rent")}
            </Button>
            {!t.canDefault && (
              <p className="text-center text-xs text-muted-foreground">
                Default opens {duration(t.due + lease.graceSecs + lease.periodSecs + 1 - snap.now)} from now, one full period plus grace after a missed rent.
              </p>
            )}
          </>
        )}
      </StickyAction>
    </>
  );
}

// ---- finished: the track record + next lease ------------------------------------------

export function Finished({ lease, snap, h }: { lease: LeaseView; snap: Snapshot; h: Handlers }) {
  const [who, setWho] = useState<Role>("tenant");
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">
            {lease.status === "defaulted" ? "Lease ended in default" : "Lease completed"}
          </h2>
          <p className="text-sm text-muted-foreground">
            The record below was written by the program from the payments and the deposit outcome. Neither side can edit it.
          </p>
        </div>

        <div className="flex gap-1 rounded-xl bg-secondary p-1">
          {(["tenant", "landlord"] as Role[]).map((r) => (
            <button
              key={r}
              onClick={() => setWho(r)}
              className={`h-10 flex-1 rounded-lg text-sm font-medium transition-colors ${
                who === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {r === "tenant" ? "Tenant" : "Landlord"}
            </button>
          ))}
        </div>
        <ProfileCard role={who} address={actors[who].key.toBase58()} profile={snap.profiles[who]} />
        {lease.status === "closed" && goodStanding(snap.profiles.tenant) && (
          <p className="flex items-start gap-2 rounded-xl bg-[#eef2e4] p-3 text-sm text-success">
            <Sparkles className="mt-0.5 size-4 shrink-0" />
            This record qualifies the tenant for a {DISCOUNT_PCT}% smaller deposit on the next lease with rent up to {usdc(maxDiscountRent(snap.profiles.tenant))} USDC.
          </p>
        )}
      </div>
      <StickyAction>
        <Button size="lg" onClick={h.next}>
          <Handshake /> Propose the next lease
        </Button>
      </StickyAction>
    </>
  );
}

export { Waiting, GRACE_SECS };
