import { useContext, useEffect, useRef, useState } from "react";
import { Building2, Copy, Home, KeyRound, LogOut } from "lucide-react";
import { WalletProvider } from "@solana/wallet-adapter-react";
import * as chain from "@/lib/chain";
import { Role } from "@/lib/chain";
import { IS_LOCAL, RPC } from "@/lib/config";
import { Doc } from "@/lib/hash";
import { ReadErrors, Tick, useChain } from "@/lib/useChain";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LocalWalletProvider, WalletButton, useMe } from "@/components/WalletButton";
import { Handlers, LeaseTab, LogEntry, Waiting } from "@/screens";
import { Listings, MyProfile } from "@/views";

const ROLE_KEY = "relstate.role";
const storedRole = (): Role | null => {
  try {
    const r = new URLSearchParams(location.search).get("role") ?? sessionStorage.getItem(ROLE_KEY);
    return r === "landlord" || r === "tenant" ? r : null;
  } catch {
    return null;
  }
};
const storeRole = (r: Role | null) => {
  try {
    if (r) sessionStorage.setItem(ROLE_KEY, r);
    else sessionStorage.removeItem(ROLE_KEY);
  } catch {
    /* private mode: the role is simply asked again on reload */
  }
};

const ROLES: Record<Role, { label: string; icon: typeof Home; blurb: string; does: string[] }> = {
  landlord: {
    label: "Landlord",
    icon: Building2,
    blurb: "Offer apartments and lease them to tenants with a verifiable record.",
    does: ["List apartments", "Propose a lease with the signed contract's fingerprint", "Release the deposit, or declare a default"],
  },
  tenant: {
    label: "Tenant",
    icon: KeyRound,
    blurb: "Find a place and build a rental record that follows you to the next city.",
    does: ["Browse listings and landlord records", "Accept a lease by funding the deposit", "Pay rent, or claim the deposit if the landlord stalls"],
  },
};

export default function App() {
  const [role, setRole] = useState<Role | null>(storedRole);

  useEffect(() => {
    document.documentElement.dataset.role = role ?? "";
    document.title = role ? `Relstate · ${ROLES[role].label}` : "Relstate";
  }, [role]);

  if (!role)
    return (
      <Landing
        onPick={(r) => {
          storeRole(r);
          setRole(r);
        }}
      />
    );

  return (
    <WalletProvider key={role} wallets={[]} autoConnect localStorageKey={`relstate.wallet.${role}`}>
      <LocalWalletProvider role={role}>
        <Workspace
          role={role}
          switchRole={() => {
            storeRole(null);
            setRole(null);
          }}
        />
      </LocalWalletProvider>
    </WalletProvider>
  );
}


