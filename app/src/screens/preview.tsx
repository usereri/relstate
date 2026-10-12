/**
 * A developer page, not a screen: `app/mediation-preview.html` on the dev server.
 *
 * It renders the **real** components — `MediationLease`, the same one the lease tab mounts, and
 * `VerdictCase` from the appraiser's own page — once per state a mediation can be in, against
 * invented leases and companies. Nothing is faked except the data: there is no chain, no wallet and
 * no backend, and the handlers are no-ops.
 *
 * It exists because the D2 program is not deployed yet, so the plan's "manual run in three windows"
 * cannot be done until it is — and because several of these states are slow or awkward to reach on
 * a live chain even then (nobody agreed in time, both key budgets spent, the appraiser went
 * silent). Reading the three roles side by side is also the only practical way to check that the
 * copy says the same thing to all of them.
 *
 * Nothing here ships in the app bundle; the entries in `vite.config.ts` are `index.html` and
 * `confidential-check.html`.
 *
 *     npm run app   →   http://localhost:5173/mediation-preview.html
 *
 * Best read at a desktop width: the real screen pins its primary action to the bottom edge on
 * narrow screens, and ten stacked copies of one screen would pin ten of them.
 */
import "@/polyfill"; // MediationLease reaches chain.ts, which needs the Buffer global. Must be first.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FlaskConical } from "lucide-react";
import { nameHashHex } from "@/lib/appraisers";
import type { LeaseInvite } from "@/lib/invites";
import * as chain from "@/lib/chain";
import type { CandidateView, DisputeView, LeaseView, Role } from "@/lib/chain";
import { MediationLease } from "@/screens";
import { VerdictCase } from "@/screens/Appraise";
import { previewHandlers } from "@/screens/preview-handlers";
import { cn } from "@/lib/utils";
import "@/index.css";

const USDC = 1_000_000;
const LANDLORD = "Demo1andlord1111111111111111111111111111111";
const TENANT = "DemoTenant22222222222222222222222222222222";
/** The account an invited company's sign-in would have created. Not a party to the lease. */
const APPRAISER_KEY = "AprA11111111111111111111111111111111111AAAA";
const OTHER_KEY = "AprB11111111111111111111111111111111111BBBB";

// Three invented firms, as the contract's §10 requires: no real appraiser's name appears, because
// using one would need their consent. "Wycena Wisła" is on both lists at different fees, which is
// how the lower-fee-wins rule shows up on screen.
const candidate = (name: string, fee: number): CandidateView => ({ name, nameHashHex: nameHashHex(name), fee });
const A = candidate("Rzeczoznawca Kazimierz", 4 * USDC);
const B = candidate("Wycena Wisła", 6 * USDC);
const B_CHEAPER = candidate("wycena wisła", 3 * USDC); // the same company, spelled differently
const C = candidate("Biuro Ekspertyz Podgórze", 5 * USDC);

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

/**
 * A fresh mediation: one deadline, nothing agreed, and `verdictDeadline: 0`.
 *
 * That zero is the point of several scenes below. It is what the chain really holds until somebody
 * is bound (§3), and the revision-1 app read it as a deadline in 1970 and rendered every one of
 * these states as "expired" (review G2).
 */
const dispute = (over: Partial<DisputeView> = {}): DisputeView => ({
  address: "Dispute11111111111111111111111111111111111111",
  lease: "Lease111111111111111111111111111111111111111",
  landlordCandidates: [],
  tenantCandidates: [],
  landlordPick: "",
  tenantPick: "",
  agreedNameHash: "",
  agreedFee: 0,
  proposedKey: "",
  keyProposer: "",
  landlordKeyProposals: 0,
  tenantKeyProposals: 0,
  appraiser: "",
  selectionDeadline: NOW + chain.SELECTION_WINDOW_SECS,
  verdictDeadline: 0,
  ...over,
});

