// The Mediation screen's pieces (docs/contracts/dispute-mediation.md).
//
// Two rejected deductions later, neither side decides any more: an appraiser the two of them
// choose together does. These are the parts of that screen — the round indicator, the status
// timeline, the fee line, and the two selection steps — all controlled components, so the lease
// screen in `screens.tsx` owns the state and the buttons and these only render.
//
// Nothing here knows which role is reading it beyond the `role` prop: the selection is symmetric
// on purpose, because the program makes it symmetric (either side proposes, either side picks,
// and a pick from the *other* side's list is how the two converge).
import { BadgeCheck, Check, Clock, Hourglass, Scale, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Terms } from "@/components/Terms";
import * as chain from "@/lib/chain";
import type { DisputeView, Role } from "@/lib/chain";
import { DIRECTORY_AVAILABLE, loadAppraiserDirectory, mergeDirectory, trustedLabel, trustedLabelFor, type AppraiserOption } from "@/lib/appraisers";
import * as med from "@/lib/mediation";
import { sharedRead } from "@/lib/reads";
import { useChain } from "@/lib/useChain";
import { cn, duration, short, usdc } from "@/lib/utils";

/**
 * The registry plus whatever names the off-chain directory knows, and why it has none when it has
 * none.
 *
 * `enabled` is false on every lease that is not in mediation, because the registry read is a
 * discriminator scan and the lease screen would otherwise pay for it on every tick of every lease.
 * A hook cannot be called conditionally, so the condition lives in here.
 */
export function useAppraiserOptions(enabled: boolean): { options: AppraiserOption[] | undefined; directoryError: string } {
  const registry = useChain(() => (enabled ? chain.loadAppraisers() : Promise.resolve([])), [enabled]);
  // A broken or absent directory must never hide the registry: the picker falls back to wallet
  // addresses, which are what the instructions take anyway. So the failure is a value, not a
  // rejection — a rejected read would leave `useChain` undefined and the picker empty forever.
  const directory = useChain(
    () =>
      enabled
        ? sharedRead("appraiser-directory", () =>
            loadAppraiserDirectory().then(
              (rows) => ({ rows, error: "" }),
              (e: unknown) => ({ rows: [], error: e instanceof Error ? e.message : String(e) }),
            ),
          )
        : Promise.resolve({ rows: [], error: "" }),
    [enabled],
  );
  return {
    options: registry && directory ? mergeDirectory(registry, directory.rows) : undefined,
    directoryError: directory?.error ?? "",
  };
}

/**
 * What to call an appraiser in prose and in lists: the directory's name, or a shortened key when
 * nobody has one. The name here may be unverified, which the row's own missing tick says.
 */
export const nameOf = (options: AppraiserOption[] | undefined, wallet: string): string =>
  options?.find((o) => o.wallet === wallet)?.name || short(wallet, 5);

/**
 * What to call one on a button that commits — picking, binding, submitting.
 *
 * Only a name the chain's `name_hash` confirms may stand in for identity there; an unverified name
 * is the directory's claim, and the key is what the program acts on.
 */
export const committedName = (options: AppraiserOption[] | undefined, wallet: string): string =>
  trustedLabelFor(options?.find((o) => o.wallet === wallet), wallet, (k) => short(k, 5));

/** The registry entry for a key, or undefined while the registry loads or if the key left it. */
export const optionFor = (options: AppraiserOption[] | undefined, wallet: string) => options?.find((o) => o.wallet === wallet);

/** A shortened key under a name, so two companies with a similar name are still told apart. */
const Key = ({ wallet }: { wallet: string }) => <span className="font-mono text-xs text-muted-foreground">{short(wallet, 4)}</span>;

const VerifiedName = ({ o }: { o: AppraiserOption }) =>
  o.nameVerified ? (
    <span title="This name hashes to the one the registry committed to on chain">
      <BadgeCheck className="size-3.5 text-success" />
    </span>
  ) : null;

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

