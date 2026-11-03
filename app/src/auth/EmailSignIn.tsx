// The email sign-up, as one block that drops into the existing wallet step on the sign-up page.
//
// Four states, in order: an email field, "creating your account", (a code field, for a provider
// that sends one), and the short address of the wallet the user now has. Nothing here mentions
// Solana, SOL or signing: that is the point of the workstream.

import { useEffect, useState } from "react";
import { Check, Loader2, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { short } from "@/lib/utils";
import { EMBEDDED_IS_MOCK } from "./mode";
import { useEmbeddedWallet } from "./EmbeddedWallet";

/**
 * Renders nothing when no provider is configured, so the sign-up page keeps exactly its previous
 * shape in a build without `VITE_EMBEDDED_WALLET*`.
 *
 * `onSignedIn` receives the new wallet's address; the sign-up page then runs its own profile step,
 * the same one the extension wallets go through.
 */
export function EmailSignIn({ onSignedIn }: { onSignedIn: (address: string) => void }) {
  const embedded = useEmbeddedWallet();
  const [typed, setTyped] = useState("");
  const [code, setCode] = useState("");

  const status = embedded?.status ?? "idle";
  const address = embedded?.address ?? null;

  // Same 450ms beat as the wallet rows use, so the success state registers before the page moves on.
  useEffect(() => {
    if (status !== "ready" || !address) return;
    const t = setTimeout(() => onSignedIn(address), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, address]);

  if (!embedded?.backend) return null;
  const { backend, error, sessionError, start, submitCode } = embedded;
  const busy = status === "sending" || status === "creating" || status === "linking";

  if (status === "ready" && address)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success-soft p-4 text-success">
          <Check className="size-5 shrink-0" />
          <span className="font-medium">
            You're in. Wallet <span className="font-mono text-sm">{short(address, 4)}</span> is yours.
          </span>
        </div>
        {sessionError && <Warning>{sessionError}</Warning>}
      </div>
    );

  if (busy)
    return (
      <div className="flex items-center gap-3 rounded-2xl border bg-card p-4">
        <Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
        <span className="font-medium">{status === "sending" ? "Emailing your code…" : "Creating your account…"}</span>
      </div>
    );

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (status === "code") submitCode(code);
        else start(typed);
      }}
    >
      {error && <Warning tone="error">{error}</Warning>}

      {status === "code" ? (
        <>
          <label htmlFor="embedded-code" className="text-sm font-medium">
            Enter the code we sent to {embedded.email}
          </label>
          <Input
            id="embedded-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" size="lg" disabled={code.trim() === ""}>
            Confirm and create my wallet
          </Button>
        </>
      ) : (
        <>
          <label htmlFor="embedded-email" className="text-sm font-medium">
            {backend.label}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="embedded-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="sm:flex-1"
            />
            <Button type="submit" size="lg" disabled={typed.trim() === ""}>
              <Mail /> Continue
            </Button>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {backend.note}
              {EMBEDDED_IS_MOCK && <strong className="font-semibold"> Demo wallet: for the demo only, not a real custodial wallet.</strong>}
            </span>
          </p>
        </>
      )}
    </form>
  );
}

const Warning = ({ tone = "warn", children }: { tone?: "warn" | "error"; children: React.ReactNode }) => (
  <p
    role="alert"
    className={
      tone === "error"
        ? "rounded-xl border border-destructive/30 bg-danger-soft px-4 py-3 text-sm text-destructive"
        : "rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning"
    }
  >
    {children}
  </p>
);
