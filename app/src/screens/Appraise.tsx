// The appraiser's own page: `#/invite/<token>` (docs/contracts/dispute-mediation.md §4, §10).
//
// This is what an appraisal company lands on when it opens the link the two parties e-mailed. It is
// not an operator tool and it is not behind a flag — it is the third participant's half of the
// product, and the only way a verdict can be given at all now that there is no backend-held key:
//
//   1. a signed-out visitor sees WHAT they are being asked, from the public invitation route,
//      before being asked to create anything;
//   2. they sign in the same way everybody else does — an e-mail address, and an account appears;
//   3. the page claims the invitation with that account, which is how the two parties come to see
//      it and confirm it on chain;
//   4. once they have confirmed it, the cases bound to that account appear here, and the appraiser
//      gives one figure per case.
//
// **It holds no key and no token at rest.** The appraiser's account is their own (an embedded
// wallet created at sign-in, or an extension they already had), the verdict is signed by it, and
// the invitation token is in the URL where they can see it — there is nothing to paste, nothing
// kept in memory and nothing in localStorage that was not already there for every other user.
//
// Every number before the confirm is this app's own §6 arithmetic, and the confirm is armed only
// for the figure that was actually previewed (`lib/verdict.ts`).
import { useEffect, useState } from "react";
import { ArrowUpRight, Building2, Check, Gavel, Hourglass, Loader2, Scale, ShieldCheck } from "lucide-react";
import { WalletProvider } from "@solana/wallet-adapter-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/Brand";
import { Terms } from "@/components/Terms";
import { EmailSignIn, EmbeddedWalletProvider } from "@/auth/embedded";
import { LocalWalletProvider, WalletButton, useMe, useSigner } from "@/components/WalletButton";
import * as chain from "@/lib/chain";
import type { DisputeView, LeaseView, Role } from "@/lib/chain";
import { INVITES_AVAILABLE, claimInvite, loadInvite, type InviteCase } from "@/lib/invites";
import * as med from "@/lib/mediation";
import { invalidateReads } from "@/lib/reads";
import { inviteToken } from "@/lib/route";
import { SplitPreview } from "@/screens/Mediation";
import { asked, confirmGate, verdictProblem } from "@/lib/verdict";
import { Tick, useChain } from "@/lib/useChain";
import { duration, isSignature, parseAmountInput, short, usdc } from "@/lib/utils";

/**
 * The storage scope for this page's wallet.
 *
 * The providers keep their per-browser state under a role-named key, and an appraiser is not a
 * `Role` — they are nobody's landlord and nobody's tenant. A scope of its own keeps the appraiser's
 * account separate from the two parties' in the same browser, which is exactly what a three-window
 * demo needs, and is the trick `Auth.tsx` already uses for its sign-in scope.
 */
const APPRAISER_SCOPE = "appraiser" as Role;

const Problem = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
    {children}
  </p>
);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- the invitation ---------------------------------------------------------------------

/** What the company is being asked, from the public route: readable before anybody signs in. */
function CaseSummary({ invite, now }: { invite: InviteCase; now: number }) {
  const left = invite.selectionDeadline - now;
  return (
    <Card>
      <CardHeader>
        <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
          <Building2 className="size-5" />
        </span>
        <CardTitle className="mt-2">{invite.companyName} has been asked to appraise a flat</CardTitle>
        <CardDescription>
          A landlord and a tenant disagree about how much of the deposit the damage justifies keeping, and they have both named your firm to decide
          it. Nobody can make you: if you do nothing, the deposit goes back to the tenant.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Terms
          rows={[
            ["The deposit in question", `${usdc(invite.depositAmount)} USDC`],
            ["Your fee, as they agreed it", `${usdc(invite.agreedFee)} USDC`],
            ["Paid by", "whichever side the decision goes against, out of the deposit"],
            [left > 0 ? "They need an answer within" : "Their window to appoint you has closed", left > 0 ? duration(left) : "—"],
          ]}
        />
        <p className="text-xs text-muted-foreground">
          <b>Check the fee before you accept.</b> It is the lower of the two figures the parties quoted for your firm, so it may not be the one you
          gave them. And it is capped at a tenth of the deposit, whatever was agreed.
        </p>
      </CardContent>
    </Card>
  );
}

