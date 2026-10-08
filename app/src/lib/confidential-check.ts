/**
 * Developer check for the confidential-balance island, run in a real browser.
 *
 * It is NOT part of the app: `app/confidential-check.html` is its own Vite entry, so building it
 * is what proves `confidential.ts` and the `@solana/zk-sdk` wasm come out of Vite's pipeline
 * intact, and opening it on the dev server is what proves they then work against devnet.
 *
 * Needs `app/.env.local` (git-ignored):
 *
 *   VITE_RPC=https://api.devnet.solana.com      # or a Helius devnet URL
 *   VITE_CT_PAYER=[12,34,...]                   # 64-byte devnet throwaway keypair, with some SOL
 *   VITE_RUSDC_MINT=<address>                   # optional: reuses a mint instead of making one
 *
 * VITE_CT_PAYER pays fees and the rent for the proof context-state accounts. Use a throwaway
 * devnet key: anything in a VITE_ variable is compiled into the page.
 */
import { RPC, RUSDC_MINT } from "./config";
import { localWallet } from "./wallet";

const out = document.getElementById("out")!;
const lines: string[] = [];
const write = (text: string, cls = "") => {
  lines.push(cls ? `<span class="${cls}">${text}</span>` : text);
  out.innerHTML = lines.join("\n");
  out.className = "";
};
const step = (text: string) => write(`→ ${text}`, "dim");
const pass = (text: string) => write(`✓ ${text}`, "ok");

