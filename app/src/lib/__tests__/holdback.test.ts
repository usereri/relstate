import { describe, expect, it } from "vitest";
import { defaultHoldback, depositShortfall, holdbackFor, holdbackParam, isShortPublicBalance, plnToCover } from "../holdback";

describe("defaultHoldback", () => {
  it("clamps to the top-up amount when the configured default is larger", () => {
    expect(defaultHoldback(100_000_000, 40_000_000)).toBe(40_000_000);
  });

  it("uses the configured default when the top-up is larger", () => {
    expect(defaultHoldback(100_000_000, 500_000_000)).toBe(100_000_000);
  });

  it("is never negative, even with a negative configured value or top-up", () => {
    expect(defaultHoldback(-5, 40_000_000)).toBe(0);
    expect(defaultHoldback(100_000_000, -1)).toBe(0);
    expect(defaultHoldback(-5, -1)).toBe(0);
  });

  it("a 0 configured default holds back nothing", () => {
    expect(defaultHoldback(0, 40_000_000)).toBe(0);
  });
});

describe("depositShortfall", () => {
  it("is the full deposit when the public balance is null (unknown/unread)", () => {
    expect(depositShortfall(null, 10_000_000)).toBe(10_000_000);
  });

  it("is 0 once the public balance already covers the deposit", () => {
    expect(depositShortfall(10_000_000, 10_000_000)).toBe(0);
    expect(depositShortfall(15_000_000, 10_000_000)).toBe(0);
  });

  it("is the gap when the public balance partially covers the deposit", () => {
    expect(depositShortfall(4_000_000, 10_000_000)).toBe(6_000_000);
  });

  it("is never negative", () => {
    expect(depositShortfall(0, 0)).toBe(0);
  });
});

describe("holdbackFor", () => {
  it("with a lease need, holds back the lesser of the shortfall and the top-up amount", () => {
    expect(holdbackFor(50_000_000, { shortfall: 10_000_000, rent: 2_000_000 }, 100_000_000)).toBe(10_000_000);
    expect(holdbackFor(5_000_000, { shortfall: 10_000_000, rent: 2_000_000 }, 100_000_000)).toBe(5_000_000);
  });

  it("with no lease need, falls back to the clamped configured default", () => {
    expect(holdbackFor(40_000_000, null, 100_000_000)).toBe(40_000_000);
    expect(holdbackFor(500_000_000, null, 100_000_000)).toBe(100_000_000);
  });

  it("a zero shortfall need holds back nothing, even with a configured default", () => {
    expect(holdbackFor(40_000_000, { shortfall: 0, rent: 2_000_000 }, 100_000_000)).toBe(0);
  });
});

describe("plnToCover", () => {
  it("rounds up to the nearest whole złoty", () => {
    expect(plnToCover(100_000_000, 4.3, 10)).toBe(Math.ceil(100 * 4.3)); // 430 PLN, above minPln
    expect(plnToCover(1_000_000, 4.3, 1)).toBe(5); // 1 USDC * 4.3 = 4.3 -> ceil 5, above the low minPln
  });

  it("never goes below minPln even for a tiny amount", () => {
    expect(plnToCover(1, 4.3, 10)).toBe(10);
  });

  it("falls back to minPln for a non-positive or unusable rate", () => {
    expect(plnToCover(100_000_000, 0, 10)).toBe(10);
    expect(plnToCover(100_000_000, -4.3, 10)).toBe(10);
    expect(plnToCover(100_000_000, Number.NaN, 10)).toBe(10);
  });
});

describe("holdbackParam", () => {
  it("formats base units as a six-decimal USDC string", () => {
    expect(holdbackParam(60_000_000)).toBe("60.000000");
    expect(holdbackParam(1)).toBe("0.000001");
    expect(holdbackParam(0)).toBe("0.000000");
  });

  it("floors a fractional base-unit amount before formatting", () => {
    expect(holdbackParam(60_000_000.9)).toBe("60.000000");
  });

  it("clamps a negative amount to zero", () => {
    expect(holdbackParam(-5)).toBe("0.000000");
  });
});

describe("isShortPublicBalance", () => {
  it("matches the Token-2022 custom program error 0x1 log line", () => {
    expect(isShortPublicBalance("Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1")).toBe(true);
  });

  it("matches the friendly message text itself", () => {
    expect(isShortPublicBalance("Not enough public balance for the deposit. Add funds and keep part of it public.")).toBe(true);
  });

  it("does not match the System program's own 0x1 (that is the unfunded-rent case, not this one)", () => {
    expect(isShortPublicBalance("Program 11111111111111111111111111111111 failed: custom program error: 0x1")).toBe(false);
  });

  it("does not match a different Token-2022 error code", () => {
    expect(isShortPublicBalance("Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x11")).toBe(false);
  });

  it("is false for unrelated text", () => {
    expect(isShortPublicBalance("")).toBe(false);
    expect(isShortPublicBalance("some other failure")).toBe(false);
  });
});