/** Mediation opened, the selection window, the verdict window: where this lease stands in the three. */
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
 * `exact` says whether an appraiser is bound, because until one is, the fee is only an upper bound
 * across the names still in play. With nobody in play at all the honest answer is neither a number
 * nor "up to 0", which would read as free.
 */
export function AppraiserFee({ deposit, fee, cap, exact }: { deposit: number; fee: number; cap: number; exact: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Terms
        rows={[
          ["Appraiser's fee", exact ? `${usdc(fee)} USDC` : fee > 0 ? `up to ${usdc(fee)} USDC` : "whatever the one you agree on charges"],
          ["Capped at", `${usdc(cap)} USDC · a tenth of the ${usdc(deposit)} USDC deposit`],
          ["Paid by", "the side the verdict goes against, out of the deposit"],
        ]}
      />
      <p className="text-xs text-muted-foreground">
        There is no second escrow: the fee comes out of the deposit when the verdict pays out, so neither side has to post anything first. If the
        appraiser deducts nothing at all — a full win for the tenant — the landlord's share is zero, so the fee still comes out of the tenant's
        refund.
      </p>
    </div>
  );
}

// ---- step one: name up to three --------------------------------------------------------

/**
 * The candidates this side puts forward, chosen from the registry.
 *
 * Only registered, active entries are offered, because only those can reach a candidate list: the
 * program's constraint on the `Appraiser` account *is* the registry lookup (§4). A side names them
 * once and cannot change them, which the caller's button copy says out loud.
 */
