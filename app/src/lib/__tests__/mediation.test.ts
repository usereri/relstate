import { describe, expect, it } from "vitest";
import {
  candidates,
  canBindDefault,
  canExpire,
  canPick,
  canPropose,
  feeCap,
  feeFor,
  phase,
  rejection,
  roundLabel,
  setKey,
  step,
  timeline,
  topFee,
  UNSET_KEY,
  verdictSplit,
} from "../mediation";
import type { DisputeView } from "../chain";

const dispute = (overrides: Partial<DisputeView> = {}): DisputeView => ({
  address: "DISPUTE",
  lease: "LEASE",
  landlordCandidates: [],
  tenantCandidates: [],
  landlordPick: "",
  tenantPick: "",
  appraiser: "",
  selectionDeadline: 100,
  verdictDeadline: 200,
  ...overrides,
});

describe("verdictSplit", () => {
  it("the tie (2d == deposit) is the tenant's win, so the landlord pays", () => {
    // deposit=100, deduction=50: 2*50 == 100, so this must take the tenant-won branch.
    const s = verdictSplit(100, 50, 10);
    expect(s.toLandlord).toBe(40); // 50 - min(10,50)
    expect(s.feePaid).toBe(10);
    expect(s.toTenant + s.toLandlord + s.feePaid).toBe(100);
  });

  it("d == deposit (total landlord win): the refund is zero, so feePaid clamps to 0", () => {
    const s = verdictSplit(100, 100, 10);
    expect(s).toEqual({ toTenant: 0, toLandlord: 100, feePaid: 0 });
  });

  it("d == 0 (total tenant win): the tenant still pays the whole fee, the known limitation", () => {
    const s = verdictSplit(100, 0, 10);
    expect(s).toEqual({ toTenant: 90, toLandlord: 0, feePaid: 10 });
  });

  it("fee == 0: nobody pays a fee in either branch", () => {
    const landlordWon = verdictSplit(100, 90, 0);
    expect(landlordWon).toEqual({ toTenant: 10, toLandlord: 90, feePaid: 0 });
    const tenantWon = verdictSplit(100, 10, 0);
    expect(tenantWon).toEqual({ toTenant: 90, toLandlord: 10, feePaid: 0 });
  });

  it("a fee larger than the loser's share clamps in the landlord-won branch", () => {
    // deposit=100, d=90 (landlord won): refund is only 10, fee of 50 cannot all be taken.
    const s = verdictSplit(100, 90, 50);
    expect(s.feePaid).toBe(10);
    expect(s.toTenant).toBe(0);
    expect(s.toLandlord).toBe(90);
    expect(s.toTenant + s.toLandlord + s.feePaid).toBe(100);
  });

  it("a fee larger than the loser's share spills onto the tenant in the tenant-won branch", () => {
    // deposit=100, d=10 (tenant won): landlord's share is only 10, fee of 50 spills the rest onto the tenant.
    const s = verdictSplit(100, 10, 50);
    expect(s.feePaid).toBe(50);
    expect(s.toLandlord).toBe(0); // 10 - min(50,10)
    expect(s.toTenant).toBe(50); // 100 - 10 - (50 - 10)
    expect(s.toTenant + s.toLandlord + s.feePaid).toBe(100);
  });

  it("holds the conservation invariant and never goes negative over a grid of (deposit, deduction, fee)", () => {
    const deposits = [0, 1, 2, 3, 7, 10, 11, 99, 100, 101, 1_000];
    for (const deposit of deposits) {
      const cap = Math.floor(deposit / 10);
      for (let d = 0; d <= deposit; d += Math.max(1, Math.floor(deposit / 5)) || 1) {
        for (let fee = 0; fee <= cap; fee += Math.max(1, Math.floor(cap / 3)) || 1) {
          const s = verdictSplit(deposit, d, fee);
          expect(s.toTenant + s.toLandlord + s.feePaid, `deposit=${deposit} d=${d} fee=${fee}`).toBe(deposit);
          expect(s.toTenant).toBeGreaterThanOrEqual(0);
          expect(s.toLandlord).toBeGreaterThanOrEqual(0);
          expect(s.feePaid).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("feeCap / feeFor", () => {
  it("feeCap is integer division", () => {
    expect(feeCap(100, 10)).toBe(10);
    expect(feeCap(105, 10)).toBe(10);
    expect(feeCap(9, 10)).toBe(0);
  });

  it("feeFor caps the registry fee at the per-lease cap", () => {
    expect(feeFor(100, 50, 10)).toBe(10); // registry fee (50) is above the cap (10)
  });

  it("feeFor passes the registry fee through when it is under the cap", () => {
    expect(feeFor(1_000, 5, 10)).toBe(5); // cap is 100, registry fee 5 is under it
  });

  it("feeFor is 0 for an appraiser with no fee set, same as topFee([]) -- a real 0, not a missing value", () => {
    // Load-bearing for the fee line on screen: with an empty registry (topFee([]) === 0) and with
    // an appraiser whose own fee is 0, the UI must read these as an honest 0, not as "nothing to show".
    expect(feeFor(1_000, 0, 10)).toBe(0);
  });
});

describe("topFee", () => {
  it("is the highest fee among the appraisers still in play", () => {
    expect(topFee([3, 7, 1])).toBe(7);
  });

  it("is 0 for an empty list", () => {
    expect(topFee([])).toBe(0);
  });
});

describe("rejection", () => {
  it("at maxRounds=2: round 0 abandons, round 1 escalates, round 2 is exhausted", () => {
    expect(rejection(0, 2)).toBe("abandon");
    expect(rejection(1, 2)).toBe("escalate");
    expect(rejection(2, 2)).toBe("exhausted");
  });

  it("at maxRounds=1 (the cut line in §12): round 0 escalates straight away, abandon is unreachable", () => {
    expect(rejection(0, 1)).toBe("escalate");
    expect(rejection(1, 1)).toBe("exhausted");
  });
});

describe("roundLabel", () => {
  it("names the round being decided", () => {
    expect(roundLabel(0, 2)).toBe("Round 1 of 2");
    expect(roundLabel(1, 2)).toBe("Round 2 of 2");
  });

  it("clamps at maxRounds once rounds are exhausted", () => {
    expect(roundLabel(5, 2)).toBe("Round 2 of 2");
  });
});

describe("phase", () => {
  it("is 'selecting' before the verdict deadline with nothing bound", () => {
    expect(phase(dispute({ verdictDeadline: 200, appraiser: "" }), 199)).toBe("selecting");
  });

  it("is 'bound' the second before the verdict deadline with an appraiser bound", () => {
    expect(phase(dispute({ verdictDeadline: 200, appraiser: "APPRAISER" }), 199)).toBe("bound");
  });

  it("is already 'expired' at the exact verdict deadline, even with an appraiser bound", () => {
    expect(phase(dispute({ verdictDeadline: 200, appraiser: "APPRAISER" }), 200)).toBe("expired");
  });

  it("is 'expired' once past the verdict deadline with nothing bound too", () => {
    expect(phase(dispute({ verdictDeadline: 200, appraiser: "" }), 201)).toBe("expired");
  });
});

describe("step", () => {
  it("is 'propose' with no candidates yet", () => {
    expect(step(dispute(), "landlord", 0)).toBe("propose");
  });

  it("is 'pick' once there are candidates but this side has not picked", () => {
    expect(step(dispute({ landlordCandidates: ["W1"] }), "landlord", 0)).toBe("pick");
  });

  it("is 'waiting' once this side has picked but nothing is bound", () => {
    expect(step(dispute({ landlordCandidates: ["W1"], landlordPick: "W1" }), "landlord", 0)).toBe("waiting");
  });

  it("is 'bound' once an appraiser is bound, before the verdict deadline", () => {
    expect(step(dispute({ appraiser: "A", verdictDeadline: 200 }), "landlord", 199)).toBe("bound");
  });

  it("is already 'expired' at the exact verdict deadline, even when bound", () => {
    expect(step(dispute({ appraiser: "A", verdictDeadline: 200 }), "landlord", 200)).toBe("expired");
  });

  it("is not yet 'expired' the second before the verdict deadline", () => {
    expect(step(dispute({ verdictDeadline: 200 }), "landlord", 199)).not.toBe("expired");
  });
});

describe("candidates", () => {
  it("is empty for an empty mediation", () => {
    expect(candidates(dispute())).toEqual([]);
  });

  it("orders the union as the landlord's candidates then the tenant's additions", () => {
    const cs = candidates(dispute({ landlordCandidates: ["L1", "L2"], tenantCandidates: ["T1"] }));
    expect(cs.map((c) => c.wallet)).toEqual(["L1", "L2", "T1"]);
  });

  it("a key on both sides' lists appears once, with proposedBy naming both", () => {
    const cs = candidates(dispute({ landlordCandidates: ["SHARED", "L2"], tenantCandidates: ["SHARED", "T1"] }));
    expect(cs.map((c) => c.wallet)).toEqual(["SHARED", "L2", "T1"]);
    const shared = cs.find((c) => c.wallet === "SHARED")!;
    expect(shared.proposedBy).toEqual(["landlord", "tenant"]);
  });

  it("agreed is true only when both picks are that candidate", () => {
    const cs = candidates(
      dispute({ landlordCandidates: ["L1"], tenantCandidates: ["L1"], landlordPick: "L1", tenantPick: "L1" }),
    );
    expect(cs[0].agreed).toBe(true);
    expect(cs[0].landlordPicked).toBe(true);
    expect(cs[0].tenantPicked).toBe(true);
  });

  it("agreed is false when only one side has picked it", () => {
    const cs = candidates(dispute({ landlordCandidates: ["L1"], landlordPick: "L1" }));
    expect(cs[0].agreed).toBe(false);
  });
});

describe("canPropose / canPick / canBindDefault / canExpire", () => {
  it("canPropose is true with no candidates yet and nothing bound", () => {
    expect(canPropose(dispute(), "landlord")).toBe(true);
  });

  it("canPropose is false once this side already proposed", () => {
    expect(canPropose(dispute({ landlordCandidates: ["L1"] }), "landlord")).toBe(false);
  });

  it("a bound appraiser closes proposing even for a side with no candidates yet", () => {
    expect(canPropose(dispute({ appraiser: "A" }), "tenant")).toBe(false);
  });

  it("a bound appraiser closes picking too", () => {
    expect(canPick(dispute({ appraiser: "A", tenantCandidates: ["T1"] }), "tenant", 50)).toBe(false);
  });

  it("a side that proposed nothing may still pick from the other side's list", () => {
    expect(canPick(dispute({ tenantCandidates: ["T1"] }), "landlord", 50)).toBe(true);
  });

  it("canPick is false when the only candidate is already this side's pick", () => {
    expect(canPick(dispute({ landlordCandidates: ["L1"], landlordPick: "L1" }), "landlord", 50)).toBe(false);
  });

  it("canPick is true when a side's own pick could be changed to another candidate", () => {
    expect(canPick(dispute({ landlordCandidates: ["L1", "L2"], landlordPick: "L1" }), "landlord", 50)).toBe(true);
  });

  it("picking stays open past the selection deadline as long as nothing is bound", () => {
    expect(canPick(dispute({ selectionDeadline: 10, tenantCandidates: ["T1"] }), "landlord", 50)).toBe(true);
  });

  it("canPick is true the second before the verdict deadline", () => {
    expect(canPick(dispute({ verdictDeadline: 200, tenantCandidates: ["T1"] }), "landlord", 199)).toBe(true);
  });

  it("canPick is already false at the exact verdict deadline (BindingWindowClosed) and stays false past it", () => {
    expect(canPick(dispute({ verdictDeadline: 200, tenantCandidates: ["T1"] }), "landlord", 200)).toBe(false);
    expect(canPick(dispute({ verdictDeadline: 200, tenantCandidates: ["T1"] }), "landlord", 201)).toBe(false);
  });

  it("canBindDefault is false before the selection deadline", () => {
    expect(canBindDefault(dispute({ selectionDeadline: 100 }), 99)).toBe(false);
  });

  it("canBindDefault is already true at the exact selection deadline", () => {
    expect(canBindDefault(dispute({ selectionDeadline: 100 }), 100)).toBe(true);
  });

  it("canBindDefault is true the second before the verdict deadline too", () => {
    expect(canBindDefault(dispute({ selectionDeadline: 100, verdictDeadline: 200 }), 199)).toBe(true);
  });

  it("canBindDefault is already false at the exact verdict deadline (BindingWindowClosed), same bound as canPick", () => {
    expect(canBindDefault(dispute({ selectionDeadline: 100, verdictDeadline: 200 }), 200)).toBe(false);
  });

  it("canBindDefault is false once an appraiser is already bound", () => {
    expect(canBindDefault(dispute({ selectionDeadline: 100, appraiser: "A" }), 200)).toBe(false);
  });

  it("canExpire is false before the verdict deadline and true at it, regardless of bound state", () => {
    expect(canExpire(dispute({ verdictDeadline: 200 }), 199)).toBe(false);
    expect(canExpire(dispute({ verdictDeadline: 200 }), 200)).toBe(true);
    expect(canExpire(dispute({ verdictDeadline: 200, appraiser: "A" }), 200)).toBe(true);
  });

  it("canBindDefault and canExpire are exact complements for an unbound dispute, from the selection deadline on", () => {
    // The liveness property the whole design rests on (S3 F2 / BindingWindowClosed): from the
    // selection deadline (where the deadlock exit opens) to well past the verdict deadline, exactly
    // one of "bind the fallback" and "give up and expire" must be possible, or the deposit could
    // get stuck. Before the selection deadline both are false by design -- the normal pick path is
    // still live and nothing is deadlocked yet -- so the sweep starts there, not at 0.
    const d = dispute({ selectionDeadline: 100, verdictDeadline: 200 });
    for (let now = d.selectionDeadline; now <= d.verdictDeadline + 10; now++) {
      const bind = canBindDefault(d, now);
      const expire = canExpire(d, now);
      expect(bind !== expire, `now=${now} bind=${bind} expire=${expire}`).toBe(true);
    }
  });
});

describe("timeline", () => {
  it("lists the three keys in order", () => {
    const t = timeline(dispute(), 10, 20);
    expect(t.map((s) => s.key)).toEqual(["opened", "selection", "verdict"]);
  });

  it("the opened step always carries its date", () => {
    const t = timeline(dispute(), 10, 20);
    expect(t[0]).toMatchObject({ key: "opened", at: 10, state: "done" });
  });

  it("the selection step carries at: 0 once an appraiser is already agreed", () => {
    const t = timeline(dispute({ appraiser: "A" }), 10, 20);
    const selection = t.find((s) => s.key === "selection")!;
    expect(selection).toMatchObject({ label: "Appraiser agreed", at: 0, state: "done" });
  });

  it("'Fallback appraiser can be bound' appears only unbound and past the selection deadline", () => {
    const t = timeline(dispute({ selectionDeadline: 50, verdictDeadline: 500 }), 10, 60);
    const selection = t.find((s) => s.key === "selection")!;
    expect(selection.label).toBe("Fallback appraiser can be bound");
  });

  it("before the selection deadline, unbound, the label asks the two sides to agree", () => {
    const t = timeline(dispute({ selectionDeadline: 50, verdictDeadline: 500 }), 10, 20);
    const selection = t.find((s) => s.key === "selection")!;
    expect(selection.label).toBe("Both sides agree on an appraiser");
  });

  it("'Verdict window closed' appears, with the selection step already closed, once expired", () => {
    const t = timeline(dispute({ selectionDeadline: 50, verdictDeadline: 100 }), 10, 100);
    const selection = t.find((s) => s.key === "selection")!;
    const verdict = t.find((s) => s.key === "verdict")!;
    expect(selection).toMatchObject({ label: "No appraiser was agreed", at: 50, state: "done" });
    expect(verdict).toMatchObject({ label: "Verdict window closed", at: 100, state: "done" });
  });

  it("the verdict step reads 'The appraiser decides' and is 'now' once bound and not expired", () => {
    const t = timeline(dispute({ appraiser: "A", verdictDeadline: 500 }), 10, 20);
    const verdict = t.find((s) => s.key === "verdict")!;
    expect(verdict).toMatchObject({ label: "The appraiser decides", state: "now" });
  });

  it("the verdict step is 'later' while still selecting, not yet expired", () => {
    const t = timeline(dispute({ selectionDeadline: 50, verdictDeadline: 500 }), 10, 20);
    const verdict = t.find((s) => s.key === "verdict")!;
    expect(verdict).toMatchObject({ label: "The appraiser decides", state: "later" });
  });
});

describe("setKey", () => {
  it("the all-zero pubkey becomes ''", () => {
    expect(setKey(UNSET_KEY)).toBe("");
  });

  it("anything else passes through unchanged", () => {
    expect(setKey("SomeRealWalletAddress")).toBe("SomeRealWalletAddress");
  });
});
