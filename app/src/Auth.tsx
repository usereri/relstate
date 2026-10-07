import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Building2, Check, FlaskConical, KeyRound, Loader2, Lock, ShieldCheck, Wallet } from "lucide-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import * as chain from "@/lib/chain";
import { Role } from "@/lib/chain";
import { Account, loadAccount, saveAccount } from "@/lib/account";
import { Logo } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocalWalletProvider, useLocalWallet } from "@/components/WalletButton";
import { cn } from "@/lib/utils";

const ROLE_CARDS: Record<Role, { icon: typeof KeyRound; title: string; text: string }> = {
  tenant: { icon: KeyRound, title: "I'm looking for a place", text: "Browse apartments, lock your deposit safely and build your record." },
  landlord: { icon: Building2, title: "I rent out property", text: "List apartments and pick tenants with a verified payment history." },
};

/** Sign up and sign in share one frame: a form on the left, a brand panel on the right. */
export function AuthPage({ mode, onDone }: { mode: "signup" | "signin"; onDone: (role: Role) => void }) {
  const [role, setRole] = useState<Role>("tenant");
  const [step, setStep] = useState<"role" | "details" | "wallet">(mode === "signup" ? "role" : "wallet");
  const [details, setDetails] = useState({ name: "", email: "", city: "" });
  // a wallet that signed in but has no name on this device yet (new browser, cleared storage): ask once, then continue
  const [pending, setPending] = useState<string | null>(null);
  const finish = (address: string) => {
    const prior = loadAccount(address);
    const a: Account = {
      name: details.name.trim() || prior?.name || "",
      email: details.email.trim() || prior?.email || "",
      city: details.city.trim() || prior?.city || "",
      role,
      createdAt: prior?.createdAt ?? Date.now(),
    };
    if (!a.name) {
      setPending(address);
      setStep("details");
      return;
    }
    saveAccount(address, a);
    onDone(role);
  };

  useEffect(() => {
    document.documentElement.dataset.role = role;
    document.title = mode === "signup" ? "Create account · Relstate" : "Sign in · Relstate";
  }, [role, mode]);

  const steps = ["role", "details", "wallet"] as const;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,560px)]">
      <main className="flex flex-col px-5 py-6 sm:px-10">
        <header className="flex items-center justify-between">
          <Logo />
          <p className="text-sm text-muted-foreground">
            {mode === "signup" ? "Already have an account? " : "New to Relstate? "}
            <a className="font-medium text-foreground underline-offset-4 hover:underline" href={mode === "signup" ? "#/signin" : "#/signup"}>
              {mode === "signup" ? "Sign in" : "Create one"}
            </a>
          </p>
        </header>

        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center gap-8 py-12">
          {mode === "signup" && (
            <ol className="flex gap-2" aria-label="Progress">
              {steps.map((s, i) => (
                <li key={s} className={cn("h-1 flex-1 rounded-full transition-colors", steps.indexOf(step) >= i ? "bg-primary" : "bg-border")}>
                  <span className="sr-only">
                    Step {i + 1}
                    {s === step && " (current)"}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {step === "role" && (
            <div key="role" className="rise flex flex-col gap-6">
              <Heading title="Create your account" text="Free for tenants and landlords. Tell us how you'll use Relstate." />
              <div className="grid gap-3" role="radiogroup" aria-label="Account type">
                {(Object.keys(ROLE_CARDS) as Role[]).map((r) => {
                  const C = ROLE_CARDS[r];
                  const on = role === r;
                  return (
                    <button
                      key={r}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setRole(r)}
                      className={cn(
                        "flex items-start gap-4 rounded-2xl border bg-card p-4 text-left transition-all",
                        on ? "border-primary ring-2 ring-primary/20" : "hover:border-input hover:bg-muted/40",
                      )}
                    >
                      <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                        <C.icon className="size-5" />
                      </span>
                      <span className="flex-1">
                        <span className="block font-semibold">{C.title}</span>
                        <span className="block text-sm text-muted-foreground">{C.text}</span>
                      </span>
                      <span className={cn("mt-1 grid size-5 place-items-center rounded-full border", on && "border-primary bg-primary text-primary-foreground")}>
                        {on && <Check className="size-3" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Button size="lg" onClick={() => setStep("details")}>
                Continue <ArrowRight />
              </Button>
            </div>
          )}

          {step === "details" && (
            <form
              key="details"
              className="rise flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (pending) finish(pending);
                else setStep("wallet");
              }}
            >
              <Heading
                title={pending ? "Finish your profile" : "About you"}
                text={
                  pending
                    ? "Wallet connected. We don't have your name on this device yet. Add it once and you're in."
                    : "Shown to the people you rent with. Stored on this device only, never on-chain."
                }
              />
              <Field id="name" label="Full name">
                <Input id="name" required autoComplete="name" placeholder="Maria Kowalska" value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
              </Field>
              <Field id="email" label="Email" hint="For lease reminders. Optional.">
                <Input id="email" type="email" autoComplete="email" placeholder="maria@example.com" value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} />
              </Field>
              <Field id="city" label={role === "tenant" ? "City you're moving to" : "City of your properties"}>
                <Input id="city" autoComplete="address-level2" placeholder="Kraków" value={details.city} onChange={(e) => setDetails({ ...details, city: e.target.value })} />
              </Field>
              <div className="flex gap-3">
                {!pending && (
                  <Button type="button" variant="outline" size="lg" onClick={() => setStep("role")} aria-label="Back">
                    <ArrowLeft />
                  </Button>
                )}
                <Button type="submit" size="lg" className="flex-1">
                  Continue <ArrowRight />
                </Button>
              </div>
            </form>
          )}

          {step === "wallet" && (
            <div key="wallet" className="rise flex flex-col gap-6">
              {mode === "signin" ? (
                <>
                  <Heading title="Welcome back" text="Sign in with the wallet that holds your rental record." />
                  <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Sign in as">
                    {(["tenant", "landlord"] as Role[]).map((r) => (
                      <button
                        key={r}
                        role="tab"
                        aria-selected={role === r}
                        onClick={() => setRole(r)}
                        className={cn(
                          "h-10 rounded-lg text-sm font-medium capitalize transition-all",
                          role === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <Heading title="Connect your wallet" text="Your wallet is your login. It signs leases and owns your record, so no password to forget." />
              )}

              {/* keyed by role: each role keeps its own wallet, exactly like the app */}
              <WalletProvider key={role} wallets={[]} autoConnect={false} localStorageKey={`relstate.wallet.${role}`}>
                <LocalWalletProvider role={role}>
                  <WalletChoices
                    onConnected={finish}
                  />
                </LocalWalletProvider>
              </WalletProvider>

              {mode === "signup" && (
                <button className="flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground" onClick={() => setStep("details")}>
                  <ArrowLeft className="size-4" /> Back
                </button>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                By continuing you agree to the Terms of Service and Privacy Policy. Relstate never asks for your seed phrase.
              </p>
            </div>
          )}
        </div>
      </main>
      <BrandPanel mode={mode} />
    </div>
  );
}

function WalletChoices({ onConnected }: { onConnected: (address: string) => void }) {
  const local = useLocalWallet();
  const { wallets, select, connect, disconnect, connected, publicKey, signMessage, wallet } = useWallet();
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);
  // the wallet the user clicked; nothing happens on its own (no autoConnect), so a stale session never logs anyone in
  const [picked, setPicked] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "connecting" | "signing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const busy = phase === "connecting" || phase === "signing";

  // step 1: once the clicked adapter is selected, connect it (Phantom shows its popup unless the site is already trusted)
  useEffect(() => {
    if (!picked || wallet?.adapter.name !== picked || connected || phase !== "connecting") return;
    connect().catch((e) => {
      setPicked(null);
      setPhase("idle");
      setError(e?.name === "WalletNotReadyError" ? "That wallet isn't ready. Unlock it and try again." : "Connection was cancelled.");
    });
  }, [picked, wallet, connected, connect, phase]);

  // step 2: prove ownership with a signed message. This always asks the user, even on a trusted site.
  useEffect(() => {
    if (!picked || !connected || !publicKey || phase !== "connecting") return;
    const addr = publicKey.toBase58();
    if (!signMessage) {
      setAddress(addr);
      setPhase("done");
      return;
    }
    setPhase("signing");
    const text = `Sign in to Relstate\n\nWallet: ${addr}\nIssued: ${new Date().toISOString()}\nNonce: ${crypto.randomUUID()}\n\nThis request costs nothing and does not send a transaction.`;
    signMessage(new TextEncoder().encode(text)).then(
      () => {
        setAddress(addr);
        setPhase("done");
      },
      () => {
        setPicked(null);
        setPhase("idle");
        setError("Signature declined. Signing proves this wallet is yours; it costs nothing.");
        disconnect().catch(() => {});
      },
    );
  }, [picked, connected, publicKey, signMessage, disconnect, phase]);

  useEffect(() => {
    if (phase !== "done" || !address) return;
    const t = setTimeout(() => onConnected(address), 450); // let the success state register
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, address]);

  const pick = (name: string) => {
    setError(null);
    setPicked(name);
    setPhase("connecting");
    if (wallet?.adapter.name !== name) select(name as Parameters<typeof select>[0]);
  };

  if (phase === "done")
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success-soft p-4 text-success">
        <Check className="size-5" /> <span className="font-medium">Connected. Opening your dashboard…</span>
      </div>
    );

  const Row = ({ icon, name, note, onClick }: { icon: React.ReactNode; name: string; note?: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      disabled={busy}
      className="group flex min-h-14 w-full items-center gap-3 rounded-xl border bg-card px-4 text-left transition-all hover:border-input hover:shadow-card disabled:opacity-60"
    >
      {icon}
      <span className="flex-1">
        <span className="block font-medium">{name}</span>
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </span>
      {busy && picked === name ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      )}
    </button>
  );

  return (
    <div className="flex flex-col gap-2.5">
      {error && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {installed.map((w) => (
        <Row key={w.adapter.name} icon={<img src={w.adapter.icon} alt="" className="size-7 rounded-md" />} name={w.adapter.name} note={busy && picked === w.adapter.name ? (phase === "signing" ? "Approve the sign-in request in your wallet" : "Waiting for your wallet…") : "Detected in this browser"}
          onClick={() => pick(w.adapter.name)} />
      ))}
      {chain.LOCAL_WALLETS_AVAILABLE && (
        <Row
          icon={
            <span className="grid size-7 place-items-center rounded-md bg-brass-soft text-warning">
              <FlaskConical className="size-4" />
            </span>
          }
          name={`Demo wallet (${local.role})`}
          note="Pre-funded test account on the local network"
          onClick={() => {
            local.set(true);
            setAddress(chain.localKeypair(local.role).publicKey.toBase58());
            setPhase("done");
          }}
        />
      )}
      {installed.length === 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          <Wallet className="mt-0.5 size-5 shrink-0" />
          <p>
            No Solana wallet found in this browser.{" "}
            <a className="font-medium text-foreground underline underline-offset-4" href="https://phantom.com/download" target="_blank" rel="noreferrer">
              Get Phantom
            </a>{" "}
            (free, two minutes), then reload this page.
          </p>
        </div>
      )}
    </div>
  );
}

function Heading({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-4xl font-semibold leading-tight">{title}</h1>
      <p className="text-muted-foreground">{text}</p>
    </div>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function BrandPanel({ mode }: { mode: "signup" | "signin" }) {
  return (
    <aside className="relative hidden overflow-hidden bg-ink p-10 text-white lg:flex lg:flex-col lg:justify-between">
      <img src="/listings/praga.jpg" alt="" className="absolute inset-0 size-full object-cover opacity-35" />
      <div className="absolute inset-0 bg-gradient-to-b from-ink/30 via-ink/60 to-ink" />
      <p className="relative eyebrow text-white/60">{mode === "signup" ? "Join Relstate" : "Your record is waiting"}</p>
      <div className="relative flex flex-col gap-8">
        <blockquote className="font-display text-3xl font-medium leading-snug tracking-tight">
          “I moved from Lisbon to Kraków and my landlord could see two years of on-time rent before we'd even met. Half the deposit, same week.”
        </blockquote>
        <p className="text-sm text-white/60">Illustrative tenant story</p>
        <ul className="grid gap-3 border-t border-white/15 pt-6 text-sm text-white/80">
          {[
            [Lock, "Deposit held in a vault, never by the landlord"],
            [ShieldCheck, "A record only the protocol can write"],
          ].map(([Icon, t]) => {
            const I = Icon as typeof Lock;
            return (
              <li key={t as string} className="flex items-center gap-3">
                <I className="size-4 text-brass" /> {t as string}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
