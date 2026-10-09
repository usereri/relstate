import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  CONFIDENTIAL_DERIVATION_MESSAGE as MSG,
  adapterWallet,
  embeddedKeypairWallet,
  embeddedWallet,
  isConfidentialDerivationMessage,
  localKeypair,
  localWallet,
} from "../wallet";

const enc = (s: string) => new TextEncoder().encode(s);
const concat = (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]);

describe("derivation message guard", () => {
  it("the constant is solana-conf-bal/v1", () => {
    expect(new TextDecoder().decode(MSG)).toBe("solana-conf-bal/v1");
  });

  it("matches the exact constant and seed-scoped extensions", () => {
    expect(isConfidentialDerivationMessage(MSG)).toBe(true);
    expect(isConfidentialDerivationMessage(concat(MSG, enc("seed")))).toBe(true);
  });

  it("rejects empty, short-prefix and partially matching messages", () => {
    expect(isConfidentialDerivationMessage(new Uint8Array([]))).toBe(false);
    expect(isConfidentialDerivationMessage(MSG.slice(0, MSG.length - 1))).toBe(false);
    expect(isConfidentialDerivationMessage(MSG.slice(0, 5))).toBe(false);
    const nearly = Uint8Array.from(MSG);
    nearly[nearly.length - 1] ^= 1;
    expect(isConfidentialDerivationMessage(nearly)).toBe(false);
    expect(isConfidentialDerivationMessage(concat(enc("x"), MSG))).toBe(false);
    expect(isConfidentialDerivationMessage(enc("solana-conf-bal/v2"))).toBe(false);
  });
});

describe("localWallet", () => {
  for (const role of ["landlord", "tenant"] as const) {
    describe(role, () => {
      const w = localWallet(role);

      it("signMessage refuses the constant and anything starting with it", async () => {
        await expect(w.signMessage!(MSG)).rejects.toThrow(/refuses/);
        await expect(w.signMessage!(concat(MSG, enc("/seed-1")))).rejects.toThrow(/refuses/);
      });

      it("signMessage signs unrelated messages, verifiably", async () => {
        const m = enc("hello rent");
        const sig = await w.signMessage!(m);
        expect(ed25519.verify(sig, m, localKeypair(role).publicKey.toBytes())).toBe(true);
      });

      it("deriveConfidentialKeyMaterial signs exactly the constant", async () => {
        const sig = await w.deriveConfidentialKeyMaterial!();
        expect(sig).toHaveLength(64);
        const pk = localKeypair(role).publicKey.toBytes();
        expect(ed25519.verify(sig, MSG, pk)).toBe(true);
        expect(ed25519.verify(sig, enc("anything else"), pk)).toBe(false);
      });
    });
  }
});

describe("adapterWallet", () => {
  const publicKey = localKeypair("tenant").publicKey;
  const base = { publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };

  it("without signMessage exposes neither signMessage nor key derivation", () => {
    const w = adapterWallet(base);
    expect(w.kind).toBe("adapter");
    expect(w.signMessage).toBeUndefined();
    expect(w.deriveConfidentialKeyMaterial).toBeUndefined();
  });

  it("with signMessage exposes both and applies the same refusal", async () => {
    const raw = vi.fn(async (_m: Uint8Array) => new Uint8Array(64).fill(7));
    const w = adapterWallet({ ...base, signMessage: raw });
    await expect(w.signMessage!(MSG)).rejects.toThrow(/refuses/);
    await expect(w.signMessage!(concat(MSG, enc("s")))).rejects.toThrow(/refuses/);
    expect(raw).not.toHaveBeenCalled();

    await w.signMessage!(enc("ok"));
    expect(raw).toHaveBeenCalledTimes(1);

    const sig = await w.deriveConfidentialKeyMaterial!();
    expect(sig).toHaveLength(64);
    expect(raw).toHaveBeenLastCalledWith(MSG);
  });
});

