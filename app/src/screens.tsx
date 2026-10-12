import { useState } from "react";
import { ArrowUpRight, Clock, FastForward, Gavel, Handshake, HandCoins, KeyRound, Plus, Scale, Sparkles, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DocPicker } from "@/components/DocPicker";
import { ProfileCard } from "@/components/ProfileCard";
import { Listing, Terms, termRows } from "@/components/Terms";
import { PaySection, useConfidentialRent } from "@/screens/Pay";
import {
  AppraiserFee,
  BoundAppraiser,
  CandidateChoice,
  MediationTimeline,
  OracleNote,
  RegistryChoice,
  Rounds,
  committedName,
  optionFor,
  useAppraiserOptions,
} from "@/screens/Mediation";
import type { AppraiserOption } from "@/lib/appraisers";
import { apartmentName, apartmentWhere, depositFor, leaseListing } from "@/lib/apartment";
import { Doc } from "@/lib/hash";
import * as chain from "@/lib/chain";
import { ApplicationView, DISCOUNT_PCT, DisputeView, LeaseView, ListingView, NewListing, Role, Snapshot, Status, isWallet, maxDiscountRent, qualifiesForDiscount } from "@/lib/chain";
import * as med from "@/lib/mediation";
import { CAN_FAST_FORWARD, CLAIM_WINDOW_SECS, PERIOD_SECS, TERM_PERIODS, USDC } from "@/lib/config";
import { recordLine, unique, useRecords } from "@/lib/records";
import { useChain, useChainClock } from "@/lib/useChain";
import { cn, duration, short, usdc } from "@/lib/utils";

/** Primary action: pinned above the bottom edge on narrow screens, inline under the content on desktop. */
export function StickyAction({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6 lg:static lg:bg-none lg:p-0">
      <div className="mx-auto flex max-w-md flex-col gap-2 lg:mx-0 lg:max-w-none">{children}</div>
    </div>
  );
}

export interface Handlers {
  busy: string | null;
  createListing: (f: NewListing) => Promise<boolean>;
  closeListing: (l: ListingView) => Promise<boolean>;
  apply: (l: ListingView) => Promise<boolean>;
  closeApplication: (a: ApplicationView) => Promise<boolean>;
  propose: (id: string, l: ListingView, tenant: string, doc: Doc, application?: ApplicationView) => Promise<boolean>;
  fund: (l: LeaseView, doc: Doc) => Promise<boolean>;
  pay: (l: LeaseView) => Promise<boolean>;
  release: (l: LeaseView, deduction: number) => Promise<boolean>;
  markDefault: (l: LeaseView) => Promise<boolean>;
  claim: (l: LeaseView) => Promise<boolean>;
  acceptDeduction: (l: LeaseView) => Promise<boolean>;
  /** The tenant's rejection while rounds are left: the proposal is void and the lease goes back to active. */
  abandonDispute: (l: LeaseView) => Promise<boolean>;
  /** The last rejection: the lease enters mediation and an appraiser decides. */
  escalateToMediation: (l: LeaseView) => Promise<boolean>;
  proposeAppraisers: (l: LeaseView, wallets: string[]) => Promise<boolean>;
  pickAppraiser: (l: LeaseView, wallet: string) => Promise<boolean>;
  bindDefaultAppraiser: (l: LeaseView, wallet: string) => Promise<boolean>;
  expireMediation: (l: LeaseView) => Promise<boolean>;
  finalizeDeduction: (l: LeaseView) => Promise<boolean>;
  jump: (secs: number) => Promise<boolean>;
}

export interface LogEntry {
  label: string;
  sig: string;
}

export const statusBadge = (s: Status) =>
  ({
    proposed: <Badge variant="warning">Proposed</Badge>,
    active: <Badge variant="success">Active</Badge>,
    disputed: <Badge variant="warning">Deduction proposed</Badge>,
    mediation: <Badge variant="warning">With an appraiser</Badge>,
    closed: <Badge variant="outline">Completed</Badge>,
    defaulted: <Badge variant="danger">Defaulted</Badge>,
  })[s];

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
    canClaim: allPaid && now >= end + CLAIM_WINDOW_SECS + l.claimPauseSecs,
  };
}

export function Waiting({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <Card className="rise">
      <CardHeader>
        <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
          <Clock className="size-5" />
        </span>
        <CardTitle className="mt-2">{title}</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      {children && <CardContent>{children}</CardContent>}
    </Card>
  );
}

// ---- landlord: propose a lease ---------------------------------------------------------

