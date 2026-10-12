/**
 * A developer page, not a screen: `app/mediation-preview.html` on the dev server.
 *
 * It renders the **real** `MediationLease` — the same component the lease tab mounts — once per
 * phase of a mediation, against invented leases, disputes and appraisers. Nothing is faked except
 * the data: there is no chain, no wallet and no backend, and the handlers are no-ops.
 *
 * It exists because the D2 program is not deployed yet, so the plan's "manual run in two windows"
 * cannot be done until it is, and until then this is the only way to see every state of this
 * screen — including the ones a live run is slow to reach (nobody agreed in time, the appraiser
 * went silent) and the ones it cannot reach at all without a registry (`/api/appraisers` and
 * `scripts/setup-appraisers.ts` are the backend workstream's).
 *
 * Nothing here ships in the app bundle; the entries in `vite.config.ts` are `index.html` and
 * `confidential-check.html`.
 *
 *     npm run app   →   http://localhost:5173/mediation-preview.html
 *
 * Best read at a desktop width: the real screen pins its primary action to the bottom edge on
 * narrow screens, and eight stacked copies of one screen would pin eight of them.
 */
import "@/polyfill"; // MediationLease reaches chain.ts, which needs the Buffer global. Must be first.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FlaskConical } from "lucide-react";
import { nameHash, type AppraiserOption } from "@/lib/appraisers";
import * as chain from "@/lib/chain";
import type { DisputeView, LeaseView, Role } from "@/lib/chain";
import { MediationLease } from "@/screens";
import type { Handlers } from "@/screens";
import { cn } from "@/lib/utils";
import "@/index.css";

const USDC = 1_000_000;
const LANDLORD = "Demo1andlord1111111111111111111111111111111";
const TENANT = "DemoTenant22222222222222222222222222222222";

// Three invented firms, as the contract's §10 requires: no real appraiser's name appears, because
// using one would need their consent. Two carry the name the registry committed to, so the picker
// shows them as verified; "Rzeczoznawca C" deliberately does not, which is how a directory that
// disagrees with the chain looks.
// The fake keys end in distinct characters on purpose: the screen shortens them to head…tail, so
// placeholders that differed only in the middle would all render as the same string.
const appraiser = (name: string, wallet: string, over: Partial<AppraiserOption> = {}): AppraiserOption => ({
  address: `Pda${wallet.slice(3)}`,
  wallet,
  name,
  nameVerified: true,
  active: true,
  isDefault: false,
  fee: 4 * USDC,
  ...over,
});

const A = appraiser("Rzeczoznawca A", "AprA11111111111111111111111111111111111AAAA");
const B = appraiser("Rzeczoznawca B", "AprB11111111111111111111111111111111111BBBB", { fee: 6 * USDC });
const C = appraiser("Rzeczoznawca C", "AprC11111111111111111111111111111111111CCCC", { nameVerified: false, fee: 3 * USDC });
const PLATFORM = appraiser("Relstate fallback appraiser", "Fall11111111111111111111111111111111back", { isDefault: true, fee: 5 * USDC });
const SUSPENDED = appraiser("Rzeczoznawca D", "AprD11111111111111111111111111111111111DDDD", { active: false });
const OPTIONS = [A, B, C, PLATFORM, SUSPENDED];

// Proof that the verified tick means something: these are the hashes `register_appraiser` would
// have been given, and the real screen compares them itself.
if (typeof console !== "undefined") console.log("name hashes the registry would hold:", Object.fromEntries([A, B, C].map((o) => [o.name, nameHash(o.name)])));

const NOW = 1_760_000_000;

const lease = (over: Partial<LeaseView> = {}): LeaseView => ({
  address: "Lease111111111111111111111111111111111111111",
  id: "42",
  landlord: LANDLORD,
  tenant: TENANT,
  mint: "Gco8ivBzZTq9U4iBLEApWxy8bcHbtenNP6crmYQcPCXH",
  rent: 2_500 * USDC,
  deposit: 5_000 * USDC,
  startTs: NOW - 90 * 86_400,
  termPeriods: 3,
  paidCount: 3,
  periodSecs: 30 * 86_400,
  graceSecs: 3 * 86_400,
  hashHex: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  region: "PL",
  discountPct: 0,
  status: "mediation",
  proposedDeduction: 0,
  disputedAt: NOW - 20,
  claimPauseSecs: 120,
  disputeRounds: chain.MAX_DISPUTE_ROUNDS,
  ...over,
});

const dispute = (over: Partial<DisputeView> = {}): DisputeView => ({
  address: "Dispute11111111111111111111111111111111111111",
  lease: "Lease111111111111111111111111111111111111111",
  landlordCandidates: [],
  tenantCandidates: [],
  landlordPick: "",
  tenantPick: "",
  appraiser: "",
  selectionDeadline: NOW + chain.SELECTION_WINDOW_SECS,
  verdictDeadline: NOW + chain.SELECTION_WINDOW_SECS + chain.VERDICT_WINDOW_SECS,
  ...over,
});

const no = async () => false;
const h: Handlers = {
  busy: null,
  createListing: no,
  closeListing: no,
  apply: no,
  closeApplication: no,
  propose: no,
  fund: no,
  pay: no,
  release: no,
  markDefault: no,
  claim: no,
  acceptDeduction: no,
  abandonDispute: no,
  escalateToMediation: no,
  proposeAppraisers: no,
  pickAppraiser: no,
  bindDefaultAppraiser: no,
  expireMediation: no,
  finalizeDeduction: no,
  jump: no,
};

