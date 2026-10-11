// Fiat in (tenant) and fiat out (landlord). Workstream E; docs/contracts/stripe.md.
//
// Both screens are honest about what they are. The top-up really does open a
// Stripe test-mode checkout when keys are configured, and really does end with
// rUSDC minted against the treasury reserve — but the money is test money and
// the USDC behind it is devnet USDC. The payout is a stage prop and says so on
// the card, not in a footnote.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, BadgeCheck, Banknote, CircleAlert, CreditCard, Landmark, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import * as fiat from "@/lib/fiat";
import { SecurePrivateBalance } from "@/screens/Pay";
import { USDC } from "@/lib/config";

const PRESETS_PLN = ["400", "1200", "2500"];

type Phase =
  | { at: "idle" }
  | { at: "starting" }
  | { at: "waiting"; intent: string; amountPln: string; amountUsdc: string }
  | { at: "done"; credit: fiat.OnrampCredit }
  | { at: "cancelled" }
  | { at: "error"; message: string };

function Simulated({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="warning" className="gap-1.5">
      <CircleAlert className="size-3.5" /> {children}
    </Badge>
  );
}

/** A labelled figure. Tabular digits so the numbers do not jitter while polling. */
const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <span className="text-sm text-muted-foreground">{label}</span>
    <span className={`font-mono tabular-nums ${strong ? "text-base font-semibold" : "text-sm"}`}>{value}</span>
  </div>
);

/**
 * Tenant top-up: PLN in, rUSDC out.
 *
 * `onCredited` is how the balance in the header catches up — the screen does not
 * read the chain itself, it tells the shell to refresh when the backend confirms
 * the webhook landed.
 */