export function ProposeLease({
  me,
  listings,
  h,
  goListings,
  initial,
}: {
  me: string;
  listings: ListingView[];
  h: Handlers;
  goListings: () => void;
  initial?: { listing: string; tenant: string };
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [tenant, setTenant] = useState(initial?.tenant ?? "");
  const [pick, setPick] = useState(initial?.listing ?? "");
  const listing = listings.find((l) => l.address === pick) ?? listings[0];
  const applications = useChain(() => chain.loadApplications({ landlord: me }), [me]) ?? [];
  const applicants = applications.filter((a) => a.listing === listing?.address);

  const who = tenant.trim();
  const valid = isWallet(who) && who !== me;
  const record = useChain(() => (valid ? chain.loadProfile(who) : Promise.resolve(null)), [who, valid]) ?? null;

  if (!listing)
    return (
      <Waiting title="List an apartment first" text="A lease is proposed on one of your listings.">
        <Button onClick={goListings}>
          <Plus /> Create a listing
        </Button>
      </Waiting>
    );

  const discount = valid && qualifiesForDiscount(record, listing.rent);
  const tooBig = valid && chain.goodStanding(record) && !discount;
  const deposit = depositFor(listing.deposit, discount ? DISCOUNT_PCT : 0);
  const propose = () =>
    doc && valid && h.propose(chain.newId(), listing, who, doc, applicants.find((a) => a.tenant === who));

  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Propose a lease</h2>
          <p className="text-sm text-muted-foreground">
            Read the tenant's record first, then pick the listing and attach the signed contract. Only its fingerprint goes on-chain, so both sides
            are bound to this exact document.
          </p>
        </div>

        {/* Who, before what. A landlord agrees to a person, so naming the tenant and reading their
            record is the top of this screen; the lease itself and the button that commits to it sit
            below, where they are reached after the record rather than before it. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Who you are renting to</CardTitle>
            <CardDescription>Written by the program from their past leases. Neither of you can edit it.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Tenant wallet
              <Input
                className="font-mono text-sm font-normal"
                placeholder="Pick an applicant, or paste a wallet address"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                aria-invalid={!!who && !valid}
              />
              {who && !valid && (
                <span className="text-xs font-normal text-destructive">
                  {who === me ? "That is your own wallet." : "Not a valid wallet address."}
                </span>
              )}
              {applicants.length > 0 && (
                <span className="flex flex-wrap items-center gap-2 pt-1 text-xs font-normal text-muted-foreground">
                  Applicants:
                  {applicants.map((a) => (
                    <button
                      type="button"
                      key={a.address}
                      onClick={() => setTenant(a.tenant)}
                      className={cn("rounded-full border px-2.5 py-1 font-mono", who === a.tenant ? "bg-secondary text-foreground" : "hover:bg-secondary/50")}
                    >
                      {short(a.tenant, 5)}
                    </button>
                  ))}
                </span>
              )}
            </label>
            {valid ? (
              <div className="flex flex-col gap-2">
                <ProfileCard role="tenant" address={who} profile={record} />
                {tooBig && (
                  <p className="rounded-xl bg-secondary p-3 text-sm text-muted-foreground">
                    No discount here: this rent is above {usdc(maxDiscountRent(record))} USDC, the most the tenant's typical rent of past leases
                    covers.
                  </p>
                )}
                {discount && (
                  <p className="flex items-start gap-2 rounded-xl bg-success-soft p-3 text-sm text-success">
                    <Sparkles className="mt-0.5 size-4 shrink-0" />
                    Good standing: no late payments, no defaults. The program takes {DISCOUNT_PCT}% off the deposit when the lease is proposed.
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded-xl bg-secondary p-3 text-sm text-muted-foreground">
                {applicants.length > 0
                  ? "Pick an applicant above, and their rental record appears here before you agree to anything."
                  : "Name a wallet above, and its rental record appears here before you agree to anything."}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">The lease</CardTitle>
            <CardDescription>Which apartment, and on what terms.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Apartment
              <select
                value={listing.address}
                onChange={(e) => setPick(e.target.value)}
                className="h-12 rounded-xl border border-input bg-card px-3 text-base font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {listings.map((l) => (
                  <option key={l.address} value={l.address}>
                    {l.title} · {usdc(l.rent)} USDC
                  </option>
                ))}
              </select>
            </label>
            <DocPicker label="Lease document" hint="PDF or scan, signed off-chain" doc={doc} onDoc={setDoc} />
            <Terms
              rows={termRows({
                rent: listing.rent,
                deposit,
                term: TERM_PERIODS,
                periodSecs: PERIOD_SECS,
                apartment: listing.title,
                where: [listing.city, listing.region].filter(Boolean).join(" · "),
                discountPct: discount ? DISCOUNT_PCT : 0,
              })}
            />
          </CardContent>
        </Card>
      </div>
      <StickyAction>
        <Button size="lg" disabled={!doc || !valid || !!h.busy} onClick={propose}>
          <Handshake /> {h.busy ?? "Propose lease"}
        </Button>
      </StickyAction>
    </>
  );
}

// ---- tenant: review + accept ----------------------------------------------------------

/**
 * The tenant is about to lock up a deposit, so the screen leads with the apartment it is for.
 *
 * `listing` is the advertisement this lease was proposed on, when it can still be told apart
 * (`lib/apartment.ts`); with it the tenant sees the photo, the district and the description they
 * applied to rather than only a rent figure. Without it the rows below still name the place.
 */
export function AcceptLease({ lease, listing, h }: { lease: LeaseView; listing: ListingView | null; h: Handlers }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const ok = doc?.hex === lease.hashHex;
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Review and accept</h2>
          <p className="text-sm text-muted-foreground">
            Landlord {short(lease.landlord, 5)} proposed this lease on {apartmentName(lease, listing ? [listing] : [])}. Attach the contract you
            received: funding the deposit only works if it is the same document.
          </p>
        </div>
        {listing && <Listing l={listing} />}
        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <Terms
              rows={termRows({
                ...lease,
                term: lease.termPeriods,
                hashHex: lease.hashHex,
                apartment: apartmentName(lease, listing ? [listing] : []),
                where: apartmentWhere(lease, listing ? [listing] : []),
                landlord: lease.landlord,
              })}
            />
            <DocPicker label="Your copy of the lease" hint="Same file the landlord signed" doc={doc} onDoc={setDoc} expectedHex={lease.hashHex} />
          </CardContent>
        </Card>
      </div>
      <StickyAction>
        <Button size="lg" disabled={!ok || !!h.busy} onClick={() => doc && h.fund(lease, doc)}>
          <KeyRound /> {h.busy ?? `Accept and pay ${usdc(lease.deposit)} USDC deposit`}
        </Button>
      </StickyAction>
    </>
  );
}

const ProposedWaiting = ({ lease, listing }: { lease: LeaseView; listing: ListingView | null }) => (
  <Waiting
    title={`Waiting for the tenant on ${apartmentName(lease, listing ? [listing] : [])}`}
    text={`Tenant ${short(lease.tenant, 5)} reviews the lease and funds the deposit to accept. Ask them to open the Lease tab in their window.`}
  />
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

function TimeControls({ lease, now, h, dispute }: { lease: LeaseView; now: number; h: Handlers; dispute?: DisputeView | null }) {
  if (!CAN_FAST_FORWARD) return null;
  const t = timing(lease, now);
  const steps: [string, number][] = lease.status === "disputed"
    ? [["Answer window over", lease.disputedAt + chain.DISPUTE_WINDOW_SECS + 1]]
    : lease.status === "mediation"
    ? dispute
      ? [
        ["Selection window over", dispute.selectionDeadline + 1],
        ["Verdict window over", dispute.verdictDeadline + 1],
      ]
      : []
    : t.allPaid
    ? [
      ["Term ends", t.end],
      ["Landlord window over", t.end + CLAIM_WINDOW_SECS + lease.claimPauseSecs + 1],
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

export function ActiveLease({ lease, listing, now, role, h }: { lease: LeaseView; listing: ListingView | null; now: number; role: Role; h: Handlers }) {
  const [deduction, setDeduction] = useState("0");
  const apartment = apartmentName(lease, listing ? [listing] : []);
  // On a confidential mint `pay_rent` moves nothing by itself: the transfer has to be composed
  // around it, which is workstream F's Pay section below. The public button stands down.
  const privateRent = useConfidentialRent(lease);
  const t = timing(lease, now);
  const dueIn = t.due - now;
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
              {/* The apartment leads: "Rent 2 of 6" says nothing about which place this is, and a
                  tenant or landlord with two leases open was reading two identical headers. */}
              <CardTitle>{apartment}</CardTitle>
              <CardDescription>
                Rent {Math.min(lease.paidCount + 1, lease.termPeriods)} of {lease.termPeriods} ·{" "}
                {t.allPaid
                  ? t.canRelease
                    ? "term finished"
                    : `term ends in ${duration(t.end - now)}`
                  : t.canPay
                    ? t.late
                      ? `overdue by ${duration(now - t.due)}`
                      : "payable now"
                    : `opens in ${duration(dueIn)}`}
              </CardDescription>
            </div>
            {status}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Periods lease={lease} />
            <Terms
              rows={[
                ...(apartmentWhere(lease, listing ? [listing] : []) ? ([["Where", apartmentWhere(lease, listing ? [listing] : [])]] as [string, string][]) : []),
                ["Rent paid", `${usdc(lease.paidCount * lease.rent)} of ${usdc(lease.termPeriods * lease.rent)} USDC`],
                ["Deposit in vault", `${usdc(lease.deposit)} USDC${lease.discountPct ? ` (−${lease.discountPct}% good standing)` : ""}`],
                ["Grace period", duration(lease.graceSecs)],
                [role === "tenant" ? "Landlord" : "Tenant", short(role === "tenant" ? lease.landlord : lease.tenant, 5)],
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
              <Input id="deduction" inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} aria-invalid={badDeduction} />
              <p className="text-xs text-muted-foreground">
                The tenant gets {usdc(Math.max(0, lease.deposit - deductionBase))} USDC back. Leave at 0 to return it in full. A deduction is only a proposal: the tenant can accept or reject it, and it is visible on both records.
              </p>
            </CardContent>
          </Card>
        )}

        {/* workstream F: the private rent payment, and the landlord's own view of what arrived */}
        <PaySection lease={lease} role={role} canPay={t.canPay} />

        <TimeControls lease={lease} now={now} h={h} />
      </div>

      <StickyAction>
        {role === "tenant" && !t.allPaid && !privateRent && (
          <Button size="lg" disabled={!t.canPay || !!h.busy} onClick={() => h.pay(lease)}>
            <HandCoins /> {h.busy ?? (t.canPay ? `Pay ${usdc(lease.rent)} USDC rent` : `Next rent opens in ${duration(dueIn)}`)}
          </Button>
        )}
        {role === "tenant" && t.allPaid && (
          <Button size="lg" variant={t.canClaim ? "default" : "secondary"} disabled={!t.canClaim || !!h.busy} onClick={() => h.claim(lease)}>
            <KeyRound />{" "}
            {h.busy ?? (t.canClaim ? "Landlord did not respond: claim my deposit" : "Waiting for the landlord to release the deposit")}
          </Button>
        )}
        {role === "landlord" && t.allPaid && (
          <Button size="lg" disabled={!t.canRelease || badDeduction || !!h.busy} onClick={() => h.release(lease, deductionBase)}>
            <KeyRound /> {h.busy ?? (t.canRelease ? (deductionBase > 0 ? "Propose deduction" : "Release deposit") : `Release opens in ${duration(t.end - now)}`)}
          </Button>
        )}
        {role === "landlord" && !t.allPaid && (
          <>
            <Button size="lg" variant={t.canDefault ? "destructive" : "secondary"} disabled={!t.canDefault || !!h.busy} onClick={() => h.markDefault(lease)}>
              <Gavel /> {h.busy ?? (t.canDefault ? "Declare default" : "Waiting for tenant rent")}
            </Button>
            {!t.canDefault && (
              <p className="text-center text-xs text-muted-foreground">
                Default opens {duration(t.due + lease.graceSecs + lease.periodSecs + 1 - now)} from now, one full period plus grace after a missed rent.
              </p>
            )}
          </>
        )}
      </StickyAction>
    </>
  );
}

// ---- a proposed deduction waiting for the tenant ----------------------------------------

/**
 * How long is left to answer, as a bar that empties.
 *
 * The window is the one thing on this screen that runs out while you look at it, and a tenant who
 * misses it loses the deposit to the landlord's figure. So it is counted in seconds, visibly,
 * rather than left in a sentence that only refreshes on the five-second tick.
 */
function AnswerWindow({ left, of }: { left: number; of: number }) {
  const secs = Math.max(0, left);
  // Under ten seconds it is no longer "plenty of time": the bar and the figure both go red.
  const urgent = secs <= 10;
  return (
    <div className="flex flex-col gap-1.5" role="timer" aria-live="off">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Time left to answer</span>
        <span className={cn("font-mono text-base font-semibold tabular-nums", urgent ? "text-destructive" : "text-foreground")}>
          {secs > 0 ? duration(secs) : "none"}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", urgent ? "bg-destructive" : "bg-primary")}
          style={{ width: `${of > 0 ? Math.min(100, Math.max(0, (secs / of) * 100)) : 0}%` }}
        />
      </div>
    </div>
  );
}

export function DisputedLease({
  lease,
  listing,
  now,
  role,
  h,
}: {
  lease: LeaseView;
  listing: ListingView | null;
  now: number;
  role: Role;
  h: Handlers;
}) {
  const answerBy = lease.disputedAt + chain.DISPUTE_WINDOW_SECS;
  // Per-second, because this window is short enough that the five-second tick is the difference
  // between rejecting in time and not.
  const clock = useChainClock(now) ?? now;
  const left = answerBy - clock;
  const open = left > 0;
  const kept = lease.proposedDeduction;
  const returned = lease.deposit - kept;
  // Which instruction this rejection is. The first one voids the proposal and lets the landlord
  // try again; the last one is `escalate_to_mediation` and hands the deposit to an appraiser.
  const next = med.rejection(lease.disputeRounds, chain.MAX_DISPUTE_ROUNDS);
  const copy =
    role === "landlord"
      ? open
        ? "Waiting for the tenant to accept or reject. Nothing has been paid yet."
        : "The tenant did not answer in time, so you can finalize your proposed deduction."
      : open
        ? `Your landlord wants to keep ${usdc(kept)} USDC and return ${usdc(returned)} USDC. Accept or reject before the window closes.`
        : "The answer window has passed. You can still accept; the landlord can now finalize.";
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <Waiting title={`Deduction proposed on ${apartmentName(lease, listing ? [listing] : [])}`} text={copy}>
          {open && (
            <div className="mb-4">
              <AnswerWindow left={left} of={chain.DISPUTE_WINDOW_SECS} />
            </div>
          )}
          <Terms
            rows={[
              ["Deposit in vault", `${usdc(lease.deposit)} USDC`],
              ["Proposed deduction", `${usdc(kept)} USDC`],
              ["Back to the tenant", `${usdc(returned)} USDC`],
            ]}
          />
          <div className="mt-3 flex flex-col gap-2">
            <Rounds used={lease.disputeRounds} max={chain.MAX_DISPUTE_ROUNDS} />
            {role === "tenant" && (
              <p className="text-xs text-muted-foreground">
                {next === "escalate"
                  ? "You have rejected once already, so this rejection does not hand you the deposit: the lease goes into mediation, you and the landlord choose an appraiser together, and their verdict splits it."
                  : "Rejecting returns the whole deposit to you after the usual claim wait; the landlord's proposal is void and the rejection stays on the record."}
              </p>
            )}
          </div>
        </Waiting>
        <TimeControls lease={lease} now={now} h={h} />
      </div>
      <StickyAction>
        {role === "tenant" && (
          <>
            {open && next !== "exhausted" && (
              // The rejection comes first: it is the move with a deadline on it, and the one the
              // tenant was losing to the clock.
              <Button
                size="lg"
                disabled={!!h.busy}
                onClick={() => (next === "escalate" ? h.escalateToMediation(lease) : h.abandonDispute(lease))}
              >
                {next === "escalate" ? <Scale /> : <X />}
                {h.busy ??
                  (next === "escalate"
                    ? `Reject: let an appraiser decide (${duration(left)} left)`
                    : `Reject the deduction (${duration(left)} left)`)}
              </Button>
            )}
            <Button size="lg" variant={open && next !== "exhausted" ? "outline" : "default"} disabled={!!h.busy} onClick={() => h.acceptDeduction(lease)}>
              <KeyRound /> {h.busy ?? `Accept: get ${usdc(returned)} USDC back`}
            </Button>
          </>
        )}
        {role === "landlord" && (
          <Button size="lg" disabled={open || !!h.busy} onClick={() => h.finalizeDeduction(lease)}>
            <Gavel /> {h.busy ?? (open ? `Finalize opens in ${duration(left)}` : "Finalize deduction")}
          </Button>
        )}
      </StickyAction>
    </>
  );
}

// ---- mediation: the two sides choose an appraiser, the appraiser decides -----------------

/**
 * The deposit is no longer either side's call (docs/contracts/dispute-mediation.md).
 *
 * The same screen serves both roles, because the program's selection is symmetric: either side
 * names up to three registered appraisers, either side picks one from *either* list, and the same
 * pick from both binds it. The state lives here and the pieces in `screens/Mediation.tsx` render
 * it, so the sticky action bar and the picker cannot disagree about what is selected.
 *
 * Every state on this screen has an exit that needs only one party: past the selection deadline
 * anyone binds the registry's fallback, and past the verdict deadline either party ends the
 * mediation and the deposit returns to the tenant through the usual claim. That is the property
 * the contract's §2 table asserts, and it is what these buttons are.
 *
 * The registry arrives as a prop rather than from a hook in here, so that every phase of this
 * screen can be rendered against invented data with no chain at all — which is the only way to
 * see it before the program is deployed (`app/mediation-preview.html`).
 */
export function MediationLease({
  lease,
  listing = null,
  dispute,
  now,
  role,
  h,
  options,
  directoryError = "",
}: {
  lease: LeaseView;
  listing?: ListingView | null;
  dispute: DisputeView | null | undefined;
  now: number;
  role: Role;
  h: Handlers;
  options: AppraiserOption[] | undefined;
  directoryError?: string;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [pick, setPick] = useState("");

  if (dispute === undefined) return <Waiting title="Loading" text="Reading the mediation from the network." />;
  if (!dispute)
    return (
      <Waiting
        title="Mediation not found"
        text="This lease says it is in mediation, but its dispute account could not be read. It is probably a moment out of date: it will appear on the next refresh, or the lease has just been settled from another window."
      />
    );

  const phase = med.phase(dispute, now);
  const expired = phase === "expired";
  const bound = !!dispute.appraiser;
  const rows = med.candidates(dispute);
  const mine = med.pickOf(dispute, role);
  const theirs = med.pickOf(dispute, med.other(role));
  const canPropose = med.canPropose(dispute, role);
  const fallback = options?.find((o) => o.isDefault && o.active);
  const target = pick || mine;
  // `undefined` is "still loading", so it must not read as "empty registry" and hide the picker.
  const anyActive = !options || options.some((o) => o.active);

  // The fee: exactly the bound appraiser's once there is one, otherwise the highest among the
  // names still in play — the whole active registry while nobody has proposed anything yet.
  const inPlay = bound
    ? [optionFor(options, dispute.appraiser)?.fee ?? 0]
    : rows.length
      ? rows.map((c) => optionFor(options, c.wallet)?.fee ?? 0)
      : (options ?? []).filter((o) => o.active).map((o) => o.fee);
  const fee = med.feeFor(lease.deposit, med.topFee(inPlay), chain.APPRAISER_FEE_CAP_DIVISOR);

  const headline = expired
    ? "The appraiser's window has passed with no verdict. Either side can end the mediation now: the lease returns to active and the deposit goes back to the tenant through the usual claim."
    : bound
      ? `The appraiser has ${duration(dispute.verdictDeadline - now)} to decide. Until then the deposit stays in the vault and neither of you can move it.`
      : now >= dispute.selectionDeadline
        ? "Nobody was agreed in time. You two can still agree between yourselves, or anyone can bring in the registry's fallback appraiser."
        : `Each side names up to ${med.MAX_CANDIDATES} appraisers and then both pick one — from either list. Agree within ${duration(dispute.selectionDeadline - now)}, or anyone can bring in the registry's fallback.`;

  return (
    <>
      <div className="rise flex flex-col gap-4">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>An appraiser decides the deposit on {apartmentName(lease, listing ? [listing] : [])}</CardTitle>
              <CardDescription>{headline}</CardDescription>
            </div>
            {statusBadge("mediation")}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Rounds used={lease.disputeRounds} max={chain.MAX_DISPUTE_ROUNDS} />
            <MediationTimeline dispute={dispute} openedAt={lease.disputedAt} now={now} />
            <Terms
              rows={[
                ["Deposit in vault", `${usdc(lease.deposit)} USDC`],
                ["The landlord's proposal", "void — the only numbers left are the verdict and one you both sign"],
                // claim_pause_secs is only written on the way out, so the stretch running right
                // now is added here: the tenant waits exactly as long as they would have without
                // any dispute (§5).
                ["Tenant's claim clock pushed back", duration(lease.claimPauseSecs + Math.max(0, now - lease.disputedAt))],
              ]}
            />
          </CardContent>
        </Card>

        {bound && <BoundAppraiser dispute={dispute} options={options} now={now} />}

        {!bound && !expired && (
          <>
            {canPropose && (
              <Card>
                <CardHeader>
                  <CardTitle>Name the appraisers you would accept</CardTitle>
                  <CardDescription>
                    {/* Promising a registry and then saying it is empty reads as a contradiction. */}
                    {anyActive
                      ? `Up to ${med.MAX_CANDIDATES}, from the platform's registry. Only registered, active companies can be named — that is what stops either side nominating their own.`
                      : "The platform's registry holds no active appraiser on this network."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {options ? (
                    <RegistryChoice options={options} chosen={chosen} onToggle={(w) => setChosen((c) => (c.includes(w) ? c.filter((x) => x !== w) : [...c, w]))} max={med.MAX_CANDIDATES} />
                  ) : (
                    <p className="text-sm text-muted-foreground">Reading the registry…</p>
                  )}
                </CardContent>
              </Card>
            )}

            {rows.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Agree on one</CardTitle>
                  <CardDescription>
                    Both lists, as one. Picking from the {med.other(role)}'s list is how the two of you converge, and the same pick from both binds
                    it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CandidateChoice dispute={dispute} role={role} options={options} pick={pick} onPick={setPick} />
                </CardContent>
              </Card>
            )}

            {rows.length === 0 && !canPropose && (
              <Waiting
                title="Waiting for the other side"
                text={`You have named your appraisers. Nothing can be picked until the ${med.other(role)} names theirs, or the selection window runs out and the registry's fallback can be brought in.`}
              />
            )}
          </>
        )}

        <Card>
          <CardHeader>
            <CardTitle>What the appraisal costs</CardTitle>
            <CardDescription>Loser pays, out of the deposit.</CardDescription>
          </CardHeader>
          <CardContent>
            <AppraiserFee deposit={lease.deposit} fee={fee} cap={med.feeCap(lease.deposit, chain.APPRAISER_FEE_CAP_DIVISOR)} exact={bound} />
          </CardContent>
        </Card>

        {/* The settle exit. There is deliberately no button: one transaction needs both
            signatures and this app holds one session (see chain.settleDisputeTx). */}
        <div className="flex flex-col gap-1.5 rounded-2xl border border-dashed border-input p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="size-3.5" /> Or settle it between you
          </p>
          <p className="text-xs text-muted-foreground">
            A figure you both sign closes the lease at any point in mediation, verdict or not. It takes one transaction signed by both wallets, which
            this window cannot collect on its own, so for now it is a script or multisig flow rather than a button.
          </p>
        </div>

        <OracleNote names={(options ?? []).filter((o) => o.active && o.name).map((o) => o.name)} />

        {directoryError && (
          <p className="text-xs text-muted-foreground">
            The appraiser directory could not be read ({directoryError}), so the names below the keys may be missing. The registry itself is on
            chain and is what the program checks.
          </p>
        )}

        <TimeControls lease={lease} now={now} h={h} dispute={dispute} />
      </div>

      <StickyAction>
        {expired ? (
          <Button size="lg" disabled={!!h.busy} onClick={() => h.expireMediation(lease)}>
            <Gavel /> {h.busy ?? "End the mediation and unlock the deposit"}
          </Button>
        ) : bound ? (
          <Button size="lg" variant="secondary" disabled>
            <Clock /> Waiting for {committedName(options, dispute.appraiser)} to decide
          </Button>
        ) : (
          <>
            {canPropose && (
              <Button
                size="lg"
                disabled={chosen.length === 0 || !anyActive || !!h.busy}
                onClick={async () => {
                  if (await h.proposeAppraisers(lease, chosen)) setChosen([]);
                }}
              >
                <Users />{" "}
                {h.busy ??
                  (!anyActive
                    ? "No appraiser is registered on this network"
                    : chosen.length
                      ? `Put forward ${chosen.length === 1 ? "this appraiser" : `these ${chosen.length}`}`
                      : `Choose up to ${med.MAX_CANDIDATES} appraisers`)}
              </Button>
            )}
            {rows.length > 0 && (
              <Button
                size="lg"
                variant={canPropose ? "outline" : "default"}
                disabled={!target || target === mine || !!h.busy}
                onClick={async () => {
                  if (await h.pickAppraiser(lease, target)) setPick("");
                }}
              >
                <Scale />{" "}
                {h.busy ??
                  (!target
                    ? "Pick an appraiser above"
                    : target === mine
                      ? // Both have picked and the picks differ: the move that ends this is to take
                        // theirs, so the dead button says which name to tap rather than restating
                        // what this side already did.
                        theirs && theirs !== mine
                        ? `Pick ${committedName(options, theirs)} above to agree`
                        : `You picked ${committedName(options, mine)}`
                      : mine
                        ? `Change to ${committedName(options, target)}`
                        : `Agree on ${committedName(options, target)}`)}
              </Button>
            )}
            {med.canBindDefault(dispute, now) && fallback && (
              <Button size="lg" variant="outline" disabled={!!h.busy} onClick={() => h.bindDefaultAppraiser(lease, fallback.wallet)}>
                <Gavel /> {h.busy ?? `Bring in the fallback: ${committedName(options, fallback.wallet)}`}
              </Button>
            )}
          </>
        )}
      </StickyAction>
    </>
  );
}

// ---- finished: the track record ---------------------------------------------------------

function Finished({ lease, listing, snap, onNew }: { lease: LeaseView; listing: ListingView | null; snap: Snapshot; onNew?: () => void }) {
  const [who, setWho] = useState<Role>("tenant");
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">
            {apartmentName(lease, listing ? [listing] : [])}: {lease.status === "defaulted" ? "ended in default" : "lease completed"}
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
              className={cn(
                "h-10 flex-1 rounded-lg text-sm font-medium transition-colors",
                who === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {r === "tenant" ? "Tenant" : "Landlord"}
            </button>
          ))}
        </div>
        <ProfileCard role={who} address={lease[who]} profile={snap.profiles[who]} />
        {lease.status === "closed" && chain.goodStanding(snap.profiles.tenant) && (
          <p className="flex items-start gap-2 rounded-xl bg-success-soft p-3 text-sm text-success">
            <Sparkles className="mt-0.5 size-4 shrink-0" />
            This record qualifies the tenant for a {DISCOUNT_PCT}% smaller deposit on the next lease with rent up to{" "}
            {usdc(maxDiscountRent(snap.profiles.tenant))} USDC.
          </p>
        )}
      </div>
      {onNew && (
        <StickyAction>
          <Button size="lg" onClick={onNew}>
            <Handshake /> Propose another lease
          </Button>
        </StickyAction>
      )}
    </>
  );
}

/**
 * `listings` is EVERY listing, not only this wallet's.
 *
 * A tenant's lease was proposed on their landlord's advertisement, so naming the apartment on the
 * tenant's own screens needs the other side's listings too (`lib/apartment.ts`). The scan is the
 * same shared read the Apartments tab already does, so this costs nothing. `mine` is what a
 * landlord may propose a lease on.
 */
export function LeaseTab({
  role,
  me,
  listings,
  now,
  h,
  log,
  goListings,
}: {
  role: Role;
  me: string;
  listings: ListingView[];
  now: number | undefined;
  h: Handlers;
  log: LogEntry[];
  goListings: () => void;
}) {
  const leases = useChain(() => chain.loadLeases(me, role), [me, role]);
  const [sel, setSel] = useState<string | null>(null); // a lease address, "new", or null = the sensible default
  const mine = listings.filter((l) => l.landlord === me);

  // an applicant chosen below opens a proposal for them
  const [draft, setDraft] = useState<{ listing: string; tenant: string } | null>(null);
  const applications = useChain(() => (role === "landlord" ? chain.loadApplications({ landlord: me }) : Promise.resolve([])), [me, role]) ?? [];
  const applicants = applications.filter((a) => mine.some((l) => l.address === a.listing));
  const records = useRecords(unique(applicants.map((a) => a.tenant)));

  const list = leases ?? [];
  const open = list.find((l) => chain.inProgress(l.status));
  const current = sel ?? open?.address ?? list[0]?.address ?? (role === "landlord" ? "new" : "");
  const lease = list.find((l) => l.address === current) ?? null;

  // The Dispute PDA exists exactly while the lease is in Mediation, so it is only read then —
  // `undefined` is "still loading", `null` is "no such account".
  const dispute = useChain(
    () => (lease?.status === "mediation" ? chain.loadDispute(lease.address) : Promise.resolve(null)),
    [lease?.address, lease?.status],
  );
  const { options, directoryError } = useAppraiserOptions(lease?.status === "mediation");

  const parties = useChain(
    () => (lease ? Promise.all([chain.loadProfile(lease.landlord), chain.loadProfile(lease.tenant)]) : Promise.resolve(null)),
    [lease?.landlord, lease?.tenant],
  );
  const snap: Snapshot | null = now !== undefined && parties ? { now, profiles: { landlord: parties[0], tenant: parties[1] } } : null;
  // The advertisement this lease was proposed on, when it can still be told apart from the
  // landlord's others. Null is a normal answer — the listing may have been removed since.
  const listing = lease ? leaseListing(lease, listings) : null;

  const proposeAndSelect: Handlers["propose"] = async (id, l, tenant, doc, application) => {
    const ok = await h.propose(id, l, tenant, doc, application);
    if (ok) {
      setDraft(null);
      setSel(chain.leaseAddress(me, id));
    }
    return ok;
  };

  let main: React.ReactNode;
  if (!leases || now === undefined) main = <Waiting title="Loading" text="Reading your leases from the network." />;
  else if (current === "new")
    main = (
      <ProposeLease key={draft ? draft.listing + draft.tenant : "blank"} me={me} listings={mine} h={{ ...h, propose: proposeAndSelect }} goListings={goListings} initial={draft ?? undefined} />
    );
  else if (!lease)
    main = (
      <Waiting
        title="No lease for you yet"
        text={`You are connected as ${me}. A landlord has to propose the lease to exactly this address; anything proposed to another wallet will not show up. Apply to an apartment in the Apartments tab to make yourself known.`}
      />
    );
  else if (!snap) main = <Waiting title="Loading" text="Reading both records from the network." />;
  else if (lease.status === "proposed")
    main = role === "tenant" ? <AcceptLease lease={lease} listing={listing} h={h} /> : <ProposedWaiting lease={lease} listing={listing} />;
  else if (lease.status === "active") main = <ActiveLease lease={lease} listing={listing} now={now} role={role} h={h} />;
  else if (lease.status === "disputed") main = <DisputedLease lease={lease} listing={listing} now={now} role={role} h={h} />;
  else if (lease.status === "mediation")
    main = (
      <MediationLease lease={lease} listing={listing} dispute={dispute} now={now} role={role} h={h} options={options} directoryError={directoryError} />
    );
  else main = <Finished lease={lease} listing={listing} snap={snap} onNew={role === "landlord" ? () => setSel("new") : undefined} />;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-5">{main}</div>

      <aside className="flex flex-col gap-4">
        {role === "landlord" && (
          <Card className="p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Applicants ({applicants.length})</p>
            {applicants.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody has applied yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {applicants.map((a) => (
                  <li key={a.address} className="flex flex-col gap-1.5 rounded-xl bg-secondary/50 p-3">
                    <p className="text-xs text-muted-foreground">{mine.find((l) => l.address === a.listing)?.title}</p>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{short(a.tenant, 5)}</span>
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          disabled={!!h.busy}
                          onClick={() => {
                            setDraft({ listing: a.listing, tenant: a.tenant });
                            setSel("new");
                          }}
                        >
                          Propose lease
                        </Button>
                        <Button size="sm" variant="ghost" title="Dismiss" aria-label="Dismiss application" disabled={!!h.busy} onClick={() => h.closeApplication(a)}>
                          <X />
                        </Button>
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{recordLine("tenant", records[a.tenant])}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your leases</p>
            {role === "landlord" && (
              <Button size="sm" variant={current === "new" ? "secondary" : "outline"} onClick={() => setSel("new")}>
                <Plus /> New
              </Button>
            )}
          </div>
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {list.map((l) => (
                <li key={l.address}>
                  <button
                    onClick={() => setSel(l.address)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      current === l.address ? "bg-secondary" : "hover:bg-secondary/50",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{apartmentName(l, listings)}</span>
                      <span className="text-xs text-muted-foreground">
                        {role === "landlord" ? "Tenant" : "Landlord"} {short(role === "landlord" ? l.tenant : l.landlord, 4)} · {usdc(l.rent)} USDC ·{" "}
                        {l.paidCount}/{l.termPeriods} paid
                      </span>
                    </span>
                    {statusBadge(l.status)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {log.length > 0 && (
          <Card className="p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transactions</p>
            <ul className="flex flex-col divide-y divide-border">
              {log.map((e) => (
                <li key={e.sig}>
                  <a href={chain.explorerTx(e.sig)} target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-between gap-3 text-sm">
                    <span>{e.label.replace("…", "")}</span>
                    <span className="flex items-center gap-1 font-mono text-xs text-accent">
                      {short(e.sig, 5)} <ArrowUpRight className="size-3.5" />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </aside>
    </div>
  );
}