describe("embeddedKeypairWallet", () => {
  const kp = localKeypair("landlord");
  const w = embeddedKeypairWallet(kp);
  const pk = kp.publicKey.toBytes();

  it("is the embedded kind", () => expect(w.kind).toBe("embedded"));

  it("signMessage refuses the constant and anything starting with it", async () => {
    await expect(w.signMessage!(MSG)).rejects.toThrow(/refuses/);
    await expect(w.signMessage!(concat(MSG, enc("/seed-1")))).rejects.toThrow(/refuses/);
  });

  it("signMessage signs unrelated messages, verifiably", async () => {
    const m = enc("hello rent");
    expect(ed25519.verify(await w.signMessage!(m), m, pk)).toBe(true);
  });

  it("deriveConfidentialKeyMaterial signs exactly the constant", async () => {
    const sig = await w.deriveConfidentialKeyMaterial!();
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, MSG, pk)).toBe(true);
    expect(ed25519.verify(sig, enc("anything else"), pk)).toBe(false);
  });
});

describe("embeddedWallet", () => {
  const publicKey = localKeypair("tenant").publicKey;
  const tx = (n: number) => ({ n }) as any;
  const signer = (extra: object = {}) => ({
    publicKey,
    signTransaction: vi.fn(async (t: any) => ({ ...t, signed: true })),
    signMessage: vi.fn(async (_m: Uint8Array) => new Uint8Array(64).fill(7)),
    ...extra,
  });

  it("is the embedded kind and keeps the signer's public key", () => {
    const w = embeddedWallet(signer());
    expect(w.kind).toBe("embedded");
    expect(w.publicKey).toBe(publicKey);
  });

  it("refuses the derivation message without ever reaching the raw signer", async () => {
    const s = signer();
    const w = embeddedWallet(s);
    await expect(w.signMessage!(MSG)).rejects.toThrow(/refuses/);
    await expect(w.signMessage!(concat(MSG, enc("s")))).rejects.toThrow(/refuses/);
    expect(s.signMessage).not.toHaveBeenCalled();

    await w.signMessage!(enc("ok"));
    expect(s.signMessage).toHaveBeenCalledTimes(1);
  });

  it("deriveConfidentialKeyMaterial calls the raw signer with exactly the constant", async () => {
    const s = signer();
    const sig = await embeddedWallet(s).deriveConfidentialKeyMaterial!();
    expect(sig).toHaveLength(64);
    expect(s.signMessage).toHaveBeenCalledTimes(1);
    expect(s.signMessage).toHaveBeenLastCalledWith(MSG);
  });

  it("without signAllTransactions signs serially via signTransaction, in order", async () => {
    const s = signer();
    const out = await embeddedWallet(s).signAllTransactions([tx(1), tx(2), tx(3)]);
    expect(out.map((t: any) => t.n)).toEqual([1, 2, 3]);
    expect(out.every((t: any) => t.signed)).toBe(true);
    expect(s.signTransaction).toHaveBeenCalledTimes(3);
  });

  it("with signAllTransactions supplied, uses it instead", async () => {
    const all = vi.fn(async (t: any[]) => t);
    const s = signer({ signAllTransactions: all });
    await embeddedWallet(s).signAllTransactions([tx(1), tx(2)]);
    expect(all).toHaveBeenCalledTimes(1);
    expect(s.signTransaction).not.toHaveBeenCalled();
  });
});

describe("embedded and local derive the same keys from the same keypair", () => {
  // The point of sharing keypairWallet: the embedded path is not a second, divergent derivation.
  it("deriveConfidentialKeyMaterial is byte-identical", async () => {
    const kp = localKeypair("tenant");
    const a = await embeddedKeypairWallet(kp).deriveConfidentialKeyMaterial!();
    const b = await localWallet("tenant").deriveConfidentialKeyMaterial!();
    expect(a).toHaveLength(64);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(ed25519.verify(a, MSG, kp.publicKey.toBytes())).toBe(true);
    expect(ed25519.verify(b, MSG, kp.publicKey.toBytes())).toBe(true);
  });
});

describe("local test wallets stay put", () => {
  // scripts/setup-demo.ts derives the same keys to fund them; drift would silently unfund the demo.
  it("landlord", () => expect(localKeypair("landlord").publicKey.toBase58()).toBe("2FMsGC43RXGToQ1aL2bC4Mig1jVa57ZhCipxtgVMKsBv"));
  it("tenant", () => expect(localKeypair("tenant").publicKey.toBase58()).toBe("QrHG6qqxiKaCH67PBJ9E164mtYAsej7aqjB5sFWEPo3"));
});
