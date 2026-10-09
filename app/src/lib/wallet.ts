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
type Kp = anchor.web3.Keypair;

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
 * A wallet whose ed25519 key this page holds itself: the built-in test wallets (`local`) and the
 * mock embedded wallet (`embedded`, app/src/auth/mock.ts). The signing and the derivation guard
 * are shared on purpose, so one keypair yields the same confidential-balance keys whichever kind
 * it is presented as — the embedded path is not a second, divergent derivation.
 */
function keypairWallet(kind: "local" | "embedded", kp: Kp): WalletProvider {
  const sign = <T extends AnyTransaction>(tx: T): T => {
    if ("version" in tx) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    kind,
    publicKey: kp.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
    // secretKey is seed || publicKey; ed25519 signs from the 32-byte seed.
    ...keyDerivation(async (message) => ed25519.sign(message, kp.secretKey.slice(0, 32))),
  };
}

/**
 * Built-in test wallets for a LOCAL network only: one fixed key per role, derived from a public
 * seed, so two browser tabs can be two different people without a wallet extension (an extension
 * keeps one connected account per site). scripts/setup-demo.ts derives the same keys to fund them.
 */
export const localKeypair = (role: Role) => Keypair.fromSeed(sha256(new TextEncoder().encode(`relstate-local-${role}`)));

export const localWallet = (role: Role): WalletProvider => keypairWallet("local", localKeypair(role));

/**
 * The mock embedded wallet: an email-derived keypair this page holds, so the email sign-up flow
 * works with no provider account and no secrets. `app/src/auth/mock.ts` owns the derivation and
 * the "demo wallet" labelling; this is only the signer.
 */
export const embeddedKeypairWallet = (kp: Kp): WalletProvider => keypairWallet("embedded", kp);

/**
 * What a hosted embedded wallet (Privy, Turnkey, …) hands back: it holds the key, and we only ever
 * get signing calls. `signMessage` is required here, unlike on {@link AdapterWallet} — a wallet
 * created by this app for this app has no reason to withhold it, and without it the account could
 * never pay rent privately.
 */
export interface EmbeddedSigner {
  publicKey: PubKey;
  signTransaction: <T extends AnyTransaction>(tx: T) => Promise<T>;
  /** Optional: a provider that only signs one at a time is driven serially below. */
  signAllTransactions?: <T extends AnyTransaction>(txs: T[]) => Promise<T[]>;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

/** A hosted embedded wallet as a `WalletProvider`, with the same derivation guard as every other. */
export function embeddedWallet(s: EmbeddedSigner): WalletProvider {
  const serially = async <T extends AnyTransaction>(txs: T[]): Promise<T[]> => {
    const signed: T[] = [];
    for (const tx of txs) signed.push(await s.signTransaction(tx));
    return signed;
  };
  return {
    kind: "embedded",
    publicKey: s.publicKey,
    signTransaction: s.signTransaction,
    signAllTransactions: s.signAllTransactions ?? serially,
    ...keyDerivation(s.signMessage),
  };
}

/** A read-only stand-in: lets Anchor build a reader `Program` without a connected wallet. */
export const readOnlyWallet = (): WalletProvider => ({
  kind: "local",
  publicKey: PublicKey.default,
  signTransaction: async (tx) => tx,
  signAllTransactions: async (txs) => txs,
});
