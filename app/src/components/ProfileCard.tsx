import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DISCOUNT_PCT, RENT_HEADROOM_PCT, ProfileView, Role, goodStanding, maxDiscountRent, typicalRent } from "@/lib/chain";
import { short, usdc } from "@/lib/utils";

interface Props {
  role: Role;
  address: string;
  profile: ProfileView | null;
  /** countries of the wallet's finished leases in this role, when known */
  countries?: string[];
}

/** The on-chain track record: counters written only by the program, never by the users. */
export function ProfileCard({ role, address, profile, countries }: Props) {
  const p = profile;
  const paid = p ? p.paidOnTime + p.paidLate : 0;
  const onTime = p && paid > 0 ? Math.round((p.paidOnTime / paid) * 100) : null;
  const deducted = p && p.depositTotal > 0 ? Math.round((p.deductedTotal / p.depositTotal) * 100) : null;

  return (
    <Card className="overflow-hidden">
      <div className="bg-primary px-5 pb-5 pt-4 text-primary-foreground">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest opacity-80">
            {role === "tenant" ? "Tenant" : "Landlord"} record
          </span>
          <Badge className="bg-primary-foreground/15 text-primary-foreground">
            <ShieldCheck /> on-chain
          </Badge>
        </div>
        <p className="mt-3 font-mono text-xs opacity-75">{short(address, 6)}</p>
        <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <p className="font-serif text-5xl font-semibold leading-none">{p?.leasesCompleted ?? 0}</p>
            <p className="mt-1 text-xs opacity-80">leases completed</p>
          </div>
          {role === "tenant" && (
            <>
              <div>
                <p className="font-serif text-5xl font-semibold leading-none">{onTime === null ? "—" : `${onTime}%`}</p>
                <p className="mt-1 text-xs opacity-80">paid on time</p>
              </div>
              <div>
                <p className="font-serif text-5xl font-semibold leading-none">{typicalRent(p) ? usdc(typicalRent(p)) : "—"}</p>
                <p className="mt-1 text-xs opacity-80">typical rent, USDC</p>
              </div>
            </>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-px bg-border">
        {role === "tenant" && (
          <div className="col-span-2 bg-card px-5 py-3">
            <dd>
              {goodStanding(p) ? (
                <Badge variant="success">
                  <ShieldCheck /> {DISCOUNT_PCT}% off deposits, rent up to {usdc(maxDiscountRent(p))} USDC
                </Badge>
              ) : (
                <Badge>No deposit discount yet</Badge>
              )}
            </dd>
            <dt className="mt-1 text-xs text-muted-foreground">
              {goodStanding(p)
                ? `Clean record; the discount covers rent up to ${RENT_HEADROOM_PCT / 100}x the typical rent. Applied by the program.`
                : "Needs a finished lease with no late payment and no default."}
            </dt>
          </div>
        )}
        {(role === "tenant"
          ? [
              ["Paid on time", p?.paidOnTime ?? 0],
              ["Paid late", p?.paidLate ?? 0],
              ["Defaults", p?.defaults ?? 0],
              ["Deposit returned in full", p?.depositsReturnedFull ?? 0],
            ]
          : [
              ["Deposits returned in full", p?.depositsReturnedFull ?? 0],
              ["Tenant had to claim", p?.depositsClaimed ?? 0],
            ]
        ).map(([k, v]) => (
          <div key={k} className="bg-card px-5 py-3">
            <dd className="font-serif text-2xl font-semibold">{v}</dd>
            <dt className="text-xs text-muted-foreground">{k}</dt>
          </div>
        ))}
        <div className="col-span-2 bg-card px-5 py-3">
          <dd className="font-serif text-2xl font-semibold">
            {p ? usdc(p.deductedTotal) : 0} <span className="text-base font-normal text-muted-foreground">of {p ? usdc(p.depositTotal) : 0} USDC deducted</span>
          </dd>
          <dt className="text-xs text-muted-foreground">
            {deducted === null ? "No closed deposits yet" : `${deducted}% of deposits kept by the landlord`}
          </dt>
        </div>
        {countries && countries.length > 0 && (
          <div className="col-span-2 bg-card px-5 py-3">
            <dd className="flex flex-wrap gap-1.5">
              {countries.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </dd>
            <dt className="mt-1 text-xs text-muted-foreground">
              Finished leases in {countries.length} {countries.length === 1 ? "country" : "countries"}
            </dt>
          </div>
        )}
      </dl>
    </Card>
  );
}
