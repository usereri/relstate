import { describe, expect, it } from "vitest";
import { draftProblem, draftsToQuotes, emptyDrafts, sideName } from "../Mediation";

const CAP = 500_000_000; // a tenth of a 5000 USDC deposit

describe("emptyDrafts", () => {
  it("has one row per candidate slot", () => {
    expect(emptyDrafts()).toHaveLength(3);
  });
});

describe("draftProblem", () => {
  const d = (...rows: [string, string?][]) => rows.map(([name, fee]) => ({ name, fee: fee ?? "" }));
  it("needs at least one company", () => {
    expect(draftProblem(emptyDrafts(), CAP)).toMatch(/at least one/);
  });
  it("accepts one to three valid companies, fee optional", () => {
    expect(draftProblem(d(["Acme"], ["Beta", "12.5"], ["Gamma", "0"]), CAP)).toBeNull();
  });
  it("refuses the same company twice, ignoring case and spacing", () => {
    expect(draftProblem(d(["Acme  Wycena"], ["acme wycena"]), CAP)).toMatch(/twice/);
  });
  it("refuses invisible characters and a fee above the cap or malformed", () => {
    expect(draftProblem(d(["Ac​me"]), CAP)).toMatch(/invisible/);
    expect(draftProblem(d(["Acme", "501"]), CAP)).toMatch(/above/);
    expect(draftProblem(d(["Acme", "1e3"]), CAP)).toMatch(/quote for "Acme"/);
  });
});

describe("draftsToQuotes", () => {
  it("skips blank rows and turns a blank fee into 0", () => {
    expect(draftsToQuotes([{ name: " Acme ", fee: "1.5" }, { name: "", fee: "9" }, { name: "Beta", fee: "" }])).toEqual([
      { name: "Acme", fee: 1_500_000 },
      { name: "Beta", fee: 0 },
    ]);
  });
});

describe("sideName", () => {
  it("names a side, never a wallet", () => {
    expect(sideName("landlord")).toBe("the landlord");
    expect(sideName("tenant")).toBe("the tenant");
  });
});
