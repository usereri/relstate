// Identity verification (workstream D; docs/contracts/attestation.md).
//
// The screen is honest about two things. What is checked: the status shown here is read from the
// chain through the backend, never from the browser's own idea of having finished a form. And
// what is kept: personal data stays with the identity provider; the chain holds a level, an expiry
// and a salted hash, and the card says so rather than leaving it to a footnote.
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, CircleAlert, FileCheck2, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import * as kyc from "@/lib/kyc";
import { useChain } from "@/lib/useChain";

type Phase = { at: "idle" } | { at: "starting" } | { at: "checking" } | { at: "cancelled" } | { at: "error"; message: string };

/** The wallet's identity status, re-read on the app's tick. Undefined while loading or when no backend is configured. */
export function useKycStatus(wallet: string | null): kyc.KycStatus | undefined {
  return useChain(
    () => (wallet && kyc.KYC_AVAILABLE ? kyc.kycStatus(wallet).catch(() => undefined) : Promise.resolve(undefined)),
    [wallet],
  );
}

const Notice = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card className="rise max-w-xl">
    <CardHeader>
      <CardTitle>{title}</CardTitle>
    </CardHeader>
    <CardContent className="text-sm text-muted-foreground">{children}</CardContent>
  </Card>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <span className="text-sm text-muted-foreground">{label}</span>
    <span className="text-sm font-medium">{value}</span>
  </div>
);

export function Kyc({ wallet, onVerified }: { wallet: string | null; onVerified?: () => void }) {
  const status = useKycStatus(wallet);
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const resumed = useRef<string | null>(null);

  // Returning from the verification page remounts this screen. The redirect proves nothing, so it
  // only starts a short wait for the status to catch up with the webhook.
  const follow = useCallback(async () => {
    if (!wallet) return;
    setPhase({ at: "checking" });
    try {
      for (let i = 0; i < 20; i++) {
        const s = await kyc.kycStatus(wallet);
        if (s.verified || s.last !== null || s.unavailable) {
          setPhase({ at: "idle" });
          onVerified?.();
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setPhase({ at: "error", message: "The identity provider has not confirmed yet. It will show here once it does — check again in a moment." });
    } catch (e) {
      setPhase({ at: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [wallet, onVerified]);

  useEffect(() => {
    if (!wallet) return;
    const back = kyc.kycReturn();
    if (!back || resumed.current === back.session) return;
    resumed.current = back.session;
    kyc.clearKycReturn();
    if (back.outcome === "cancelled") setPhase({ at: "cancelled" });
    else void follow();
  }, [wallet, follow]);

  const start = async () => {
    if (!wallet) return;
    setPhase({ at: "starting" });
    try {
      const started = await kyc.startKyc(wallet);
      // Same tab on purpose, as the top-up does: a blocked popup is the commonest way a demo stalls.
      globalThis.location.assign(started.url);
    } catch (e) {
      setPhase({ at: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!kyc.KYC_AVAILABLE) {
    return (
      <Notice title="No identity service configured">
        Set <code className="font-mono text-xs">VITE_API</code> in <code className="font-mono text-xs">app/.env.local</code> to a running backend. In mock
        mode it needs no keys: <code className="font-mono text-xs">cd backend &amp;&amp; npm run dev</code>.
      </Notice>
    );
  }
  if (!wallet) return <Notice title="Sign in first">A verification is attached to one wallet, so there has to be one connected.</Notice>;

  const att = status?.attestation;
  const verified = status?.verified === true;
  const revoked = att?.revoked === true;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="rise">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="grid size-11 place-items-center rounded-xl bg-secondary text-primary">
              <FileCheck2 className="size-5" />
            </span>
            {status?.provider === "mock" && (
              <Badge variant="warning" className="gap-1.5">
                <CircleAlert className="size-3.5" /> Simulated check
              </Badge>
            )}
          </div>
          <CardTitle className="mt-2">Verify your identity</CardTitle>
          <CardDescription>
            One check, reusable with every landlord. They see a Verified badge, never your documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {phase.at === "error" && (
            <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
              {phase.message}
            </p>
          )}
          {phase.at === "cancelled" && <p className="rounded-xl border bg-secondary/40 p-3 text-sm">Verification cancelled. Nothing was recorded.</p>}
          {status?.unavailable && (
            <p className="rounded-xl border bg-secondary/40 p-3 text-sm">
              <b>Not recorded on chain:</b> {status.unavailable}
            </p>
          )}

          {verified && att ? (
            <div className="flex flex-col gap-1 rounded-xl border border-success/40 bg-success-soft p-4">
              <p className="flex items-center gap-2 font-medium">
                <BadgeCheck className="size-4" /> Verified
              </p>
              <Row label="Level" value={kyc.levelName(att.level)} />
              <Row label="Verified" value={new Date(att.verifiedAt * 1000).toLocaleDateString()} />
              <Row label="Validity" value={kyc.expiryText(att.expiresAt)} />
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">on chain: {att.subjectHash.slice(0, 16)}…</p>
            </div>
          ) : phase.at === "checking" ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-secondary/40 p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Loader2 className="size-4 animate-spin" /> Waiting for the provider to confirm
              </p>
              <p className="text-sm text-muted-foreground">
                The result is written by the provider's signed webhook, not by your browser coming back here — so this waits for the chain to show it.
              </p>
            </div>
          ) : (
            <>
              {revoked && (
                <p className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
                  Your verification was withdrawn. Verify again to continue.
                </p>
              )}
              {att && !revoked && !verified && (
                <p className="rounded-xl border bg-secondary/40 p-3 text-sm">Your verification has expired. Verify again to renew it.</p>
              )}
              {status?.last?.decision === "rejected" && !att && (
                <p className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
                  The check was not approved{status.last.reason ? ` (${status.last.reason})` : ""}.
                </p>
              )}
              <Button onClick={start} disabled={!status || phase.at === "starting"} size="lg">
                {phase.at === "starting" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {phase.at === "starting" ? "Opening verification…" : status?.provider === "mock" ? "Start verification (simulated)" : "Start verification"}
              </Button>
              {status?.requireKyc && (
                <p className="text-sm text-muted-foreground">Applying for an apartment and proposing a lease both require a verified identity.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" /> What is stored
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex list-decimal flex-col gap-2 pl-4 text-sm text-muted-foreground">
            <li>Your documents go to the identity provider and nowhere else.</li>
            <li>The provider signs a result to our backend. Your browser saying it finished credits nothing.</li>
            <li>The chain keeps your level, an expiry and a salted hash of the provider's applicant id. No name, no document, no date of birth.</li>
            <li>The key that writes it is separate from the one that pays fees, so sponsorship cannot be used to verify anyone.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Shown in place of the raw program error when `apply` / `propose_lease` is refused for want of a
 * verified identity. A prompt with a way forward, not a failure to be decoded.
 */
export function VerifyFirst({ onVerify, onDismiss }: { onVerify: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-secondary/60 p-4 text-sm">
      <p className="flex items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-primary" />
        <span>
          <b>Verify your identity first.</b> This takes a minute, and landlords see only a badge.
        </span>
      </p>
      <span className="flex gap-2">
        <Button size="sm" onClick={onVerify}>
          Verify now
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Later
        </Button>
      </span>
    </div>
  );
}
