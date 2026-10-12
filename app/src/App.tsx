import { Suspense, lazy, useContext, useEffect, useRef, useState } from "react";
import { UserRound, ArrowLeftRight, Building2, ChevronDown, Copy, Home, KeyRound, LogOut } from "lucide-react";
import { AuthPage } from "@/Auth";
import { Landing } from "@/Landing";
import { Logo, useRoute } from "@/components/Brand";
import { go, hashQuery, updateHash } from "@/lib/route";
import { Gamify } from "@/gamify";
import { initials, loadAccount } from "@/lib/account";
import { EmbeddedWalletProvider, useEmbeddedWallet } from "@/auth/embedded";
import { WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import * as chain from "@/lib/chain";
import { Role } from "@/lib/chain";
import { IS_LOCAL, RPC } from "@/lib/config";
import { Doc } from "@/lib/hash";
import { ReadErrors, Tick, useChain } from "@/lib/useChain";
import { invalidateReads } from "@/lib/reads";
import { createInvite } from "@/lib/invites";
import { depositShortfall, isShortPublicBalance, type TopUpNeed } from "@/lib/holdback";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LocalWalletProvider, WalletButton, useLocalWallet, useMe } from "@/components/WalletButton";
import { Handlers, LeaseTab, LogEntry, Waiting } from "@/screens";
import { Kyc, VerifyFirst } from "@/screens/Kyc";
import { Payout, TopUp } from "@/screens/TopUp";
import { isKycRequired, needsVerification, returnAfterKyc, setReturnAfterKyc } from "@/lib/kyc";
import { Listings, MyProfile } from "@/views";

/**
 * The appraiser's page, loaded on demand.
 *
 * Lazy because it is a third party's screen: nobody renting or letting a flat will ever open it, so
 * its chunk should not be in the bundle they download. It is NOT behind a build flag — the
 * appraiser is a user of this product, signing with an account of their own, and the invitation
 * link in their e-mail has to resolve on the public build.
 */
const AppraiserPage = lazy(() => import("@/screens/Appraise").then((m) => ({ default: m.AppraiserPage })));

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
  const route = useRoute();
  const [role, setRole] = useState<Role | null>(storedRole);

  useEffect(() => {
    if (route !== "app") return;
    document.documentElement.dataset.role = role ?? "";
    document.title = role ? `${ROLES[role].label} · Relstate` : "Relstate";
  }, [role, route]);

  useEffect(() => {
    if (route === "home") {
      document.documentElement.dataset.role = "tenant";
      document.title = "Relstate · Rent with a record";
    }
    // Otherwise the appraiser's page inherits whatever title the last route left in the tab,
    // which on a fresh load is "Sign in".
    if (route === "invite") {
      document.documentElement.dataset.role = "tenant";
      document.title = "Appraise a deposit · Relstate";
    }
  }, [route]);

  // the app needs a role; without one, sign in first
  useEffect(() => {
    if (route === "app" && !role) go("signin");
  }, [route, role]);

  // The appraiser's page, before the role gate: an appraiser is neither party, has no role to pick
  // and arrives from an e-mail link with no session at all (screens/Appraise.tsx). It brings its
  // own wallet providers, because the three below are keyed on a role this visitor does not have.
  if (route === "invite")
    return (
      <Suspense fallback={null}>
        <AppraiserPage />
      </Suspense>
    );

  if (route === "signup" || route === "signin")
    return (
      <AuthPage
        key={route}
        mode={route}
        onDone={(r) => {
          storeRole(r);
          setRole(r);
          go("app");
        }}
      />
    );

  if (route !== "app" || !role) return <Landing />;

  return (
    <WalletProvider key={role} wallets={[]} autoConnect localStorageKey={`relstate.wallet.${role}`}>
      <LocalWalletProvider role={role}>
        <EmbeddedWalletProvider role={role}>
          <Workspace
            role={role}
            switchRole={() => {
              const next: Role = role === "tenant" ? "landlord" : "tenant";
              storeRole(next);
              setRole(next);
            }}
            signOut={() => {
              storeRole(null);
              setRole(null);
              go("home");
            }}
          />
        </EmbeddedWalletProvider>
      </LocalWalletProvider>
    </WalletProvider>
  );
}

type Tab = "apartments" | "listings" | "lease" | "wallet" | "identity" | "profile";
const TABS: Record<Role, [Tab, string][]> = {
  tenant: [
    ["apartments", "Apartments"],
    ["lease", "My lease"],
    ["wallet", "Add funds"],
    ["identity", "Verify"],
    ["profile", "My profile"],
  ],
  landlord: [
    ["listings", "My listings"],
    ["lease", "Leases"],
    ["wallet", "Payouts"],
    ["identity", "Verify"],
    ["profile", "My profile"],
  ],
};

