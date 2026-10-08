/**
 * The confidential-balance island.
 *
 * Everything here is `@solana/kit` 8 + `@solana-program/token-2022` + the `@solana/zk-sdk` wasm,
 * which is a different stack from the rest of the app (web3.js + Anchor). The rest of the app is
 * deliberately NOT rewritten to kit: this module is loaded on demand, builds the instructions a
 * confidential rent payment needs, and hands them back for the caller to compose and submit.
 *
 * Why plans rather than single instructions: a confidential transfer is a batch of ZK proofs
 * (equality, ciphertext validity, batched range) staged in context-state accounts, which does not
 * fit in one transaction. `@solana-program/token-2022` returns an `InstructionPlan`; the planner
 * here turns it into an ordered list of transaction messages, the last of which carries the actual
 * `ConfidentialTransfer` instruction. `pay_rent` belongs in that last transaction (see
 * docs/contracts/program-interface.md), which is what `alsoInLastTransaction` is for.
 *
 * Every private operation needs the wallet's ElGamal + AES keys, derived once per session from
 * the wallet's dedicated key-derivation capability (docs/privacy.md). No key ever leaves the
 * browser; the auditor key that lets us decrypt for compliance lives only in backend secrets and
 * is read off the mint by the transfer helper.
 */
import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionMessage,
  TransactionMessageWithFeePayer,
  TransactionSigner,
} from "@solana/kit";
import type { AeKey, ElGamalKeypair } from "@solana/zk-sdk/bundler";
import type { ConfidentialTransferBalance } from "@solana-program/token-2022/confidential";
import { RPC, RUSDC_MINT } from "./config";
import { retryOn429 } from "./rpc";
import { postSponsored, sponsorFeePayer } from "./sponsor";
import { CONFIDENTIAL_DERIVATION_MESSAGE, isConfidentialDerivationMessage, type WalletProvider } from "./wallet";

/** The kit, token-2022 and zk-sdk modules, imported on first use so the wasm stays lazy. */
const libs = async () => {
  const [kit, token, confidential, zk] = await Promise.all([
    import("@solana/kit"),
    import("@solana-program/token-2022"),
    import("@solana-program/token-2022/confidential"),
    import("@solana/zk-sdk/bundler"),
  ]);
  return { kit, token, confidential, zk };
};
type Libs = Awaited<ReturnType<typeof libs>>;

export type PlannedMessage = TransactionMessage & TransactionMessageWithFeePayer;
export type { ConfidentialTransferBalance };

/** A wallet's confidential-balance keys. One ElGamal keypair and one AES key per wallet. */
export interface ConfidentialKeyPair {
  elgamal: ElGamalKeypair;
  ae: AeKey;
}

/**
 * Derives the wallet's confidential-balance keys.
 *
 * The input key material is the wallet's signature over the constant `solana-conf-bal/v1`,
 * obtained ONLY through the dedicated capability on {@link WalletProvider} — never through
 * generic message signing, which refuses that message outright.
 */
export async function deriveKeys(wallet: WalletProvider): Promise<ConfidentialKeyPair> {
  if (!wallet.deriveConfidentialKeyMaterial)
    throw new Error(
      `This ${wallet.kind} wallet cannot derive confidential-balance keys: it exposes no key-derivation capability, ` +
        "so private balances are unavailable for it.",
    );
  const { zk } = await libs();
  // The constant is spelled out in wallet.ts to keep the wasm out of the main bundle; this is
  // where the two are checked against each other, before any key material is produced.
  const canonical = zk.ConfidentialKeys.signerMessage();
  const ours = CONFIDENTIAL_DERIVATION_MESSAGE;
  if (canonical.length !== ours.length || !canonical.every((b, i) => b === ours[i]))
    throw new Error("The wallet contract's derivation message no longer matches ConfidentialKeys.signerMessage(). Refusing to derive keys.");
  if (!isConfidentialDerivationMessage(canonical)) throw new Error("Internal: derivation message guard disagrees with itself.");

  const signature = await wallet.deriveConfidentialKeyMaterial();
  if (signature.length !== 64) throw new Error(`Expected a 64-byte ed25519 signature for key derivation, got ${signature.length} bytes.`);
  const keys = zk.ConfidentialKeys.fromSignature(signature);
  return { elgamal: keys.elgamal(), ae: keys.ae() };
}

/** How a planned transaction reaches the chain: sponsored by the backend, or paid for locally. */
export type Submit = (message: PlannedMessage) => Promise<string>;

