// Paying rent privately, and seeing that it arrived. Workstream F; docs/contracts/pay.md.
//
// There are no crypto words on this screen on purpose. The tenant presses one button and the app
// does the whole thing — derives the viewing keys, creates the private-balance account if this is
// the first time, moves the balance across, stages three zero-knowledge proofs and sends the
// transfer with `pay_rent` riding in the same transaction. All the person is told is which step is
// running, and at the end: the amount is encrypted on chain.
//
// The landlord's half is the honest counterpart. "Payment received" comes from the lease account,
// which is public and says only that a period was paid. The amount is never shown from public data,
// because it is not there: the landlord reveals it by decrypting their own incoming balance with
// their own viewing key, in their own browser.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BadgeCheck, Eye, HandCoins, Loader2, Lock, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSigner } from "@/components/WalletButton";
import * as chain from "@/lib/chain";
import type { LeaseView, Role } from "@/lib/chain";
import type { OnrampCredit } from "@/lib/fiat";
import { mintKind, type MintKind } from "@/lib/mint";
import * as pay from "@/lib/pay";
import { usdc } from "@/lib/utils";

/** The one line the demo rests on. Spelled once, used in both receipts. */
const ENCRYPTED_LINE = "Amount encrypted on chain";

const Problem = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
    {children}
  </p>
);

const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <span className="text-sm text-muted-foreground">{label}</span>
    <span className={`font-mono tabular-nums ${strong ? "text-base font-semibold" : "text-sm"}`}>{value}</span>
  </div>
);

const ExplorerLink = ({ signature, label }: { signature: string; label: string }) => (
  <a
    href={chain.explorerTx(signature)}
    target="_blank"
    rel="noreferrer"
    className="mt-1 inline-flex items-center gap-1 text-sm underline underline-offset-4"
  >
    {label} <ArrowUpRight className="size-3.5" />
  </a>
);

