import { describe, expect, it } from "vitest";
import { termRows } from "../Terms";

describe("termRows", () => {
  it("uses termLabel for the Term row", () => {
    const rows = termRows({ rent: 500_000_000, deposit: 500_000_000, term: 3, periodSecs: 30 * 86_400 });
    const term = rows.find(([k]) => k === "Term");
    expect(term).toEqual(["Term", "3 months"]);
  });

  it("uses termLabel's non-month phrasing for a compressed period", () => {
    const rows = termRows({ rent: 500_000_000, deposit: 500_000_000, term: 1, periodSecs: 45 });
    const term = rows.find(([k]) => k === "Term");
    expect(term).toEqual(["Term", "1 period of 45s"]);
  });
});