/** Sign in, in the plainest possible terms, and then claim the invitation with that account. */
function ClaimStep({ invite, token, me, onClaimed }: { invite: InviteCase; token: string; me: string | null; onClaimed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const alreadyMine = invite.status === "claimed" && !!me && invite.claimedWallet === me;

  if (!me)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Accept, by creating an account</CardTitle>
          <CardDescription>
            An e-mail address is enough. We set up the account that signs your decision; there is nothing to install, no password and no fee to pay.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <EmailSignIn onSignedIn={() => undefined} />
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            Already have a Solana wallet? Connect it with the button at the top right instead. Either way the account has to be your own — the program
            refuses a decision signed by the landlord or the tenant.
          </p>
        </CardContent>
      </Card>
    );

  if (alreadyMine || done)
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success-soft p-4 text-success">
        <Check className="size-5 shrink-0" />
        <span className="text-sm font-medium">
          You have accepted this invitation. Both parties now have to confirm your account before you can give a decision — that is their safeguard,
          not a delay we chose.
        </span>
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accept this case</CardTitle>
        <CardDescription>
          This tells the landlord and the tenant which account is yours. They each confirm it, and only then can you give a decision — neither of them
          can appoint you alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Terms rows={[["Your account", short(me, 8)]]} />
        {error && <Problem>{error}</Problem>}
        <Button
          size="lg"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await claimInvite(token);
              // The token has done its job; strip it from the fragment so it does not linger in
              // browser history. `#/invite` with no token still works for a returning appraiser.
              if (token) globalThis.history?.replaceState(null, "", "#/invite");
              setDone(true);
              onClaimed();
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Check />} {busy ? "Accepting…" : `Accept as ${invite.companyName}`}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          If this invitation was not meant for you, close this page. Accepting it with the wrong account only wastes the parties' time.
        </p>
      </CardContent>
    </Card>
  );
}

// ---- a case, and the decision ------------------------------------------------------------

/**
 * One bound case: what is at stake, the figure, what the figure does, and the submit.
 *
 * Exported so the developer preview can render it against invented data — the same reason
 * `MediationLease` takes its data as props.
 */