export function RegistryChoice({
  options,
  chosen,
  onToggle,
  max,
}: {
  options: AppraiserOption[];
  chosen: string[];
  onToggle: (wallet: string) => void;
  max: number;
}) {
  const pickable = options.filter((o) => o.active);
  if (pickable.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        The registry has no active appraiser on this network yet, so there is nobody to name. The mediation still ends: either side can let it expire
        once the appraiser's window passes, and the deposit returns to the tenant.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {pickable.map((o) => {
          const on = chosen.includes(o.wallet);
          const full = !on && chosen.length >= max;
          return (
            <li key={o.wallet}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={full}
                onClick={() => onToggle(o.wallet)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                  on ? "border-primary bg-secondary" : "border-input hover:bg-secondary/50",
                  full && "opacity-50",
                )}
              >
                <span className={cn("grid size-5 shrink-0 place-items-center rounded-md border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                  {on && <Check className="size-3.5" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {o.name || short(o.wallet, 5)} <VerifiedName o={o} />
                    {o.isDefault && <Badge variant="outline">fallback</Badge>}
                  </span>
                  <span className="flex items-center gap-2">
                    <Key wallet={o.wallet} />
                    <span className="text-xs text-muted-foreground">fee {usdc(o.fee)} USDC</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {chosen.length} of {max} chosen. You name them once; after that you can still agree on one from either list.
      </p>
    </div>
  );
}

// ---- step two: agree on one ------------------------------------------------------------

/**
 * The union of both lists, with who proposed each name and who has picked it.
 *
 * Picking from the other side's list is the intended way to converge, so the two lists are shown
 * as one and labelled by origin rather than split into "mine" and "theirs".
 */
export function CandidateChoice({
  dispute,
  role,
  options,
  pick,
  onPick,
}: {
  dispute: DisputeView;
  role: Role;
  options: AppraiserOption[] | undefined;
  pick: string;
  onPick: (wallet: string) => void;
}) {
  const rows = med.candidates(dispute);
  const mine = med.pickOf(dispute, role);
  const theirs = med.pickOf(dispute, med.other(role));
  const them = med.other(role);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {rows.map((c) => {
          const o = optionFor(options, c.wallet);
          const on = c.wallet === (pick || mine);
          const suspended = !!o && !o.active;
          const theyPicked = role === "landlord" ? c.tenantPicked : c.landlordPicked;
          return (
            <li key={c.wallet}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                disabled={suspended}
                onClick={() => onPick(c.wallet)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                  on ? "border-primary bg-secondary" : "border-input hover:bg-secondary/50",
                  suspended && "opacity-50",
                )}
              >
                <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-primary" : "border-input")}>
                  {on && <span className="size-2.5 rounded-full bg-primary" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {o?.name || short(c.wallet, 5)} {o && <VerifiedName o={o} />}
                    {c.agreed && <Badge variant="success">agreed</Badge>}
                    {suspended && <Badge variant="danger">suspended</Badge>}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <Key wallet={c.wallet} />
                    <span>
                      named by {c.proposedBy.length === 2 ? "both sides" : c.proposedBy[0] === role ? "you" : them}
                    </span>
                    {o && <span>fee {usdc(o.fee)} USDC</span>}
                    {theyPicked && <span className="text-foreground">· {them} picked this</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {mine ? `You picked ${nameOf(options, mine)}. ` : "You have not picked yet. "}
        {theirs ? `The ${them} picked ${nameOf(options, theirs)}.` : `The ${them} has not picked yet.`} The same pick from both of you binds it, and
        you can change yours until then.
      </p>
    </div>
  );
}

// ---- bound: waiting for the verdict ----------------------------------------------------

/** Who is deciding, how they got there, and how long they have. */
export function BoundAppraiser({ dispute, options, now }: { dispute: DisputeView; options: AppraiserOption[] | undefined; now: number }) {
  const o = optionFor(options, dispute.appraiser);
  const agreedByBoth = !!dispute.landlordPick && dispute.landlordPick === dispute.tenantPick;
  return (
    <Card>
      <CardHeader>
        <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
          <Scale className="size-5" />
        </span>
        <CardTitle className="mt-2 flex flex-wrap items-center gap-2">
          {trustedLabel(o, (k) => short(k, 5))}
          {o && <VerifiedName o={o} />}
          {o?.isDefault && !agreedByBoth && <Badge variant="outline">fallback</Badge>}
        </CardTitle>
        <CardDescription>
          {agreedByBoth
            ? "Both sides picked this appraiser, so the program bound them."
            : "Nobody was agreed in time, so the registry's fallback appraiser was bound. The Config admin designated them; neither side chose them."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Terms
          rows={[
            ["Deciding", committedName(options, dispute.appraiser)],
            ["Wallet", short(dispute.appraiser, 8)],
            // Past the deadline "due ... ago" reads as a mistake, and the fact that matters has
            // changed: it is no longer a wait, it is an exit.
            [dispute.verdictDeadline > now ? "Verdict due" : "Window closed", when(dispute.verdictDeadline, now) || "—"],
          ]}
        />
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Hourglass className="mt-0.5 size-3.5 shrink-0" />
          They sign one number between 0 and the whole deposit, and the program splits the vault on it. They never gain any authority over the
          deposit, and if they stay silent nothing happens to it: either side ends the mediation once the window above passes.
        </p>
      </CardContent>
    </Card>
  );
}

// ---- the one honest paragraph ----------------------------------------------------------

/**
 * The oracle disclosure (§10), on screen rather than only in the docs.
 *
 * The program cannot make an appraisal company look at a flat. What it does constrain is who may
 * speak and when, and that is worth saying where the money is, not just in a contract document.
 */
export function OracleNote({ names }: { names: string[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-input p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Users className="size-3.5" /> What the program can and cannot check
      </p>
      <p className="text-xs text-muted-foreground">
        An appraiser is an oracle. The program cannot send anyone to look at the flat, and it cannot check that the number they sign matches any
        damage. It does constrain who may speak: only a key the platform registered, still active, that <b>both sides picked</b> — or the fallback,
        after the two failed to agree — and never a party to this lease. One verdict, bounded by the deposit, and silence decides nothing.
      </p>
      {names.length > 0 && (
        <p className="text-xs text-muted-foreground">
          The names in this demo registry are invented ({names.join(", ")}). Using a real firm's would need their consent.
        </p>
      )}
      {!DIRECTORY_AVAILABLE && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5 shrink-0" /> This window has no backend configured, so the registry is shown by wallet address: the chain holds
          only a hash of each name.
        </p>
      )}
    </div>
  );
}
