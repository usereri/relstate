import { describe, expect, it } from "vitest";
import { asked, confirmGate, verdictProblem } from "../verdict";
import { parseAmountInput } from "../utils";

describe("parseAmountInput", () => {
  it("parses exact decimals to base units", () => {
    expect(parseAmountInput("12.5")).toEqual({ base: 12_500_000 });
    expect(parseAmountInput("0")).toEqual({ base: 0 });
    expect(parseAmountInput(" 3 ")).toEqual({ base: 3_000_000 });
    expect(parseAmountInput("0.000001")).toEqual({ base: 1 });
  });
  it("refuses what Number() would coerce", () => {
    for (const bad of ["1e3", "0x10", "1,5", "abc", "1.2345678", "."]) expect("error" in parseAmountInput(bad), bad).toBe(true);
  });
  it("uses the caller's wording for empty input, and refuses negatives", () => {
    expect(parseAmountInput("", "Enter it.")).toEqual({ error: "Enter it." });
    expect("error" in parseAmountInput("-1")).toBe(true);
  });
  it("refuses amounts beyond a safe integer", () => {
    expect("error" in parseAmountInput("99999999999999999999")).toBe(true);
  });
});

describe("verdictProblem", () => {
  const ok = { deductionBase: 10, deposit: 100, status: "mediation", appraiser: "A", mine: "A" };
  it("accepts a valid verdict, bounds included", () => {
    expect(verdictProblem(ok)).toBeNull();
    expect(verdictProblem({ ...ok, deductionBase: 0 })).toBeNull();
    expect(verdictProblem({ ...ok, deductionBase: 100 })).toBeNull();
  });
  it("refuses more than the deposit", () => {
    expect(verdictProblem({ ...ok, deductionBase: 101 })).toMatch(/more than the deposit/);
  });
  it("refuses a lease that is not in mediation, or has no appraiser", () => {
    expect(verdictProblem({ ...ok, status: "closed" })).toMatch(/finished/);
    expect(verdictProblem({ ...ok, status: "active" })).toMatch(/not in mediation/);
    expect(verdictProblem({ ...ok, appraiser: "" })).toMatch(/No appraiser/);
  });
  it("refuses a case bound to somebody else, and skips that check when the wallet is unknown", () => {
    expect(verdictProblem({ ...ok, mine: "B" })).toMatch(/not yours/);
    expect(verdictProblem({ deductionBase: 1, deposit: 100, status: "mediation", appraiser: "A" })).toBeNull();
  });
});

describe("confirmGate", () => {
  it("is disarmed until a split was confirmed, and for any other number or lease", () => {
    expect(confirmGate(null, "L", 5)).toEqual({ armed: false, reason: "none" });
    expect(confirmGate(asked("L", 5), "L", 6)).toEqual({ armed: false, reason: "stale" });
    expect(confirmGate(asked("L", 5), "M", 5)).toEqual({ armed: false, reason: "stale" });
    expect(confirmGate(asked("L", 5), "L", 5)).toEqual({ armed: true });
  });
});
