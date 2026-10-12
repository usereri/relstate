// Contract 1: the only wallet surface the rest of the app may depend on.
//
// Three wallets satisfy it: the browser extension (`adapter`), the built-in test keypairs
// (`local`, local networks only) and the email/embedded wallet (`embedded`, workstream B).
// `chain.ts` and `confidential.ts` see nothing else.
import * as anchor from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2";
import { WalletError, WalletNotConnectedError, WalletSignTransactionError } from "@solana/wallet-adapter-base";
import { CLUSTER } from "./config";

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
  /**
   * The Wallet Standard wallet behind the adapter, when the connected wallet is a standard one
   * (every current extension is). Needed only to name the cluster — see {@link chainAwareSigner}.
   */
  standard?: StandardWallet | null;
}

// ---- telling the wallet which cluster this is -----------------------------------------------
//
// A wallet simulates what it is asked to sign and shows the user the balance changes it predicts.
// Which cluster it simulates against comes from the `chain` field of the Wallet Standard request —
// and `StandardWalletAdapter.signTransaction` does not send one: it passes `{ account,
// transaction }` and nothing else (the field is optional in the standard, and only the adapter's
// `sendTransaction`, which this app cannot use because the sponsor has to co-sign, fills it in from
// the connection's endpoint).
//
// With no cluster named, the wallet falls back to its own default. On mainnet none of this exists —
// not the program, not the mint, not one PDA — so the simulation fails and the wallet says "This
// transaction reverted during simulation. Funds may be lost if submitted." over a transaction that
// then lands perfectly well on the cluster the app and the sponsor actually use.
//
// So the request is made against the wallet's standard interface directly, with the cluster this
// app is configured for. Everything else is the adapter's behaviour, byte for byte.

const SOLANA_SIGN_TRANSACTION = "solana:signTransaction";

/** The slice of a Wallet Standard wallet this needs. Structural, so no new dependency. */
export interface StandardAccount {
  address: string;
  features: readonly string[];
  chains: readonly string[];
}
export interface StandardWallet {
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}
type SignTransactionFeature = {
  signTransaction: (
    ...inputs: { account: StandardAccount; transaction: Uint8Array; chain?: string }[]
  ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
};

/**
 * The connected account, if this wallet can sign for it on this cluster.
 *
 * Null for every reason a standard wallet might not be usable here: a wallet that offers no
 * `solana:signTransaction`, an account that is not the connected key, or an account that does not
 * claim the cluster — a wallet that has never heard of `solana:localnet` would refuse the request
 * outright, and a refusal is worse than the warning this exists to remove. Each of those falls
 * back to the adapter's own chain-less call, which is exactly today's behaviour.
 */
export function chainAwareAccount(wallet: StandardWallet | null | undefined, publicKey: PubKey, chain: string): StandardAccount | null {
  const feature = wallet?.features?.[SOLANA_SIGN_TRANSACTION] as SignTransactionFeature | undefined;
  if (!feature || typeof feature.signTransaction !== "function") return null;
  const address = publicKey.toBase58();
  const account = wallet!.accounts.find((a) => a.address === address);
  if (!account || !account.features.includes(SOLANA_SIGN_TRANSACTION) || !account.chains.includes(chain)) return null;
  return account;
}

/**
 * Signing that names the cluster. The wire handling is the adapter's: a versioned transaction goes
 * over as-is, a legacy one without requiring the signatures it is still missing (the sponsor's fee-
 * payer slot is empty by design), and what comes back is deserialized into whichever it was.
 */
function chainAwareSigner(wallet: StandardWallet, account: StandardAccount, chain: string) {
  const feature = wallet.features[SOLANA_SIGN_TRANSACTION] as SignTransactionFeature;
  const wire = (tx: AnyTransaction): Uint8Array =>
    "version" in tx ? tx.serialize() : new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const back = <T extends AnyTransaction>(tx: T, bytes: Uint8Array): T =>
    ("version" in tx ? anchor.web3.VersionedTransaction.deserialize(bytes) : anchor.web3.Transaction.from(bytes)) as T;
  // What `StandardWalletAdapter` does around the same call: a disconnected wallet is
  // WalletNotConnectedError, and any other failure — including the user pressing Reject — is
  // re-wrapped as WalletSignTransactionError. `chain.errorMessage` keys its wallet guidance ("set to
  // the same network as this app…") on that `Wallet…` name, so a bare Error from the extension would
  // silently lose it.
  const request = async (txs: AnyTransaction[]) => {
    if (!wallet.accounts.some((a) => a.address === account.address)) throw new WalletNotConnectedError();
    try {
      return await feature.signTransaction(...txs.map((tx) => ({ account, chain, transaction: wire(tx) })));
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletSignTransactionError((error as { message?: string } | null)?.message, error);
    }
  };
  return {
    signTransaction: async <T extends AnyTransaction>(tx: T): Promise<T> => back(tx, (await request([tx]))[0]!.signedTransaction),
    signAllTransactions: async <T extends AnyTransaction>(txs: T[]): Promise<T[]> => {
      const out = await request(txs);
      return txs.map((tx, i) => back(tx, out[i]!.signedTransaction));
    },
  };
}

/**
 * A browser-extension wallet as a `WalletProvider`.
 *
 * `chain` is the cluster to name in the signing request, `CLUSTER` by default, and null when the app
 * does not know it — in which case, like a wallet that cannot be reached through its standard
 * interface, the adapter's own signers are used unchanged.
 */
export function adapterWallet(w: AdapterWallet, chain: string | null = CLUSTER): WalletProvider {
  const account = chain ? chainAwareAccount(w.standard, w.publicKey, chain) : null;
  const signers = account ? chainAwareSigner(w.standard!, account, chain!) : { signTransaction: w.signTransaction, signAllTransactions: w.signAllTransactions };
  return {
    kind: "adapter",
    publicKey: w.publicKey,
    ...signers,
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
