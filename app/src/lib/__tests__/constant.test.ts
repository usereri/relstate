import { describe, expect, it } from "vitest";
import { ConfidentialKeys } from "@solana/zk-sdk/node";
import { CONFIDENTIAL_DERIVATION_MESSAGE } from "../wallet";
import idl from "@target/idl/relstate.json";
import { APPRAISER_FEE_CAP_DIVISOR, MAX_DISPUTE_ROUNDS, SELECTION_WINDOW_SECS, VERDICT_WINDOW_SECS } from "../chain";
import { CLAIM_WINDOW_SECS } from "../config";

// Own file on purpose: this is the only test that loads the zk-sdk wasm. wallet.ts spells the
// constant out to keep that wasm out of the main bundle, so this is what stops the two drifting.
describe("CONFIDENTIAL_DERIVATION_MESSAGE", () => {
  it("equals ConfidentialKeys.signerMessage() byte for byte", () => {
    const canonical = ConfidentialKeys.signerMessage();
    expect(Array.from(CONFIDENTIAL_DERIVATION_MESSAGE)).toEqual(Array.from(canonical));
  });
});

// The app reads these off the program's own IDL (chain.ts's `constant()` helper) rather than
// mirroring a number, so the app and the program cannot disagree (docs/contracts/dispute-mediation.md §2).
// This pins that the export really is the IDL's own value, not a mirrored literal that happens to match.
describe("mediation window / round constants, read from the IDL", () => {
  const idlConstant = (name: string) => Number(idl.constants.find((c) => c.name === name)!.value);

  it("MAX_DISPUTE_ROUNDS equals the IDL's own value", () => {
    expect(MAX_DISPUTE_ROUNDS).toBe(idlConstant("MAX_DISPUTE_ROUNDS"));
  });

  it("SELECTION_WINDOW_SECS equals the IDL's own value", () => {
    expect(SELECTION_WINDOW_SECS).toBe(idlConstant("SELECTION_WINDOW_SECS"));
  });

  it("VERDICT_WINDOW_SECS equals the IDL's own value", () => {
    expect(VERDICT_WINDOW_SECS).toBe(idlConstant("VERDICT_WINDOW_SECS"));
  });

  it("APPRAISER_FEE_CAP_DIVISOR equals the IDL's own value", () => {
    expect(APPRAISER_FEE_CAP_DIVISOR).toBe(idlConstant("APPRAISER_FEE_CAP_DIVISOR"));
  });

  it("CLAIM_WINDOW_SECS (config.ts; predates these four) equals the IDL's own value too", () => {
    expect(CLAIM_WINDOW_SECS).toBe(idlConstant("CLAIM_WINDOW_SECS"));
  });
});