export interface ConfidentialSession {
  rpc: Rpc<SolanaRpcApi>;
  mint: Address;
  owner: Address;
  /** The owner's Token-2022 associated token account for this mint. */
  token: Address;
  keys: ConfidentialKeyPair;
  /** Pays fees AND the rent for the proof context-state accounts a transfer stages. */
  payer: TransactionSigner;
  /** The token account's owner, as the instructions' authority. */
  authority: Address | TransactionSigner;
  submit: Submit;
}

const rpcFor = async (url: string, { kit }: Libs) =>
  kit.createSolanaRpcFromTransport(retryOn429(kit.createDefaultRpcTransport({ url }))) as Rpc<SolanaRpcApi>;

const ataFor = async (owner: Address, mint: Address, { token }: Libs) =>
  (await token.findAssociatedTokenPda({ owner, mint, tokenProgram: token.TOKEN_2022_PROGRAM_ADDRESS }))[0];

const requireMint = (mint?: string): string => {
  const m = mint ?? RUSDC_MINT;
  if (!m) throw new Error("No confidential mint configured: set VITE_RUSDC_MINT to the rUSDC mint address.");
  return m;
};

/**
 * Opens a session for the connected wallet, sponsored by the backend.
 *
 * The wallet signs as the token account's authority; the backend's fee payer is a noop signer, so
 * kit leaves its signature slot empty and the backend fills it in. That is the same sponsorship
 * shape `chain.sendSponsored` uses for the Anchor flows.
 */
export async function openSession(opts: { wallet: WalletProvider; mint?: string; rpcUrl?: string }): Promise<ConfidentialSession> {
  const l = await libs();
  const { kit } = l;
  const [feePayer, keys] = await Promise.all([sponsorFeePayer(), deriveKeys(opts.wallet)]);
  const mint = kit.address(requireMint(opts.mint));
  const owner = kit.address(opts.wallet.publicKey.toBase58());
  const rpc = await rpcFor(opts.rpcUrl ?? RPC, l);
  return {
    rpc,
    mint,
    owner,
    token: await ataFor(owner, mint, l),
    keys,
    payer: kit.createNoopSigner(kit.address(feePayer)),
    authority: owner,
    submit: sponsoredSubmit(opts.wallet, l),
  };
}

/**
 * Opens a session whose signer pays for itself: the local test wallet, scripts and tests. Nothing
 * is posted to a backend, which is what keeps this module usable with no backend running.
 */
export async function openLocalSession(opts: {
  signer: TransactionSigner;
  keys: ConfidentialKeyPair;
  mint: string;
  rpcUrl?: string;
}): Promise<ConfidentialSession> {
  const l = await libs();
  const { kit } = l;
  const mint = kit.address(requireMint(opts.mint));
  const owner = opts.signer.address;
  const rpc = await rpcFor(opts.rpcUrl ?? RPC, l);
  return {
    rpc,
    mint,
    owner,
    token: await ataFor(owner, mint, l),
    keys: opts.keys,
    payer: opts.signer,
    authority: opts.signer,
    submit: localSubmit(rpc, l),
  };
}

// --- submission strategies -------------------------------------------------------------------

const withLifetime = async (session: Pick<ConfidentialSession, "rpc">, message: PlannedMessage, { kit }: Libs) => {
  const { value: blockhash } = await session.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  return { message: kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, message), blockhash };
};