function Landing({ onPick }: { onPick: (r: Role) => void }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-10 px-8 py-8">
      <header className="flex items-center justify-between">
        <Logo />
        <Badge variant="outline">{IS_LOCAL ? "local network" : "devnet"}</Badge>
      </header>

      <section className="grid flex-1 items-center gap-12 lg:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-5">
          <h1 className="text-5xl font-semibold leading-[1.05] lg:text-6xl">Rent with a record nobody can edit.</h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Deposits sit in an on-chain vault. Every payment and every deduction is written to the wallet's profile by the program itself, so a good
            tenant or landlord takes their reputation to any city.
          </p>
          <p className="max-w-xl text-sm text-muted-foreground">
            Each browser window plays one role with its own wallet. Open a second window, ideally another browser profile with its own wallet, for the
            other side.
          </p>
        </div>

        <div className="grid gap-4">
          {(Object.keys(ROLES) as Role[]).map((r) => {
            const R = ROLES[r];
            return (
              <button
                key={r}
                onClick={() => onPick(r)}
                data-pick={r}
                className={cn(
                  "group flex flex-col gap-3 rounded-3xl p-6 text-left text-white shadow-lg transition-transform hover:-translate-y-0.5",
                  r === "landlord" ? "bg-[#6b4226]" : "bg-[#1d5f6c]",
                )}
              >
                <span className="flex items-center gap-3">
                  <span className="grid size-11 place-items-center rounded-xl bg-white/15">
                    <R.icon className="size-6" />
                  </span>
                  <span className="font-serif text-2xl font-semibold">I'm a {R.label.toLowerCase()}</span>
                </span>
                <span className="text-white/85">{R.blurb}</span>
                <ul className="flex flex-col gap-1 text-sm text-white/75">
                  {R.does.map((d) => (
                    <li key={d}>· {d}</li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const Logo = () => (
  <div className="flex items-center gap-2.5">
    <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
      <Home className="size-5" />
    </span>
    <span className="font-serif text-2xl font-semibold tracking-tight">Relstate</span>
  </div>
);


type Tab = "apartments" | "listings" | "lease" | "profile";
const TABS: Record<Role, [Tab, string][]> = {
  tenant: [
    ["apartments", "Apartments"],
    ["lease", "My lease"],
    ["profile", "My profile"],
  ],
  landlord: [
    ["listings", "My listings"],
    ["lease", "Leases"],
    ["profile", "My profile"],
  ],
};

function Workspace({ role, switchRole }: { role: Role; switchRole: () => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  // a failed read is shown until reads stop failing: every tick re-reports it, so it fades out ~12s after the last failure
  const [readError, setReadError] = useState<string | null>(null);
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);
  const report = (message: string) => {
    setReadError(message);
    clearTimeout(clear.current);
    clear.current = setTimeout(() => setReadError(null), 12000);
  };
  return (
    <Tick.Provider value={tick}>
      <ReadErrors.Provider value={report}>
        <Shell role={role} switchRole={switchRole} bump={() => setTick((x) => x + 1)} readError={readError} />
      </ReadErrors.Provider>
    </Tick.Provider>
  );
}

function Shell({ role, switchRole, bump, readError }: { role: Role; switchRole: () => void; bump: () => void; readError: string | null }) {
  const me = useMe();
  const address = me?.key.toBase58() ?? null;
  const [tab, setTab] = useState<Tab>(TABS[role][0][0]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [now, setNow] = useState<number>();

  const listings = useChain(() => chain.loadListings(), []);
  const balances = useChain(() => (address ? chain.loadBalances(address) : Promise.resolve(undefined)), [address]);

  // The chain clock doubles as the reachability check.
  const tick = useContext(Tick);
  useEffect(() => {
    chain.loadNow().then(
      (n) => {
        setNow(n);
        setError((e) => (e?.startsWith("Cannot reach") ? null : e));
      },
      () => setError(`Cannot reach the network at ${RPC}. Is it running?`),
    );
  }, [tick]);

  /** Runs one transaction with a busy label, logs its explorer link, refreshes. */
  const run = async (label: string, fn: (me: chain.Me) => Promise<string | void>) => {
    if (!me) {
      setError("Connect your wallet first.");
      return false;
    }
    if (balances && balances.sol < 0.01) {
      setError(`This wallet has ${balances.sol.toFixed(3)} SOL on this network, not enough to pay fees. Fund it first (see the box at the top).`);
      return false;
    }
    setBusy(label);
    setError(null);
    try {
      const sig = await fn(me);
      if (sig) setLog((l) => [{ label, sig }, ...l]);
      bump();
      return true;
    } catch (e) {
      setError(chain.errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const h: Handlers = {
    busy,
    createListing: (f) => run("Publishing listing…", (m) => chain.createListing(m, chain.newId(), f)),
    closeListing: (l) => run("Removing listing…", (m) => chain.closeListing(m, l)),
    apply: (l) => run("Applying…", (m) => chain.applyTo(m, l)),
    closeApplication: (a) => run("Closing application…", (m) => chain.closeApplication(m, a)),
    propose: (id, l, tenant, doc: Doc, application) =>
      run("Proposing lease…", (m) => chain.proposeLease(m, id, l, tenant, doc.hash, application)),
    fund: (l, doc) =>
      run("Funding deposit…", async (m) => {
        // tidying up applications is a nicety: never let a failed lookup block accepting the lease
        const open = await chain.loadApplications({ tenant: m.key.toBase58() }).catch(() => []);
        return chain.fundDeposit(m, l, doc.hash, open.filter((a) => a.landlord === l.landlord));
      }),
    pay: (l) => run("Paying rent…", (m) => chain.payRent(m, l)),
    release: (l, deduction) => run("Releasing deposit…", (m) => chain.releaseDeposit(m, l, deduction)),
    markDefault: (l) => run("Declaring default…", (m) => chain.markDefault(m, l)),
    claim: (l) => run("Claiming deposit…", (m) => chain.claimDeposit(m, l)),
    jump: (secs) => run("Moving the clock…", () => chain.fastForward(secs)),
  };

  const needsFunds = !!address && !!balances && (balances.usdc === null || balances.sol < 0.01);
  const fundCommand = `${IS_LOCAL ? "" : `RPC=${RPC} `}make demo-setup WALLETS=${address}`;
  const connectFirst = (
    <Waiting title="Connect your wallet" text={`This window acts as a ${role}. Connect the wallet you want to use with the button at the top right.`} />
  );

  return (
    <div className="min-h-dvh">
      <div className="h-2 bg-primary" aria-hidden />
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-8 pb-16 pt-5">
        <header className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="rounded-full bg-primary px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary-foreground">
              {ROLES[role].label} window
            </span>
          </div>

          <nav role="tablist" aria-label="Sections" className="flex gap-1">
            {TABS[role].map(([t, label]) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "min-h-11 rounded-xl px-4 text-sm font-semibold transition-colors",
                  tab === t ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-secondary/50",
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Badge variant="outline">{IS_LOCAL ? "local network" : "devnet"}</Badge>
            <WalletButton balances={balances} />
            <Button variant="ghost" size="sm" title="Pick the other role in this window" onClick={switchRole}>
              <LogOut /> Switch role
            </Button>
          </div>
        </header>

        {error && (
          <p role="alert" className="rounded-xl border border-destructive/30 bg-[#f6e4df] p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {readError && !error && (
          <p role="alert" className="rounded-xl border border-destructive/30 bg-[#f6e4df] p-3 text-sm text-destructive">
            Could not read from the network: {readError}
            {/mainnet|remote|datasource/i.test(readError) && IS_LOCAL && " Restart the local chain with `make demo-chain` (it now runs offline)."}
          </p>
        )}

        {needsFunds && (
          <Card className="flex flex-col gap-2 border-accent/40 p-4 text-sm">
            <p>
              <b>This wallet needs test funds</b> ({balances!.usdc === null ? "no test-USDC account yet" : `${balances!.sol.toFixed(3)} SOL`}). Run this in the
              project folder:
            </p>
            <button
              onClick={() => navigator.clipboard?.writeText(fundCommand)}
              className="flex items-center justify-between gap-3 rounded-lg bg-secondary px-3 py-2 text-left font-mono text-xs"
              title="Copy command"
            >
              <span className="break-all">{fundCommand}</span> <Copy className="size-4 shrink-0" />
            </button>
          </Card>
        )}

        {tab === "apartments" && <Listings mode="browse" me={address} listings={listings} h={h} />}
        {tab === "listings" && (
          <Listings
            mode="mine"
            me={address}
            listings={listings}
            h={h}
            onReview={() => setTab("lease")}
          />
        )}
        {tab === "lease" &&
          (address ? (
            <LeaseTab role={role} me={address} listings={(listings ?? []).filter((l) => l.landlord === address)} now={now} h={h} log={log} goListings={() => setTab("listings")} />
          ) : (
            connectFirst
          ))}
        {tab === "profile" && (address ? <MyProfile role={role} me={address} /> : connectFirst)}
      </div>
    </div>
  );
}

