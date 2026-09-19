import { Card } from "@/components/ui/card";
import { LISTING } from "@/lib/config";
import { duration, short, usdc } from "@/lib/utils";

export function Listing() {
  return (
    <Card className="overflow-hidden">
      <div
        className="relative h-40 bg-cover bg-center"
        style={{
          backgroundImage: `url(${LISTING.photo}), linear-gradient(135deg, #8f5a22 0%, #6b4226 55%, #3f2616 100%)`,
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-[#2e2016]/70 via-transparent to-transparent" />
        <div className="absolute bottom-3 left-4 right-4 text-white">
          <p className="text-xs opacity-85">{LISTING.city}</p>
          <h2 className="text-xl font-semibold leading-tight">{LISTING.title}</h2>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">{LISTING.blurb}</p>
        <p className="shrink-0 text-right">
          <span className="font-serif text-lg font-semibold">{usdc(LISTING.rent)}</span>
          <span className="text-xs text-muted-foreground"> USDC / mo</span>
        </p>
      </div>
    </Card>
  );
}

/** Key/value rows for the lease terms. */
export function Terms({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="divide-y divide-border rounded-xl border bg-card/60">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const termRows = (o: {
  rent: number;
  deposit: number;
  term: number;
  periodSecs: number;
  hashHex?: string;
}): [string, string][] => [
  ["Rent", `${usdc(o.rent)} USDC / period`],
  ["Deposit", `${usdc(o.deposit)} USDC · held in vault`],
  ["Term", `${o.term} periods of ${duration(o.periodSecs)}`],
  ...(o.hashHex ? ([["Lease fingerprint", short(o.hashHex, 8)]] as [string, string][]) : []),
];
