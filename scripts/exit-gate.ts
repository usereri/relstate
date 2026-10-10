// Phase 1 exit gate, scripted, on devnet, no browser.
//
//   node scripts/exit-gate.ts            # the full gate
//   node scripts/exit-gate.ts --probe    # no program needed: measure + policy-check a real proof plan
//
// The full gate: create listing -> apply -> propose lease -> fund deposit -> pay rent with a
// confidential transfer on the rUSDC mint, the fee paid by the fee-payer key for a tenant wallet
// holding 0 SOL. Then it proves the claims the demo makes rather than assuming them:
//
//   - the rent amount is NOT in the confirmed transaction (decoded from the chain, not from what we built);
//   - the auditor key decrypts EXACTLY the rent, and does not "decrypt" a different figure (negative control);
//   - the landlord can decrypt the payment with their own key;
//   - POST /api/rent/verify, run in-process against devnet, agrees;
//   - the reserve invariant holds.
//
// Env: ../demo/.env first, then ~/.config/relstate/keys/p1-backend.env on top (non-empty values win),
// because the demo worktree's .env has the key slots blank. Real environment variables beat both.
// Secrets are never printed: only addresses and signatures.
//
// Everything confidential runs through ../backend/src. scripts/ and backend/ each have their own
// copy of @solana/kit and the zk-sdk wasm, and two wasm instances cannot exchange ElGamal objects.
import * as anchor from "@anchor-lang/core";
import { fetchMint } from "@solana-program/token-2022";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { Relstate } from "../target/types/relstate.ts";

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } = anchor.web3;

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const PROBE = args.includes("--probe");

// ---- env ------------------------------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const value = line
      .slice(eq + 1)
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** Later files override earlier ones, but only with a non-empty value; the real environment beats all. */
function loadEnv(): string[] {
  const files = [resolve(ROOT, "../demo/.env"), resolve(homedir(), ".config/relstate/keys/p1-backend.env")];
  const merged: Record<string, string> = {};
  const used: string[] = [];
  for (const file of files) {
    const parsed = parseEnvFile(file);
    if (Object.keys(parsed).length > 0) used.push(file.replace(homedir(), "~"));
    for (const [k, v] of Object.entries(parsed)) if (v !== "" || !(k in merged)) merged[k] = v;
  }
  for (const [k, v] of Object.entries(merged)) {
    if ((process.env[k] ?? "") === "") process.env[k] = v;
  }
  // p1-backend.env points at key files inside a worktree that has since been removed. The same keys
  // were backed up under ~/.config/relstate/keys, so fall back to the canonical backup name.
  const backups: Record<string, string> = {
    TREASURY_KEYPAIR: "treasury.json",
    FEE_PAYER_KEYPAIR: "fee-payer.json",
    ATTESTATION_ISSUER_KEYPAIR: "attestation-issuer.json",
  };
  for (const [name, file] of Object.entries(backups)) {
    const spec = process.env[name] ?? "";
    if (spec === "" || spec.trim().startsWith("[") || existsSync(spec)) continue;
    const backup = resolve(homedir(), ".config/relstate/keys", file);
    if (existsSync(backup)) process.env[name] = backup;
  }
  // A script drives the chain directly: never let a demo file's mock defaults generate throwaway keys.
  process.env.BACKEND_MODE ??= "live";
  return used;
}
const envFiles = loadEnv();

// Dynamic, so backend/src/env.ts reads the environment AFTER the line above has filled it.
const { env, redactedRpcUrl } = await import("../backend/src/env.ts");
const keys = await import("../backend/src/keys.ts");
const rpcMod = await import("../backend/src/rpc.ts");
const conf = await import("../backend/src/confidential.ts");
const rentpay = await import("../backend/src/rentpay.ts");
const treasuryMod = await import("../backend/src/treasury.ts");
const txinspect = await import("../backend/src/txinspect.ts");
const { RELSTATE_PROGRAM } = await import("../backend/src/contracts.ts");

// ---- output ---------------------------------------------------------------------------------

