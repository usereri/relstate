// Contract 1: the only wallet surface the rest of the app may depend on.
//
// Three wallets satisfy it: the browser extension (`adapter`), the built-in test keypairs
// (`local`, local networks only) and the email/embedded wallet (`embedded`, workstream B).
// `chain.ts` and `confidential.ts` see nothing else.
import * as anchor from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2";

const { Keypair, PublicKey } = anchor.web3;
type PubKey = anchor.web3.PublicKey;

export type Role = "landlord" | "tenant";
export type AnyTransaction = anchor.web3.Transaction | anchor.web3.VersionedTransaction;

/**
 * The exact bytes a wallet signs once to derive its confidential-balance keys, as defined by
 * `ConfidentialKeys.signerMessage()` in `@solana/zk-sdk`. Spelled out here so this module stays
 * free of the zk-sdk wasm; `confidential.ts` asserts the two agree before using the signature.
 */
export const CONFIDENTIAL_DERIVATION_MESSAGE = new TextEncoder().encode("solana-conf-bal/v1");

export interface WalletProvider {
  kind: "embedded" | "adapter" | "local";
  publicKey: PubKey;
  signTransaction: <T extends AnyTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends AnyTransaction>(txs: T[]) => Promise<T[]>;
  /**
   * Generic off-chain message signing, when the wallet offers it. It must REFUSE any message
   * starting with {@link CONFIDENTIAL_DERIVATION_MESSAGE}: that signature is the input key
   * material for the wallet's confidential balances, so it is only ever produced by the
   * dedicated capability below. Every factory here wraps the wallet's own signer accordingly.
   */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  /**
   * The dedicated key-derivation capability (docs/privacy.md). Takes no message: it signs
   * {@link CONFIDENTIAL_DERIVATION_MESSAGE} and nothing else, and returns the 64-byte signature
   * to feed to `ConfidentialKeys.fromSignature`. Absent when the wallet cannot sign messages,
   * in which case confidential balances are unavailable for that wallet.
   */
  deriveConfidentialKeyMaterial?: () => Promise<Uint8Array>;
}

/** True for the derivation message and for any seed-scoped variant (`message || seed`). */
export function isConfidentialDerivationMessage(message: Uint8Array): boolean {
  const m = CONFIDENTIAL_DERIVATION_MESSAGE;
  return message.length >= m.length && m.every((b, i) => message[i] === b);
}

const GENERIC_REFUSAL =
  "This wallet refuses to sign the confidential-balance derivation message through generic " +
  "message signing. Use the wallet's key-derivation capability instead.";

/**
 * Wraps a raw message signer into the pair the contract asks for: a generic `signMessage` that
 * refuses the derivation message, and a dedicated capability that signs only that message.
 */
function keyDerivation(sign: (message: Uint8Array) => Promise<Uint8Array>) {
  return {
    signMessage: async (message: Uint8Array) => {
      if (isConfidentialDerivationMessage(message)) throw new Error(GENERIC_REFUSAL);
      return sign(message);
    },
    deriveConfidentialKeyMaterial: () => sign(CONFIDENTIAL_DERIVATION_MESSAGE),
  };
}

/** The fields `@solana/wallet-adapter-react`'s `useWallet()` hands back once a wallet is connected. */
export interface AdapterWallet {
  publicKey: PubKey;
  signTransaction: <T extends AnyTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends AnyTransaction>(txs: T[]) => Promise<T[]>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/** A browser-extension wallet as a `WalletProvider`. */
export function adapterWallet(w: AdapterWallet): WalletProvider {
  return {
    kind: "adapter",
    publicKey: w.publicKey,
    signTransaction: w.signTransaction,
    signAllTransactions: w.signAllTransactions,
    ...(w.signMessage ? keyDerivation(w.signMessage) : {}),
  };
}

/** Accepts either a finished provider or the adapter's raw fields, so call sites can pass either. */
export const asWalletProvider = (w: WalletProvider | AdapterWallet): WalletProvider =>
  "kind" in w ? w : adapterWallet(w);

/**
 * Built-in test wallets for a LOCAL network only: one fixed key per role, derived from a public
 * seed, so two browser tabs can be two different people without a wallet extension (an extension
 * keeps one connected account per site). scripts/setup-demo.ts derives the same keys to fund them.
 */
export const localKeypair = (role: Role) => Keypair.fromSeed(sha256(new TextEncoder().encode(`relstate-local-${role}`)));

export function localWallet(role: Role): WalletProvider {
  const kp = localKeypair(role);
  const sign = <T extends AnyTransaction>(tx: T): T => {
    if ("version" in tx) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    kind: "local",
    publicKey: kp.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
    // secretKey is seed || publicKey; ed25519 signs from the 32-byte seed.
    ...keyDerivation(async (message) => ed25519.sign(message, kp.secretKey.slice(0, 32))),
  };
}

/** A read-only stand-in: lets Anchor build a reader `Program` without a connected wallet. */
export const readOnlyWallet = (): WalletProvider => ({
  kind: "local",
  publicKey: PublicKey.default,
  signTransaction: async (tx) => tx,
  signAllTransactions: async (txs) => txs,
});
