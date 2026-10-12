import "./noenv.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfidentialKeys } from "@solana/zk-sdk";
import { decryptAuditorAmount, recombineLoHi } from "../src/confidential.ts";

const auditor = ConfidentialKeys.fromIkm(new Uint8Array(32).fill(7));
const other = ConfidentialKeys.fromIkm(new Uint8Array(32).fill(8));

/** What a ConfidentialTransfer instruction carries for the auditor: lo (16-bit) and hi halves, encrypted separately. */
function encryptSplit(amount: bigint, pubkey = auditor.elgamal().pubkey()) {
  const lo = amount & 0xffffn;
  const hi = amount >> 16n;
  return { lo: pubkey.encryptU64(lo).toBytes(), hi: pubkey.encryptU64(hi).toBytes() };
}

describe("recombineLoHi", () => {
  it("is lo + hi * 2^16", () => {
    assert.equal(recombineLoHi(0n, 0n), 0n);
    assert.equal(recombineLoHi(5n, 0n), 5n);
    assert.equal(recombineLoHi(0n, 1n), 65_536n);
    assert.equal(recombineLoHi(0xffffn, 0xffffn), 0xffffffffn);
  });
});

describe("decryptAuditorAmount", () => {
  for (const amount of [0n, 1n, 65_535n, 65_536n, 1_234_567n, 500_000_000n]) {
    it(`round-trips ${amount}`, () => {
      const { lo, hi } = encryptSplit(amount);
      assert.equal(decryptAuditorAmount(auditor.elgamal().secret(), lo, hi), amount);
    });
  }

  it("does not decrypt to the right amount under a different key", () => {
    const { lo, hi } = encryptSplit(1_234_567n);
    // Decryption with a wrong key either throws (no discrete log found) or yields garbage; it must never yield the amount.
    let got: bigint | undefined;
    try {
      got = decryptAuditorAmount(other.elgamal().secret(), lo, hi);
    } catch {
      got = undefined;
    }
    assert.notEqual(got, 1_234_567n);
  });

  it("rejects bytes that are not a ciphertext", () => {
    assert.throws(() => decryptAuditorAmount(auditor.elgamal().secret(), new Uint8Array(3), new Uint8Array(3)));
  });
});

describe("ConfidentialKeys.fromIkm", () => {
  it("is deterministic", () => {
    const a = ConfidentialKeys.fromIkm(new Uint8Array(32).fill(1));
    const b = ConfidentialKeys.fromIkm(new Uint8Array(32).fill(1));
    assert.deepEqual(a.elgamal().pubkey().toBytes(), b.elgamal().pubkey().toBytes());
    assert.notDeepEqual(a.elgamal().pubkey().toBytes(), other.elgamal().pubkey().toBytes());
  });
});