export function TopUp({ wallet, onCredited }: { wallet: string | null; onCredited?: () => void }) {
  const [config, setConfig] = useState<fiat.OnrampConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [amount, setAmount] = useState(PRESETS_PLN[1]!);
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  // Returning from the hosted page remounts this screen, so the resume must run
  // once per return and not once per render.
  const resumed = useRef<string | null>(null);

  useEffect(() => {
    if (!fiat.FIAT_AVAILABLE) return;
    let live = true;
    fiat.onrampConfig().then(
      (c) => live && setConfig(c),
      (e: unknown) => live && setConfigError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const follow = useCallback(
    async (intent: string, amountPln: string, amountUsdc: string) => {
      setPhase({ at: "waiting", intent, amountPln, amountUsdc });
      try {
        const status = await fiat.awaitTopUp(wallet!, intent);
        if (status.state === "credited" && status.credit) {
          setPhase({ at: "done", credit: status.credit });
          onCredited?.();
        } else if (status.state === "rejected") {
          setPhase({ at: "error", message: status.credit?.reason ?? "the top-up was refused" });
        } else {
          setPhase({
            at: "error",
            message: "The payment provider has not confirmed this top-up yet. It will be credited when the webhook arrives — reload in a moment.",
          });
        }
      } catch (e) {
        setPhase({ at: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [wallet, onCredited],
  );

  // Pick up where the hosted page left off. The redirect is only a hint: the
  // credit is whatever the webhook did, which is what `follow` goes and asks.
  useEffect(() => {
    if (!wallet) return;
    const back = fiat.topUpReturn();
    if (!back || resumed.current === back.intent) return;
    resumed.current = back.intent;
    fiat.clearTopUpReturn();
    if (back.outcome === "cancelled") setPhase({ at: "cancelled" });
    else void follow(back.intent, "", "");
  }, [wallet, follow]);

  const preview = useMemo(() => (config ? fiat.previewUsdc(amount, config.plnPerUsdc) : null), [amount, config]);
  const valid = fiat.normalisePln(amount) !== null;

  const start = async () => {
    const normalised = fiat.normalisePln(amount);
    if (!wallet || normalised === null) return;
    setPhase({ at: "starting" });
    try {
      const checkout = await fiat.startTopUp(wallet, normalised);
      // Same tab on purpose: a popup blocked by the browser is the single most
      // common way a demo stalls, and the hosted page returns us here anyway.
      globalThis.location.assign(checkout.url);
    } catch (e) {
      setPhase({ at: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!fiat.FIAT_AVAILABLE) {
    return (
      <Notice title="No fiat rail configured">
        Set <code className="font-mono text-xs">VITE_API</code> in <code className="font-mono text-xs">app/.env.local</code> to a running backend. In
        mock mode it needs no keys at all: <code className="font-mono text-xs">cd backend &amp;&amp; npm run dev</code>.
      </Notice>
    );
  }
  if (!wallet) return <Notice title="Connect your wallet">A top-up is credited to one wallet, so there has to be one connected first.</Notice>;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="rise">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
              <Banknote className="size-5" />
            </span>
            {config && (config.simulated ? <Simulated>Simulated checkout</Simulated> : <Badge variant="warning">Stripe test mode</Badge>)}
          </div>
          <CardTitle className="mt-2">Add funds</CardTitle>
          <CardDescription>
            Pay in złoty; the deposit and your rent are settled in rUSDC, a devnet token pegged 1:1 to USDC. No real money moves at any point.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {configError && <Problem>{configError}</Problem>}

          <div className="flex flex-col gap-3">
            <label htmlFor="topup-amount" className="eyebrow">
              Amount to pay
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="topup-amount"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!valid}
                aria-describedby="topup-rate"
                className="font-mono tabular-nums"
                disabled={phase.at === "starting" || phase.at === "waiting"}
              />
              <span className="shrink-0 text-sm font-semibold text-muted-foreground">PLN</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {PRESETS_PLN.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  className="min-h-9 rounded-lg border px-3 font-mono text-sm tabular-nums hover:bg-secondary/60"
                >
                  {p}
                </button>
              ))}
            </div>
            {!valid && <p className="text-sm text-destructive">Enter an amount in złoty, up to two decimal places.</p>}
            {config && (
              <p id="topup-rate" className="text-sm text-muted-foreground">
                {preview ? (
                  <>
                    You receive <b className="font-mono tabular-nums text-foreground">{preview} rUSDC</b> at{" "}
                  </>
                ) : (
                  <>Rate </>
                )}
                <span className="font-mono tabular-nums">{config.plnPerUsdc}</span> PLN per USDC — a fixed demo rate, illustrative only. Between{" "}
                <span className="font-mono tabular-nums">{config.minPln}</span> and <span className="font-mono tabular-nums">{config.maxPln}</span> PLN.
              </p>
            )}
          </div>

          {phase.at === "error" && <Problem>{phase.message}</Problem>}
          {phase.at === "cancelled" && (
            <p className="rounded-xl border bg-secondary/40 p-3 text-sm">Checkout cancelled. Nothing was charged and nothing was credited.</p>
          )}

          {phase.at === "waiting" ? (
            <Waiting amountPln={phase.amountPln} amountUsdc={phase.amountUsdc} />
          ) : phase.at === "done" ? (
            <>
              <Credited credit={phase.credit} />
              {/* workstream F: finishes the credit by moving it to the private balance */}
              <SecurePrivateBalance credit={phase.credit} />
            </>
          ) : (
            <Button onClick={start} disabled={!valid || !config || phase.at === "starting"} size="lg">
              {phase.at === "starting" ? <Loader2 className="animate-spin" /> : <CreditCard />}
              {phase.at === "starting" ? "Opening checkout…" : config?.simulated ? "Continue (simulated)" : "Pay with card"}
            </Button>
          )}
        </CardContent>
      </Card>

      <HowItWorks simulated={config?.simulated ?? true} />
    </div>
  );
}

const Waiting = ({ amountPln, amountUsdc }: { amountPln: string; amountUsdc: string }) => (
  <div className="flex flex-col gap-2 rounded-xl border bg-secondary/40 p-4">
    <p className="flex items-center gap-2 text-sm font-medium">
      <Loader2 className="size-4 animate-spin" /> Waiting for the payment provider to confirm
    </p>
    <p className="text-sm text-muted-foreground">
      The credit is triggered by the provider's signed webhook, not by your browser coming back here — so this waits for the backend to see it.
      {amountPln !== "" && ` ${amountPln} PLN → ${amountUsdc} rUSDC.`}
    </p>
  </div>
);

const Credited = ({ credit }: { credit: fiat.OnrampCredit }) => (
  <div className="flex flex-col gap-1 rounded-xl border border-success/40 bg-success-soft p-4">
    <p className="flex items-center gap-2 font-medium">
      <BadgeCheck className="size-4" /> {fiat.usdcFromBase(credit.amountUsdc)} rUSDC credited
    </p>
    <Row label="You paid" value={`${fiat.plnFromMinor(credit.amountPln)} PLN`} />
    <Row label="Minted to your wallet" value={`${fiat.usdcFromBase(credit.amountUsdc)} rUSDC`} strong />
    {credit.publicHoldback !== "0" && <Row label="Kept public for the deposit" value={`${fiat.usdcFromBase(credit.publicHoldback)} rUSDC`} />}
    {credit.confidentialPending && BigInt(credit.confidentialAmount) > 0n && (
      <p className="mt-1 text-sm text-muted-foreground">
        {fiat.usdcFromBase(credit.confidentialAmount)} rUSDC is moving to your private balance. That step is signed by your own wallet — nobody here
        holds your key — so it happens in this browser, now.
      </p>
    )}
    {credit.signatures[0] && (
      <a
        href={`https://explorer.solana.com/tx/${credit.signatures[0]}?cluster=devnet`}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 text-sm underline underline-offset-4"
      >
        See the mint on the explorer <ArrowUpRight className="size-3.5" />
      </a>
    )}
  </div>
);

const HowItWorks = ({ simulated }: { simulated: boolean }) => (
  <Card className="h-fit">
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <ShieldCheck className="size-4" /> What happens to the money
      </CardTitle>
    </CardHeader>
    <CardContent>
      <ol className="flex list-decimal flex-col gap-2 pl-4 text-sm text-muted-foreground">
        <li>{simulated ? "A local page stands in for the hosted checkout — no card, no money." : "You pay on Stripe's hosted page, in test mode."}</li>
        <li>The provider signs a webhook to the backend. Your browser coming back here credits nothing.</li>
        <li>The backend credits its USDC reserve, then mints you the same amount of rUSDC. It refuses to mint more rUSDC than the reserve holds.</li>
        <li>Rent is paid with a confidential transfer, so the amount is encrypted on chain. The deposit stays public — the vault is a program account and cannot hold keys.</li>
      </ol>
    </CardContent>
  </Card>
);

/**
 * Landlord payout. Mocked end to end: it prices the payout at the demo rate and
 * writes a receipt, and nothing leaves the chain or a bank.
 *
 * The rUSDC burn that a real payout needs is signed by the landlord's own
 * wallet, which this backend deliberately cannot do on their behalf — so the
 * receipt says whether a burn happened rather than implying one did.
 */
export function Payout({ wallet, balanceBase }: { wallet: string | null; balanceBase?: number | null }) {
  const [history, setHistory] = useState<fiat.PayoutHistory | null>(null);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<fiat.PayoutReceipt | null>(null);

  const refresh = useCallback(() => {
    if (!wallet) return;
    fiat.payoutHistory(wallet).then(setHistory, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [wallet]);
  useEffect(refresh, [refresh]);

  const available = balanceBase == null ? null : (balanceBase / USDC).toFixed(2);
  const valid = fiat.normalisePln(amount) !== null;

  const submit = async () => {
    const normalised = fiat.normalisePln(amount);
    if (!wallet || normalised === null) return;
    setBusy(true);
    setError(null);
    try {
      setReceipt(await fiat.requestPayout(wallet, normalised, { destination: destination.trim() || undefined }));
      setAmount("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!fiat.FIAT_AVAILABLE) {
    return (
      <Notice title="No fiat rail configured">
        Set <code className="font-mono text-xs">VITE_API</code> in <code className="font-mono text-xs">app/.env.local</code> to a running backend.
      </Notice>
    );
  }
  if (!wallet) return <Notice title="Connect your wallet">A payout is paid out of one wallet's balance, so connect it first.</Notice>;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="rise">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
              <Landmark className="size-5" />
            </span>
            <Simulated>Simulated payout — no money moves</Simulated>
          </div>
          <CardTitle className="mt-2">Cash out to your bank</CardTitle>
          <CardDescription>
            Rent you have received is held as rUSDC. A real cash-out settles through MoneyGram on mainnet, which is out of scope for this demo — this
            screen writes a receipt and nothing else.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <label htmlFor="payout-amount" className="eyebrow">
              Amount to cash out
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="payout-amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amount !== "" && !valid}
                className="font-mono tabular-nums"
                disabled={busy}
              />
              <span className="shrink-0 text-sm font-semibold text-muted-foreground">rUSDC</span>
            </div>
            {available !== null && (
              <p className="text-sm text-muted-foreground">
                Public balance <span className="font-mono tabular-nums">{available}</span> rUSDC. A confidential balance has to be withdrawn to the
                public one first.
              </p>
            )}
            <label htmlFor="payout-iban" className="eyebrow mt-2">
              Where to (not stored)
            </label>
            <Input
              id="payout-iban"
              autoComplete="off"
              placeholder="PL00 0000 0000 0000 0000 0000 0000"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              disabled={busy}
            />
          </div>

          {error && <Problem>{error}</Problem>}
          {receipt && <Receipt receipt={receipt} />}

          <Button onClick={submit} disabled={!valid || busy} size="lg">
            {busy ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
            {busy ? "Requesting…" : "Request payout (simulated)"}
          </Button>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Past payouts</CardTitle>
          <CardDescription>
            {history === null
              ? "Loading…"
              : history.receipts.length === 0
                ? "Nothing yet."
                : `Rate ${history.plnPerUsdc} PLN per USDC. All simulated.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(history?.receipts ?? []).map((r) => (
            <div key={r.reference} className="flex flex-col gap-0.5 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground">{r.reference}</span>
                <Badge variant="warning">Simulated</Badge>
              </div>
              <span className="font-mono tabular-nums">
                {fiat.usdcFromBase(r.amountUsdc)} rUSDC → {fiat.plnFromMinor(r.amountPln)} PLN
              </span>
              <span className="text-xs text-muted-foreground">{new Date(r.at).toLocaleString()}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const Receipt = ({ receipt }: { receipt: fiat.PayoutReceipt }) => (
  <div className="flex flex-col gap-1 rounded-xl border border-warning/50 bg-warning-soft p-4">
    <p className="flex items-center justify-between gap-2 font-medium">
      <span>Payout receipt</span> <span className="font-mono text-xs">{receipt.reference}</span>
    </p>
    <Row label="Cashed out" value={`${fiat.usdcFromBase(receipt.amountUsdc)} rUSDC`} strong />
    <Row label="Would arrive as" value={`${fiat.plnFromMinor(receipt.amountPln)} PLN`} />
    <Row label="At" value={`${receipt.plnPerUsdc} PLN / USDC`} />
    {receipt.destination && <Row label="To" value={receipt.destination} />}
    <p className="mt-1 text-sm">
      <b>Simulated.</b> {receipt.unwrap.note}
    </p>
  </div>
);

const Notice = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card className="rise max-w-xl">
    <CardHeader>
      <CardTitle>{title}</CardTitle>
    </CardHeader>
    <CardContent className="text-sm text-muted-foreground">{children}</CardContent>
  </Card>
);

const Problem = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
    {children}
  </p>
);
