import { useState } from "react";
import { ArrowUpRight, Clock, FastForward, Gavel, Handshake, HandCoins, KeyRound, Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DocPicker } from "@/components/DocPicker";
import { ProfileCard } from "@/components/ProfileCard";
import { Terms, termRows } from "@/components/Terms";
import { Doc } from "@/lib/hash";
import * as chain from "@/lib/chain";
import { DISCOUNT_PCT, LeaseView, ListingView, NewListing, Role, Snapshot, Status, isWallet, maxDiscountRent, qualifiesForDiscount } from "@/lib/chain";
import { CAN_FAST_FORWARD, CLAIM_WINDOW_SECS, PERIOD_SECS, TERM_PERIODS, USDC } from "@/lib/config";
import { useChain } from "@/lib/useChain";
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
  propose: (id: string, l: ListingView, tenant: string, doc: Doc) => Promise<boolean>;
  fund: (l: LeaseView, doc: Doc) => Promise<boolean>;
  pay: (l: LeaseView) => Promise<boolean>;
  release: (l: LeaseView, deduction: number) => Promise<boolean>;
  markDefault: (l: LeaseView) => Promise<boolean>;
  claim: (l: LeaseView) => Promise<boolean>;
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
    canClaim: allPaid && now >= end + CLAIM_WINDOW_SECS,
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
}: {
  me: string;
  listings: ListingView[];
  h: Handlers;
  goListings: () => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [tenant, setTenant] = useState("");
  const [pick, setPick] = useState("");
  const listing = listings.find((l) => l.address === pick) ?? listings[0];

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
  const deposit = discount ? (listing.deposit * (100 - DISCOUNT_PCT)) / 100 : listing.deposit;
  const propose = () => doc && valid && h.propose(chain.newId(), listing, who, doc);

  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Propose a lease</h2>
          <p className="text-sm text-muted-foreground">
            Pick the listing, name the tenant's wallet and attach the signed contract. Only its fingerprint goes on-chain, so both sides are bound to
            this exact document.
          </p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Listing
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
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Tenant wallet
              <Input
                className="font-mono text-sm font-normal"
                placeholder="Paste the address from the tenant's window"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                aria-invalid={!!who && !valid}
              />
              {who && !valid && (
                <span className="text-xs font-normal text-destructive">
                  {who === me ? "That is your own wallet." : "Not a valid wallet address."}
                </span>
              )}
            </label>
            <DocPicker label="Lease document" hint="PDF or scan, signed off-chain" doc={doc} onDoc={setDoc} />
            <Terms
              rows={termRows({
                rent: listing.rent,
                deposit,
                term: TERM_PERIODS,
                periodSecs: PERIOD_SECS,
                region: listing.region,
                discountPct: discount ? DISCOUNT_PCT : 0,
              })}
            />
          </CardContent>
        </Card>

        {valid && (
          <div className="flex flex-col gap-2">
            <ProfileCard role="tenant" address={who} profile={record} />
            {tooBig && (
              <p className="rounded-xl bg-secondary p-3 text-sm text-muted-foreground">
                No discount here: this rent is above {usdc(maxDiscountRent(record))} USDC, the most the tenant's typical rent of past leases covers.
              </p>
            )}
            {discount && (
              <p className="flex items-start gap-2 rounded-xl bg-[#eef2e4] p-3 text-sm text-success">
                <Sparkles className="mt-0.5 size-4 shrink-0" />
                Good standing: no late payments, no defaults. The program takes {DISCOUNT_PCT}% off the deposit when the lease is proposed.
              </p>
            )}
          </div>
        )}
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

export function AcceptLease({ lease, h }: { lease: LeaseView; h: Handlers }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const ok = doc?.hex === lease.hashHex;
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Review and accept</h2>
          <p className="text-sm text-muted-foreground">
            Landlord {short(lease.landlord, 5)} proposed this lease. Attach the contract you received: funding the deposit only works if it is the
            same document.
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-4 p-5">
            <Terms rows={termRows({ ...lease, term: lease.termPeriods, hashHex: lease.hashHex })} />
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

const ProposedWaiting = ({ lease }: { lease: LeaseView }) => (
  <Waiting
    title="Waiting for the tenant"
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

export function ActiveLease({ lease, now, role, h }: { lease: LeaseView; now: number; role: Role; h: Handlers }) {
  const [deduction, setDeduction] = useState("0");
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
              <CardTitle>
                Rent {Math.min(lease.paidCount + 1, lease.termPeriods)} of {lease.termPeriods}
              </CardTitle>
              <CardDescription>
                {t.allPaid
                  ? t.canRelease
                    ? "Term finished"
                    : `Term ends in ${duration(t.end - now)}`
                  : t.canPay
                    ? t.late
                      ? `Overdue by ${duration(now - t.due)}`
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
                ["Region", lease.region],
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
                The tenant gets {usdc(Math.max(0, lease.deposit - deductionBase))} USDC back. Leave at 0 to return it in full; deductions are visible on both
                records.
              </p>
            </CardContent>
          </Card>
        )}

        <TimeControls lease={lease} now={now} h={h} />
      </div>

      <StickyAction>
        {role === "tenant" && !t.allPaid && (
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
            <KeyRound /> {h.busy ?? (t.canRelease ? "Release deposit" : `Release opens in ${duration(t.end - now)}`)}
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

// ---- finished: the track record ---------------------------------------------------------

function Finished({ lease, snap, onNew }: { lease: LeaseView; snap: Snapshot; onNew?: () => void }) {
  const [who, setWho] = useState<Role>("tenant");
  return (
    <>
      <div className="rise flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold">{lease.status === "defaulted" ? "Lease ended in default" : "Lease completed"}</h2>
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
          <p className="flex items-start gap-2 rounded-xl bg-[#eef2e4] p-3 text-sm text-success">
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

  const list = leases ?? [];
  const open = list.find((l) => l.status === "proposed" || l.status === "active");
  const current = sel ?? open?.address ?? list[0]?.address ?? (role === "landlord" ? "new" : "");
  const lease = list.find((l) => l.address === current) ?? null;

  const parties = useChain(
    () => (lease ? Promise.all([chain.loadProfile(lease.landlord), chain.loadProfile(lease.tenant)]) : Promise.resolve(null)),
    [lease?.landlord, lease?.tenant],
  );
  const snap: Snapshot | null = now !== undefined && parties ? { now, profiles: { landlord: parties[0], tenant: parties[1] } } : null;

  const proposeAndSelect: Handlers["propose"] = async (id, l, tenant, doc) => {
    const ok = await h.propose(id, l, tenant, doc);
    if (ok) setSel(chain.leaseAddress(me, id));
    return ok;
  };

  let main: React.ReactNode;
  if (!leases || now === undefined) main = <Waiting title="Loading" text="Reading your leases from the network." />;
  else if (current === "new")
    main = <ProposeLease me={me} listings={listings} h={{ ...h, propose: proposeAndSelect }} goListings={goListings} />;
  else if (!lease)
    main = (
      <Waiting
        title="No lease for you yet"
        text="When a landlord proposes a lease to your wallet it shows up here. Give them the address from the wallet button at the top of this window."
      />
    );
  else if (!snap) main = <Waiting title="Loading" text="Reading both records from the network." />;
  else if (lease.status === "proposed") main = role === "tenant" ? <AcceptLease lease={lease} h={h} /> : <ProposedWaiting lease={lease} />;
  else if (lease.status === "active") main = <ActiveLease lease={lease} now={now} role={role} h={h} />;
  else main = <Finished lease={lease} snap={snap} onNew={role === "landlord" ? () => setSel("new") : undefined} />;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-5">{main}</div>

      <aside className="flex flex-col gap-4">
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
                    <span>
                      <span className="block font-mono text-xs">
                        {role === "landlord" ? "Tenant" : "Landlord"} {short(role === "landlord" ? l.tenant : l.landlord, 4)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {usdc(l.rent)} USDC · {l.paidCount}/{l.termPeriods} paid
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