/** Signs locally with every signer the message carries and sends it directly. */
function localSubmit(rpc: Rpc<SolanaRpcApi>, l: Libs): Submit {
  const { kit } = l;
  return async (message) => {
    const { message: m, blockhash } = await withLifetime({ rpc }, message, l);
    const tx = await kit.signTransactionMessageWithSigners(m);
    const signature = kit.getSignatureFromTransaction(tx);
    await rpc
      .sendTransaction(kit.getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
    await confirm(rpc, signature, blockhash.lastValidBlockHeight);
    return signature;
  };
}

/**
 * Signs with the ephemeral proof-account signers, then hands the half-signed transaction to the
 * wallet for the authority signature and posts it. The backend adds the fee payer's signature.
 *
 * kit and web3.js disagree about types but agree about the wire format, so the bridge between
 * them is the serialized transaction itself.
 */
function sponsoredSubmit(wallet: WalletProvider, l: Libs): Submit {
  const { kit } = l;
  return async (message) => {
    const { message: m } = await withLifetime({ rpc: await rpcFor(RPC, l) }, message, l);
    const partial = await kit.partiallySignTransactionMessageWithSigners(m);
    const anchor = await import("@anchor-lang/core");
    const wire = Buffer.from(kit.getBase64EncodedWireTransaction(partial), "base64");
    const tx = anchor.web3.VersionedTransaction.deserialize(wire);
    const signed = await wallet.signTransaction(tx);
    return postSponsored(Buffer.from(signed.serialize()).toString("base64"));
  };
}

/** Polls for confirmation, so the island needs no websocket transport of its own. */
async function confirm(rpc: Rpc<SolanaRpcApi>, signature: string, lastValidBlockHeight: bigint) {
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][0]]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > lastValidBlockHeight) throw new Error(`Transaction ${signature} expired before it was confirmed.`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// --- reads -----------------------------------------------------------------------------------

/**
 * Decrypts the wallet's own confidential balance. Returns null when the token account does not
 * exist yet, which is the normal state before {@link planCreateAccount} has run.
 */
export async function loadBalance(session: ConfidentialSession): Promise<ConfidentialTransferBalance | null> {
  const { confidential } = await libs();
  try {
    return await confidential.fetchConfidentialTransferBalance({
      token: session.token,
      rpc: session.rpc,
      elgamalSecretKey: session.keys.elgamal.secret(),
      aesKey: session.keys.ae,
    });
  } catch (e) {
    if (/not\s*found|does not exist|AccountNotFound/i.test(String((e as Error)?.message ?? ""))) return null;
    throw e;
  }
}

// --- plans -----------------------------------------------------------------------------------

/** Walks the planner's tree in execution order. Running it sequentially is always safe. */
const flatten = (plan: { kind: string; message?: PlannedMessage; plans?: unknown[] }): PlannedMessage[] =>
  plan.kind === "single" ? [plan.message!] : (plan.plans as typeof plan[]).flatMap(flatten);

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** `TokenInstruction::ConfidentialTransferExtension`, then `ConfidentialTransferInstruction::Transfer`. */
const TRANSFER_DISCRIMINATOR = [27, 7];

const isConfidentialTransfer = (ix: Instruction) =>
  ix.programAddress === TOKEN_2022_PROGRAM &&
  !!ix.data &&
  ix.data[0] === TRANSFER_DISCRIMINATOR[0] &&
  ix.data[1] === TRANSFER_DISCRIMINATOR[1];

async function plan(session: ConfidentialSession, instructionPlan: unknown, l: Libs): Promise<PlannedMessage[]> {
  const { kit } = l;
  const planner = kit.createTransactionPlanner({
    createTransactionMessage: () =>
      kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.setTransactionMessageFeePayerSigner(session.payer, m)),
  });
  return flatten(await planner(instructionPlan as Parameters<typeof planner>[0]));
}

/** Appends to the last transaction of a plan, for callers with nothing to be adjacent to. */
function appendToLast(messages: PlannedMessage[], extra: Instruction[], { kit }: Libs): PlannedMessage[] {
  if (!extra.length) return messages;
  const last = messages.length - 1;
  messages[last] = kit.appendTransactionMessageInstructions(extra, messages[last]);
  return messages;
}

/**
 * Creates and configures the wallet's confidential token account: the ATA, the realloc for the
 * extension, `ConfigureAccount`, and the PubkeyValidity proof the ZK ElGamal program verifies.
 * Idempotent in effect — skip it when {@link loadBalance} already returns a balance.
 */
export async function planCreateAccount(session: ConfidentialSession, alsoInLastTransaction: Instruction[] = []): Promise<PlannedMessage[]> {
  const l = await libs();
  const messages = await plan(
    session,
    await l.confidential.getCreateConfidentialTransferAccountInstructionPlan({
      payer: session.payer,
      owner: session.authority,
      mint: session.mint,
      token: session.token,
      rpc: session.rpc,
      elgamalKeypair: session.keys.elgamal,
      aesKey: session.keys.ae,
    }),
    l,
  );
  return appendToLast(messages, alsoInLastTransaction, l);
}

/**
 * Moves everything credited to the pending balance into the available balance, re-encrypting it
 * locally. Needed after anything is received — a deposit from the public balance, or an incoming
 * confidential transfer — before it can be spent.
 */
export async function planApplyPending(session: ConfidentialSession, alsoInLastTransaction: Instruction[] = []): Promise<PlannedMessage[]> {
  const l = await libs();
  const { data } = await l.token.fetchToken(session.rpc, session.token);
  const messages = await plan(
    session,
    l.kit.sequentialInstructionPlan([
      l.confidential.getApplyConfidentialPendingBalanceInstructionFromToken({
        token: session.token,
        tokenAccount: data,
        authority: session.authority,
        elgamalSecretKey: session.keys.elgamal.secret(),
        aesKey: session.keys.ae,
      }),
    ]),
    l,
  );
  return appendToLast(messages, alsoInLastTransaction, l);
}