/**
 * Which tab the URL asks for. `#/app?tab=wallet` is the whole of the app's screen state, so a
 * reload, a back and a pasted link all land where the user was; a fiat or KYC return naming its own
 * tab is just another caller of the same thing.
 *
 * A tab the role does not have — `apartments` after switching to landlord, or anything typed by
 * hand — falls back to the role's first tab rather than showing nothing.
 */
export const tabFromHash = (role: Role, hash = globalThis.location?.hash ?? ""): Tab => {
  const asked = hashQuery(hash).get("tab");
  return TABS[role].find(([t]) => t === asked)?.[0] ?? TABS[role][0][0];
};

function Workspace({ role, switchRole, signOut }: { role: Role; switchRole: () => void; signOut: () => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // A hidden tab polls nothing; coming back refreshes at once.
    const t = setInterval(() => {
      if (!document.hidden) setTick((x) => x + 1);
    }, 5000);
    const visible = () => {
      if (!document.hidden) setTick((x) => x + 1);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", visible);
    };
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
        <Shell role={role} switchRole={switchRole} signOut={signOut} bump={() => (invalidateReads(), setTick((x) => x + 1))} readError={readError} />
      </ReadErrors.Provider>
    </Tick.Provider>
  );
}

function Shell({
  role,
  switchRole,
  signOut,
  bump,
  readError,
}: {
  role: Role;
  switchRole: () => void;
  signOut: () => void;
  bump: () => void;
  readError: string | null;
}) {
  const me = useMe();
  const address = me?.key.toBase58() ?? null;
  // The URL owns the tab. `setTab` writes it and the listener below reads it back, so the address
  // bar can never disagree with the screen — and back, forward and reload all work for free.
  const [tab, showTab] = useState<Tab>(() => tabFromHash(role));
  const setTab = (t: Tab) => updateHash((q) => q.set("tab", t));
  useEffect(() => {
    const sync = () => showTab(tabFromHash(role));
    sync();
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, [role]);
  // The URL says nothing about the tab (a fresh `#/app`), or names one this role does not have
  // (a role switch): make it say what is on screen, without adding a history entry for a move the
  // user never made.
  useEffect(() => {
    if (hashQuery(globalThis.location?.hash ?? "").get("tab") !== tab) updateHash((q) => q.set("tab", tab), { replace: true });
  }, [tab]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // apply / propose_lease refused for want of a verified identity: a prompt, not an error
  const [needsKyc, setNeedsKyc] = useState(false);
  // set when an action sent the user to the Verify tab: the screen explains why and returns them after
  const [kycFor, setKycFor] = useState<"apply" | "propose" | null>(returnAfterKyc);
  const sendToVerify = (action: "apply" | "propose") => {
    setReturnAfterKyc(action);
    setKycFor(action);
    setNeedsKyc(false);
    setTab("identity");
  };
  // accepting a lease needs a PUBLIC deposit the wallet does not hold: sends the user to top up with it kept public
  const [topUpNeed, setTopUpNeed] = useState<TopUpNeed | null>(null);
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
    // Sponsored mode is the whole point of the backend: the wallet is expected to hold 0 SOL.
    if (!chain.SPONSORED && balances && balances.sol < 0.01) {
      setError(`This wallet has ${balances.sol.toFixed(3)} SOL on this network, not enough to pay fees. Fund it first (see the box at the top).`);
      return false;
    }
    setBusy(label);
    setError(null);
    setNeedsKyc(false);
    try {
      const sig = await fn(me);
      if (sig) setLog((l) => [{ label, sig }, ...l]);
      bump();
      return true;
    } catch (e) {
      if (isKycRequired(e)) setNeedsKyc(true);
      else setError(chain.errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const fundRun = (l: chain.LeaseView, doc: Doc) =>
    run("Funding deposit…", async (m) => {
      // tidying up applications is a nicety: never let a failed lookup block accepting the lease
      const open = await chain.loadApplications({ tenant: m.key.toBase58() }).catch(() => []);
      return chain.fundDeposit(m, l, doc.hash, open.filter((a) => a.landlord === l.landlord));
    });

  const h: Handlers = {
    busy,
    createListing: (f) => run("Publishing listing…", (m) => chain.createListing(m, chain.newId(), f)),
    closeListing: (l) => run("Removing listing…", (m) => chain.closeListing(m, l)),
    apply: async (l) => {
      if (address && (await needsVerification(address))) {
        sendToVerify("apply");
        return false;
      }
      return run("Applying…", (m) => chain.applyTo(m, l));
    },
    closeApplication: (a) => run("Closing application…", (m) => chain.closeApplication(m, a)),
    propose: async (id, l, tenant, doc: Doc, application) => {
      if (address && (await needsVerification(address))) {
        sendToVerify("propose");
        return false;
      }
      return run("Proposing lease…", (m) => chain.proposeLease(m, id, l, tenant, doc.hash, application));
    },
    fund: async (l, doc) => {
      if (address) {
        const pub = await chain.loadBalances(address).then((b) => b.usdc, () => null);
        // A null balance (no token account) or a read failure is left to the program to judge.
        if (pub !== null) {
          const shortfall = depositShortfall(pub, l.deposit);
          if (shortfall > 0) {
            setTopUpNeed({ shortfall, rent: l.rent });
            setTab("wallet");
            return false;
          }
        }
      }
      const ok = await fundRun(l, doc);
      return ok;
    },
    pay: (l) => run("Paying rent…", (m) => chain.payRent(m, l)),
    release: (l, deduction) => run("Releasing deposit…", (m) => chain.releaseDeposit(m, l, deduction)),
    markDefault: (l) => run("Declaring default…", (m) => chain.markDefault(m, l)),
    claim: (l) => run("Claiming deposit…", (m) => chain.claimDeposit(m, l)),
    acceptDeduction: (l) => run("Accepting deduction…", (m) => chain.acceptDeduction(m, l)),
    abandonDispute: (l) => run("Rejecting deduction…", (m) => chain.abandonDispute(m, l)),
    escalateToMediation: (l) => run("Going to mediation…", (m) => chain.escalateToMediation(m, l)),
    proposeAppraisers: (l, companies) => run("Sending your list…", (m) => chain.proposeAppraisers(m, l, companies)),
    pickAppraiser: (l, name) => run("Agreeing on a company…", (m) => chain.pickAppraiser(m, l, name)),
    proposeAppraiserKey: (l, wallet) => run("Putting the account forward…", (m) => chain.proposeAppraiserKey(m, l, wallet)),
    confirmAppraiserKey: (l, wallet) => run("Confirming the account…", (m) => chain.confirmAppraiserKey(m, l, wallet)),
    // Off chain, so it is not a transaction and does not go through `run`: there is no signature to
    // log, and a failure here must leave the rest of the mediation working (the program only ever
    // sees a pubkey, which can always be pasted by hand).
    inviteAppraiser: async (l, companyName, email) => {
      setBusy("Sending the invitation…");
      setError(null);
      try {
        const issued = await createInvite({ lease: l.address, companyName, email });
        bump();
        return issued;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    expireMediation: (l) => run("Ending the mediation…", (m) => chain.expireMediation(m, l)),
    finalizeDeduction: (l) => run("Finalizing deduction…", (m) => chain.finalizeDeduction(m, l)),
    jump: (secs) => run("Moving the clock…", () => chain.fastForward(secs)),
  };

  const needsFunds = !!address && !!balances && !chain.SPONSORED && (balances.usdc === null || balances.sol < 0.01);
  const fundCommand = `${IS_LOCAL ? "" : `RPC=${RPC} `}make demo-setup WALLETS=${address}`;
  const connectFirst = (
    <Waiting title="Connect your wallet" text={`This window acts as a ${role}. Connect the wallet you want to use with the button at the top right.`} />
  );

  const account = address ? loadAccount(address) : null;
  const firstName = account?.name.split(" ")[0];

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-5 sm:px-8">
          <Logo />
          <nav role="tablist" aria-label="Sections" className="hidden gap-1 md:flex">
            {TABS[role].map(([t, label]) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "relative h-16 px-3 text-sm font-medium transition-colors",
                  tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                {tab === t && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] text-muted-foreground sm:flex">
              <span className="size-1.5 rounded-full bg-success" /> {IS_LOCAL ? "localnet" : "devnet"}
            </span>
            <WalletButton balances={balances} />
            <AccountMenu role={role} name={account?.name} switchRole={switchRole} signOut={signOut} />
          </div>
        </div>
        <nav role="tablist" aria-label="Sections" className="flex gap-1 overflow-x-auto px-3 md:hidden">
          {TABS[role].map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("h-11 shrink-0 border-b-2 px-3 text-sm font-medium", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 pb-16 pt-8 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">{ROLES[role].label} dashboard</p>
            <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">
              {GREETING[tab]}
              {firstName && tab === TABS[role][0][0] ? `, ${firstName}` : ""}
            </h1>
          </div>
          <p className="max-w-md text-sm text-muted-foreground">{SUBTITLE[role][tab]}</p>
        </div>

        {error && (
          <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
            {error}
            {role === "tenant" && isShortPublicBalance(error) && (
              <Button size="sm" className="ml-3" onClick={() => (setTopUpNeed(null), setError(null), setTab("wallet"))}>
                Add funds
              </Button>
            )}
          </p>
        )}

        {needsKyc && <VerifyFirst onVerify={() => sendToVerify("apply")} onDismiss={() => setNeedsKyc(false)} />}

        {readError && !error && (
          <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-3 text-sm text-destructive">
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

        {/* workstream G: the level-up toast (any tab) and the tenant's onboarding checklist */}
        <Gamify role={role} address={address} balance={balances?.usdc ?? null} showChecklist={tab === "apartments"} />

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
            // every listing, not only this wallet's: a tenant's lease names the landlord's
            // apartment, and LeaseTab narrows to `landlord === me` for what may be proposed on
            <LeaseTab role={role} me={address} listings={listings ?? []} now={now} h={h} log={log} goListings={() => setTab("listings")} />
          ) : (
            connectFirst
          ))}
        {tab === "wallet" &&
          (role === "tenant" ? <TopUp wallet={address} onCredited={bump} need={topUpNeed} /> : <Payout wallet={address} balanceBase={balances?.usdc} />)}
        {tab === "identity" && (
          <>
            {kycFor && (
              <p role="status" className="rounded-xl border border-primary/30 bg-secondary/60 p-3 text-sm">
                {kycFor === "apply" ? "Applying to a listing needs a verified identity." : "Proposing a lease needs a verified identity."} Verify once
                here and you will go straight back.
              </p>
            )}
            <Kyc
              wallet={address}
              onVerified={() => {
                bump();
                // back to where the action started, but only if the check actually passed
                if (!kycFor || !address) return;
                void needsVerification(address).then((still) => {
                  if (still) return;
                  setReturnAfterKyc(null);
                  setKycFor(null);
                  setTab(kycFor === "apply" ? "apartments" : "lease");
                });
              }}
            />
          </>
        )}
        {tab === "profile" && (address ? <MyProfile role={role} me={address} /> : connectFirst)}
      </div>
    </div>
  );
}


const GREETING: Record<Tab, string> = {
  apartments: "Find your next home",
  listings: "Your properties",
  lease: "Leases",
  wallet: "Money in and out",
  identity: "Verify your identity",
  profile: "Your rental record",
};
const SUBTITLE: Record<Role, Partial<Record<Tab, string>>> = {
  tenant: {
    apartments: "Every landlord's record is verified on-chain. Apply in one click.",
    lease: "Accept proposals, pay rent and get your deposit back.",
    wallet: "Pay in złoty. Rent settles in rUSDC, and the amount stays private.",
    identity: "One check, reusable with every landlord. Only a level and an expiry go on chain, never your documents.",
    profile: "Written only by the protocol. Take it to any city.",
  },
  landlord: {
    listings: "Publish apartments and review applicants with a verified history.",
    lease: "Propose leases, track rent and release deposits.",
    wallet: "Cash rent out to your bank. Simulated for the demo.",
    identity: "A verified landlord is trusted faster. Required before you can propose a lease.",
    profile: "Tenants see this before they apply. Keep it clean.",
  },
};

function AccountMenu({ role, name, switchRole, signOut }: { role: Role; name?: string; switchRole: () => void; signOut: () => void }) {
  const [open, setOpen] = useState(false);
  const { disconnect } = useWallet();
  const local = useLocalWallet();
  const embedded = useEmbeddedWallet();
  // signing out drops the wallet session too, otherwise the next sign-in would skip the wallet entirely
  const leave = async () => {
    setOpen(false);
    local.set(false);
    embedded?.signOut();
    await disconnect().catch(() => {});
    try {
      localStorage.removeItem(`relstate.wallet.${role}`);
    } catch {
      /* private mode: nothing was stored */
    }
    signOut();
  };
  const other: Role = role === "tenant" ? "landlord" : "tenant";
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-11 items-center gap-1.5 rounded-xl px-1.5 hover:bg-muted"
      >
        <span className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{name ? initials(name) : <UserRound className="size-4" />}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-50 mt-2 w-64 rounded-2xl border bg-card p-2 shadow-card">
            <div className="px-3 py-2">
              <p className="font-medium">{name || "Your account"}</p>
              <p className="text-xs capitalize text-muted-foreground">{role} account</p>
            </div>
            <div className="my-1 h-px bg-border" />
            <button onClick={() => (setOpen(false), switchRole())} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-muted">
              <ArrowLeftRight className="size-4" /> Switch to {other}
            </button>
            <a href="#/" className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-muted">
              <Home className="size-4" /> Relstate home
            </a>
            <button onClick={leave} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-destructive hover:bg-danger-soft">
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
