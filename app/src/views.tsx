import { useEffect, useState } from "react";
import { Copy, Plus, Search, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Listing } from "@/components/Terms";
import { ProfileCard } from "@/components/ProfileCard";
import { Handlers, Waiting, statusBadge } from "@/screens";
import * as chain from "@/lib/chain";
import { LeaseView, ListingView, ProfileView, Role, typicalRent } from "@/lib/chain";
import { MAX_TEXT, USDC } from "@/lib/config";
import { useChain } from "@/lib/useChain";
import { duration, photoUrl, short, usdc } from "@/lib/utils";

const unique = (xs: string[]) => [...new Set(xs)];
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The record of each wallet in `addresses`, keyed by address. */
function useRecords(addresses: string[]) {
  return (
    useChain(
      async () => Object.fromEntries(await Promise.all(addresses.map(async (a) => [a, await chain.loadProfile(a)] as const))) as Record<string, ProfileView | null>,
      [addresses.join()],
    ) ?? {}
  );
}

export function Listings({
  mode,
  me,
  listings,
  h,
  onPropose,
}: {
  mode: "browse" | "mine";
  me: string | null;
  listings: ListingView[] | undefined;
  h: Handlers;
  onPropose?: (l: ListingView, tenant: string) => void;
}) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (listings ?? []).filter(
    (l) =>
      (mode === "browse" || l.landlord === me) && words.every((w) => `${l.title} ${l.city} ${l.blurb} ${l.region}`.toLowerCase().includes(w)),
  );
  // tenants see their own applications; landlords see the ones made to their listings
  const applications =
    useChain(
      () => (me ? chain.loadApplications(mode === "mine" ? { landlord: me } : { tenant: me }) : Promise.resolve([])),
      [me, mode],
    ) ?? [];
  const records = useRecords(unique(mode === "mine" ? applications.map((a) => a.tenant) : shown.map((l) => l.landlord)));

  if (mode === "mine" && !me)
    return <Waiting title="Connect your wallet" text="Your listings belong to your wallet. Connect it with the button at the top right." />;

  const grid = (
    <div className={mode === "mine" ? "grid gap-5 sm:grid-cols-2" : "grid gap-5 sm:grid-cols-2 xl:grid-cols-3"}>
      {shown.map((l) => {
        const rec = records[l.landlord];
        const forListing = applications.filter((a) => a.listing === l.address);
        const applied = forListing[0];
        return (
          <Listing key={l.address} l={l}>
            <div className="flex flex-col gap-3 border-t px-4 py-3">
              {mode === "browse" ? (
                <>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <UserRound className="size-3.5" />
                    <span className="font-mono">{short(l.landlord)}</span>
                    {rec ? (
                      <Badge variant="success">
                        <ShieldCheck /> {rec.leasesCompleted} completed · {count(rec.depositsReturnedFull, "deposit")} returned in full
                      </Badge>
                    ) : (
                      <Badge>new landlord</Badge>
                    )}
                  </p>
                  {!me ? (
                    <p className="text-xs text-muted-foreground">Connect a wallet to apply.</p>
                  ) : l.landlord === me ? (
                    <p className="text-xs text-muted-foreground">This is your own listing.</p>
                  ) : applied ? (
                    <Button variant="outline" disabled={!!h.busy} onClick={() => h.closeApplication(applied)}>
                      Applied · withdraw
                    </Button>
                  ) : (
                    <Button disabled={!!h.busy} onClick={() => h.apply(l)}>
                      {h.busy ?? "Apply to rent"}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Deposit {usdc(l.deposit)} USDC</span>
                    <Button size="sm" variant="outline" disabled={!!h.busy} onClick={() => h.closeListing(l)}>
                      <Trash2 /> Remove
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Applicants ({forListing.length})</p>
                    {forListing.length === 0 && <p className="text-xs text-muted-foreground">No applications yet.</p>}
                    {forListing.map((a) => (
                      <div key={a.address} className="flex flex-col gap-1.5 rounded-xl bg-secondary/50 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs">{short(a.tenant, 5)}</span>
                          <span className="flex gap-1">
                            <Button size="sm" disabled={!!h.busy} onClick={() => onPropose?.(l, a.tenant)}>
                              Propose lease
                            </Button>
                            <Button size="sm" variant="ghost" title="Dismiss" aria-label="Dismiss application" disabled={!!h.busy} onClick={() => h.closeApplication(a)}>
                              <X />
                            </Button>
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">{recordLine("tenant", records[a.tenant])}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </Listing>
        );
      })}
    </div>
  );

  const empty =
    listings && shown.length === 0 ? (
      <p className="text-sm text-muted-foreground">
        {mode === "mine" && !q ? "You have no listings yet. Add one with the form." : q ? `Nothing matches “${q}”.` : "No apartments are listed yet. Switch to a landlord window and add one."}
      </p>
    ) : null;

  if (mode === "mine")
    return (
      <div className="rise grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-3xl font-semibold">My listings</h1>
            <p className="text-sm text-muted-foreground">Tenants see these in their Apartments tab. Removing a listing returns its storage deposit to you.</p>
          </div>
          {empty}
          {grid}
        </div>
        <ListingForm h={h} />
      </div>
    );

  return (
    <div className="rise flex flex-col gap-6">
      <section className="flex flex-col gap-2 py-2 lg:py-6">
        <h1 className="max-w-5xl text-4xl font-semibold leading-[1.1] lg:text-5xl">Find a home. Bring your record with you.</h1>
        <p className="max-w-2xl text-muted-foreground">
          The deposit sits in an on-chain vault, and every payment and deduction is written to the wallet's profile by the program itself. Landlords
          here can see your record; you can see theirs.
        </p>
      </section>

      <div className="relative max-w-2xl">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-11" placeholder="Search by district, city or feature: Kraków, garden, furnished…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search apartments" />
      </div>
      {!listings && <p className="text-sm text-muted-foreground">Loading apartments…</p>}
      {empty}
      {grid}
    </div>
  );
}

function ListingForm({ h }: { h: Handlers }) {
  const blank = { title: "", city: "", region: "", blurb: "", photo: "", rent: "", deposit: "" };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const rent = Math.round(Number(f.rent) * USDC);
  const deposit = Math.round(Number(f.deposit === "" ? f.rent : f.deposit) * USDC);
  const region = f.region.toUpperCase();
  const tooLong = (["title", "city", "blurb", "photo"] as const).find((k) => bytes(f[k]) > MAX_TEXT[k]);
  const photo = photoUrl(f.photo);
  const [photoOk, setPhotoOk] = useState<boolean | null>(null); // null = not checked yet
  useEffect(() => setPhotoOk(null), [photo]);
  const ok = !!f.title.trim() && rent > 0 && deposit >= 0 && /^[A-Z]{2}$/.test(region) && !tooLong && (!photo || photoOk === true);

  const submit = async () => {
    if (await h.createListing({ rent, deposit, region, title: f.title.trim(), city: f.city.trim(), blurb: f.blurb.trim(), photo })) setF(blank);
  };

  const field = (k: keyof typeof blank, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1.5 text-sm font-semibold">
      {label}
      <Input className="font-normal" value={f[k]} onChange={set(k)} {...props} />
    </label>
  );

  return (
    <Card className="flex flex-col gap-4 p-5 lg:sticky lg:top-6">
      <h2 className="flex items-center gap-2 text-xl font-semibold">
        <Plus className="size-5" /> New listing
      </h2>
      {field("title", "Title", { placeholder: "Sunlit 1-bedroom, Kazimierz" })}
      <div className="grid grid-cols-[1fr_88px] gap-3">
        {field("city", "City", { placeholder: "Kraków" })}
        {field("region", "Country", { placeholder: "PL", maxLength: 2, className: "font-normal uppercase" })}
      </div>
      {field("blurb", "Short description", { placeholder: "Furnished · 42 m² · fibre internet" })}
      {field("photo", "Photo", { placeholder: "kazimierz.jpg, /listings/flat.jpg or https://…" })}
      {photo && (
        <div className="flex items-center gap-3 text-xs">
          <img
            key={photo}
            src={photo}
            alt=""
            className={photoOk === true ? "h-16 w-24 rounded-lg object-cover" : "hidden"}
            onLoad={() => setPhotoOk(true)}
            onError={() => setPhotoOk(false)}
          />
          {photoOk === false && <span className="text-destructive">No image at {photo}. Check the name, or clear the field.</span>}
          {photoOk === true && <span className="text-muted-foreground">Found {photo}</span>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {field("rent", "Rent, USDC / period", { inputMode: "decimal", placeholder: "850" })}
        {field("deposit", "Deposit, USDC", { inputMode: "decimal", placeholder: f.rent || "same as rent" })}
      </div>
      <p className="text-xs text-muted-foreground">
        Photo: a file name from <span className="font-mono">app/public/listings</span>, or a web address. The deposit is the standard one; the program halves it
        for tenants with a clean record.
        {tooLong && <span className="block text-destructive">The {tooLong} is too long for the chain (max {MAX_TEXT[tooLong]} bytes).</span>}
      </p>
      <Button size="lg" disabled={!ok || !!h.busy} onClick={submit}>
        {h.busy ?? "Publish listing"}
      </Button>
    </Card>
  );
}

// ---- my profile + my current and recent counterparties ------------------------------------

const recordLine = (counterparty: Role, p: ProfileView | null | undefined) => {
  if (p === undefined) return "Loading their record…";
  if (!p) return "No record yet: their first lease.";
  if (counterparty === "tenant") {
    const paid = p.paidOnTime + p.paidLate;
    return `${count(p.leasesCompleted, "lease")} completed · ${paid ? `${Math.round((p.paidOnTime / paid) * 100)}% paid on time` : "no rent paid yet"} · typical rent ${typicalRent(p) ? usdc(typicalRent(p)) : "—"} USDC`;
  }
  return `${count(p.leasesCompleted, "lease")} completed · ${count(p.depositsReturnedFull, "deposit")} returned in full · ${p.depositsClaimed} claimed by tenants`;
};

export function MyProfile({ role, me }: { role: Role; me: string }) {
  const profile = useChain(() => chain.loadProfile(me), [me]);
  const leases = useChain(() => chain.loadLeases(me, role), [me, role]);
  const other: Role = role === "landlord" ? "tenant" : "landlord";
  const records = useRecords(unique((leases ?? []).map((l) => l[other])));

  const current = (leases ?? []).filter((l) => l.status === "proposed" || l.status === "active");
  const recent = (leases ?? []).filter((l) => l.status === "closed" || l.status === "defaulted");
  const countries = unique(recent.filter((l) => l.status === "closed").map((l) => l.region)).sort();

  const rows = (title: string, items: LeaseView[], none: string) => (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      {!leases ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{none}</p>
      ) : (
        items.map((l) => (
          <Card key={l.address} className="flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                title="Copy full address"
                onClick={() => navigator.clipboard?.writeText(l[other])}
                className="flex items-center gap-2 font-mono text-sm font-medium hover:text-accent"
              >
                <UserRound className="size-4" /> {short(l[other], 6)} <Copy className="size-3.5 text-muted-foreground" />
              </button>
              {statusBadge(l.status)}
            </div>
            <p className="text-sm text-muted-foreground">{recordLine(other, records[l[other]])}</p>
            <p className="text-xs text-muted-foreground">
              {usdc(l.rent)} USDC / {duration(l.periodSecs)} · {l.paidCount}/{l.termPeriods} paid · deposit {usdc(l.deposit)} USDC · {l.region}
              {l.startTs ? ` · started ${new Date(l.startTs * 1000).toLocaleDateString()}` : " · not started"}
            </p>
          </Card>
        ))
      )}
    </section>
  );

  return (
    <div className="rise grid items-start gap-8 lg:grid-cols-[400px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3 lg:sticky lg:top-6">
        <ProfileCard role={role} address={me} profile={profile ?? null} countries={countries} />
      </div>
      <div className="flex flex-col gap-8">
        {rows(role === "landlord" ? "Current tenants" : "Current landlord", current, role === "landlord" ? "No tenant is in a lease with you right now." : "You have no lease in progress.")}
        {rows(role === "landlord" ? "Recent tenants" : "Recent landlords", recent, "Nothing finished yet.")}
      </div>
    </div>
  );
}
