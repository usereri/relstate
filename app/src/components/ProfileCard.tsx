import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProfileView, Role } from "@/lib/chain";
import { short, usdc } from "@/lib/utils";

interface Props {
  role: Role;
  address: string;
  profile: ProfileView | null;
}

/** The on-chain track record: counters written only by the program, never by the users. */
export function ProfileCard({ role, address, profile }: Props) {
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
        <div className="mt-2 flex items-end gap-6">
          <div>
            <p className="font-serif text-5xl font-semibold leading-none">{p?.leasesCompleted ?? 0}</p>
            <p className="mt-1 text-xs opacity-80">leases completed</p>
          </div>
          {role === "tenant" && (
            <div>
              <p className="font-serif text-5xl font-semibold leading-none">{onTime === null ? "—" : `${onTime}%`}</p>
              <p className="mt-1 text-xs opacity-80">paid on time</p>
            </div>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-px bg-border">
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
      </dl>
    </Card>
  );
}