/**
 * Builds a confidential transfer of `amount` base units to `destinationToken`.
 *
 * The amount is split into lo/hi halves and the three required proofs are staged in context-state
 * accounts; the returned messages must run in order, and the last one carries the
 * `ConfidentialTransfer` instruction itself.
 *
 * `rightAfterTransfer` is for `pay_rent`. The program matches the transfer by position, not by
 * searching the transaction: it must be the instruction DIRECTLY before `pay_rent`
 * (docs/contracts/program-interface.md §3), so these instructions are spliced in immediately
 * after the transfer rather than appended to the end — the planner puts the context-state closes
 * after the transfer, and anything between the two would fail as `MissingConfidentialTransfer`.
 *
 * The auditor ElGamal key is read off the mint by the helper, so every transfer stays decryptable
 * by us for compliance without the app ever holding that key.
 */
export async function planTransfer(
  session: ConfidentialSession,
  opts: { destinationToken: Address; amount: bigint; rightAfterTransfer?: Instruction[] },
): Promise<PlannedMessage[]> {
  const l = await libs();
  const [source, destination, mint] = await Promise.all([
    l.token.fetchToken(session.rpc, session.token),
    l.token.fetchToken(session.rpc, opts.destinationToken),
    l.token.fetchMint(session.rpc, session.mint),
  ]);
  const messages = await plan(
    session,
    await l.confidential.getConfidentialTransferInstructionPlan({
      payer: session.payer,
      rpc: session.rpc,
      sourceToken: session.token,
      destinationToken: opts.destinationToken,
      mint: session.mint,
      authority: session.authority,
      amount: opts.amount,
      sourceTokenAccount: source.data,
      destinationTokenAccount: destination.data,
      mintAccount: mint.data,
      sourceElgamalKeypair: session.keys.elgamal,
      aesKey: session.keys.ae,
    }),
    l,
  );
  return opts.rightAfterTransfer?.length ? spliceAfterTransfer(messages, opts.rightAfterTransfer, l) : messages;
}

/**
 * Puts `extra` directly after the `ConfidentialTransfer` instruction, wherever the planner placed
 * it. Throws rather than guessing if the plan has no such instruction, because a silently wrong
 * position only shows up on chain as `MissingConfidentialTransfer`.
 */
function spliceAfterTransfer(messages: PlannedMessage[], extra: Instruction[], { kit }: Libs): PlannedMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const instructions = messages[i].instructions as readonly Instruction[];
    const at = instructions.findIndex(isConfidentialTransfer);
    if (at < 0) continue;
    const reordered = [...instructions.slice(0, at + 1), ...extra, ...instructions.slice(at + 1)];
    messages[i] = kit.appendTransactionMessageInstructions(
      reordered,
      // appendTransactionMessageInstructions only adds, so rebuild the instruction list from empty.
      { ...messages[i], instructions: [] } as PlannedMessage,
    );
    return messages;
  }
  throw new Error("No ConfidentialTransfer instruction in the plan, so there is nothing for pay_rent to sit behind.");
}

/** Runs planned messages in order, returning one signature per transaction. */
export async function runPlan(session: ConfidentialSession, messages: PlannedMessage[]): Promise<string[]> {
  const signatures: string[] = [];
  for (const message of messages) signatures.push(await session.submit(message));
  return signatures;
}

/** The Token-2022 associated token account a wallet receives confidential rUSDC into. */
export async function tokenAccountFor(owner: string, mint?: string): Promise<Address> {
  const l = await libs();
  return ataFor(l.kit.address(owner), l.kit.address(requireMint(mint)), l);
}

/**
 * Converts a web3.js/Anchor instruction into a kit one, so an Anchor-built `pay_rent` can ride in
 * the same transaction as the confidential transfer. Structural on purpose: this module does not
 * depend on Anchor's types.
 */
export interface Web3Instruction {
  programId: { toBase58(): string };
  keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}
export async function fromWeb3Instruction(ix: Web3Instruction): Promise<Instruction> {
  const { kit } = await libs();
  const { AccountRole } = kit;
  return {
    programAddress: kit.address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: kit.address(k.pubkey.toBase58()),
      role: k.isSigner
        ? k.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : k.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  };
}
