// Phase 1, step 6: create the rUSDC mint.
//
//   node scripts/make-rusdc.ts                      # devnet, treasury key from .env or generated
//   node scripts/make-rusdc.ts --funder <keypair>   # also top the treasury up from that key
//   RPC_URL=... node scripts/make-rusdc.ts          # or HELIUS_API_KEY=...
//
// Writes TREASURY_KEYPAIR, RUSDC_MINT, RUSDC_AUDITOR_IKM and
// RUSDC_AUDITOR_ELGAMAL_PUBKEY into the git-ignored .env and prints every
// address. Refuses to create a second mint when RUSDC_MINT is already set
// unless --force is passed.
//
// Everything is imported through ../backend/src on purpose: scripts/ has no
// node_modules of its own, and a relative import resolves its dependencies from
// backend/ where @solana/kit actually lives.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, env, redactedRpcUrl } from "../backend/src/env.ts";
import { auditorElgamalAddress, confidentialKeysFromIkm, generateKeyPairBytes, loadKeyPairSigner } from "../backend/src/keys.ts";
import { RUSDC_DECIMALS, createRusdcMint, fundAccount } from "../backend/src/mint.ts";
import { createPlanRunner, getSolanaClient } from "../backend/src/rpc.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const ENV_PATH = resolve(REPO_ROOT, ".env");
const KEYS_DIR = resolve(REPO_ROOT, ".keys");
/**
 * The mint's rent plus headroom for the confidential-transfer proof plans,
 * whose context-state accounts are large. `spikes/ct` used the same threshold.
 */
const MIN_TREASURY_LAMPORTS = 300_000_000n;

/** Upserts keys in .env, leaving every other line untouched. Never logs a value. */
function writeEnv(updates: Record<string, string>): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_PATH, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function resolveTreasury() {
  if (env.treasuryKeypair !== "") {
    return { signer: await loadKeyPairSigner(env.treasuryKeypair, "TREASURY_KEYPAIR"), created: false };
  }
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  const path = resolve(KEYS_DIR, "treasury.json");
  writeFileSync(path, JSON.stringify([...(await generateKeyPairBytes())]), { mode: 0o600 });
  writeEnv({ TREASURY_KEYPAIR: path });
  return { signer: await loadKeyPairSigner(path, "TREASURY_KEYPAIR"), created: true };
}

async function main(): Promise<void> {
  if (env.rusdcMint !== "" && !has("force")) {
    console.error(`RUSDC_MINT is already set to ${env.rusdcMint}. Pass --force to create another mint.`);
    process.exit(1);
  }

  const client = getSolanaClient();
  const run = createPlanRunner(client, console.log);
  console.log(`cluster   ${env.cluster}`);
  console.log(`rpc       ${redactedRpcUrl()}${env.rpcIsHelius ? " (helius)" : " (public — retry/backoff is on)"}`);

  const treasury = await resolveTreasury();
  console.log(`treasury  ${treasury.signer.address}${treasury.created ? " (generated, saved to .keys/treasury.json)" : ""}`);

  // The auditor key is the whole compliance story for this mint: 32 bytes of
  // seed material that decrypts every transfer amount. It goes in .env and
  // never anywhere near the app bundle.
  const ikm =
    env.rusdcAuditorIkm !== "" ? new Uint8Array(Buffer.from(env.rusdcAuditorIkm, "base64")) : new Uint8Array(randomBytes(32));
  if (env.rusdcAuditorIkm !== "") console.log("auditor   reusing RUSDC_AUDITOR_IKM from .env");
  const auditorElgamalPubkey = auditorElgamalAddress(confidentialKeysFromIkm(ikm));
  console.log(`auditor   ${auditorElgamalPubkey} (ElGamal pubkey)`);

  let balance = (await client.rpc.getBalance(treasury.signer.address, { commitment: "confirmed" }).send()).value;
  const funderPath = flag("funder");
  if (balance < MIN_TREASURY_LAMPORTS && funderPath !== undefined) {
    const funder = await loadKeyPairSigner(funderPath, "--funder");
    const top = MIN_TREASURY_LAMPORTS - balance;
    console.log(`funding   ${top} lamports from ${funder.address}`);
    await fundAccount({ run, funder, destination: treasury.signer.address, lamports: top });
    balance = (await client.rpc.getBalance(treasury.signer.address, { commitment: "confirmed" }).send()).value;
  }
  if (balance < MIN_TREASURY_LAMPORTS) {
    console.error(
      `\nTreasury ${treasury.signer.address} holds ${balance} lamports; at least ${MIN_TREASURY_LAMPORTS} is needed.\n` +
        "The public devnet faucet is rate-limited, so fund it from a key you already have:\n" +
        "  node scripts/make-rusdc.ts --funder <path-to-funded-keypair.json>\n" +
        "or airdrop manually:\n" +
        `  solana airdrop 1 ${treasury.signer.address} --url devnet\n`,
    );
    process.exit(1);
  }
  console.log(`balance   ${balance} lamports`);

  const { mint } = await createRusdcMint({
    client,
    run,
    treasury: treasury.signer,
    auditorElgamalPubkey: auditorElgamalPubkey as Parameters<typeof createRusdcMint>[0]["auditorElgamalPubkey"],
  });

  writeEnv({
    RUSDC_MINT: mint,
    RUSDC_DECIMALS: String(RUSDC_DECIMALS),
    RUSDC_AUDITOR_IKM: Buffer.from(ikm).toString("base64"),
    RUSDC_AUDITOR_ELGAMAL_PUBKEY: auditorElgamalPubkey,
  });

  console.log("\nrUSDC created.\n");
  console.log(`  mint              ${mint}`);
  console.log(`  decimals          ${RUSDC_DECIMALS}`);
  console.log(`  mint authority    ${treasury.signer.address}`);
  console.log(`  freeze authority  ${treasury.signer.address}`);
  console.log(`  CT authority      ${treasury.signer.address}`);
  console.log("  auto-approve      true");
  console.log(`  auditor ElGamal   ${auditorElgamalPubkey}`);
  console.log(`  explorer          https://explorer.solana.com/address/${mint}?cluster=${env.cluster}`);
  console.log("\nWritten to .env: RUSDC_MINT, RUSDC_DECIMALS, RUSDC_AUDITOR_IKM, RUSDC_AUDITOR_ELGAMAL_PUBKEY");
  console.log("RUSDC_AUDITOR_IKM is a secret. .env and .keys/ are git-ignored; never copy it into app/.");
  console.log("\nNext: set USDC_RESERVE_MINT and USDC_RESERVE_TOKEN_ACCOUNT to run the treasury in live mode.");
}

await main();
