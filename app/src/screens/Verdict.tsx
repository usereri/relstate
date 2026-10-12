// The appraiser verdict console: `#/appraiser` (docs/contracts/dispute-mediation.md §4, §10).
//
// An operator tool, deliberately not linked from either role's UI. It exists because the program
// forbids a party to the lease from being its appraiser, so the verdict can never be submitted
// from the tenant's or the landlord's window — and a demo that has to drop to a script to finish
// the flow is a demo with a hole in it.
//
// It holds NO key and no secret at rest. The appraiser's key lives in the backend; this screen
// sends a lease address and a number under the backend's own `VERDICT_CONSOLE_TOKEN`, which the
// operator pastes and which is kept in this tab's memory only — never localStorage, never a
// cookie, gone on reload. The backend signs only as whoever the chain says is bound, or refuses.
//
// Every number shown before the confirm button is a preview: the app's own arithmetic first, then
// the backend's dry run, and the two are compared out loud.
import { useState } from "react";
import { AlertTriangle, ArrowUpRight, Eye, Gavel, KeyRound, Loader2, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/Brand";
import { Terms } from "@/components/Terms";
import * as chain from "@/lib/chain";
import * as med from "@/lib/mediation";
import { optionFor, useAppraiserOptions } from "@/screens/Mediation";
import { trustedLabelFor } from "@/lib/appraisers";
import { CONSOLE_AVAILABLE, asked, parseAmountInput, postVerdict, previewGate, verdictProblem, type VerdictResult } from "@/lib/verdict";
import { invalidateReads } from "@/lib/reads";
import { Tick, useChain } from "@/lib/useChain";
import { duration, isSignature, short, usdc } from "@/lib/utils";

const Problem = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
    {children}
  </p>
);

