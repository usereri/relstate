// The Mediation screen's pieces (docs/contracts/dispute-mediation.md, revision 2).
//
// Two rejected deductions later, neither side decides any more: an appraisal company the two of
// them choose together does. These are the parts of that screen — the round indicator, the status
// timeline, the fee line, and the four steps of choosing — all controlled components, so the lease
// screen in `screens.tsx` owns the state and the buttons and these only render.
//
// Nothing here knows which role is reading it beyond the `role` prop: the selection is symmetric on
// purpose, because the program makes it symmetric (either side names companies, either side picks,
// either side may put the appraiser's account forward and the other confirms it).
//
// Two rules about words, both load-bearing:
//
//  1. **The company name is the identity, not the address.** Nobody using this is a crypto user.
//     The only place a raw account address is the thing on screen is the confirm step, where the
//     whole point is that a person looks at the exact key before it becomes able to spend their
//     deposit; everywhere else it is a muted second line at most.
//  2. **Say what happens if nobody cooperates.** The deposit goes back to the tenant. That is the
//     honest answer to "why would the tenant ever agree to this" (review G5), and it belongs on
//     the screen rather than only in a contract document.
import { AlertTriangle, BadgeCheck, Building2, Check, Clock, Hourglass, Mail, Scale, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Terms } from "@/components/Terms";
import * as chain from "@/lib/chain";
import type { DisputeView, Role } from "@/lib/chain";
import { MAX_CANDIDATES, nameProblem } from "@/lib/appraisers";
import { INVITES_AVAILABLE, type IssuedInvite, type LeaseInvite } from "@/lib/invites";
import * as med from "@/lib/mediation";
import { cn, duration, parseAmountInput, short, usdc } from "@/lib/utils";

/** How a person is named on screen: their side of the lease, never their address. */
export const sideName = (role: Role): string => (role === "landlord" ? "the landlord" : "the tenant");
const Side = ({ role }: { role: Role }) => <>{sideName(role)}</>;

// ---- how many rounds are left ---------------------------------------------------------

/**
 * `used` rejections spent out of `max`, and what the next one does.
 *
 * `MAX_DISPUTE_ROUNDS` comes from the IDL, so this counts pips of whatever the build allows rather
 * than assuming two.
 */
export function Rounds({ used, max }: { used: number; max: number }) {
  const next = med.rejection(used, max);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-1.5">
        <span className="flex gap-1" aria-hidden>
          {Array.from({ length: max }, (_, i) => (
            <span key={i} className={cn("size-2 rounded-full", i < used ? "bg-primary" : "bg-secondary ring-1 ring-inset ring-border")} />
          ))}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{med.roundLabel(used, max)}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        {next === "abandon"
          ? "Rejecting this voids the proposal and the landlord may propose once more."
          : next === "escalate"
            ? "This is the last round: rejecting it hands the decision to an independent appraiser."
            : "Both rounds are spent, so neither side decides the deduction any more."}
      </span>
    </div>
  );
}

// ---- the status timeline ---------------------------------------------------------------

const when = (at: number, now: number) => (at === 0 ? "" : at > now ? `in ${duration(at - now)}` : `${duration(now - at)} ago`);

