import { BadgeCheck, Building2, Check, Flame, Globe2, HandCoins, Handshake, KeyRound, Lock, Percent, ShieldCheck, Sparkles, Trophy, Vault } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProfileView, Role } from "@/lib/chain";
import { cn } from "@/lib/utils";
import { BadgeId, badgesFor } from "./badges";
import { Requirement, standing } from "./levels";
import { ProgressRing } from "./ProgressRing";

/** Level marks, entry level first, matching the ladders in levels.ts. */
const MARKS: Record<Role, LucideIcon[]> = {
  tenant: [Sparkles, KeyRound, BadgeCheck, Trophy],
  landlord: [Sparkles, Building2, BadgeCheck, Trophy],
};

const BADGE_ICONS: Record<BadgeId, LucideIcon> = {
  "first-rent": HandCoins,
  "on-time-run": Flame,
  "deposit-returned": Vault,
  "cross-border": Globe2,
  discount: Percent,
  "first-lease": Handshake,
  "no-claims": ShieldCheck,
};

const RequirementRow = ({ r }: { r: Requirement }) => (
  <li className="flex items-center gap-2 text-xs">
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full",
        r.met ? "bg-success-soft text-success" : "border border-border text-muted-foreground",
      )}
    >
      {r.met && <Check className="size-2.5" strokeWidth={3.5} />}
    </span>
    <span className={cn("truncate", r.met ? "text-muted-foreground line-through" : "text-foreground")}>{r.label}</span>
    {r.need > 0 && (
      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
        {Math.min(r.have, r.need)}/{r.need}
      </span>
    )}
  </li>
);

/**
 * The reputation band inside a profile card: the level reached, what the next one wants, and the
 * badges earned. Presentational and stateless — every number comes from the counters passed in, so
 * it is as correct for a counterparty's record as it is for your own.
 */
export function ReputationPanel({ role, profile, countries = [] }: { role: Role; profile: ProfileView | null; countries?: string[] }) {
  const s = standing(profile, role);
  const Mark = MARKS[role][s.index] ?? Sparkles;
  const badges = badgesFor(role, profile, countries);
  const earned = badges.filter((b) => b.earned).length;

  return (
    <div className="flex flex-col gap-4 border-b bg-card px-5 py-4">
      <div className="flex items-center gap-4">
        <ProgressRing value={s.next ? s.progress : 100} label={s.next ? `Progress to ${s.next.name}` : "Top level reached"} className="text-primary">
          <Mark className={cn("size-6", s.index === s.top ? "text-brass" : "text-primary")} />
        </ProgressRing>
        <div className="min-w-0">
          <p className="eyebrow">
            Level {s.index + 1} of {s.top + 1}
          </p>
          <p className="font-display text-2xl font-semibold leading-tight">{s.name}</p>
          <p className="text-xs text-muted-foreground">{s.blurb}</p>
        </div>
      </div>

      {s.next ? (
        <div className="flex flex-col gap-2 rounded-xl bg-muted/60 p-3">
          <p className="text-xs text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{s.progress}%</span> of the way to{" "}
            <span className="font-medium text-foreground">{s.next.name}</span>
          </p>
          <ul className="flex flex-col gap-1.5">
            {s.requirements.map((r) => (
              <RequirementRow key={r.label} r={r} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-xl bg-brass-soft p-3 text-xs text-warning">
          <Trophy className="size-4 shrink-0" /> The top of the ladder. Every counter behind it was written by the program.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <p className="eyebrow">
          Badges · {earned} of {badges.length}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {badges.map((b) => {
            const Icon = BADGE_ICONS[b.id];
            return (
              <li
                key={b.id}
                title={b.hint}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
                  b.earned ? "bg-brass-soft text-warning" : "border border-dashed border-border text-muted-foreground",
                )}
              >
                {b.earned ? <Icon className="size-3.5" /> : <Lock className="size-3 opacity-70" />}
                {b.label}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
