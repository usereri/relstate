import { Card } from "@/components/ui/card";
import { ListingView } from "@/lib/chain";
import { termLabel } from "@/lib/term";
import { photoUrl, short, usdc } from "@/lib/utils";

export function Listing({ l, children }: { l: ListingView; children?: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div
        className="relative h-48 bg-cover bg-center"
        style={{
          backgroundImage: `${l.photo ? `url("${photoUrl(l.photo)}"), ` : ""}linear-gradient(135deg, var(--accent) 0%, var(--primary) 55%, var(--ink) 100%)`,
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        <div className="absolute bottom-3 left-4 right-4 text-white">
          <p className="text-xs opacity-85">{[l.city, l.region].filter(Boolean).join(" · ")}</p>
          <h2 className="text-xl font-semibold leading-tight">{l.title}</h2>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">{l.blurb}</p>
        <p className="shrink-0 text-right">
          <span className="font-serif text-lg font-semibold">{usdc(l.rent)}</span>
          <span className="text-xs text-muted-foreground"> USDC / mo</span>
        </p>
      </div>
      {children}
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

/**
 * The lease terms as rows.
 *
 * The apartment comes first and by name: a two-letter country code is not what either party calls
 * the place they are signing for, and "Region: PL" was all these rows used to say about which
 * apartment this is. `where` carries the city and the country under it, so nothing is lost.
 */
export const termRows = (o: {
  rent: number;
  deposit: number;
  term: number;
  periodSecs: number;
  hashHex?: string;
  apartment?: string;
  where?: string;
  landlord?: string;
  discountPct?: number;
}): [string, string][] => [
  ...(row("Apartment", o.apartment)),
  ...(row("Where", o.where)),
  ["Rent", `${usdc(o.rent)} USDC / period`],
  ["Deposit", `${usdc(o.deposit)} USDC · held in vault${o.discountPct ? ` · −${o.discountPct}% good standing` : ""}`],
  ["Term", termLabel(o.term, o.periodSecs)],
  ...(row("Landlord", o.landlord && short(o.landlord, 5))),
  ...(row("Lease fingerprint", o.hashHex && short(o.hashHex, 8))),
];

/** One row, or none at all when there is nothing to put in it. Never a label with a blank beside it. */
const row = (label: string, value: string | undefined | false): [string, string][] =>
  value && value.trim() ? [[label, value]] : [];
