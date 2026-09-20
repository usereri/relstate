import { useEffect, useState } from "react";
import { Search, ShieldCheck, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Listing } from "@/components/Terms";
import { ProfileCard } from "@/components/ProfileCard";
import * as chain from "@/lib/chain";
import { ProfileView, Role } from "@/lib/chain";
import { LISTINGS, ListingData } from "@/lib/config";
import { short } from "@/lib/utils";

export const landlordOf = (l: ListingData) => l.landlord ?? chain.actors.landlord.key.toBase58();

// ---- landing + search -------------------------------------------------------------------

export function Listings({
  onRent,
  onProfile,
}: {
  onRent: (l: ListingData) => void;
  onProfile: (addr: string) => void;
}) {
  const [q, setQ] = useState("");
  const [records, setRecords] = useState<Record<string, ProfileView | null>>({});

  useEffect(() => {
    const load = () =>
      Promise.all(LISTINGS.map((l) => chain.loadProfile(landlordOf(l)).then((p) => [landlordOf(l), p] as const)))
        .then((rows) => setRecords(Object.fromEntries(rows)))
        .catch(() => {}); // network trouble is reported by the app-level poll
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = LISTINGS.filter((l) => words.every((w) => `${l.title} ${l.city} ${l.blurb}`.toLowerCase().includes(w)));

  return (
    <div className="rise flex flex-col gap-6">
      <section className="flex flex-col gap-2 py-4 sm:py-8">
        <h1 className="max-w-2xl text-4xl font-semibold leading-[1.1] sm:text-5xl">
          Rent with a record nobody can edit.
        </h1>
        <p className="max-w-xl text-muted-foreground">
          Deposits sit in an on-chain vault, and every payment and every deduction is written to the wallet's profile by
          the program itself. Find a place, check the landlord, then lease.
        </p>
      </section>

      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-11"
          placeholder="Search by district, city or feature: Kraków, garden, furnished…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search apartments"
        />
      </div>

      {shown.length === 0 && <p className="text-sm text-muted-foreground">No apartments match “{q}”.</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {shown.map((l) => {
          const addr = landlordOf(l);
          const rec = records[addr];
          return (
            <Listing key={l.id} l={l}>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
                <button
                  onClick={() => onProfile(addr)}
                  className="flex min-h-9 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  <UserRound className="size-3.5" />
                  <span className="font-mono">{short(addr)}</span>
                  {rec ? (
                    <Badge variant="success">
                      <ShieldCheck /> {rec.leasesCompleted} completed
                    </Badge>
                  ) : (
                    <Badge>new landlord</Badge>
                  )}
                </button>
                {l.landlord === null ? (
                  <Button size="sm" onClick={() => onRent(l)}>
                    Lease this
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">view only in demo</span>
                )}
              </div>
            </Listing>
          );
        })}
      </div>
    </div>
  );
}

// ---- profile lookup ---------------------------------------------------------------------

export function Profiles({ initial }: { initial: string }) {
  const [input, setInput] = useState(initial);
  const [addr, setAddr] = useState(initial);
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [countries, setCountries] = useState<Record<Role, string[]> | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([chain.loadProfile(addr), chain.loadCountries(addr)]).then(
        ([p, c]) => live && (setProfile(p), setCountries(c), setState("ok")),
        (e) => live && (e instanceof Error && /address|base58|key/i.test(e.message) ? setState("invalid") : undefined)
      );
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [addr]);

  const go = (a: string) => {
    setInput(a);
    setAddr(a.trim());
    setProfile(null);
    setCountries(null);
    setState("loading");
  };

  return (
    <div className="rise flex flex-col gap-4">
      <div>
        <h1 className="text-3xl font-semibold">Profiles</h1>
        <p className="text-sm text-muted-foreground">
          Look up any wallet. A wallet has one record, seen here as tenant and as landlord.
        </p>
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          go(input);
        }}
      >
        <Input
          className="font-mono text-sm"
          placeholder="Wallet address"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Wallet address"
        />
        <Button type="submit">Look up</Button>
      </form>

      <div className="flex flex-wrap gap-2">
        {(["landlord", "tenant"] as const).map((r) => (
          <Button key={r} size="sm" variant="outline" onClick={() => go(chain.actors[r].key.toBase58())}>
            <UserRound /> Demo {r} · {short(chain.actors[r].key.toBase58())}
          </Button>
        ))}
      </div>

      {state === "invalid" ? (
        <p role="alert" className="text-sm text-destructive">
          That is not a valid wallet address.
        </p>
      ) : state === "ok" && !profile ? (
        <Card className="p-5 text-sm text-muted-foreground">
          No on-chain record yet. This wallet has not taken part in a lease.
        </Card>
      ) : profile ? (
        <div className="grid gap-4 md:grid-cols-2">
          <ProfileCard role="tenant" address={addr} profile={profile} countries={countries?.tenant} />
          <ProfileCard role="landlord" address={addr} profile={profile} countries={countries?.landlord} />
        </div>
      ) : null}
    </div>
  );
}