const failures: string[] = [];
const warnings: string[] = [];
const say = (s = "") => console.log(s);
const pass = (s: string) => say(`  ✓ ${s}`);
const info = (s: string) => say(`    ${s}`);
function check(ok: boolean, what: string, detail = "") {
  if (ok) pass(what);
  else {
    say(`  ✗ ${what}${detail ? ` — ${detail}` : ""}`);
    failures.push(what);
  }
  return ok;
}
function warn(what: string) {
  say(`  ! ${what}`);
  warnings.push(what);
}
class Blocked extends Error {}
const blocked = (m: string): never => {
  throw new Blocked(m);
};
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ---- constants ------------------------------------------------------------------------------

// Odd on purpose: 8 bytes of 1_234_567 are far less likely to occur in a ciphertext by chance than a
// round number, and the plaintext search below means nothing for a figure that is easy to hit.
const RENT = 1_234_567n;
const DEPOSIT = 2_000_000n;
const TERM = 3;
const PERIOD_SECS = 45; // needs the `demo` build; a production build refuses < 28 days
const GRACE_SECS = 20;
const REGION: [number, number] = [80, 76];

// ---- setup ----------------------------------------------------------------------------------

const requireSpec = (value: string, name: string) => (value === "" ? blocked(`${name} is not set in any env file`) : value);
const toWeb3 = (spec: string) => Keypair.fromSecretKey(keys.parseKeyPairBytes(spec));
const kitSigner = (bytes: Uint8Array) => keys.loadKeyPairSigner(JSON.stringify([...bytes]), "gate actor");