/** Both sides have named and both have picked "Wycena Wisła", so it is agreed at the lower fee. */
const agreed = (over: Partial<DisputeView> = {}): DisputeView =>
  dispute({
    landlordCandidates: [A, B],
    tenantCandidates: [B_CHEAPER, C],
    landlordPick: B.nameHashHex,
    tenantPick: B.nameHashHex,
    agreedNameHash: B.nameHashHex,
    agreedFee: 3 * USDC,
    ...over,
  });

const h = previewHandlers();

const claimedInvite = (over: Partial<LeaseInvite> = {}): LeaseInvite => ({
  companyName: B.name,
  nameHash: B.nameHashHex,
  agreedFee: 3 * USDC,
  status: "claimed",
  wallet: APPRAISER_KEY,
  claimedAt: NOW - 30,
  expiresAt: NOW + chain.SELECTION_WINDOW_SECS,
  issuedBy: "landlord",
  ...over,
});

interface Scene {
  title: string;
  note: string;
  dispute: DisputeView;
  invite?: LeaseInvite | null;
  now?: number;
  /** Render the appraiser's own card instead of the parties' screen. */
  appraiser?: boolean;
}

/** Every state the program can put a mediation in, in the order a demo walks through them. */
const SCENES: Scene[] = [
  {
    title: "Just escalated",
    note: "The tenant's second rejection has landed. Nobody has named anyone, so there is nothing to pick. The verdict step carries no date at all, because there is no verdict deadline yet — that is the G2 regression this screen used to render as 'expired'.",
    dispute: dispute(),
  },
  {
    title: "Landlord has named two",
    note: "The landlord's list is sent and cannot be changed. Flip the role above: the landlord can only pick now, while the tenant can still send their own list AND pick from the landlord's.",
    dispute: dispute({ landlordCandidates: [A, B] }),
  },
  {
    title: "Both have named, nobody has picked",
    note: "Both lists shown as one, labelled by who named each. 'Wycena Wisła' is on both at different fees and appears once, at the lower one — that is the fee that would be agreed.",
    dispute: dispute({ landlordCandidates: [A, B], tenantCandidates: [B_CHEAPER, C] }),
  },
  {
    title: "Tenant has picked, landlord has not",
    note: "Read as the landlord: picking the same company settles it, and picking from the tenant's list is the intended move rather than a concession. Read as the tenant: you have picked and are waiting.",
    dispute: dispute({ landlordCandidates: [A, B], tenantCandidates: [B_CHEAPER, C], tenantPick: B.nameHashHex }),
  },
  {
    title: "Picks disagree",
    note: "Both have picked, neither the same one. Nothing is agreed, and the dead primary button names the other side's pick so the way out is on the button rather than left to be worked out.",
    dispute: dispute({ landlordCandidates: [A, B], tenantCandidates: [B_CHEAPER, C], landlordPick: A.nameHashHex, tenantPick: C.nameHashHex }),
  },
  {
    title: "Company agreed — invite them",
    note: "Phase 2 begins. The company and the fee are settled; what is missing is the account it signs with, which no chain can tell them. Either party e-mails the firm; nobody has put an account forward yet.",
    dispute: agreed(),
    invite: null,
  },
  {
    title: "The appraiser has claimed the invitation",
    note: "The firm opened the link and signed in, so the account is here and either party can put it forward. Note that the address is still not the headline — the company's name is.",
    dispute: agreed(),
    invite: claimedInvite(),
  },
  {
    title: "Landlord proposed the account, tenant must confirm",
    note: "The one place an address is the thing on screen. Read as the tenant: you confirm, and the copy says who proposed it. Read as the landlord: you cannot confirm your own proposal, and the screen says why that is deliberate.",
    dispute: agreed({ proposedKey: APPRAISER_KEY, keyProposer: LANDLORD, landlordKeyProposals: 1 }),
    invite: claimedInvite(),
  },
  {
    title: "Both key budgets spent",
    note: "Two proposals each, all four used (review G4: the budget is per party, so neither side could ever burn the other's). The last proposal stands and its recipient can confirm it or let the window close.",
    dispute: agreed({ proposedKey: OTHER_KEY, keyProposer: TENANT, landlordKeyProposals: 2, tenantKeyProposals: 2 }),
    invite: claimedInvite({ wallet: OTHER_KEY, issuedBy: "tenant" }),
  },
  {
    title: "Bound, waiting for the verdict",
    note: "Confirmed by both, so the verdict window starts from the binding and the appraiser has the full window. Selection is frozen.",
    dispute: agreed({
      proposedKey: APPRAISER_KEY,
      keyProposer: LANDLORD,
      landlordKeyProposals: 1,
      tenantKeyProposals: 0,
      appraiser: APPRAISER_KEY,
      selectionDeadline: NOW - 10,
      verdictDeadline: NOW + chain.VERDICT_WINDOW_SECS - 10,
    }),
  },
  {
    title: "Nobody was appointed in time",
    note: "The deadline passed with nothing bound. There is no stand-in appraiser, so the only exits are the expiry — which pays the tenant the whole deposit — and a settlement. This is the sharp edge of revision 2, said out loud on the screen.",
    dispute: dispute({ landlordCandidates: [A], tenantCandidates: [C], selectionDeadline: NOW - 5 }),
  },
  {
    title: "The appraiser went silent",
    note: "Bound, and past the verdict window with no answer. Either party ends the mediation and the deposit goes back to the tenant through the usual wait.",
    dispute: agreed({
      appraiser: APPRAISER_KEY,
      proposedKey: APPRAISER_KEY,
      keyProposer: TENANT,
      tenantKeyProposals: 1,
      selectionDeadline: NOW - 200,
      verdictDeadline: NOW - 1,
    }),
  },
  {
    title: "The appraiser's own card",
    note: "What the invited firm sees at #/invite/<token> once both parties have confirmed its account. Type a figure to see the split preview, which is the app's mirror of the contract's §6 fee rule; the submit arms only for the figure that was actually checked.",
    appraiser: true,
    dispute: agreed({
      appraiser: APPRAISER_KEY,
      proposedKey: APPRAISER_KEY,
      keyProposer: LANDLORD,
      landlordKeyProposals: 1,
      selectionDeadline: NOW - 10,
      verdictDeadline: NOW + chain.VERDICT_WINDOW_SECS - 10,
    }),
  },
];

