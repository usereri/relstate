import {
  createSolanaRpc, createSolanaRpcSubscriptions, generateKeyPairSigner, airdropFactory, lamports,
  sendAndConfirmTransactionFactory, createTransactionPlanner, createTransactionPlanExecutor,
  pipe, createTransactionMessage, setTransactionMessageFeePayerSigner, appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, getSignatureFromTransaction,
  assertIsSendableTransaction, assertIsTransactionWithBlockhashLifetime, sequentialInstructionPlan,
} from "@solana/kit";
import * as t22base from "@solana-program/token-2022";
import * as t22conf from "@solana-program/token-2022/confidential";
const t22 = { ...t22base, ...t22conf };
import { ConfidentialKeys } from "@solana/zk-sdk";

const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => {
  for (let i = 0; ; i++) {
    const r = await realFetch(...a);
    if (r.status !== 429 || i > 8) return r;
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
};
const URL = process.env.RPC ?? "https://api.devnet.solana.com";
const WS = URL.replace("https", "wss").replace("http", "ws");
const rpc = createSolanaRpc(URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const log = (...a) => console.log(...a);

const planner = (payer) =>
  createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m)),
  });
const executor = createTransactionPlanExecutor({
  executeTransactionMessage: async (_ctx, message) => {
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const m = setTransactionMessageLifetimeUsingBlockhash(bh, message);
    const tx = await signTransactionMessageWithSigners(m);
    assertIsSendableTransaction(tx);
    assertIsTransactionWithBlockhashLifetime(tx);
    await sendAndConfirm(tx, { commitment: "confirmed", skipPreflight: false });
    log("   tx", getSignatureFromTransaction(tx));
    return { transaction: tx };
  },
});
async function run(payer, instructionPlan, label) {
  log(`-> ${label}`);
  const tp = await planner(payer)(instructionPlan);
  await executor(tp);
}

import fs from "fs";
import { createKeyPairSignerFromBytes, createKeyPairFromBytes } from "@solana/kit";
// persist the throwaway payer so reruns do not need new funding
let payer;
if (fs.existsSync(".payer.json")) payer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(fs.readFileSync(".payer.json"))));
else {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).slice(-32);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const bytes = new Uint8Array([...pkcs8, ...pub]);
  fs.writeFileSync(".payer.json", JSON.stringify([...bytes]));
  payer = await createKeyPairSignerFromBytes(bytes);
}
const mint = await generateKeyPairSigner();
const alice = await generateKeyPairSigner();
const bob = await generateKeyPairSigner();
log("payer", payer.address);

if (!URL.includes("devnet")) log("(non-devnet RPC)");
if ((await rpc.getBalance(payer.address).send()).value < 300_000_000n) {
  // faucet is rate-limited: fund the throwaway payer from the dev keypair (user-approved, 1 devnet SOL)
  const fs = await import("fs");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { getTransferSolInstruction } = await import("@solana-program/system");
  const funder = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json"))));
  await run(funder, sequentialInstructionPlan([getTransferSolInstruction({ source: funder, destination: payer.address, amount: 1_000_000_000n })]), "fund payer");
}
log("airdrop ok");

// keys derived like a wallet would (fixed bytes stand in for the wallet signature)
const keysFor = (seed) => {
  const k = ConfidentialKeys.fromIkm(new Uint8Array(32).fill(seed));
  return { elgamal: k.elgamal(), ae: k.ae() };
};
const A = keysFor(1), B = keysFor(2);

await run(payer, await t22.getCreateMintInstructionPlan(
  { getMinimumBalance: async (n) => rpc.getMinimumBalanceForRentExemption(BigInt(n)).send() },
  {
    payer, newMint: mint, decimals: 6, mintAuthority: payer,
    extensions: [{
      __kind: "ConfidentialTransferMint", authority: payer.address, autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    }],
  }), "create CT mint");

const tokenA = (await t22.findAssociatedTokenPda({ owner: alice.address, mint: mint.address, tokenProgram: t22.TOKEN_2022_PROGRAM_ADDRESS }))[0];
const tokenB = (await t22.findAssociatedTokenPda({ owner: bob.address, mint: mint.address, tokenProgram: t22.TOKEN_2022_PROGRAM_ADDRESS }))[0];

for (const [name, owner, token, K] of [["alice", alice, tokenA, A], ["bob", bob, tokenB, B]]) {
  await run(payer, await t22.getCreateConfidentialTransferAccountInstructionPlan({
    payer, owner, mint: mint.address, token, rpc,
    elgamalKeypair: K.elgamal, aesKey: K.ae,
  }), `create + configure confidential account (${name}) [needs ZK proof program]`);
}
log("RESULT: configure (PubkeyValidity proof) works on", URL);

await run(payer, t22.getMintToInstructionPlan?.({ mint: mint.address, token: tokenA, mintAuthority: payer, amount: 1_000_000n })
  ?? sequentialInstructionPlan([t22.getMintToInstruction({ mint: mint.address, token: tokenA, mintAuthority: payer, amount: 1_000_000n })]),
  "mint 1 USDC-unit to alice (public balance)");
await run(payer, sequentialInstructionPlan([t22.getConfidentialDepositInstruction({
  token: tokenA, mint: mint.address, authority: alice, amount: 1_000_000n, decimals: 6,
})]), "alice: public -> pending confidential");
const fetchTok = (a) => t22.fetchToken(rpc, a);
await run(payer, sequentialInstructionPlan([t22.getApplyConfidentialPendingBalanceInstructionFromToken({
  token: tokenA, tokenAccount: (await fetchTok(tokenA)).data, authority: alice,
  elgamalSecretKey: A.elgamal.secret(), aesKey: A.ae,
})]), "alice: apply pending balance");
log("alice balance", await t22.fetchConfidentialTransferBalance({ token: tokenA, rpc, elgamalSecretKey: A.elgamal.secret(), aesKey: A.ae }));
log("RESULT: deposit + apply works");

await run(payer, await t22.getConfidentialTransferInstructionPlan({
  payer, rpc, sourceToken: tokenA, destinationToken: tokenB, mint: mint.address, authority: alice,
  amount: 250_000n, sourceTokenAccount: (await fetchTok(tokenA)).data,
  destinationTokenAccount: (await fetchTok(tokenB)).data, mintAccount: (await t22.fetchMint(rpc, mint.address)).data,
  sourceElgamalKeypair: A.elgamal, aesKey: A.ae,
}), "alice -> bob confidential transfer 0.25");
log("RESULT: confidential transfer works. pending bob:", (await fetchTok(tokenB)).data.extensions);
