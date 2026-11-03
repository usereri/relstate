import { describe, expect, it } from "vitest";
import idl from "@target/idl/relstate.json";
import {
  MAX_KEY_PROPOSALS_PER_PARTY,
  agreedName,
  candidates,
  canConfirmKey,
  canExpire,
  canPick,
  canProposeKey,
  canProposeNames,
  feeCap,
  feeFor,
  feeInPlay,
  feePayer,
  keyProposalsLeft,
  lapsed,
  phase,
  proposerRole,
  rejection,
  roundLabel,
  selectionOpen,
  setKey,
  step,
  timeline,
  UNSET_KEY,
  verdictOpen,
  verdictSplit,
} from "../mediation";
import type { CandidateView, DisputeView } from "../chain";

const L = "LANDLORD";
const T = "TENANT";
const parties = { landlord: L, tenant: T };
const cand = (name: string, fee = 0): CandidateView => ({ name, nameHashHex: name.toLowerCase(), fee });

const dispute = (o: Partial<DisputeView> = {}): DisputeView => ({
  address: "D",
  lease: "LEASE",
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
  selectionDeadline: 100,
  verdictDeadline: 0, // unbound: the chain holds 0 until a binding writes it
  ...o,
});
const agreed = (o: Partial<DisputeView> = {}) =>
  dispute({ landlordCandidates: [cand("Acme", 5)], tenantCandidates: [cand("ACME", 3)], landlordPick: "acme", tenantPick: "acme", agreedNameHash: "acme", agreedFee: 3, ...o });
const bound = (o: Partial<DisputeView> = {}) => agreed({ appraiser: "APP", proposedKey: "APP", keyProposer: L, verdictDeadline: 200, ...o });

describe("phase keys on the account, never on verdictDeadline (review G2)", () => {
  it("a fresh mediation (verdictDeadline 0) is 'names', not expired", () => {
    expect(phase(dispute())).toBe("names");
    expect(canExpire(dispute(), 50)).toBe(false);
    expect(lapsed(dispute(), 50)).toBe(false);
  });
  it("names -> wallet -> bound", () => {
    expect(phase(agreed())).toBe("wallet");
    expect(phase(bound())).toBe("bound");
  });
});

describe("the one selection deadline", () => {
  it("unbound: selection open and expiry are exact complements at the boundary", () => {
    const d = dispute();
    for (let now = 0; now <= 110; now++) expect(selectionOpen(d, now) !== canExpire(d, now), `now=${now}`).toBe(true);
    expect(selectionOpen(d, 99)).toBe(true);
    expect(selectionOpen(d, 100)).toBe(false);
    expect(lapsed(d, 100)).toBe(true);
  });
  it("bound: selection is closed and expiry/verdict are exact complements at the verdict deadline", () => {
    const d = bound({ selectionDeadline: 100, verdictDeadline: 200 });
    expect(selectionOpen(d, 50)).toBe(false);
    for (let now = 0; now <= 210; now++) expect(verdictOpen(d, now) !== canExpire(d, now), `now=${now}`).toBe(true);
  });
});

describe("rounds", () => {
  it("rejection at maxRounds=2", () => {
    expect(rejection(0, 2)).toBe("abandon");
    expect(rejection(1, 2)).toBe("escalate");
    expect(rejection(2, 2)).toBe("exhausted");
    expect(roundLabel(5, 2)).toBe("Round 2 of 2");
  });
});

describe("candidates", () => {
  it("lists the union keyed by name hash, with the lower fee and both proposers", () => {
    const rows = candidates(dispute({ landlordCandidates: [cand("Acme", 5), cand("Beta", 1)], tenantCandidates: [cand("Acme", 3)] }));
    expect(rows.map((r) => r.name)).toEqual(["Acme", "Beta"]);
    expect(rows[0]).toMatchObject({ fee: 3, proposedBy: ["landlord", "tenant"] });
  });
  it("marks picks and the agreed row, and ignores the unset pick", () => {
    const rows = candidates(dispute({ landlordCandidates: [cand("Acme")], landlordPick: "acme", agreedNameHash: "" }));
    expect(rows[0]).toMatchObject({ landlordPicked: true, tenantPicked: false, agreed: false });
    expect(candidates(agreed())[0].agreed).toBe(true);
    expect(agreedName(agreed())).toBe("Acme");
    expect(agreedName(dispute())).toBe("");
  });
});

describe("phase 1 gates", () => {
  it("propose once per side, only while open and before agreement", () => {
    expect(canProposeNames(dispute(), "landlord", 50)).toBe(true);
    expect(canProposeNames(dispute({ landlordCandidates: [cand("A")] }), "landlord", 50)).toBe(false);
    expect(canProposeNames(dispute({ landlordCandidates: [cand("A")] }), "tenant", 50)).toBe(true);
    expect(canProposeNames(dispute(), "landlord", 100)).toBe(false);
    expect(canProposeNames(agreed(), "tenant", 50)).toBe(false);
  });
  it("a side with nothing proposed may still pick; the only candidate being your own pick does not count", () => {
    const d = dispute({ tenantCandidates: [cand("A")] });
    expect(canPick(d, "landlord", 50)).toBe(true);
    expect(canPick({ ...d, landlordPick: "a" }, "landlord", 50)).toBe(false);
    expect(canPick(d, "landlord", 100)).toBe(false);
    expect(canPick(agreed(), "landlord", 50)).toBe(false);
  });
});

