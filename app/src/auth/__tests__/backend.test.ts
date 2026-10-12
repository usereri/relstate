import { describe, expect, it } from "vitest";
import { looksLikeEmail, normalizeEmail } from "../backend";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => expect(normalizeEmail("  Foo@Bar.COM \n")).toBe("foo@bar.com"));
});

describe("looksLikeEmail", () => {
  it("accepts ordinary addresses, however typed", () => {
    expect(looksLikeEmail("a@b.co")).toBe(true);
    expect(looksLikeEmail(" Demo@Relstate.XYZ ")).toBe(true);
  });

  it("rejects obvious typos", () => {
    for (const bad of ["", "a", "a@b", "a@b.c", "@b.co", "a@.co", "a b@c.co", "a@@b.co"]) expect(looksLikeEmail(bad), bad).toBe(false);
  });
});