function Preview() {
  const [role, setRole] = useState<Role>("tenant");
  const [scene, setScene] = useState(0);
  const s = SCENES[scene];

  return (
    <div className="min-h-dvh" data-role={role}>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 pb-32 pt-8 sm:px-8">
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            Developer preview of the Mediation screens. The real components, invented leases and companies, no chain, no wallet and no backend — so
            the buttons do nothing. The demo clock below each scene is the one the local network gets.
          </span>
        </p>

        <div className="flex flex-wrap gap-4">
          <div className="flex gap-1 rounded-xl bg-secondary p-1">
            {(["tenant", "landlord"] as Role[]).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                disabled={s.appraiser}
                className={cn(
                  "h-10 rounded-lg px-4 text-sm font-medium transition-colors",
                  role === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
                  s.appraiser && "opacity-40",
                )}
              >
                Reading as <span className="capitalize">{r}</span>
              </button>
            ))}
          </div>
          {s.appraiser && <p className="self-center text-sm text-muted-foreground">This scene is the appraiser's own page, which has no role.</p>}
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

        {s.appraiser ? (
          <VerdictCase
            key={scene}
            lease={lease()}
            dispute={s.dispute}
            me={s.dispute.appraiser}
            now={s.now ?? NOW}
            busy={null}
            onSubmit={async () => null}
          />
        ) : (
          <MediationLease
            key={`${scene}-${role}`}
            lease={lease()}
            dispute={s.dispute}
            now={s.now ?? NOW}
            role={role}
            h={h}
            invite={s.invite ?? null}
          />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
