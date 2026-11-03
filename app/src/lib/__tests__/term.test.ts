import { describe, expect, it } from "vitest";
import { DEFAULT_TERM_PERIODS, MAX_TERM_PERIODS, MIN_TERM_PERIODS, parseTerm, periodWord, termLabel } from "../term";

const MONTH_SECS = 30 * 86_400;

describe("constants", () => {
  it("MIN/MAX/DEFAULT are the app's own bounds", () => {
    expect(MIN_TERM_PERIODS).toBe(1);
    expect(MAX_TERM_PERIODS).toBe(60);
    expect(DEFAULT_TERM_PERIODS).toBe(3);
  });
});

describe("parseTerm", () => {
  it("rejects an empty string", () => {
    expect(parseTerm("")).toEqual({ ok: false, error: "Enter a whole number of periods." });
  });

  it("rejects 0 as below the minimum", () => {
    expect(parseTerm("0")).toEqual({ ok: false, error: `The term is at least ${MIN_TERM_PERIODS} period.` });
  });

  it("rejects a negative number", () => {
    expect(parseTerm("-1")).toEqual({ ok: false, error: "Enter a whole number of periods." });
  });

  it("rejects a fractional number", () => {
    expect(parseTerm("1.5")).toEqual({ ok: false, error: "Enter a whole number of periods." });
  });

  it("rejects 61 as above the maximum", () => {
    expect(parseTerm("61")).toEqual({ ok: false, error: `The term is at most ${MAX_TERM_PERIODS} periods.` });
  });

  it("rejects non-numeric input", () => {
    expect(parseTerm("abc")).toEqual({ ok: false, error: "Enter a whole number of periods." });
  });

  it("accepts the minimum, the default and the maximum", () => {
    expect(parseTerm("1")).toEqual({ ok: true, value: 1 });
    expect(parseTerm("3")).toEqual({ ok: true, value: 3 });
    expect(parseTerm("60")).toEqual({ ok: true, value: 60 });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseTerm("  3  ")).toEqual({ ok: true, value: 3 });
  });
});

describe("periodWord", () => {
  it("is 'month' when the period is 30 days", () => {
    expect(periodWord(MONTH_SECS)).toBe("month");
  });

  it("is 'period of <duration>' for any other period length", () => {
    expect(periodWord(45)).toBe("period of 45s");
  });
});

describe("termLabel", () => {
  it("gives '1 month' / '3 months' when the period is 30 days", () => {
    expect(termLabel(1, MONTH_SECS)).toBe("1 month");
    expect(termLabel(3, MONTH_SECS)).toBe("3 months");
  });

  it("gives '<n> period(s) of <duration>' for a non-month period, singular and plural", () => {
    expect(termLabel(1, 45)).toBe("1 period of 45s");
    expect(termLabel(3, 45)).toBe("3 periods of 45s");
  });
});