/** Every phase the program can put a mediation in, in the order a demo walks through them. */
const SCENES: { title: string; note: string; dispute: DisputeView; now?: number }[] = [
  {
    title: "Just escalated",
    note: "The tenant's second rejection has landed. Neither side has named anyone, so there is nothing to pick yet.",
    dispute: dispute(),
  },
  {
    title: "Landlord has named three",
    note: "The landlord has named three and cannot change them; the tenant has named nobody. Flip the role above: the landlord can only pick now, while the tenant can still name their own AND pick from the landlord's list.",
    dispute: dispute({ landlordCandidates: [A.wallet, B.wallet, C.wallet] }),
  },
  {
    title: "Both have named, nobody has picked",
    note: "Both lists shown as one, labelled by who named each. Rzeczoznawca B is on both, which is how the two converge.",
    dispute: dispute({ landlordCandidates: [A.wallet, B.wallet], tenantCandidates: [B.wallet, C.wallet] }),
  },
  {
    title: "Tenant has picked, landlord has not",
    note: "Read as the landlord: picking the same name binds it, and picking from the tenant's list is the intended move rather than a concession. Read as the tenant: you have picked and are waiting.",
    dispute: dispute({ landlordCandidates: [A.wallet, B.wallet], tenantCandidates: [B.wallet, C.wallet], tenantPick: B.wallet }),
  },
  {
    title: "Picks disagree",
    note: "Both have picked, neither the same one. Nothing is bound, and the dead primary button names the other side's pick so the way out is on the button rather than left to be worked out.",
    dispute: dispute({ landlordCandidates: [A.wallet, B.wallet], tenantCandidates: [B.wallet, C.wallet], landlordPick: A.wallet, tenantPick: C.wallet }),
  },
  {
    title: "Selection window over, nothing bound",
    note: "The two can still agree between themselves, and now ANYONE can bind the registry's fallback. This is the exit that makes a deadlock impossible.",
    dispute: dispute({
      landlordCandidates: [A.wallet],
      tenantCandidates: [C.wallet],
      selectionDeadline: NOW - 5,
      verdictDeadline: NOW + chain.VERDICT_WINDOW_SECS,
    }),
  },
  {
    title: "Bound by agreement",
    note: "Both picked Rzeczoznawca B, so the program bound them and re-based the verdict window on the binding.",
    dispute: dispute({
      landlordCandidates: [A.wallet, B.wallet],
      tenantCandidates: [B.wallet],
      landlordPick: B.wallet,
      tenantPick: B.wallet,
      appraiser: B.wallet,
      selectionDeadline: NOW - 10,
      verdictDeadline: NOW + chain.VERDICT_WINDOW_SECS - 10,
    }),
  },
  {
    title: "Bound by fallback",
    note: "Nobody agreed in time, so the admin-designated fallback was bound. The screen says who chose them, because neither party did.",
    dispute: dispute({
      landlordCandidates: [A.wallet],
      appraiser: PLATFORM.wallet,
      selectionDeadline: NOW - 40,
      verdictDeadline: NOW + chain.VERDICT_WINDOW_SECS - 40,
    }),
  },
  {
    title: "Appraiser went silent",
    note: "Past the verdict window with no verdict. Either party ends the mediation: the lease returns to active and the deposit goes back to the tenant through the usual claim.",
    dispute: dispute({
      landlordCandidates: [B.wallet],
      tenantCandidates: [B.wallet],
      landlordPick: B.wallet,
      tenantPick: B.wallet,
      appraiser: B.wallet,
      selectionDeadline: NOW - 200,
      verdictDeadline: NOW - 1,
    }),
  },
  {
    title: "Empty registry",
    note: "No appraiser has been registered on this network yet. The screen says so instead of offering an empty picker, and the expiry exit still ends it.",
    dispute: dispute(),
  },
];

function Preview() {
  const [role, setRole] = useState<Role>("tenant");
  const [scene, setScene] = useState(0);
  const s = SCENES[scene];
  const empty = s.title === "Empty registry";

  return (
    <div className="min-h-dvh" data-role={role}>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 pb-32 pt-8 sm:px-8">
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            Developer preview of the Mediation screen. The real component, invented leases and appraisers, no chain and no wallet — so the buttons do
            nothing. The demo clock below each scene is the one the local network gets.
          </span>
        </p>

        <div className="flex flex-wrap gap-4">
          <div className="flex gap-1 rounded-xl bg-secondary p-1">
            {(["tenant", "landlord"] as Role[]).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={cn("h-10 rounded-lg px-4 text-sm font-medium transition-colors", role === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
              >
                Reading as <span className="capitalize">{r}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SCENES.map((x, i) => (
            <button
              key={x.title}
              onClick={() => setScene(i)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs transition-colors",
                i === scene ? "border-primary bg-secondary font-medium text-foreground" : "border-input text-muted-foreground hover:bg-secondary/50",
              )}
            >
              {i + 1}. {x.title}
            </button>
          ))}
        </div>

        <p className="rounded-xl bg-secondary/60 p-3 text-sm text-muted-foreground">{s.note}</p>

        <MediationLease
          key={`${scene}-${role}`}
          lease={lease()}
          dispute={s.dispute}
          now={s.now ?? NOW}
          role={role}
          h={h}
          options={empty ? [] : OPTIONS}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
