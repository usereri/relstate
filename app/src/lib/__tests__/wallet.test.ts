import { describe, expect, it, vi } from "vitest";
import * as anchor from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  CONFIDENTIAL_DERIVATION_MESSAGE as MSG,
  adapterWallet,
  chainAwareAccount,
  embeddedKeypairWallet,
  embeddedWallet,
  isConfidentialDerivationMessage,
  localKeypair,
  localWallet,
  type StandardAccount,
  type StandardWallet,
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

describe("chainAwareAccount", () => {
  const CHAIN = "solana:localnet";
  const publicKey = localKeypair("tenant").publicKey;
  const address = publicKey.toBase58();

  const account = (over: Partial<StandardAccount> = {}): StandardAccount => ({
    address,
    features: ["solana:signTransaction"],
    chains: [CHAIN],
    ...over,
  });

  const wallet = (over: { accounts?: StandardAccount[]; signFn?: unknown } = {}): StandardWallet => ({
    accounts: over.accounts ?? [account()],
    features: { "solana:signTransaction": { signTransaction: over.signFn ?? vi.fn() } },
  });

  it("happy path: the account is returned when every condition holds", () => {
    const w = wallet();
    expect(chainAwareAccount(w, publicKey, CHAIN)).toEqual(account());
  });

  it("no wallet at all: null", () => {
    expect(chainAwareAccount(null, publicKey, CHAIN)).toBeNull();
    expect(chainAwareAccount(undefined, publicKey, CHAIN)).toBeNull();
  });

  it("the wallet offers no solana:signTransaction feature: null", () => {
    const w: StandardWallet = { accounts: [account()], features: {} };
    expect(chainAwareAccount(w, publicKey, CHAIN)).toBeNull();
  });

  it("the feature is present but not a function: null", () => {
    const w: StandardWallet = { accounts: [account()], features: { "solana:signTransaction": { signTransaction: "nope" } } };
    expect(chainAwareAccount(w, publicKey, CHAIN)).toBeNull();
  });

  it("no account matches the connected public key: null", () => {
    const w = wallet({ accounts: [account({ address: "someone-else" })] });
    expect(chainAwareAccount(w, publicKey, CHAIN)).toBeNull();
  });

  it("the account is missing the feature: null", () => {
    const w = wallet({ accounts: [account({ features: [] })] });
    expect(chainAwareAccount(w, publicKey, CHAIN)).toBeNull();
  });

  it("the account does not list the requested cluster: null (a wallet that refuses solana:localnet)", () => {
    const w = wallet({ accounts: [account({ chains: ["solana:devnet"] })] });
    expect(chainAwareAccount(w, publicKey, CHAIN)).toBeNull();
  });
});

describe("adapterWallet with a Wallet Standard wallet attached", () => {
  const CHAIN = "solana:localnet";
  const publicKey = localKeypair("tenant").publicKey;
  const address = publicKey.toBase58();

  // A real legacy transaction, so the adapter's wire handling (serialize without requiring every
  // signature, deserialize back) runs for real instead of being stubbed out.
  const legacyTx = () => {
    const tx = new anchor.web3.Transaction({ feePayer: publicKey, recentBlockhash: anchor.web3.PublicKey.default.toBase58() });
    tx.add(
      new anchor.web3.TransactionInstruction({ keys: [], programId: anchor.web3.PublicKey.default, data: Buffer.alloc(0) }),
    );
    return tx;
  };

  it("signs through the standard feature, naming the chain, when the wallet can serve it", async () => {
    // Echoes the serialized bytes back unchanged: a real wallet would add its signature, but this
    // only has to prove the request named the right account and chain, and that the bytes round-trip.
    const signTransaction = vi.fn(async (...inputs: { account: unknown; chain?: string; transaction: Uint8Array }[]) =>
      inputs.map((i) => ({ signedTransaction: i.transaction })),
    );
    const standard: StandardWallet = {
      accounts: [{ address, features: ["solana:signTransaction"], chains: [CHAIN] }],
      features: { "solana:signTransaction": { signTransaction } },
    };
    const adapterSign = vi.fn();
    const w = adapterWallet({ publicKey, signTransaction: adapterSign, signAllTransactions: vi.fn(), standard }, CHAIN);

    const out = await w.signTransaction(legacyTx());
    expect(out.feePayer?.equals(publicKey)).toBe(true);
    expect(signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ chain: CHAIN, account: expect.objectContaining({ address }) }),
    );
    expect(adapterSign).not.toHaveBeenCalled();
  });

  it("falls back to the adapter's own signer when the standard account does not list the chain", async () => {
    const standard: StandardWallet = {
      accounts: [{ address, features: ["solana:signTransaction"], chains: ["solana:devnet"] }],
      features: { "solana:signTransaction": { signTransaction: vi.fn() } },
    };
    const adapterSign = vi.fn(async (t: any) => t);
    const w = adapterWallet(
      { publicKey, signTransaction: adapterSign, signAllTransactions: vi.fn(), standard },
      CHAIN,
    );
    const tx = { n: 1 } as any;
    await w.signTransaction(tx);
    expect(adapterSign).toHaveBeenCalledWith(tx);
  });
});

describe("local test wallets stay put", () => {
  // scripts/setup-demo.ts derives the same keys to fund them; drift would silently unfund the demo.
  it("landlord", () => expect(localKeypair("landlord").publicKey.toBase58()).toBe("2FMsGC43RXGToQ1aL2bC4Mig1jVa57ZhCipxtgVMKsBv"));
  it("tenant", () => expect(localKeypair("tenant").publicKey.toBase58()).toBe("QrHG6qqxiKaCH67PBJ9E164mtYAsej7aqjB5sFWEPo3"));
});