/** Spinner plus whatever the flow last said, and "step k of n" once a multi-transaction plan starts. */
const Running = ({ progress }: { progress: pay.Progress }) => (
  <div className="flex flex-col gap-2 rounded-xl border bg-secondary/40 p-4">
    <p className="flex items-center gap-2 text-sm font-medium">
      <Loader2 className="size-4 animate-spin" /> {progress.message}
    </p>
    {progress.steps !== undefined && progress.steps > 1 && (
      <>
        <p className="text-sm text-muted-foreground">
          Step {Math.max(1, progress.step ?? 1)} of {progress.steps}. A private payment is sent as several transactions; leave this open.
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.round((100 * (progress.step ?? 0)) / progress.steps)}%` }}
          />
        </div>
      </>
    )}
  </div>
);

/** `useChain` would re-read on every tick; the mint's kind never changes, so read it once. */
function useMintKind(mint: string | undefined): MintKind | undefined {
  const [kind, setKind] = useState<MintKind>();
  useEffect(() => {
    if (!mint) return;
    let live = true;
    // A failed read must not be mistaken for "not private": leaving `kind` undefined keeps the
    // screen in its loading state rather than offering the wrong payment path.
    mintKind(mint).then((k) => live && setKind(k), () => {});
    return () => {
      live = false;
    };
  }, [mint]);
  return kind;
}

/**
 * The rent section of an active lease, for whichever side is looking.
 *
 * Renders nothing on a lease settled in an ordinary token: there the program moves the amount
 * inside `pay_rent` and the existing public button already does the job.
 */
export function PaySection({ lease, role, canPay }: { lease: LeaseView; role: Role; canPay: boolean }) {
  const kind = useMintKind(lease.mint);
  if (!kind?.confidential) return null;
  return role === "tenant" ? <PayRentCard lease={lease} kind={kind} canPay={canPay} /> : <ReceivedCard lease={lease} />;
}

/** True when rent on this lease is private, so the caller can stand its public button down. */
export function useConfidentialRent(lease: LeaseView): boolean {
  return useMintKind(lease.mint)?.confidential === true;
}

// ---- tenant ---------------------------------------------------------------------------------

function PayRentCard({ lease, kind, canPay }: { lease: LeaseView; kind: MintKind; canPay: boolean }) {
  const me = useSigner();
  const [progress, setProgress] = useState<pay.Progress | null>(null);
  const [result, setResult] = useState<pay.PayResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null && progress.phase !== "done";

  const send = async () => {
    if (!me) {
      setError("Connect your wallet first.");
      return;
    }
    setError(null);
    setResult(null);
    setProgress({ phase: "unlocking", message: "Unlocking your private balance…" });
    try {
      setResult(await pay.payRentPrivately({ me, lease, onProgress: setProgress }));
    } catch (e) {
      setError(pay.payErrorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card className="rise">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
            <Lock className="size-5" />
          </span>
          <Badge variant="success" className="gap-1.5">
            <ShieldCheck className="size-3.5" /> Private payment
          </Badge>
        </div>
        <CardTitle className="mt-2">Pay your rent</CardTitle>
        <CardDescription>
          Your landlord is paid straight away. What settles is encrypted: the network records that you paid this period, not the figure. You need no
          SOL and no wallet pop-up — the fee is on us.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Problem>{error}</Problem>}
        {result ? (
          <Receipt result={result} decimals={kind.decimals} />
        ) : progress ? (
          <Running progress={progress} />
        ) : (
          <Button size="lg" disabled={!canPay || busy || !me} onClick={send}>
            <HandCoins /> {canPay ? `Pay ${usdc(lease.rent)} rent` : "Not due yet"}
          </Button>
        )}
        {!kind.hasAuditor && (
          <p className="text-xs text-muted-foreground">
            This token carries no compliance key, so a payment made here could not be audited afterwards.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const Receipt = ({ result, decimals }: { result: pay.PayResult; decimals: number }) => (
  <div className="flex flex-col gap-1 rounded-xl border border-success/40 bg-success-soft p-4">
    <p className="flex items-center gap-2 font-medium">
      <BadgeCheck className="size-4" /> Rent paid
    </p>
    <Row label="You paid" value={`${pay.format(result.amount, decimals)} rUSDC`} strong />
    <p className="flex items-center gap-1.5 py-1 text-sm font-medium">
      <Lock className="size-3.5" /> {ENCRYPTED_LINE}
    </p>
    {result.secured && result.secured.secured > 0n && (
      <Row label="Moved to your private balance first" value={`${pay.format(result.secured.secured, decimals)} rUSDC`} />
    )}
    <ExplorerLink signature={result.signature} label="See the payment on the explorer" />
    {result.signatures.length > 1 && (
      <p className="text-xs text-muted-foreground">
        Sent as {result.signatures.length} transactions: the proofs that keep the amount hidden do not fit in one.
      </p>
    )}
  </div>
);

// ---- landlord -------------------------------------------------------------------------------

/**
 * What the landlord can see, and what they have to decrypt.
 *
 * The counters come from the lease account. The amount does not come from anywhere public — it is
 * decrypted here, on demand, with the landlord's own viewing key.
 */
function ReceivedCard({ lease }: { lease: LeaseView }) {
  const me = useSigner();
  const [revealed, setRevealed] = useState<pay.RevealedBalance | null>(null);
  const [progress, setProgress] = useState<pay.Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ created: boolean } | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);

  // Can this wallet be paid privately at all? Only the owner's signature can make it so, so if the
  // answer is no it is the landlord's own one-time action, offered below.
  const check = useCallback(async () => {
    if (!me) return;
    try {
      const conf = await chain.confidential();
      const session = await conf.openSession({ wallet: me.wallet, mint: lease.mint });
      setReady((await conf.accountState(session)).configured);
    } catch {
      setReady(null);
    }
  }, [me, lease.mint]);

  const reveal = async () => {
    if (!me) return;
    setError(null);
    setProgress({ phase: "unlocking", message: "Unlocking your view of the payment…" });
    try {
      setRevealed(await pay.revealReceived({ wallet: me.wallet, mint: lease.mint, onProgress: setProgress }));
    } catch (e) {
      setError(pay.payErrorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const enable = async () => {
    if (!me) return;
    setError(null);
    setProgress({ phase: "account", message: "Setting up your private balance…" });
    try {
      setSetup(await pay.enablePrivateReceiving({ wallet: me.wallet, mint: lease.mint, onProgress: setProgress }));
      setReady(true);
    } catch (e) {
      setError(pay.payErrorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  useEffect(() => {
    void check();
  }, [check]);

  // Setting up the receiving side is the landlord's own signature, but it needs no decision: do it
  // the first time this card sees the account missing. The button below stays as the retry.
  const autoSetup = useRef(false);
  useEffect(() => {
    if (ready !== false || !me || autoSetup.current) return;
    autoSetup.current = true;
    void enable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me]);

  const paid = lease.paidCount;
  return (
    <Card className="rise">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
            <Lock className="size-5" />
          </span>
          {paid > 0 ? <Badge variant="success">Payment received</Badge> : <Badge variant="outline">Nothing received yet</Badge>}
        </div>
        <CardTitle className="mt-2">{paid > 0 ? `Rent received for ${paid} of ${lease.termPeriods} periods` : "Rent is not in yet"}</CardTitle>
        <CardDescription>
          The chain records that your tenant paid, and when — never how much. {ENCRYPTED_LINE}, so the figure below is decrypted in this browser with
          your own viewing key.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Problem>{error}</Problem>}
        {ready === false && (
          <div className="flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning-soft p-4 text-sm">
            <p className="font-medium">Your private balance is not set up yet.</p>
            <p>
              Until it is, your tenant cannot send a private payment: only your own signature can create it, which is the point. It takes one
              transaction and costs you nothing.
            </p>
            {!progress && (
              <Button onClick={enable} disabled={!me} className="self-start">
                Set up private payments
              </Button>
            )}
          </div>
        )}
        {setup?.created && ready && <p className="text-sm text-success">Done. Your tenant can pay you privately now.</p>}
        {progress && <Running progress={progress} />}
        {revealed ? (
          <div className="flex flex-col gap-1 rounded-xl border bg-secondary/40 p-4">
            <p className="flex items-center gap-2 font-medium">
              <Eye className="size-4" /> Decrypted with your key
            </p>
            <Row label="Just received, not yet spendable" value={`${pay.format(revealed.incoming, revealed.decimals)} rUSDC`} strong />
            <Row label="Spendable" value={`${pay.format(revealed.spendable, revealed.decimals)} rUSDC`} />
            <Row label="Total held privately" value={`${pay.format(revealed.total, revealed.decimals)} rUSDC`} />
            <p className="mt-1 text-xs text-muted-foreground">
              Nobody reading the chain can see these numbers. Cash out from the Payouts tab, which moves rUSDC back to a public balance first.
            </p>
          </div>
        ) : (
          !progress &&
          ready !== false && (
            <Button variant="outline" onClick={reveal} disabled={!me} className="self-start">
              <Eye /> Reveal the amount
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ---- after a top-up -------------------------------------------------------------------------

/**
 * The second half of a top-up, run automatically.
 *
 * The Stripe webhook mints rUSDC to the **public** balance and stops there: `Deposit` and
 * `ApplyPendingBalance` are signed by the wallet, and the backend holds nobody's wallet key
 * (docs/contracts/stripe.md). So the browser finishes it the moment the credit lands, keeping the
 * lease deposit public — `fund_deposit` spends a public amount, and a tenant whose whole balance
 * went private could not accept a lease.
 *
 * One state, one sentence, no crypto words.
 */
const SECURE_TIMEOUT_MS = 180_000;

export function SecurePrivateBalance({ credit }: { credit: OnrampCredit }) {
  const me = useSigner();
  const [progress, setProgress] = useState<pay.Progress | null>(null);
  const [done, setDone] = useState<pay.SecureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = credit.confidentialPending && BigInt(credit.confidentialAmount) > 0n;
  // The effect must not depend on `me` (a fresh object whenever the wallet context re-renders) or
  // on its own progress state: either one re-runs the effect, and the cleanup of the previous run
  // used to drop every later result, leaving "Securing…" on screen for good.
  const meRef = useRef(me);
  meRef.current = me;
  const wallet = me?.key.toBase58() ?? null;
  const holdback = credit.publicHoldback || "0";

  useEffect(() => {
    const signer = meRef.current;
    if (!signer || !pending) return;
    let live = true;
    setError(null);
    setProgress({ phase: "unlocking", message: pay.SECURING_MESSAGE });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new pay.PayError("This is taking longer than expected. Nothing is lost; try again.")), SECURE_TIMEOUT_MS),
    );
    Promise.race([
      pay.securePrivateBalance({
        wallet: signer.wallet,
        holdback: BigInt(holdback),
        onProgress: (p) => live && setProgress(p),
      }),
      timeout,
    ]).then(
      (r) => live && (setDone(r), setProgress(null)),
      (e: unknown) => {
        console.error("securePrivateBalance failed", e);
        if (live) (setError(pay.payErrorMessage(e)), setProgress(null));
      },
    );
    return () => {
      live = false;
    };
  }, [wallet, pending, holdback, attempt]);

  if (!pending) return null;
  if (!me) return <p className="text-sm text-muted-foreground">Sign in to finish securing your balance.</p>;
  if (error) {
    return (
      <div className="flex flex-col gap-1 rounded-xl border border-warning/50 bg-warning-soft p-4 text-sm">
        <p className="font-medium">Your balance is credited, but not private yet.</p>
        <p>{error}</p>
        <p>Nothing is lost: it is in your wallet, and the app will also try again the next time you pay rent.</p>
        <Button size="sm" variant="outline" className="self-start" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  if (done) {
    if (done.secured === 0n)
      return (
        <p className="flex items-center gap-2 rounded-xl border border-success/40 bg-success-soft p-3 text-sm">
          <Lock className="size-4 shrink-0" />
          <span>Your balance is private.</span>
        </p>
      );
    return (
      <p className="flex items-center gap-2 rounded-xl border border-success/40 bg-success-soft p-3 text-sm">
        <Lock className="size-4 shrink-0" />
        <span>
          <b>{pay.format(done.secured)} rUSDC is now private.</b> From here on, what you pay is encrypted on chain.
          {done.heldBack > 0n && ` ${pay.format(done.heldBack)} rUSDC stays visible, ready for your deposit.`}
        </span>
      </p>
    );
  }
  return <Running progress={progress ?? { phase: "securing", message: pay.SECURING_MESSAGE }} />;
}