function Console({ bump }: { bump: () => void }) {
  const [token, setToken] = useState("");
  const [address, setAddress] = useState("");
  const [typed, setTyped] = useState("");
  const [preview, setPreview] = useState<{ asked: string; result: VerdictResult } | null>(null);
  const [done, setDone] = useState<VerdictResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leaseAddress = address.trim();
  const looksLikeAddress = leaseAddress !== "" && chain.isWallet(leaseAddress);
  const lease = useChain(() => (looksLikeAddress ? chain.loadLease(leaseAddress) : Promise.resolve(null)), [leaseAddress, looksLikeAddress]);
  const dispute = useChain(
    () => (lease?.status === "mediation" ? chain.loadDispute(lease.address) : Promise.resolve(null)),
    [lease?.address, lease?.status],
  );
  const { options } = useAppraiserOptions(lease?.status === "mediation");

  const parsed = parseAmountInput(typed);
  const deductionBase = "base" in parsed ? parsed.base : 0;
  const bound = dispute?.appraiser ?? "";
  const problem =
    lease && "base" in parsed
      ? verdictProblem({ deductionBase, deposit: lease.deposit, status: lease.status, appraiser: bound })
      : null;

  // The app's own §6 arithmetic, shown before anything is sent. The backend's dry run is the
  // authority; disagreement between the two is worth seeing, not smoothing over.
  const fee = lease && bound ? med.feeFor(lease.deposit, optionFor(options, bound)?.fee ?? 0, chain.APPRAISER_FEE_CAP_DIVISOR) : 0;
  const local = lease ? med.verdictSplit(lease.deposit, deductionBase, fee) : null;
  const current = asked(leaseAddress, deductionBase);
  // Editing the lease or the amount disarms the confirm, and so does a backend that echoed back a
  // different question than it was asked.
  const gate = previewGate(preview, leaseAddress, deductionBase);
  const previewed = gate.armed && preview ? preview.result : null;
  const echoMismatch = !gate.armed && gate.reason === "echo" ? preview?.result : null;
  const drift =
    previewed && local && (previewed.toTenant !== local.toTenant || previewed.toLandlord !== local.toLandlord || previewed.feePaid !== local.feePaid);

  const ready = !!lease && "base" in parsed && !problem && token.trim() !== "" && !busy;

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "Asking the backend…" : "Submitting the verdict…");
    setError(null);
    try {
      const result = await postVerdict(token, { lease: leaseAddress, deduction: deductionBase, dryRun });
      if (dryRun) setPreview({ asked: current, result });
      else {
        setDone(result);
        // The lease is closed now; drop what was read so re-pasting it shows the truth.
        invalidateReads();
        bump();
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // A program error can reach here through the backend's message, so it gets the same
      // readable treatment it would get anywhere else in the app.
      setError(chain.programErrorMessage(raw) ?? raw);
    } finally {
      setBusy(null);
    }
  };

  if (done)
    return (
      <Card className="rise">
        <CardHeader>
          <span className="grid size-11 place-items-center rounded-xl bg-success-soft text-success">
            <Gavel className="size-5" />
          </span>
          <CardTitle className="mt-2">Verdict submitted</CardTitle>
          <CardDescription>The program split the vault on this number and closed the lease. There is no second verdict to give.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Terms
            rows={[
              ["Deducted", `${usdc(done.deduction)} USDC`],
              ["To the landlord", `${usdc(done.toLandlord)} USDC`],
              ["To the tenant", `${usdc(done.toTenant)} USDC`],
              ["Appraiser's fee", `${usdc(done.feePaid)} USDC`],
            ]}
          />
          {/* A signature becomes an href, so it is checked to be base58 first: it arrives in a
              backend response, and anything that is not a signature has no business in a URL. */}
          {done.signatures.map((sig) =>
            isSignature(sig) ? (
              <a
                key={sig}
                href={chain.explorerTx(sig)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
              >
                {short(sig, 8)} <ArrowUpRight className="size-3.5" />
              </a>
            ) : (
              <span key={sig} className="font-mono text-xs text-muted-foreground">
                {short(sig, 8)} — not a valid signature, so it is not linked
              </span>
            ),
          )}
          <Button
            variant="outline"
            onClick={() => {
              setDone(null);
              setPreview(null);
              setAddress("");
              setTyped("");
            }}
          >
            Decide another lease
          </Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Console token</CardTitle>
          <CardDescription>
            The backend's <span className="font-mono text-xs">VERDICT_CONSOLE_TOKEN</span>, which is deliberately not the admin token. Kept in this
            tab's memory only: never stored, never sent anywhere but that one route, and gone when you reload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input type="password" autoComplete="off" spellCheck={false} placeholder="Paste the console token" value={token} onChange={(e) => setToken(e.target.value)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The lease</CardTitle>
          <CardDescription>The address of a lease in mediation. The backend will refuse any other.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            className="font-mono text-sm"
            spellCheck={false}
            placeholder="Lease account address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-invalid={leaseAddress !== "" && !looksLikeAddress}
          />
          {leaseAddress !== "" && !looksLikeAddress && <p className="text-xs text-destructive">That is not a valid account address.</p>}
          {looksLikeAddress && lease === undefined && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading the lease…
            </p>
          )}
          {looksLikeAddress && lease === null && <p className="text-sm text-muted-foreground">No lease account exists at that address on this network.</p>}
          {lease && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={lease.status === "mediation" ? "warning" : "outline"}>{lease.status}</Badge>
                {bound && <Badge variant="success">appraiser bound</Badge>}
              </div>
              <Terms
                rows={[
                  ["Deposit in vault", `${usdc(lease.deposit)} USDC`],
                  ["Landlord", short(lease.landlord, 6)],
                  ["Tenant", short(lease.tenant, 6)],
                  ...(bound ? ([["Bound appraiser", trustedLabelFor(optionFor(options, bound), bound, (k) => short(k, 6))]] as [string, string][]) : []),
                  ...(dispute
                    ? ([
                        [
                          dispute.verdictDeadline > Math.floor(Date.now() / 1000) ? "Verdict due in" : "Window closed",
                          duration(Math.abs(dispute.verdictDeadline - Math.floor(Date.now() / 1000))),
                        ],
                      ] as [string, string][])
                    : []),
                ]}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The decision</CardTitle>
          <CardDescription>
            How much of the deposit the damage justifies keeping, in USDC. 0 returns it all to the tenant. This is the appraiser's judgement of the
            flat, not a platform decision and not a negotiation — the program pays out whatever is signed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            inputMode="decimal"
            placeholder="0"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-invalid={typed.trim() !== "" && "error" in parsed}
          />
          {typed.trim() !== "" && "error" in parsed && <p className="text-xs text-destructive">{parsed.error}</p>}
          {problem && <Problem>{problem}</Problem>}
          {lease && local && "base" in parsed && !problem && (
            <>
              <Terms
                rows={[
                  ["To the landlord", `${usdc(local.toLandlord)} USDC`],
                  ["To the tenant", `${usdc(local.toTenant)} USDC`],
                  ["Appraiser's fee", `${usdc(local.feePaid)} USDC · ${med.feePayer(lease.deposit, deductionBase)} pays`],
                ]}
              />
              <p className="text-xs text-muted-foreground">
                This app's own arithmetic, from the contract's fee rule. Preview it with the backend before submitting: the backend reads the bound
                appraiser's registered fee itself, and its numbers are the ones that will be signed.
              </p>
            </>
          )}
          <Button variant="outline" disabled={!ready} onClick={() => run(true)}>
            <Eye /> {busy === "Asking the backend…" ? busy : "Preview with the backend"}
          </Button>
        </CardContent>
      </Card>

      {error && <Problem>{error}</Problem>}

      {echoMismatch && (
        <Problem>
          The backend answered about a different verdict than it was asked: it reports lease {short(echoMismatch.lease, 6)} and{" "}
          {usdc(echoMismatch.deduction)} USDC, where this form asked about {short(leaseAddress, 6)} and {usdc(deductionBase)} USDC. Nothing can be
          submitted from this preview — the numbers above would not be the ones signed. Check that this app points at the backend you think it does,
          then preview again.
        </Problem>
      )}

      {previewed && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle>What the backend will sign</CardTitle>
            <CardDescription>
              Nothing has been sent to the chain yet. These are the backend's own numbers for this lease and this deduction.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Terms
              rows={[
                ["Deducted", `${usdc(previewed.deduction)} USDC of ${usdc(previewed.deposit)} USDC`],
                ["To the landlord", `${usdc(previewed.toLandlord)} USDC`],
                ["To the tenant", `${usdc(previewed.toTenant)} USDC`],
                ["Appraiser's fee", `${usdc(previewed.feePaid)} USDC`],
                ["Signing as", short(previewed.appraiser, 6)],
              ]}
            />
            {drift && (
              <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                This app's arithmetic and the backend's disagree about the split. The backend reads the registered fee from the chain, so trust its
                numbers — but this disagreement means the app's copy of the fee rule has drifted from the program's and should be reported.
              </p>
            )}
            {!previewed.appraiserAtaExists && (
              <p className="text-xs text-muted-foreground">
                The appraiser has no token account for this lease's mint yet. Submitting creates it first, so the verdict takes an extra transaction.
              </p>
            )}
            <Button disabled={!ready} onClick={() => run(false)}>
              <Gavel /> {busy === "Submitting the verdict…" ? busy : `Submit this verdict: keep ${usdc(previewed.deduction)} USDC`}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              This pays out the deposit and closes the lease. There is exactly one verdict per dispute and it cannot be revised.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function VerdictConsole() {
  // This screen lives outside the app shell, which is what normally provides the read tick. One
  // here, bumped only after a submit: an operator console has no reason to poll, but the lease it
  // just closed must not still read as open.
  const [tick, setTick] = useState(0);
  return (
    <div className="min-h-dvh" data-role="landlord">
      <header className="border-b bg-card/85">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-4 px-5">
          <Logo />
          <Badge variant="warning" className="ml-auto">
            <Scale /> Operator tool
          </Badge>
        </div>
      </header>
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 pb-20 pt-8">
        <div>
          <p className="eyebrow">Appraiser</p>
          <h1 className="mt-1 text-3xl font-semibold">Submit a verdict</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            For the appraisal company bound to a lease in mediation. This page is not linked from the tenant's or the landlord's app, and neither of
            them can reach this instruction: the program refuses a verdict from a party to the lease.
          </p>
        </div>

        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            The appraiser's key is held by the backend, not by this page. For the demo those keys are ours and the companies are fictional, which is
            the oracle trust the contract discloses: the program constrains <i>who</i> may decide and <i>when</i>, never that the number is fair.
          </span>
        </p>

        {CONSOLE_AVAILABLE ? (
          <Tick.Provider value={tick}>
            <Console bump={() => setTick((t) => t + 1)} />
          </Tick.Provider>
        ) : (
          <Problem>
            This window has no backend configured (<span className="font-mono text-xs">VITE_API</span>), and the appraiser's key lives in the
            backend. Point the app at a deployment that has one.
          </Problem>
        )}
      </div>
    </div>
  );
}
