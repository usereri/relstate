import { describe, expect, it } from "vitest";
import idl from "@target/idl/relstate.json";
import { expiryText, isKycRequired, kycReturn, levelName } from "../kyc";

// Read from the IDL, not hard-coded: the point of these cases is that the app and the program
// agree on the code, and a reordering of the program's errors must move both.
const errors = (idl as { errors: { name: string; code: number }[] }).errors;
const KYC = errors.find((e) => e.name === "KycRequired")!.code;
const hex = (n: number) => `0x${n.toString(16)}`;

describe("kycReturn", () => {
  it("reads done and cancelled with their session", () => {
    expect(kycReturn("#/app?tab=identity&kyc=done&session=abc")).toEqual({ outcome: "done", session: "abc" });
    expect(kycReturn("#/app?tab=identity&kyc=cancelled&session=abc")).toEqual({ outcome: "cancelled", session: "abc" });
  });

  it("is null when there is no query, no kyc parameter or no session", () => {
    expect(kycReturn("")).toBeNull();
    expect(kycReturn("#/app")).toBeNull();
    expect(kycReturn("#/app?tab=identity")).toBeNull();
    expect(kycReturn("#/app?tab=identity&kyc=done")).toBeNull();
    expect(kycReturn("#/app?kyc=done&session=")).toBeNull();
  });

  it("is null for an outcome other than done or cancelled", () => {
    // The hash is user-controlled, so only the two known values may reach the screen.
    for (const outcome of ["approved", "DONE", "", "done;drop", "<script>"]) {
      expect(kycReturn(`#/app?kyc=${encodeURIComponent(outcome)}&session=s`)).toBeNull();
    }
  });

  it("survives a garbage hash without throwing", () => {
    for (const hash of ["?", "#?&&&", "#/app?%E0%A4%A", "#/app?kyc", "not a hash", "#/?kyc=done&session=%"]) {
      expect(() => kycReturn(hash)).not.toThrow();
    }
    expect(kycReturn("?")).toBeNull();
  });

  it("falls back to the page's own hash when none is given", () => {
    expect(kycReturn()).toBeNull();
  });
});

describe("levelName", () => {
  it("names 0, 1 and 2, and treats anything above 2 as enhanced", () => {
    expect(levelName(0)).toBe("None");
    expect(levelName(1)).toBe("Basic");
    expect(levelName(2)).toBe("Enhanced");
    expect(levelName(3)).toBe("Enhanced");
  });
});

describe("expiryText", () => {
  it("says never expires for 0", () => {
    expect(expiryText(0)).toBe("never expires");
  });

  it("formats a real timestamp as valid until a date", () => {
    expect(expiryText(1_800_000_000)).toMatch(/^valid until .*2027/);
  });
});

describe("isKycRequired", () => {
  it("knows the program's KycRequired code", () => {
    expect(KYC).toBeGreaterThan(0);
  });

  it("recognises an Anchor error object by errorCode.code", () => {
    expect(isKycRequired({ error: { errorCode: { code: "KycRequired", number: KYC } } })).toBe(true);
    expect(isKycRequired({ message: "AnchorError", error: { errorCode: { code: "KycRequired" } } })).toBe(true);
  });

  it("recognises the program's message in a plain string", () => {
    expect(isKycRequired("Error: This wallet needs a valid identity attestation (level 1 or higher)")).toBe(true);
    expect(isKycRequired("custom: KycRequired")).toBe(true);
  });

  it("recognises a simulation failure carrying the Custom code", () => {
    expect(isKycRequired(`Transaction simulation failed: {"InstructionError":[1,{"Custom":${KYC}}]}`)).toBe(true);
    expect(isKycRequired({ simulationResponse: { err: { InstructionError: [0, { Custom: KYC }] } } })).toBe(true);
  });

  it("recognises the log line's hex code, in either case", () => {
    expect(isKycRequired(`Program failed: custom program error: ${hex(KYC)}`)).toBe(true);
    expect(isKycRequired({ logs: [`Program log: custom program error: ${hex(KYC).toUpperCase().replace("0X", "0x")}`] })).toBe(true);
  });

  it("is false for the neighbouring codes, in every shape", () => {
    // 6024 / 0x1788 is `InvalidNewAdmin`: one off must not read as an identity problem.
    const other = KYC - 1;
    expect(isKycRequired(`{"Custom":${other}}`)).toBe(false);
    expect(isKycRequired(`custom program error: ${hex(other)}`)).toBe(false);
    expect(isKycRequired({ error: { errorCode: { code: "InvalidNewAdmin" } } })).toBe(false);
    expect(isKycRequired(`{"Custom":${KYC + 1}}`)).toBe(false);
  });

  it("does not match a longer number that merely starts with the code", () => {
    expect(isKycRequired(`{"Custom":${KYC}0}`)).toBe(false);
  });

  it("is false for empty, nullish and unrelated errors", () => {
    expect(isKycRequired("")).toBe(false);
    expect(isKycRequired(null)).toBe(false);
    expect(isKycRequired(undefined)).toBe(false);
    expect(isKycRequired({})).toBe(false);
    expect(isKycRequired(new Error("network down"))).toBe(false);
    expect(isKycRequired(42)).toBe(false);
  });
});