describe("phase 2: the account", () => {
  it("per-party budget comes from the IDL and is tracked per side (G4)", () => {
    expect(MAX_KEY_PROPOSALS_PER_PARTY).toBe(Number(idl.constants.find((c) => c.name === "MAX_KEY_PROPOSALS_PER_PARTY")!.value));
    const d = agreed({ landlordKeyProposals: MAX_KEY_PROPOSALS_PER_PARTY });
    expect(keyProposalsLeft(d, "landlord")).toBe(0);
    expect(keyProposalsLeft(d, "tenant")).toBe(MAX_KEY_PROPOSALS_PER_PARTY);
    expect(canProposeKey(d, "landlord", 50)).toBe(false);
    expect(canProposeKey(d, "tenant", 50)).toBe(true);
  });
  it("no proposal before the name is agreed, after the deadline or once bound", () => {
    expect(canProposeKey(dispute(), "landlord", 50)).toBe(false);
    expect(canProposeKey(agreed(), "landlord", 100)).toBe(false);
    expect(canProposeKey(bound(), "landlord", 50)).toBe(false);
  });
  it("only the party that did not propose may confirm", () => {
    const d = agreed({ proposedKey: "W", keyProposer: L });
    expect(proposerRole(d, parties)).toBe("landlord");
    expect(canConfirmKey(d, parties, "landlord", 50)).toBe(false);
    expect(canConfirmKey(d, parties, "tenant", 50)).toBe(true);
    expect(canConfirmKey(d, parties, "tenant", 100)).toBe(false);
    expect(canConfirmKey(agreed(), parties, "tenant", 50)).toBe(false);
  });
});

describe("step", () => {
  it("walks propose-names -> pick -> waiting", () => {
    expect(step(dispute(), parties, "landlord", 50)).toBe("propose-names");
    const d = dispute({ tenantCandidates: [cand("A")] });
    expect(step(d, parties, "landlord", 50)).toBe("pick");
    expect(step({ ...d, landlordPick: "a" }, parties, "landlord", 50)).toBe("waiting");
  });
  it("invite -> confirm-key / waiting -> bound, lapsed after the deadline", () => {
    expect(step(agreed(), parties, "landlord", 50)).toBe("invite");
    const p = agreed({ proposedKey: "W", keyProposer: L });
    expect(step(p, parties, "tenant", 50)).toBe("confirm-key");
    expect(step(p, parties, "landlord", 50)).toBe("waiting");
    expect(step(bound(), parties, "tenant", 150)).toBe("bound");
    expect(step(dispute(), parties, "tenant", 100)).toBe("lapsed");
  });
});

describe("fee and split", () => {
  it("feeCap / feeFor / feeInPlay", () => {
    expect(feeCap(105, 10)).toBe(10);
    expect(feeFor(100, 50, 10)).toBe(10);
    expect(feeFor(1000, 5, 10)).toBe(5);
    expect(feeInPlay(agreed())).toBe(3);
    expect(feeInPlay(dispute({ landlordCandidates: [cand("A", 2), cand("B", 7)] }))).toBe(7);
    expect(feeInPlay(dispute())).toBe(0);
  });
  it("the tie is the tenant's win", () => {
    expect(feePayer(100, 50)).toBe("landlord");
    expect(feePayer(100, 51)).toBe("tenant");
    expect(verdictSplit(100, 50, 10)).toEqual({ toTenant: 50, toLandlord: 40, feePaid: 10 });
  });
  it("conserves the deposit over a grid", () => {
    for (const deposit of [0, 1, 7, 10, 99, 100, 1000]) {
      const cap = Math.floor(deposit / 10);
      for (let d = 0; d <= deposit; d += Math.max(1, Math.floor(deposit / 5))) {
        for (let fee = 0; fee <= cap; fee += Math.max(1, Math.floor(cap / 3))) {
          const s = verdictSplit(deposit, d, fee);
          expect(s.toTenant + s.toLandlord + s.feePaid, `${deposit}/${d}/${fee}`).toBe(deposit);
          expect(Math.min(s.toTenant, s.toLandlord, s.feePaid)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("timeline", () => {
  const key = (t: ReturnType<typeof timeline>, k: string) => t.find((s) => s.key === k)!;
  it("a fresh mediation has a single dated deadline and no verdict date", () => {
    const t = timeline(dispute(), 10, 20);
    expect(t.map((s) => s.key)).toEqual(["opened", "company", "wallet", "verdict"]);
    expect(key(t, "company")).toMatchObject({ at: 100, state: "now" });
    expect(key(t, "verdict")).toMatchObject({ at: 0, state: "later" });
  });
  it("company agreed: the account step is live", () => {
    const t = timeline(agreed(), 10, 20);
    expect(key(t, "company").state).toBe("done");
    expect(key(t, "wallet")).toMatchObject({ at: 100, state: "now" });
  });
  it("bound: verdict step carries the verdict deadline, then closes", () => {
    expect(key(timeline(bound(), 10, 150), "verdict")).toMatchObject({ at: 200, state: "now" });
    expect(key(timeline(bound(), 10, 200), "verdict").state).toBe("done");
  });
  it("lapsed with nothing bound", () => {
    const t = timeline(dispute(), 10, 100);
    expect(key(t, "company")).toMatchObject({ state: "done", at: 100 });
    expect(key(t, "verdict")).toMatchObject({ at: 0, state: "done" });
  });
});

describe("setKey", () => {
  it("maps the all-zero key to ''", () => {
    expect(setKey(UNSET_KEY)).toBe("");
    expect(setKey("Real")).toBe("Real");
  });
});
