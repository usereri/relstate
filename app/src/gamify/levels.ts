/**
 * Reputation levels, derived from nothing but the on-chain `Profile` counters.
 *
 * There is no new state anywhere for this: no program account, no backend row, no local tally.
 * Every level, every requirement and every percentage below is a pure function of the counters the
 * program itself writes (`leases_completed`, `paid_on_time`, `paid_late`, `defaults`,
 * `deposits_returned_full`, `deposits_claimed`), so a level cannot be farmed off-chain and a
 * profile read from any machine shows the same level.
 *
 * A level can therefore also go *down*: a default is a counter like any other, and the ladder is
 * recomputed from scratch each time rather than remembered.
 *
 * The ladders are role-aware because the counters are. A landlord never pays rent
 * (`paid_on_time` is always 0 on a landlord profile) and a tenant is never claimed against
 * (`deposits_claimed` is always 0 on a tenant profile), so one shared ladder would be
 * meaningless for one of the two roles.
 */
import type { ProfileView, Role } from "@/lib/chain";

/** A rung asks for counters. `need: 0` means "none of these", a gate rather than a count. */
interface Rule {
  one: string;
  many: string;
  need: number;
  of: (p: ProfileView) => number;
}

interface Rung {
  name: string;
  /** one line about what the level says, shown next to the name */
  blurb: string;
  rules: Rule[];
}

/** One line of "what the next level still wants", with the counter that answers it. */
export interface Requirement {
  label: string;
  have: number;
  need: number;
  met: boolean;
  /** share of this requirement already satisfied, 0..1 */
  ratio: number;
}

export interface Standing {
  /** 0-based rung: 0 is the entry level, `top` is the last one */
  index: number;
  top: number;
  name: string;
  blurb: string;
  /** the next rung's name and blurb, or null at the top */
  next: { name: string; blurb: string } | null;
  /** every rule of the next rung, met ones included; empty at the top */
  requirements: Requirement[];
  /** 0..100 toward the next rung; 100 at the top */
  progress: number;
}

const payments = (p: ProfileView) => p.paidOnTime + p.paidLate;

const TENANT: Rung[] = [
  { name: "Newcomer", blurb: "No record yet. Your first rent payment starts it.", rules: [] },
  {
    name: "Resident",
    blurb: "Renting on Relstate, with rent paid on-chain.",
    rules: [{ one: "rent payment", many: "rent payments", need: 1, of: payments }],
  },
  {
    name: "Trusted",
    blurb: "A finished lease and a run of payments on time.",
    rules: [
      { one: "finished lease", many: "finished leases", need: 1, of: (p) => p.leasesCompleted },
      { one: "payment on time", many: "payments on time", need: 3, of: (p) => p.paidOnTime },
      { one: "default", many: "defaults", need: 0, of: (p) => p.defaults },
    ],
  },
  {
    name: "Gold",
    blurb: "Two leases, every payment on time, deposits returned whole.",
    rules: [
      { one: "finished lease", many: "finished leases", need: 2, of: (p) => p.leasesCompleted },
      { one: "payment on time", many: "payments on time", need: 6, of: (p) => p.paidOnTime },
      { one: "deposit returned in full", many: "deposits returned in full", need: 1, of: (p) => p.depositsReturnedFull },
      { one: "late payment", many: "late payments", need: 0, of: (p) => p.paidLate },
      { one: "default", many: "defaults", need: 0, of: (p) => p.defaults },
    ],
  },
];

const LANDLORD: Rung[] = [
  { name: "Newcomer", blurb: "No finished lease yet.", rules: [] },
  {
    name: "Host",
    blurb: "One lease seen through to the end.",
    rules: [{ one: "finished lease", many: "finished leases", need: 1, of: (p) => p.leasesCompleted }],
  },
  {
    name: "Trusted",
    blurb: "Deposits returned without a tenant having to claim.",
    rules: [
      { one: "finished lease", many: "finished leases", need: 2, of: (p) => p.leasesCompleted },
      { one: "deposit returned in full", many: "deposits returned in full", need: 1, of: (p) => p.depositsReturnedFull },
      { one: "deposit claimed by a tenant", many: "deposits claimed by tenants", need: 0, of: (p) => p.depositsClaimed },
    ],
  },
  {
    name: "Gold",
    blurb: "A long record of deposits returned whole.",
    rules: [
      { one: "finished lease", many: "finished leases", need: 4, of: (p) => p.leasesCompleted },
      { one: "deposit returned in full", many: "deposits returned in full", need: 3, of: (p) => p.depositsReturnedFull },
      { one: "deposit claimed by a tenant", many: "deposits claimed by tenants", need: 0, of: (p) => p.depositsClaimed },
    ],
  },
];

const LADDER: Record<Role, Rung[]> = { tenant: TENANT, landlord: LANDLORD };

/** The level names of a role, entry level first. Used by the preview page and the tests. */
export const levelNames = (role: Role) => LADDER[role].map((r) => r.name);

/** A missing profile reads as all-zero, which is a real answer: nothing has happened yet. */
const ZERO: ProfileView = {
  leasesCompleted: 0,
  paidOnTime: 0,
  paidLate: 0,
  defaults: 0,
  depositsReturnedFull: 0,
  depositsClaimed: 0,
  depositTotal: 0,
  deductedTotal: 0,
  rentPaidTotal: 0,
};

const label = (r: Rule) => (r.need === 0 ? `No ${r.many}` : `${r.need} ${r.need === 1 ? r.one : r.many}`);

const requirement = (r: Rule, p: ProfileView): Requirement => {
  const have = r.of(p);
  return r.need === 0
    ? { label: label(r), have, need: 0, met: have === 0, ratio: have === 0 ? 1 : 0 }
    : { label: label(r), have, need: r.need, met: have >= r.need, ratio: Math.min(1, have / r.need) };
};

const passes = (rung: Rung, p: ProfileView) => rung.rules.every((r) => requirement(r, p).met);

/**
 * The highest rung reached: every rung up to and including it passes.
 *
 * Defined cumulatively on purpose. Taking "the highest rung that happens to pass" would let a
 * profile skip a rung it does not satisfy, so the ladder would depend on how the rules were
 * written; this way it cannot.
 */
export function levelOf(profile: ProfileView | null, role: Role): number {
  const rungs = LADDER[role];
  const p = profile ?? ZERO;
  let reached = 0;
  for (let i = 1; i < rungs.length; i++) {
    if (!passes(rungs[i]!, p)) break;
    reached = i;
  }
  return reached;
}

/** Where this profile stands, and what the next level still asks for. */
export function standing(profile: ProfileView | null, role: Role): Standing {
  const rungs = LADDER[role];
  const p = profile ?? ZERO;
  const index = levelOf(profile, role);
  const here = rungs[index]!;
  const next = rungs[index + 1];
  if (!next) return { index, top: rungs.length - 1, name: here.name, blurb: here.blurb, next: null, requirements: [], progress: 100 };

  const requirements = next.rules.map((r) => requirement(r, p));
  const progress = requirements.reduce((sum, r) => sum + r.ratio, 0) / requirements.length;
  return {
    index,
    top: rungs.length - 1,
    name: here.name,
    blurb: here.blurb,
    next: { name: next.name, blurb: next.blurb },
    requirements,
    // never let an in-progress level read as a finished one
    progress: Math.min(99, Math.round(progress * 100)),
  };
}
