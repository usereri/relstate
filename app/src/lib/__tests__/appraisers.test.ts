import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES, MAX_NAME_LEN, canonicalName, companyName, displayName, nameBytes, nameHashHex, nameProblem, sameCompany } from "../appraisers";

describe("limits come from the IDL", () => {
  it("MAX_NAME_LEN is 64 and MAX_CANDIDATES is 3", () => {
    expect(MAX_NAME_LEN).toBe(64);
    expect(MAX_CANDIDATES).toBe(3);
  });
});

describe("displayName", () => {
  it("trims and collapses whitespace runs, NBSP included", () => {
    expect(displayName("  Acme \t  Wycena  sp. z o.o. ")).toBe("Acme Wycena sp. z o.o.");
  });
  it("is empty for whitespace only", () => {
    expect(displayName("   ")).toBe("");
  });
});

describe("nameProblem", () => {
  it("accepts ordinary names, Polish diacritics included", () => {
    expect(nameProblem("Wycena Łódź")).toBeNull();
    expect(nameProblem("x".repeat(64))).toBeNull();
  });
  it("refuses empty names", () => {
    expect(nameProblem("   ")).toMatch(/Type/);
  });
  it("counts UTF-8 bytes, not characters", () => {
    const name = "ł".repeat(33); // 66 bytes
    expect(nameBytes(name)).toBe(66);
    expect(nameProblem(name)).toMatch(/limit/);
    expect(nameProblem("x".repeat(65))).not.toBeNull();
  });
  it("refuses control characters", () => {
    expect(nameProblem("Acme\u0000Wycena")).toMatch(/control/);
    expect(nameProblem("Acme\u0007")).toMatch(/control/);
  });
  it("refuses zero-width, bidi and BOM characters (review G6)", () => {
    for (const c of ["​", "‎", "‮", "⁠", "⁦", "﻿", "­", "᠎"]) {
      expect(nameProblem(`Acme${c}Wycena`), JSON.stringify(c)).toMatch(/invisible/);
    }
  });
  it("refuses variation selectors (S1: parity with the program's is_invisible)", () => {
    expect(nameProblem("Acme\u{FE0F} Wycena")).toMatch(/invisible/);
    expect(nameProblem("Acme\u{E0100} Wycena")).toMatch(/invisible/);
  });
});

describe("nameHashHex", () => {
  it("folds only ASCII case and whitespace", () => {
    expect(sameCompany("Acme  Wycena", " acme wycena ")).toBe(true);
    expect(sameCompany("Wycena Łódź", "WYCENA ŁÓDŹ")).toBe(false);
  });
  it("is sha256 of the ascii-lowercased display form", () => {
    // sha256("abc")
    expect(nameHashHex("ABC")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(canonicalName("AbC Łó")).toBe("abc Łó");
  });
});

describe("companyName", () => {
  it("strips invisible characters and keeps a full-length name intact", () => {
    expect(companyName("Ac​me")).toBe("Acme");
    const full = "x".repeat(64);
    expect(companyName(full)).toBe(full);
  });
});