/** Confidential keys the way a wallet gets them: from a signature of the derivation message. */
async function derive(signer: Awaited<ReturnType<typeof kitSigner>>) {
  const message = keys.confidentialSignerMessage();
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.keyPair.privateKey, message as never));
  return keys.confidentialKeysFromSignature(signature);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  say(PROBE ? "Exit gate (probe: no program needed)" : "Exit gate");
  say(`  rpc        ${redactedRpcUrl()} ${env.rpcIsHelius ? "(helius)" : "(public: retry + polling)"}`);
  say(`  env files  ${envFiles.join(", ") || "(none found)"}`);

  const treasurySpec = requireSpec(env.treasuryKeypair, "TREASURY_KEYPAIR");
  const feePayerSpec = requireSpec(env.feePayerKeypair, "FEE_PAYER_KEYPAIR");
  const mintAddress = requireSpec(env.rusdcMint, "RUSDC_MINT") as import("@solana/kit").Address;
  requireSpec(env.rusdcAuditorIkm, "RUSDC_AUDITOR_IKM");

  const treasuryKp = toWeb3(treasurySpec);
  const feePayerKp = toWeb3(feePayerSpec);
  if (treasuryKp.publicKey.equals(feePayerKp.publicKey)) blocked("treasury and fee payer must be different keys");
  const treasury = await keys.loadKeyPairSigner(treasurySpec, "treasury");
  const feePayer = await keys.loadKeyPairSigner(feePayerSpec, "fee payer");

  const client = rpcMod.getSolanaClient();
  const connection = new Connection(env.rpcUrl, { commitment: "confirmed", fetch: rpcMod.retryingFetch });

  // ---- A. preflight -------------------------------------------------------------------------
  say("\nA. Preflight");
  const programId = new PublicKey(RELSTATE_PROGRAM);
  const programInfo = await connection.getAccountInfo(programId);
  const programDeployed = !!programInfo?.executable;
  say(`  program    ${RELSTATE_PROGRAM}`);
  say(`  mint       ${mintAddress}`);
  say(`  treasury   ${treasury.address}`);
  say(`  fee payer  ${feePayer.address}`);
  if (!PROBE && !programDeployed) {
    blocked(
      `the relstate program ${RELSTATE_PROGRAM} is not deployed on ${env.cluster}. Deploy it first (see docs/contracts/pay.md), ` +
        "or run with --probe to check the confidential-transfer plan without it.",
    );
  }
  if (programDeployed) pass("program is deployed");

  const mint = (await fetchMint(client.rpc as never, mintAddress)).data;
  check(mint.decimals === 6, "rUSDC has 6 decimals");
  const treasurySol = (await connection.getBalance(treasuryKp.publicKey)) / LAMPORTS_PER_SOL;
  const feeSol = (await connection.getBalance(feePayerKp.publicKey)) / LAMPORTS_PER_SOL;
  say(`  balances   treasury ${treasurySol.toFixed(3)} SOL, fee payer ${feeSol.toFixed(3)} SOL`);
  if (treasurySol < 0.15) blocked(`treasury has ${treasurySol.toFixed(3)} SOL; the gate needs about 0.15 (it spends rent, most of it refunded)`);
  if (feeSol < 0.02) blocked(`fee payer has ${feeSol.toFixed(3)} SOL; the gate needs about 0.02 for fees`);

  const mode = env.usdcReserveTokenAccount === "" ? "mock" : "live";
  const treasurySvc = treasuryMod.createTreasury({
    rpc: client.rpc as never,
    run: rpcMod.createPlanRunner(client, (...a) => info(a.join(" "))),
    treasury,
    mint: mintAddress,
    decimals: 6,
    mode,
    reserveTokenAccount: env.usdcReserveTokenAccount === "" ? undefined : (env.usdcReserveTokenAccount as never),
  });
  if (mode === "mock") {
    warn("USDC_RESERVE_TOKEN_ACCOUNT is not set, so the reserve invariant below is checked against the mock ledger, not a real USDC account");
  }

  // ---- anchor plumbing ----------------------------------------------------------------------
  const idlPath = resolve(ROOT, "target/idl/relstate.json");
  if (!existsSync(idlPath)) blocked("target/idl/relstate.json is missing: run `anchor build -- --features demo` first");
  const idl: Relstate = JSON.parse(readFileSync(idlPath, "utf8"));
  if (idl.address !== RELSTATE_PROGRAM) blocked(`the IDL's program id ${idl.address} is not ${RELSTATE_PROGRAM}`);
  const program = new anchor.Program<Relstate>(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(treasuryKp), { commitment: "confirmed" }));

  /** Signs with the given keypairs, fee paid by the fee-payer key, polled to confirmation. */
  async function sendTx(tx: anchor.web3.Transaction, signers: anchor.web3.Keypair[]) {
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = feePayerKp.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.partialSign(feePayerKp, ...signers);
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    for (let i = 0; ; i++) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
      if (i % 8 === 7 && (await connection.getBlockHeight("confirmed")) > latest.lastValidBlockHeight) {
        throw new Error(`transaction ${signature} expired before it was confirmed`);
      }
      await sleep(600);
    }
  }
  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const u64 = (n: bigint | number) => new anchor.BN(n.toString()).toArrayLike(Buffer, "le", 8);

  // ---- B. config ----------------------------------------------------------------------------
  const config = pda(Buffer.from("config"));
  if (!PROBE) {
    say("\nB. Program config (idempotent)");
    let cfg = await program.account.config.fetchNullable(config);
    if (cfg === null) {
      await sendTx(await program.methods.initConfig().accountsPartial({ admin: treasuryKp.publicKey, config }).transaction(), [treasuryKp]);
      pass(`init_config: the treasury is the admin`);
      cfg = await program.account.config.fetch(config);
    } else {
      pass(`config exists, admin ${cfg.admin.toBase58()}`);
    }
    if (cfg.mints.some((m) => m.toBase58() === mintAddress)) {
      pass("rUSDC is already on the allowlist");
    } else {
      if (!cfg.admin.equals(treasuryKp.publicKey)) {
        blocked(`config admin is ${cfg.admin.toBase58()}, not the treasury, so the gate cannot allow rUSDC. Ask the admin to run set_mint_allowed, or set_admin to the treasury.`);
      }
      await sendTx(
        await program.methods.setMintAllowed(true).accountsPartial({ admin: treasuryKp.publicKey, config, mint: new PublicKey(mintAddress) }).transaction(),
        [treasuryKp],
      );
      pass("set_mint_allowed: rUSDC added to the allowlist");
    }
  }

  // ---- C. actors ----------------------------------------------------------------------------
  say("\nC. Actors");
  const landlordBytes = await keys.generateKeyPairBytes();
  const tenantBytes = await keys.generateKeyPairBytes();
  const landlordKp = Keypair.fromSecretKey(landlordBytes);
  const tenantKp = Keypair.fromSecretKey(tenantBytes);
  const landlord = await kitSigner(landlordBytes);
  const tenant = await kitSigner(tenantBytes);
  const landlordKeys = await derive(landlord);
  const tenantKeys = await derive(tenant);
  say(`  landlord   ${landlord.address}`);
  say(`  tenant     ${tenant.address}`);

  const fund = async (to: anchor.web3.PublicKey, sol: number) =>
    sendTx(new Transaction().add(SystemProgram.transfer({ fromPubkey: treasuryKp.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [treasuryKp]);
  if (!PROBE) {
    // Account rent the PROGRAM charges its caller (listing, lease, vault, profiles, application) is paid
    // by the actor, not the sponsor: the sponsor refuses any instruction that names the fee payer.
    await fund(landlordKp.publicKey, 0.02);
    await fund(tenantKp.publicKey, 0.01);
    pass("landlord and tenant funded with account rent only (the tenant is drained back to 0 SOL before paying)");
  }

  await treasurySvc.ensureAccount(landlord, landlordKeys);
  pass("landlord has a private-balance account (treasury paid the rent)");

  // ---- D. tenant balance --------------------------------------------------------------------
  say("\nD. Tenant balance");
  const wrapAmount = DEPOSIT + 2n * RENT;
  const supplyBefore = await treasurySvc.supply();
  treasurySvc.creditReserve(wrapAmount, "exit-gate");
  const wrapped = await treasurySvc.wrapAndMakeConfidential({ owner: tenant, amount: wrapAmount, publicHoldback: DEPOSIT, keys: tenantKeys, ref: "exit-gate" });
  pass(`minted ${wrapAmount} base units; ${wrapped.confidentialAmount} private, ${DEPOSIT} held public for fund_deposit`);
  const tenantToken = await conf.associatedTokenAddress(tenant.address, mintAddress);
  const landlordToken = await conf.associatedTokenAddress(landlord.address, mintAddress);
  const balance = await conf.readConfidentialBalance(client.rpc as never, tenantToken, tenantKeys);
  check(balance.availableBalance === 2n * RENT, "tenant's private balance decrypts to exactly what was secured", `${balance.availableBalance}`);

  // ---- E. lifecycle -------------------------------------------------------------------------
  const listingId = BigInt(Date.now());
  const leaseId = listingId + 1n;
  const listing = pda(Buffer.from("listing"), landlordKp.publicKey.toBuffer(), u64(listingId));
  const lease = pda(Buffer.from("lease"), landlordKp.publicKey.toBuffer(), u64(leaseId));
  const vault = pda(Buffer.from("vault"), lease.toBuffer());
  const profile = (who: anchor.web3.PublicKey) => pda(Buffer.from("profile"), who.toBuffer());
  const token2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  const mintKey = new PublicKey(mintAddress);

  if (!PROBE) {
    say("\nE. Lease lifecycle");
    await sendTx(
      await program.methods
        .createListing(new anchor.BN(listingId.toString()), new anchor.BN(RENT.toString()), new anchor.BN(DEPOSIT.toString()), REGION, "Exit-gate flat", "Kraków", "scripted", "")
        .accountsPartial({ landlord: landlordKp.publicKey, listing })
        .transaction(),
      [landlordKp],
    );
    pass("create_listing");
    const application = pda(Buffer.from("application"), listing.toBuffer(), tenantKp.publicKey.toBuffer());
    await sendTx(await program.methods.apply().accountsPartial({ tenant: tenantKp.publicKey, listing, application }).transaction(), [tenantKp]);
    pass("apply");
    const hash = Array.from(randomBytes(32));
    await sendTx(
      await program.methods
        .proposeLease(new anchor.BN(leaseId.toString()), new anchor.BN(RENT.toString()), new anchor.BN(DEPOSIT.toString()), new anchor.BN(PERIOD_SECS), new anchor.BN(GRACE_SECS), TERM, hash, REGION)
        .accountsPartial({
          landlord: landlordKp.publicKey,
          tenant: tenantKp.publicKey,
          tenantProfile: profile(tenantKp.publicKey),
          mint: mintKey,
          lease,
          vault,
          landlordProfile: profile(landlordKp.publicKey),
          tokenProgram: token2022,
        })
        .transaction(),
      [landlordKp],
    ).catch((e: Error) => {
      if (/PeriodTooShort|0x1770|MinPeriod/i.test(e.message)) blocked("propose_lease refused a 45s period: the deployed program is not the `demo` build (anchor build -- --features demo)");
      throw e;
    });
    pass("propose_lease");
    await sendTx(
      await program.methods
        .fundDeposit(hash)
        .accountsPartial({
          tenant: tenantKp.publicKey,
          lease,
          mint: mintKey,
          vault,
          tenantAta: new PublicKey(tenantToken),
          tenantProfile: profile(tenantKp.publicKey),
          tokenProgram: token2022,
        })
        .transaction(),
      [tenantKp],
    );
    const vaultBalance = BigInt((await connection.getTokenAccountBalance(vault)).value.amount);
    check(vaultBalance === DEPOSIT, "fund_deposit moved the public deposit into the vault", `${vaultBalance}`);

    // The tenant needed SOL only for the program's account rent. Hand it back: paying rent is the claim.
    const left = await connection.getBalance(tenantKp.publicKey);
    if (left > 0) await sendTx(new Transaction().add(SystemProgram.transfer({ fromPubkey: tenantKp.publicKey, toPubkey: treasuryKp.publicKey, lamports: left })), [tenantKp]);
    check((await connection.getBalance(tenantKp.publicKey)) === 0, "tenant now holds exactly 0 SOL");
  }

  // ---- F. pay rent --------------------------------------------------------------------------
  say(`\nF. ${PROBE ? "Probe a rent payment (nothing is sent)" : "Pay rent privately, fee paid by the fee payer"}`);
  const payRentIx = await program.methods
    .payRent()
    .accountsPartial({
      tenant: tenantKp.publicKey,
      lease,
      mint: mintKey,
      tenantAta: new PublicKey(tenantToken),
      landlordAta: new PublicKey(landlordToken),
      tenantProfile: profile(tenantKp.publicKey),
      tokenProgram: token2022,
    })
    .instruction();
  const rider = [
    {
      programId: payRentIx.programId.toBase58(),
      keys: payRentIx.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: new Uint8Array(payRentIx.data),
    },
  ];

  const { messages, carriesTransfer } = await rentpay.planRentPayment({
    client,
    payer: feePayer,
    authority: tenant,
    sourceToken: tenantToken,
    destinationToken: landlordToken,
    mint: mintAddress,
    mintAccount: mint,
    amount: RENT,
    sourceKeys: tenantKeys,
    rider,
  });
  pass(`planned ${messages.length} transactions; the transfer and pay_rent are in #${carriesTransfer + 1}`);

  // Would /api/sponsor accept these? Checked against the real inspector, on the real transactions.
  let sponsorRejects = 0;
  const sent: string[] = [];
  for (const [i, message] of messages.entries()) {
    const signed = await rentpay.signPlanned(client, message);
    const tooBig = signed.bytes > 1232;
    let verdict = "accepted";
    try {
      const inspected = txinspect.inspectTransaction(signed.wire, { maxBytes: 100_000, maxInstructions: 64 });
      txinspect.assertSponsorNotUsedByInstructions(inspected, feePayer.address);
    } catch (e) {
      verdict = `REJECTED: ${(e as Error).message}`;
      sponsorRejects++;
    }
    info(`tx ${i + 1}/${messages.length}: ${signed.bytes} bytes${tooBig ? " (OVER the 1232-byte limit)" : ""}; sponsor policy ${verdict}`);
    if (tooBig) failures.push(`transaction ${i + 1} is ${signed.bytes} bytes, over the 1232-byte limit`);
    if (!PROBE && !tooBig) {
      sent.push(await rpcMod.sendAndConfirmByPolling(client, signed.transaction, { blockhash: signed.blockhash.blockhash }));
      info(sent[sent.length - 1]!);
    }
  }
  if (sponsorRejects > 0) {
    warn(
      `/api/sponsor would REJECT ${sponsorRejects} of ${messages.length} transactions: the proof plan funds its context-state accounts from the payer, ` +
        "and the sponsor refuses any instruction that names the fee payer. The gate paid the fee directly with the fee-payer key. See docs/contracts/pay.md.",
    );
  }
  if (PROBE) return finish();

  const transferSignature = sent[carriesTransfer]!;
  say(`  ${explorer(transferSignature)}`);
  const onChain = await program.account.lease.fetch(lease);
  check(onChain.paidCount === 1, "pay_rent recorded the payment (paid_count = 1)");

  // ---- G. what the chain shows --------------------------------------------------------------
  say("\nG. Privacy and audit");
  const plain = await rentpay.findPlaintextAmount(client.rpc as never, transferSignature as never, RENT);
  check(plain.hits.length === 0, `the rent (${RENT}) does not appear in the confirmed transaction`, JSON.stringify(plain.hits));
  info(`searched ${plain.instructions} instructions of the confirmed transaction for the amount as a little-endian u64`);

  const auditor = keys.getAuditorKeys();
  const verdict = await conf.verifyRentPayment(client.rpc as never, transferSignature as never, {
    relstateProgram: RELSTATE_PROGRAM as never,
    expectedAmount: RENT,
    auditorSecret: auditor.elgamal.secret(),
  });
  check(verdict.ok && verdict.settledAmount === RENT, "the auditor key decrypts exactly the rent", `settled ${verdict.settledAmount}`);
  const wrong = await conf.verifyRentPayment(client.rpc as never, transferSignature as never, {
    relstateProgram: RELSTATE_PROGRAM as never,
    expectedAmount: RENT + 1n,
    auditorSecret: auditor.elgamal.secret(),
  });
  check(!wrong.ok, "negative control: the same check rejects a wrong expected amount");

  const landlordBalance = await conf.readConfidentialBalance(client.rpc as never, landlordToken, landlordKeys);
  check(landlordBalance.pendingBalance === RENT, "the landlord decrypts the payment with their own key", `${landlordBalance.pendingBalance}`);
  const after = await conf.readConfidentialBalance(client.rpc as never, tenantToken, tenantKeys);
  check(after.availableBalance === RENT, "the tenant's private balance fell by exactly the rent", `${after.availableBalance}`);

  // The same check the app calls, through the real route, in-process.
  const { createApp } = await import("../backend/src/server.ts");
  const { createServices } = await import("../backend/src/services.ts");
  const { createSessionToken } = await import("../backend/src/auth.ts");
  const app = createApp(createServices(() => {}));
  const res = await app.request("/api/rent/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${createSessionToken(tenant.address).token}` },
    body: JSON.stringify({ signature: transferSignature, lease: lease.toBase58() }),
  });
  const body = (await res.json()) as { ok?: boolean; settledAmount?: string };
  check(res.status === 200 && body.ok === true && body.settledAmount === RENT.toString(), "POST /api/rent/verify agrees", JSON.stringify(body));

  // ---- H. reserve ---------------------------------------------------------------------------
  say("\nH. Reserve invariant");
  const inv = await treasurySvc.invariant();
  check(inv.ok, `supply ${inv.supply} <= reserve ${inv.reserve} (${inv.reserveSource})`);
  check(inv.supply - supplyBefore === wrapAmount, "supply grew by exactly what was wrapped; the transfer minted nothing");

  finish();
}

function finish() {
  say("");
  if (warnings.length > 0) say(`${warnings.length} warning(s) — read them above.`);
  if (failures.length > 0) {
    say(`GATE FAILED: ${failures.length} check(s)`);
    for (const f of failures) say(`  - ${f}`);
    process.exit(1);
  }
  say(PROBE ? "PROBE DONE" : "GATE PASSED");
}

main().catch((e) => {
  if (e instanceof Blocked) {
    say(`\nBLOCKED: ${e.message}`);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
