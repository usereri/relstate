import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Home } from "lucide-react";
import * as chain from "@/lib/chain";
import { Role, Snapshot } from "@/lib/chain";
import { IS_LOCAL, LISTINGS, ListingData } from "@/lib/config";
import { Doc } from "@/lib/hash";
import { cn, short, usdc } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Listing } from "@/components/Terms";
import { Listings, Profiles } from "@/views";
import { AcceptLease, ActiveLease, CreateLease, Finished, Handlers, ProposedWaiting, Waiting } from "@/screens";

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, val: string | null) => {
  try {
    if (val) localStorage.setItem(key, val);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: the lease is simply forgotten on reload */
  }
};
const LEASE = "relstate.leaseId";
const LISTING_KEY = "relstate.listingId";

type Tab = "listings" | "profiles" | "lease";
const TABS: [Tab, string][] = [
  ["listings", "Apartments"],
  ["profiles", "Profiles"],
  ["lease", "My lease"],
];

interface LogEntry {
  label: string;
  sig: string;
}

export default function App() {
  const [role, setRole] = useState<Role>("landlord");
  const [tab, setTab] = useState<Tab>(() => (stored(LEASE) ? "lease" : "listings"));
  const [profileAddr, setProfileAddr] = useState(chain.actors.tenant.key.toBase58());
  const [listing, setListing] = useState<ListingData>(
    () => LISTINGS.find((l) => l.id === stored(LISTING_KEY)) ?? LISTINGS[0],
  );
  const [leaseId, setLeaseId] = useState<string | null>(() => stored(LEASE));
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const refresh = useCallback(async (id = leaseId) => {
    try {
      setSnap(await chain.loadSnapshot(id));
      setError((e) => (e?.startsWith("Cannot reach") ? null : e));
    } catch {
      setError("Cannot reach the network. Is Surfpool running and demo.json set up?");
    }
  }, [leaseId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  /** Runs one transaction with a busy label, logs its explorer link, refreshes. */
  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setError(null);
    try {
      const sig = await fn();
      if (sig) setLog((l) => [{ label, sig }, ...l]);
      await refresh();
    } catch (e) {
      setError(chain.errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const id = leaseId ?? "";
  const lease = snap?.lease ?? null;
  const h: Handlers = {
    busy,
    create: (doc: Doc, deposit) =>
      run("Creating lease…", async () => {
        const newId = chain.newLeaseId();
        const sig = await chain.createLease(newId, listing.rent, deposit, doc.hash, listing.country);
        store(LEASE, newId);
        setLeaseId(newId);
        setRole("tenant");
        return sig;
      }),
    fund: (doc) => run("Funding deposit…", () => chain.fundDeposit(id, doc.hash)),
    pay: () =>
      run("Paying rent…", async () => {
        const sig = await chain.payRent(id);
        if (lease && lease.paidCount + 1 >= lease.termPeriods) setRole("landlord");
        return sig;
      }),
    release: (deduction) => run("Releasing deposit…", () => chain.releaseDeposit(id, deduction)),
    markDefault: () => run("Declaring default…", () => chain.markDefault(id)),
    claim: () => run("Claiming deposit…", () => chain.claimDeposit(id)),
    jump: (secs) => run("Moving the clock…", () => chain.fastForward(secs)),
    next: () => {
      store(LEASE, null);
      setLeaseId(null);
      setRole("landlord");
      refresh(null);
    },
  };

  let screen: React.ReactNode;
  if (!snap) screen = <Waiting title="Connecting…" text="Reading the network." />;
  else if (!lease)
    screen =
      role === "landlord" ? (
        <CreateLease snap={snap} listing={listing} h={h} />
      ) : (
        <Waiting title="No lease yet" text="The landlord has not proposed a lease. Switch to Landlord to create one." />
      );
  else if (lease.status === "proposed")
    screen = role === "tenant" ? <AcceptLease lease={lease} h={h} /> : <ProposedWaiting />;
  else if (lease.status === "active") screen = <ActiveLease lease={lease} snap={snap} role={role} h={h} />;
  else screen = <Finished lease={lease} snap={snap} h={h} />;

  const rent = (l: ListingData) => {
    if (!leaseId) {
      setListing(l);
      store(LISTING_KEY, l.id);
    }
    setRole("landlord");
    setTab("lease");
  };

  return (
    <div
      className={cn(
        "mx-auto flex min-h-dvh max-w-4xl flex-col gap-5 px-4 pt-[max(1rem,env(safe-area-inset-top))]",
        tab === "lease" ? "pb-44" : "pb-12",
      )}
    >
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Home className="size-5" />
            </span>
            <span className="font-serif text-2xl font-semibold tracking-tight">Relstate</span>
          </div>
          <Badge variant="outline">{IS_LOCAL ? "local demo network" : "devnet"}</Badge>
        </div>

        <nav role="tablist" aria-label="Sections" className="grid grid-cols-3 gap-1 rounded-2xl bg-secondary p-1 sm:max-w-md">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "min-h-11 rounded-xl px-2 text-sm font-semibold transition-all",
                tab === t ? "bg-card shadow-sm" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-[#f6e4df] p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {tab === "listings" && (
        <Listings
          onRent={rent}
          onProfile={(addr) => {
            setProfileAddr(addr);
            setTab("profiles");
          }}
        />
      )}
      {tab === "profiles" && <Profiles key={profileAddr} initial={profileAddr} />}
      {tab === "lease" && (
        <div className="mx-auto flex w-full max-w-md flex-col gap-5">
          <div role="tablist" aria-label="Acting as" className="grid grid-cols-2 gap-1 rounded-2xl bg-secondary p-1">
            {(["landlord", "tenant"] as Role[]).map((r) => (
              <button
                key={r}
                role="tab"
                aria-selected={role === r}
                onClick={() => setRole(r)}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center rounded-xl px-2 transition-all",
                  role === r ? "bg-card shadow-sm" : "text-muted-foreground",
                )}
              >
                <span className="text-sm font-semibold capitalize">{r}</span>
                <span className="text-[11px] tabular-nums opacity-80">
                  {short(chain.actors[r].key.toBase58())} · {snap ? usdc(snap.balances[r]) : "…"} USDC
                </span>
              </button>
            ))}
          </div>

          <Listing l={listing} />

          {screen}

          {log.length > 0 && (
            <Card className="p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transactions</p>
              <ul className="flex flex-col divide-y divide-border">
                {log.map((e) => (
                  <li key={e.sig}>
                    <a
                      href={chain.explorerTx(e.sig)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-11 items-center justify-between gap-3 text-sm"
                    >
                      <span>{e.label.replace("…", "")}</span>
                      <span className="flex items-center gap-1 font-mono text-xs text-accent">
                        {short(e.sig, 5)} <ArrowUpRight className="size-3.5" />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
