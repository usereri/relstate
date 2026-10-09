/**
 * A developer page, not a screen: `app/gamify-preview.html` on the dev server.
 *
 * It renders the gamification pieces against **invented** profiles so every level, badge and
 * checklist state can be seen and screenshotted without playing out months of leases on a chain.
 * Nothing here is wired to the network, and nothing here ships in the app bundle — the only entries
 * in `vite.config.ts` are `index.html` and `confidential-check.html`.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FlaskConical } from "lucide-react";
import { ProfileCard } from "@/components/ProfileCard";
import type { ProfileView, Role } from "@/lib/chain";
import { cn } from "@/lib/utils";
import { ChecklistCard } from "./OnboardingChecklist";
import { LevelUpToast } from "./LevelUpToast";
import { checklist } from "./checklist";
import { levelNames, standing } from "./levels";
import "@/index.css";

const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  leasesCompleted: 0,
  paidOnTime: 0,
  paidLate: 0,
  defaults: 0,
  depositsReturnedFull: 0,
  depositsClaimed: 0,
  depositTotal: 0,
  deductedTotal: 0,
  rentPaidTotal: 0,
  ...over,
});

/** One invented profile per rung, chosen to land exactly on that level. */
const FAKES: Record<Role, { profile: ProfileView | null; countries: string[]; address: string }[]> = {
  tenant: [
    { profile: null, countries: [], address: "New11111111111111111111111111111111111111111" },
    { profile: profile({ paidOnTime: 1, rentPaidTotal: 850_000_000 }), countries: [], address: "Res22222222222222222222222222222222222222222" },
    {
      profile: profile({ leasesCompleted: 1, paidOnTime: 3, depositsReturnedFull: 1, depositTotal: 850_000_000, rentPaidTotal: 2_550_000_000 }),
      countries: ["PL"],
      address: "Tru33333333333333333333333333333333333333333",
    },
    {
      profile: profile({ leasesCompleted: 2, paidOnTime: 7, depositsReturnedFull: 2, depositTotal: 1_700_000_000, rentPaidTotal: 5_950_000_000 }),
      countries: ["DE", "PL"],
      address: "Gld44444444444444444444444444444444444444444",
    },
  ],
  landlord: [
    { profile: null, countries: [], address: "LNew1111111111111111111111111111111111111111" },
    { profile: profile({ leasesCompleted: 1, depositTotal: 850_000_000, deductedTotal: 120_000_000 }), countries: ["PL"], address: "LHst2222222222222222222222222222222222222222" },
    {
      profile: profile({ leasesCompleted: 2, depositsReturnedFull: 2, depositTotal: 1_700_000_000 }),
      countries: ["PL"],
      address: "LTru3333333333333333333333333333333333333333",
    },
    {
      profile: profile({ leasesCompleted: 5, depositsReturnedFull: 4, depositTotal: 4_250_000_000, deductedTotal: 95_000_000 }),
      countries: ["ES", "PL"],
      address: "LGld4444444444444444444444444444444444444444",
    },
  ],
};

const CHECKLISTS: [string, ReturnType<typeof checklist>][] = [
  ["Nothing done yet", checklist({ signedIn: false, balance: null, applied: false, rentPaid: false })],
  ["Signed in, no funds", checklist({ signedIn: true, balance: null, applied: false, rentPaid: false })],
  ["Topped up, applied", checklist({ signedIn: true, balance: 1_200_000_000, applied: true, rentPaid: false })],
  ["KYC landed (workstream D)", checklist({ signedIn: true, balance: 1_200_000_000, applied: true, rentPaid: false, identity: "done" })],
];

function Preview() {
  const [role, setRole] = useState<Role>("tenant");
  const [toast, setToast] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.role = role;
  }, [role]);

  const rungs = FAKES[role];
  const names = levelNames(role);

  return (
    <div className="min-h-dvh pb-20">
      <header className="sticky top-0 z-30 border-b border-warning/30 bg-warning-soft">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-warning">
            <FlaskConical className="size-4" /> Gamification preview · invented profiles, not chain data
          </p>
          <div className="flex gap-1 rounded-xl bg-card p-1">
            {(["tenant", "landlord"] as Role[]).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={cn("h-8 rounded-lg px-3 text-sm font-medium capitalize", role === r ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
              >
                {r}
              </button>
            ))}
          </div>
          <button onClick={() => setToast((n) => n + 1)} className="h-8 rounded-lg border bg-card px-3 text-sm font-medium">
            Replay level-up
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1600px] flex-col gap-10 px-6 py-8">
        <section className="flex flex-col gap-4">
          <h1 className="font-display text-2xl font-semibold">Levels · {role}</h1>
          <div className="grid items-start gap-6 lg:grid-cols-2 2xl:grid-cols-4">
            {rungs.map((f, i) => (
              <div key={f.address} className="flex flex-col gap-2">
                <p className="eyebrow">
                  {i + 1}. {names[i]}
                </p>
                <ProfileCard role={role} address={f.address} profile={f.profile} countries={f.countries} />
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h1 className="font-display text-2xl font-semibold">Onboarding checklist</h1>
          <div className="grid items-start gap-6 lg:grid-cols-2 2xl:grid-cols-4">
            {CHECKLISTS.map(([label, steps]) => (
              <div key={label} className="flex flex-col gap-2">
                <p className="eyebrow">{label}</p>
                <ChecklistCard steps={steps} />
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* onDismiss does nothing on purpose: the toast stays put for a screenshot */}
      <LevelUpToast
        key={toast}
        celebration={{ kind: "level-up", title: `${names[2]} unlocked`, detail: "Rent paid on time · Lease completed" }}
        standing={standing(rungs[2]!.profile, role)}
        onDismiss={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