export function VerdictCase({
  lease,
  dispute,
  me,
  now,
  busy,
  onSubmit,
}: {
  lease: LeaseView;
  dispute: DisputeView;
  /** The signed-in account, checked against the bound one before anything is offered. */
  me: string;
  now: number;
  busy: string | null;
  onSubmit: (deduction: number) => Promise<string | null>;
}) {
  const [typed, setTyped] = useState("");
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseAmountInput(typed, "Enter a figure — 0 returns the whole deposit to the tenant.");
  const deduction = "base" in parsed ? parsed.base : 0;
  const fee = med.feeFor(lease.deposit, dispute.agreedFee, chain.APPRAISER_FEE_CAP_DIVISOR);
  const problem =
    "base" in parsed
      ? verdictProblem({ deductionBase: deduction, deposit: lease.deposit, status: lease.status, appraiser: dispute.appraiser, mine: me })
      : null;
  const left = dispute.verdictDeadline - now;
  const gate = confirmGate(confirmed, lease.address, deduction);
  const ready = "base" in parsed && !problem && left > 0 && !busy;

  if (signature)
    return (
      <Card className="rise">
        <CardHeader>
          <span className="grid size-11 place-items-center rounded-xl bg-success-soft text-success">
            <Gavel className="size-5" />
          </span>
          <CardTitle className="mt-2">Decision given</CardTitle>
          <CardDescription>The deposit has been split on your figure and the lease is closed. There is no second decision to give.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SplitPreview deposit={lease.deposit} deduction={deduction} fee={fee} />
          {/* A signature becomes an href, so it is checked to be base58 first. */}
          {isSignature(signature) && (
            <a
              href={chain.explorerTx(signature)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
            >
              {short(signature, 8)} <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {med.agreedName(dispute) || "A flat you were asked to appraise"}
          {left > 0 ? <Badge variant="warning">answer due in {duration(left)}</Badge> : <Badge variant="danger">time ran out</Badge>}
        </CardTitle>
        <CardDescription>
          Both parties confirmed your account for this lease, so yours is the only decision the program will accept on it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Terms
          rows={[
            ["The deposit", `${usdc(lease.deposit)} USDC`],
            ["Your fee", `${usdc(fee)} USDC`],
            ["Lease", short(lease.address, 6)],
          ]}
        />
        {left <= 0 ? (
          <Problem>
            The time to answer this case has run out, so nothing can be submitted. Either party can now end the mediation, and the deposit goes back
            to the tenant.
          </Problem>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`deduction-${lease.address}`} className="text-sm font-medium">
                How much of the deposit does the damage justify keeping?
              </label>
              <Input
                id={`deduction-${lease.address}`}
                inputMode="decimal"
                placeholder="0"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  // Changing the figure withdraws the confirmation: what was reviewed is no longer
                  // what would be sent.
                  setConfirmed(null);
                  setError(null);
                }}
                aria-invalid={typed.trim() !== "" && "error" in parsed}
              />
              <p className="text-xs text-muted-foreground">
                In USDC. 0 returns the whole deposit to the tenant. This is your judgement of the flat — not a negotiation and not a Relstate
                decision: the program pays out whatever you sign here.
              </p>
            </div>
            {typed.trim() !== "" && "error" in parsed && <p className="text-xs text-destructive">{parsed.error}</p>}
            {problem && <Problem>{problem}</Problem>}
            {"base" in parsed && !problem && (
              <>
                <SplitPreview deposit={lease.deposit} deduction={deduction} fee={fee} />
                {!gate.armed ? (
                  <Button variant="outline" disabled={!ready} onClick={() => setConfirmed(asked(lease.address, deduction))}>
                    <Scale /> Check these figures
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={!ready}
                      onClick={async () => {
                        setError(null);
                        const sig = await onSubmit(deduction);
                        if (sig) setSignature(sig);
                        else setError("The decision was not submitted. The message above says why.");
                      }}
                    >
                      <Gavel /> {busy ?? `Submit: keep ${usdc(deduction)} USDC`}
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">
                      This pays out the deposit and closes the lease. There is exactly one decision per case and it cannot be revised.
                    </p>
                  </>
                )}
              </>
            )}
            {error && <Problem>{error}</Problem>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The cases bound to this account, each with its own form. */
function MyCases({ me, now, bump }: { me: string; now: number; bump: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disputes = useChain(() => chain.loadDisputesFor(me), [me]);
  const leases = useChain(
    () => (disputes ? Promise.all(disputes.map((d) => chain.loadLease(d.lease))) : Promise.resolve(undefined)),
    [disputes?.map((d) => d.address).join(",") ?? ""],
  );

  // `useSigner`, not `useMe`: the sponsor-session registration is process-wide and is done once at
  // the top of the page, so a second caller's cleanup would log the first one out.
  const signer = useSigner();
  const submit = async (lease: LeaseView, deduction: number): Promise<string | null> => {
    if (!signer) {
      setError("Sign in again before submitting: this page no longer holds your account.");
      return null;
    }
    setBusy("Submitting…");
    setError(null);
    try {
      const sig = await chain.submitVerdict(signer, lease, deduction);
      invalidateReads();
      bump();
      return sig;
    } catch (e) {
      setError(chain.errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (disputes === undefined || leases === undefined)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Looking for cases assigned to your account…
      </p>
    );

  const open = disputes
    .map((d, i) => ({ dispute: d, lease: leases[i] }))
    .filter((row): row is { dispute: DisputeView; lease: LeaseView } => !!row.lease && row.lease.status === "mediation");

  if (open.length === 0)
    return (
      <Card>
        <CardHeader>
          <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
            <Hourglass className="size-5" />
          </span>
          <CardTitle className="mt-2">No case is waiting for you yet</CardTitle>
          <CardDescription>
            A case appears here once <b>both</b> the landlord and the tenant have confirmed your account. If you have just accepted an invitation,
            that is what they are doing now; this page checks again every few seconds.
          </CardDescription>
        </CardHeader>
      </Card>
    );

  return (
    <div className="flex flex-col gap-4">
      {error && <Problem>{error}</Problem>}
      {open.map(({ dispute, lease }) => (
        <VerdictCase
          key={dispute.address}
          lease={lease}
          dispute={dispute}
          me={me}
          now={now}
          busy={busy}
          onSubmit={(deduction) => submit(lease, deduction)}
        />
      ))}
    </div>
  );
}

// ---- the page ----------------------------------------------------------------------------

function Work({ token, bump }: { token: string; bump: () => void }) {
  const me = useMe();
  const address = me?.key.toBase58() ?? null;
  const [now, setNow] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(0);

  const invite = useChain(
    () => (token && INVITES_AVAILABLE ? loadInvite(token).catch((e: unknown) => (setInviteError(message(e)), null)) : Promise.resolve(null)),
    [token, claimed],
  );
  useEffect(() => {
    chain.loadNow().then(setNow, () => {
      /* the wall clock is a good enough fallback for a countdown */
    });
  }, [claimed]);

  return (
    <div className="flex flex-col gap-5">
      {token && !INVITES_AVAILABLE && (
        <Problem>
          This window is running without a backend (<span className="font-mono text-xs">VITE_API</span>), so it cannot read your invitation. You can
          still give a decision below once both parties have confirmed your account.
        </Problem>
      )}
      {inviteError && <Problem>{inviteError}</Problem>}
      {invite && <CaseSummary invite={invite} now={now} />}
      {invite && <ClaimStep invite={invite} token={token} me={address} onClaimed={() => setClaimed((c) => c + 1)} />}
      {!invite && !address && (
        <Card>
          <CardHeader>
            <CardTitle>Sign in to see your cases</CardTitle>
            <CardDescription>
              An e-mail address is enough. If you reached this page from an invitation link, open that link again instead — it tells us which case you
              are accepting.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EmailSignIn onSignedIn={() => undefined} />
          </CardContent>
        </Card>
      )}
      {address && <MyCases me={address} now={now} bump={bump} />}
    </div>
  );
}

/**
 * `#/invite/<token>`, and `#/invite` with no token for an appraiser coming back to a case.
 *
 * Outside the app shell: there is no role to pick, no tabs and no lease of one's own. The wallet
 * providers are the same three the rest of the app uses, under a scope of this page's own.
 */
export function AppraiserPage() {
  const [tick, setTick] = useState(0);
  const token = inviteToken(globalThis.location?.hash ?? "");
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) setTick((x) => x + 1);
    }, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-h-dvh" data-role="tenant">
      <WalletProvider wallets={[]} autoConnect localStorageKey={`relstate.wallet.${APPRAISER_SCOPE}`}>
        <LocalWalletProvider role={APPRAISER_SCOPE}>
          <EmbeddedWalletProvider role={APPRAISER_SCOPE}>
            <header className="border-b bg-card/85">
              <div className="mx-auto flex h-16 max-w-3xl items-center gap-4 px-5">
                <Logo />
                <span className="ml-auto flex items-center gap-2">
                  <Badge variant="outline">
                    <Scale /> Appraiser
                  </Badge>
                  <WalletButton />
                </span>
              </div>
            </header>
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 pb-20 pt-8">
              <div>
                <p className="eyebrow">Independent appraisal</p>
                <h1 className="mt-1 text-3xl font-semibold">Decide a disputed deposit</h1>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  A landlord and a tenant could not agree on how much of a deposit the damage justifies keeping, and they both named your firm. Your
                  figure splits it. Relstate takes no part in the decision and cannot change it.
                </p>
              </div>
              <Tick.Provider value={tick}>
                <Work token={token} bump={() => setTick((x) => x + 1)} />
              </Tick.Provider>
            </div>
          </EmbeddedWalletProvider>
        </LocalWalletProvider>
      </WalletProvider>
    </div>
  );
}