async function main() {
  const { address, createKeyPairSignerFromBytes, generateKeyPairSigner } = await import("@solana/kit");
  const t22 = await import("@solana-program/token-2022");
  const conf = await import("./confidential");

  write(`rpc    ${RPC}`);

  const secret = import.meta.env.VITE_CT_PAYER;
  if (!secret) throw new Error("Set VITE_CT_PAYER in app/.env.local to a 64-byte devnet throwaway keypair.");
  const payer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(secret)));
  write(`payer  ${payer.address}`);

  // 1. Key derivation through the wallet contract: the dedicated capability, never signMessage.
  step("deriving confidential keys from the wallet's key-derivation capability");
  const wallet = localWallet("tenant");
  const keys = await conf.deriveKeys(wallet);
  pass(`keys derived for ${wallet.publicKey.toBase58()} (kind: ${wallet.kind})`);

  // The generic signer must refuse the same message.
  let refused = false;
  await wallet.signMessage!(new TextEncoder().encode("solana-conf-bal/v1")).catch(() => (refused = true));
  if (!refused) throw new Error("generic signMessage accepted the derivation message");
  pass("generic signMessage refuses the derivation message");

  // 2. A confidential mint to work against. Lane B's rUSDC replaces this via VITE_RUSDC_MINT.
  let mint = RUSDC_MINT;
  const rpcForSetup = (await import("@solana/kit")).createSolanaRpc(RPC);
  if (!mint) {
    step("creating a throwaway Token-2022 confidential mint (no VITE_RUSDC_MINT set)");
    const newMint = await generateKeyPairSigner();
    const session = await conf.openLocalSession({ signer: payer, keys, mint: newMint.address, rpcUrl: RPC });
    const plan = await t22.getCreateMintInstructionPlan(
      { getMinimumBalance: async (n: number) => rpcForSetup.getMinimumBalanceForRentExemption(BigInt(n)).send() },
      {
        payer,
        newMint,
        decimals: 6,
        mintAuthority: payer,
        extensions: [{ __kind: "ConfidentialTransferMint", authority: payer.address, autoApproveNewAccounts: true, auditorElgamalPubkey: null }],
      },
    );
    await conf.runPlan(session, await planMessages(session, plan));
    mint = newMint.address;
    pass(`mint ${mint}`);
  } else {
    write(`mint   ${mint} (from VITE_RUSDC_MINT)`);
  }

  const session = await conf.openLocalSession({ signer: payer, keys, mint, rpcUrl: RPC });
  write(`token  ${session.token}`);

  // 3. Confidential account, funded so there is something to decrypt.
  if ((await conf.loadBalance(session)) === null) {
    step("creating + configuring the confidential account (PubkeyValidity proof)");
    await conf.runPlan(session, await conf.planCreateAccount(session));
    pass("confidential account configured");

    step("minting 1.000000 to the public balance, then depositing it");
    await conf.runPlan(
      session,
      await planMessages(session, [
        t22.getMintToInstruction({ mint: address(mint), token: session.token, mintAuthority: payer, amount: 1_000_000n }),
        t22.getConfidentialDepositInstruction({ token: session.token, mint: address(mint), authority: payer, amount: 1_000_000n, decimals: 6 }),
      ]),
    );
    pass("deposited to the pending balance");
  } else {
    write("       confidential account already exists", "dim");
  }

  // 4. Apply pending, then decrypt.
  step("applying the pending balance");
  await conf.runPlan(session, await conf.planApplyPending(session));
  pass("pending balance applied");

  step("fetching + decrypting the confidential balance");
  const balance = await conf.loadBalance(session);
  if (!balance) throw new Error("balance came back null after apply-pending");
  pass(`available ${balance.availableBalance} · pending ${balance.pendingBalance} · total ${balance.totalBalance}`);
  if (balance.availableBalance <= 0n) throw new Error("available balance decrypted to zero; nothing to transfer");

  // 5. Build and run a confidential transfer to a second account.
  step("preparing a destination confidential account");
  const recipient = await generateKeyPairSigner();
  const recipientKeys = await conf.deriveKeys(localWallet("landlord"));
  const recipientSession = await conf.openLocalSession({ signer: payer, keys: recipientKeys, mint, rpcUrl: RPC });
  // Same payer, but the account is owned by the recipient and keyed with the recipient's keys.
  const destination = await conf.tokenAccountFor(recipient.address, mint);
  await conf.runPlan(
    recipientSession,
    await planMessages(
      recipientSession,
      await (await import("@solana-program/token-2022/confidential")).getCreateConfidentialTransferAccountInstructionPlan({
        payer,
        owner: recipient,
        mint: address(mint),
        token: destination,
        rpc: recipientSession.rpc,
        elgamalKeypair: recipientKeys.elgamal,
        aesKey: recipientKeys.ae,
      }),
    ),
  );
  pass(`destination ${destination}`);

  step("building the confidential transfer plan (equality + validity + range proofs)");
  const amount = 250_000n;
  // A marker instruction stands in for pay_rent until Lane P publishes the layout; it proves the
  // caller can put its own instruction in the same transaction as the transfer itself.
  const marker = await conf.fromWeb3Instruction({
    programId: { toBase58: () => "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" },
    keys: [],
    data: new TextEncoder().encode("pay_rent stand-in"),
  });
  const messages = await conf.planTransfer(session, { destinationToken: destination, amount, alsoInLastTransaction: [marker] });
  pass(`plan: ${messages.length} transactions, instruction counts ${messages.map((m) => m.instructions.length).join(", ")}`);
  const last = messages[messages.length - 1];
  if (last.instructions[last.instructions.length - 1].programAddress !== "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
    throw new Error("the appended instruction did not land last in the final transaction");
  pass("the caller's instruction rides in the same transaction as the transfer");

  step("submitting the transfer");
  const signatures = await conf.runPlan(session, messages);
  pass(`transferred ${amount} confidentially in ${signatures.length} transactions`);
  signatures.forEach((s) => write(`       https://explorer.solana.com/tx/${s}?cluster=devnet`, "dim"));

  const after = await conf.loadBalance(session);
  pass(`sender available now ${after!.availableBalance} (was ${balance.availableBalance})`);
  write("");
  write("ALL CHECKS PASSED", "ok");
}

/** Plans a bare instruction list or an existing instruction plan onto this session's fee payer. */
async function planMessages(session: Awaited<ReturnType<typeof import("./confidential").openLocalSession>>, plan: unknown) {
  const kit = await import("@solana/kit");
  const planner = kit.createTransactionPlanner({
    createTransactionMessage: () =>
      kit.pipe(kit.createTransactionMessage({ version: 0 }), (m) => kit.setTransactionMessageFeePayerSigner(session.payer, m)),
  });
  const input = Array.isArray(plan) ? kit.sequentialInstructionPlan(plan) : plan;
  const planned = await planner(input as Parameters<typeof planner>[0]);
  const flatten = (p: { kind: string; message?: unknown; plans?: unknown[] }): unknown[] =>
    p.kind === "single" ? [p.message] : (p.plans as typeof p[]).flatMap(flatten);
  return flatten(planned) as Awaited<ReturnType<typeof import("./confidential").planCreateAccount>>;
}

main().catch((e) => {
  write("");
  write(`✗ ${e?.message ?? e}`, "bad");
  if (e?.stack) write(String(e.stack), "dim");
  console.error(e);
});
