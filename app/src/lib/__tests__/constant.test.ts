import { describe, expect, it } from "vitest";
import { ConfidentialKeys } from "@solana/zk-sdk/node";
import { CONFIDENTIAL_DERIVATION_MESSAGE } from "../wallet";

// Own file on purpose: this is the only test that loads the zk-sdk wasm. wallet.ts spells the
// constant out to keep that wasm out of the main bundle, so this is what stops the two drifting.
describe("CONFIDENTIAL_DERIVATION_MESSAGE", () => {
  it("equals ConfidentialKeys.signerMessage() byte for byte", () => {
    const canonical = ConfidentialKeys.signerMessage();
    expect(Array.from(CONFIDENTIAL_DERIVATION_MESSAGE)).toEqual(Array.from(canonical));
  });
});