/** Where this lease stands: opened, the company, the appraiser's account, the verdict. */
export function MediationTimeline({ dispute, openedAt, now }: { dispute: DisputeView; openedAt: number; now: number }) {
  const steps = med.timeline(dispute, openedAt, now);
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3">
          <span className="flex flex-col items-center">
            <span
              className={cn(
                "mt-1 grid size-4 shrink-0 place-items-center rounded-full",
                s.state === "done" ? "bg-primary text-primary-foreground" : s.state === "now" ? "bg-card ring-2 ring-primary" : "bg-secondary ring-1 ring-inset ring-border",
              )}
            >
              {s.state === "done" && <Check className="size-2.5" />}
            </span>
            {i < steps.length - 1 && <span className={cn("my-1 w-0.5 flex-1", s.state === "done" ? "bg-primary/40" : "bg-border")} />}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 pb-4">
            <span className={cn("text-sm", s.state === "later" ? "text-muted-foreground" : "font-medium")}>{s.label}</span>
            {/* `at: 0` is "no date to show", which is what an unbound mediation's verdict step is:
                `verdict_deadline` does not exist until somebody is bound (G2). */}
            {s.at > 0 && <span className="font-mono text-xs tabular-nums text-muted-foreground">{when(s.at, now)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---- the fee ---------------------------------------------------------------------------

/**
 * What the appraisal costs and who pays it.
 *
 * Loser pays, out of the deposit: no second escrow, and nobody posts a stake before the appraisal
 * starts (§6). `fee` is already the capped number — what the program would actually pay — and
 * `exact` says whether a company is agreed, because until one is, the fee is only the highest of
 * the quotes still in play. With nothing in play at all the honest answer is neither a number nor
 * "up to 0", which would read as free.
 */
export function AppraiserFee({ deposit, fee, cap, exact }: { deposit: number; fee: number; cap: number; exact: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Terms
        rows={[
          ["The appraiser's fee", exact ? `${usdc(fee)} USDC` : fee > 0 ? `up to ${usdc(fee)} USDC` : "whatever the company you agree on quotes"],
          ["Never more than", `${usdc(cap)} USDC · a tenth of the ${usdc(deposit)} USDC deposit`],
          ["Paid by", "the side the verdict goes against, out of the deposit"],
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Nothing to pay up front: the fee comes out of the deposit. If you both quote the same company, the lower quote counts.
      </p>
    </div>
  );
}

// ---- step one: name the companies you would accept -------------------------------------

/** One row of the proposal form: what was typed, kept as typed so the field never fights the user. */
export interface NameDraft {
  name: string;
  /** A decimal USDC amount as typed; "" means no quote, which the program takes as a fee of 0. */
  fee: string;
}

export const emptyDrafts = (): NameDraft[] => Array.from({ length: MAX_CANDIDATES }, () => ({ name: "", fee: "" }));

/**
 * Why this draft cannot be sent, or null when it can. The same checks the program makes, in the
 * same order, so nothing gets as far as a transaction that the chain would refuse (§4).
 */
export function draftProblem(drafts: NameDraft[], cap: number): string | null {
  const filled = drafts.filter((d) => d.name.trim() !== "" || d.fee.trim() !== "");
  if (filled.length === 0) return "Name at least one company you would accept.";
  const seen = new Set<string>();
  for (const d of filled) {
    const problem = nameProblem(d.name);
    if (problem) return problem;
    const key = d.name.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return "You have the same company in the list twice.";
    seen.add(key);
    if (d.fee.trim() !== "") {
      const parsed = parseAmountInput(d.fee);
      if ("error" in parsed) return `The quote for "${d.name.trim()}": ${parsed.error}`;
      if (parsed.base > cap) return `A quote of ${usdc(parsed.base)} USDC is above the ${usdc(cap)} USDC this deposit allows.`;
    }
  }
  return null;
}

/** The drafts as the instruction takes them, with an empty quote meaning a fee of nothing. */
export function draftsToQuotes(drafts: NameDraft[]): chain.CompanyQuote[] {
  return drafts
    .filter((d) => d.name.trim() !== "")
    .map((d) => {
      const parsed = parseAmountInput(d.fee);
      return { name: d.name.trim(), fee: "base" in parsed ? parsed.base : 0 };
    });
}

/**
 * Up to three companies this side would accept, typed in.
 *
 * There is no list to choose from, and the copy says so before anybody hunts for one: the platform
 * keeps no register of appraisers and cannot install one for you (§10 item 1). Naming firms you
 * already trust is the whole mechanism.
 */
export function NameProposal({
  drafts,
  onChange,
  cap,
  disabled,
}: {
  drafts: NameDraft[];
  onChange: (drafts: NameDraft[]) => void;
  cap: number;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<NameDraft>) => onChange(drafts.map((d, j) => (i === j ? { ...d, ...patch } : d)));
  const problem = draftProblem(drafts, cap);
  const typed = drafts.filter((d) => d.name.trim() !== "").length;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 rounded-xl bg-secondary/60 p-3 text-sm">
        <Building2 className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          <b>You are not choosing from a list.</b> Name the appraisal firms you would trust to look at this flat — up to {MAX_CANDIDATES} of them. Ask
          around, search locally, use one you have used before. Relstate keeps no register of appraisers and cannot pick one for you.
        </span>
      </p>
      <ul className="flex flex-col gap-2">
        {drafts.map((d, i) => (
          <li key={i} className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label={`Company ${i + 1}`}
              placeholder={i === 0 ? "Name of an appraisal company" : "Another company (optional)"}
              value={d.name}
              disabled={disabled}
              maxLength={64}
              onChange={(e) => set(i, { name: e.target.value })}
              className="sm:flex-1"
            />
            <Input
              aria-label={`What company ${i + 1} charges, in USDC`}
              inputMode="decimal"
              placeholder="Their fee (optional)"
              value={d.fee}
              disabled={disabled || d.name.trim() === ""}
              onChange={(e) => set(i, { fee: e.target.value })}
              className="sm:w-44"
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {typed} of {MAX_CANDIDATES} named. You send this list once and cannot change it — after that you can still agree on any company from either
        list. Leave a fee blank if you do not know it yet; the appraiser confirms what they charge when they are invited.
      </p>
      {problem && typed > 0 && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}

/** The other side's list, read-only, for a side that has already sent its own. */
export function TheirNames({ dispute, role }: { dispute: DisputeView; role: Role }) {
  const theirs = med.candidatesOf(dispute, med.other(role));
  if (theirs.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        <Side role={med.other(role)} /> has not named anybody yet. Nothing can be agreed until they do — or the window runs out, which returns the
        deposit to the tenant.
      </p>
    );
  return (
    <ul className="flex flex-col gap-1.5">
      {theirs.map((c) => (
        <li key={c.nameHashHex} className="flex items-baseline justify-between gap-3 rounded-xl border border-input px-3 py-2 text-sm">
          <span className="min-w-0 font-medium">{c.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{c.fee > 0 ? `${usdc(c.fee)} USDC` : "no fee quoted"}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- step two: agree on one -------------------------------------------------------------

/**
 * Both lists as one, with who named each company and who has picked it.
 *
 * Picking from the other side's list is the intended way to converge, so the two lists are shown as
 * one and labelled by origin rather than split into "mine" and "theirs". The fee shown is the lower
 * of the two quotes where both sides named the same firm, because that is the one that would be
 * agreed (§4).
 */
export function CandidateChoice({
  dispute,
  role,
  pick,
  onPick,
}: {
  dispute: DisputeView;
  role: Role;
  /** The row this side has selected on screen but not yet sent, as a `name_hash`. */
  pick: string;
  onPick: (nameHash: string) => void;
}) {
  const rows = med.candidates(dispute);
  const mine = med.pickOf(dispute, role);
  const theirs = med.pickOf(dispute, med.other(role));
  const them = med.other(role);
  const minePicked = med.pickedRow(dispute, role);
  const theirsPicked = med.pickedRow(dispute, them);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {rows.map((c) => {
          const on = c.nameHashHex === (pick || mine);
          const theyPicked = role === "landlord" ? c.tenantPicked : c.landlordPicked;
          return (
            <li key={c.nameHashHex}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPick(c.nameHashHex)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                  on ? "border-primary bg-secondary" : "border-input hover:bg-secondary/50",
                )}
              >
                <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-primary" : "border-input")}>
                  {on && <span className="size-2.5 rounded-full bg-primary" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {c.name}
                    {c.agreed && <Badge variant="success">agreed</Badge>}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>named by {c.proposedBy.length === 2 ? "both of you" : c.proposedBy[0] === role ? "you" : sideName(them)}</span>
                    <span>{c.fee > 0 ? `${usdc(c.fee)} USDC` : "no fee quoted"}</span>
                    {theyPicked && <span className="text-foreground">· {sideName(them)} picked this</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {mine ? `You picked ${minePicked?.name ?? "a company that is no longer listed"}. ` : "You have not picked yet. "}
        {theirs ? `${sideName(them)[0].toUpperCase()}${sideName(them).slice(1)} picked ${theirsPicked?.name ?? "something not listed"}.` : `${sideName(them)[0].toUpperCase()}${sideName(them).slice(1)} has not picked yet.`} The
        same pick from both of you settles it, and you can change yours until then.
      </p>
    </div>
  );
}

// ---- step three: invite the company ----------------------------------------------------

/**
 * The invitation: an e-mail to the agreed company, which brings back the account they will sign
 * with.
 *
 * This is the one step the program cannot see at all. It knows a name, and separately a key, and it
 * cannot check that they belong together (§10 item 3) — so the invitation is how the two of you
 * take responsibility for that link, and the confirm step is where you both say you accept it.
 */
export function InviteAppraiser({
  company,
  email,
  onEmail,
  issued,
  invite,
  error,
  children,
}: {
  company: string;
  email: string;
  onEmail: (email: string) => void;
  /** What came back from the invitation that was just sent, in this session. */
  issued: IssuedInvite | null;
  /** The invitation this lease already has, as either party can read it. */
  invite: LeaseInvite | null | undefined;
  error: string | null;
  /** The send button, owned by the lease screen. */
  children?: React.ReactNode;
}) {
  if (!INVITES_AVAILABLE)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          This window cannot send e-mail (it is running without a backend), so invite <b>{company}</b> yourself and ask them to send you the account
          address they sign in with. Paste it below — that is all the program ever sees.
        </p>
      </div>
    );
  const pending = invite && invite.status === "pending";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        We will e-mail <b>{company}</b> a link. They open it, create an account in a minute, and the account they end up with comes back here for both
        of you to confirm. Nobody needs to install anything.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          autoComplete="off"
          aria-label={`Email address for ${company}`}
          placeholder="office@company.example"
          value={email}
          onChange={(e) => onEmail(e.target.value)}
          className="sm:flex-1"
        />
        {children}
      </div>
      {error && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {issued && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-success/40 bg-success-soft p-3 text-sm text-success">
          <p className="flex items-center gap-1.5 font-medium">
            <Mail className="size-4 shrink-0" /> Invitation sent to {issued.email || "the address you gave"}
          </p>
          <p className="text-xs">
            It can be used until {issued.expiresAt ? when(issued.expiresAt, Math.floor(Date.now() / 1000)) : "the window closes"}. Sending another
            invitation cancels this link.
          </p>
          {/* Only a backend in mock mode returns the link; a live one e-mails it and nothing else.
              On a stage there is no mail server, so this is how the demo reaches the next window. */}
          {issued.url && (
            <p className="break-all font-mono text-xs">
              Demo link (no mail server configured): <span className="underline">{issued.url}</span>
            </p>
          )}
        </div>
      )}
      {pending && !issued && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Hourglass className="size-4 shrink-0" />
          {invite.issuedBy === "landlord" ? "The landlord" : "The tenant"} has invited {invite.companyName}. Waiting for them to open the link.
        </p>
      )}
    </div>
  );
}

// ---- step four: confirm the account ----------------------------------------------------

/**
 * The confirm step, and the only place in the whole app where a raw account address is the thing
 * being read rather than a detail under a name.
 *
 * It has to be. The program's guarantee is exactly "both parties confirmed this account", not "this
 * account belongs to Acme Wycena" (§10 item 3), so what each party is really signing is that they
 * looked at these characters and believe they came from the company. The address is shown in full,
 * in a monospace block, with the company name above it and nothing else competing for attention.
 */
export function ConfirmWallet({
  company,
  wallet,
  proposedBy,
  role,
  fee,
  children,
}: {
  company: string;
  wallet: string;
  /** Which side put this account forward; "" when the app cannot tell (an unreadable key). */
  proposedBy: Role | "";
  role: Role;
  fee: number;
  children?: React.ReactNode;
}) {
  const mine = proposedBy === role;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {mine ? (
          <>
            You put this account forward for <b>{company}</b>. <Side role={med.other(role)} /> is the one who confirms it — that is deliberate, and it
            is what stops either of you choosing the appraiser on your own.
          </>
        ) : (
          <>
            <span className="capitalize">{proposedBy ? sideName(proposedBy) : "The other side"}</span> put this account forward for{" "}
            <b>{company}</b>. Confirm it only if you believe it really is theirs.
          </>
        )}
      </p>
      <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{company}'s account</p>
        <p className="break-all font-mono text-sm">{wallet}</p>
      </div>
      <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-xs text-warning">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>
          Check these characters against what the company told you, in whatever way you reached them. Once you both confirm it, this account — and
          only this account — decides how the {usdc(fee)} USDC fee and the rest of the deposit are split. Relstate cannot check that it belongs to{" "}
          {company}; the two of you are what checks it.
        </span>
      </p>
      {children}
    </div>
  );
}

/** The account one side has put forward, waiting for the other. Also where a counter-proposal goes. */
export function WalletProposal({
  wallet,
  onWallet,
  invite,
  left,
  children,
}: {
  wallet: string;
  onWallet: (wallet: string) => void;
  /** The claimed invitation, when there is one: its wallet is what should go in the field. */
  invite: LeaseInvite | null | undefined;
  /** This side's own remaining attempts (`MAX_KEY_PROPOSALS_PER_PARTY`). */
  left: number;
  children?: React.ReactNode;
}) {
  const claimed = invite?.status === "claimed" ? invite.wallet : "";
  return (
    <div className="flex flex-col gap-3">
      {claimed ? (
        <p className="flex items-start gap-2 rounded-xl bg-secondary/60 p-3 text-sm">
          <Wallet className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <b>{invite?.companyName}</b> has opened the invitation and created an account. Put it forward, and {" "}
            {invite?.issuedBy === "landlord" ? "the tenant" : "the landlord"} confirms it.
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          If the appraiser sent you their account address another way, paste it here.
        </p>
      )}
      <Input
        aria-label="The appraiser's account address"
        className="font-mono text-sm"
        spellCheck={false}
        placeholder={claimed || "The appraiser's account address"}
        value={wallet}
        onChange={(e) => onWallet(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        You can do this {left === 1 ? "once more" : `${left} more times`}. Your attempts are your own — whatever you use them on,{" "}
        {left > 0 ? "the other side can still put a different account forward" : "the other side still has theirs"}.
      </p>
      {children}
    </div>
  );
}

// ---- bound: waiting for the verdict ----------------------------------------------------

/** Who is deciding, how they got there, and how long they have. */
export function BoundAppraiser({ dispute, now, fee }: { dispute: DisputeView; now: number; fee: number }) {
  const name = med.agreedName(dispute);
  const open = dispute.verdictDeadline > now;
  return (
    <Card>
      <CardHeader>
        <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
          <Scale className="size-5" />
        </span>
        <CardTitle className="mt-2 flex flex-wrap items-center gap-2">
          {name || "The appraiser you agreed on"}
          <span title="Both of you named this company and both of you confirmed its account">
            <BadgeCheck className="size-4 text-success" />
          </span>
        </CardTitle>
        <CardDescription>
          You both named this company, and you both confirmed the account it signs with. Nobody else can decide this deposit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Terms
          rows={[
            ["Deciding", name || "the company you agreed on"],
            ["Their fee", `${usdc(fee)} USDC`],
            // Past the deadline "due ... ago" reads as a mistake, and the fact that matters has
            // changed: it is no longer a wait, it is an exit.
            [open ? "Answer due" : "Time to answer ran out", when(dispute.verdictDeadline, now) || "—"],
            ["Their account", short(dispute.appraiser, 8)],
          ]}
        />
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Hourglass className="mt-0.5 size-3.5 shrink-0" />
          They give one figure between nothing and the whole deposit, and the program splits the deposit on it. They never get hold of the money
          itself, and if they say nothing at all nothing happens to it: either of you ends the mediation once the time above runs out, and the deposit
          goes back to the tenant.
        </p>
      </CardContent>
    </Card>
  );
}

// ---- the two honest paragraphs ---------------------------------------------------------

/**
 * What happens if either side simply does not cooperate (review G5, §10).
 *
 * One sentence, no jargon, on the screen rather than only in a contract document, because it is the
 * first thing either party should understand about this mechanism: it needs both of them, and the
 * fallback is not neutral. A landlord who reads it knows the tenant is doing them a favour by
 * taking part; a tenant who reads it knows exactly what they are giving up by taking part. Neither
 * of those is a reason to hide it.
 */
export function NoCooperationNote({ role }: { role: Role }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-warning">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
        <AlertTriangle className="size-3.5" /> If time runs out
      </p>
      <p className="text-xs">
        An appraiser is only brought in if <b>both</b> of you agree before the deadline. Otherwise the whole deposit goes back to the tenant.
      </p>
      <p className="text-xs">
        {role === "tenant"
          ? "Letting the time run out costs you nothing; agreeing is your choice of a fair answer."
          : "So you need the tenant to take part. You can still agree a figure between you at any time."}
      </p>
    </div>
  );
}

/**
 * The oracle disclosure (§10), on screen rather than only in the docs.
 *
 * The program cannot make an appraisal company look at a flat. What it does constrain is who may
 * speak and when, and that is worth saying where the money is, not just in a contract document.
 */
export function OracleNote() {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-input p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Users className="size-3.5" /> What Relstate can and cannot check
      </p>
      <p className="text-xs text-muted-foreground">
        Relstate cannot send anyone to look at the flat, and it cannot tell whether the figure the appraiser gives is fair. What it does enforce is
        who is allowed to give one: an account that <b>one of you put forward and the other confirmed</b>, after you had both named the same company,
        and never either of you. One figure, never more than the deposit, and silence decides nothing.
      </p>
      <p className="text-xs text-muted-foreground">
        Relstate keeps no list of appraisers and cannot appoint, suspend or overrule one. The company name you agree on is written on the public
        record, so use the firm's name and not a person's.
      </p>
    </div>
  );
}

/** The settle exit, which has no button: one transaction needs both signatures (chain.settleDisputeTx). */
export function SettleNote() {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-dashed border-input p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Users className="size-3.5" /> Or settle it between you
      </p>
      <p className="text-xs text-muted-foreground">
        A figure you both agree on closes the lease at any point, appraiser or no appraiser. It takes one transaction signed by both of you, which this
        window cannot collect on its own, so for now it is a script rather than a button.
      </p>
    </div>
  );
}

/** The "nothing to do here but wait" panel, with the one thing that is always true under it. */
export function WaitingOn({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
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

/** The verdict preview both the parties' screen and the appraiser's page show, from §6. */
export function SplitPreview({ deposit, deduction, fee }: { deposit: number; deduction: number; fee: number }) {
  const split = med.verdictSplit(deposit, deduction, fee);
  return (
    <Terms
      rows={[
        ["Kept by the landlord", `${usdc(split.toLandlord)} USDC`],
        ["Back to the tenant", `${usdc(split.toTenant)} USDC`],
        ["To the appraiser", `${usdc(split.feePaid)} USDC · ${sideName(med.feePayer(deposit, deduction))} pays it`],
      ]}
    />
  );
}

/** The per-lease fee cap, with the divisor taken from the IDL rather than restated as "a tenth". */
export const feeCapOf = (deposit: number) => med.feeCap(deposit, chain.APPRAISER_FEE_CAP_DIVISOR);
