// Lists, and optionally closes, ZK proof context-state accounts left behind by an interrupted
// confidential rent payment (docs/contracts/treasury.md, "Restart orphans").
//
//   node scripts/reclaim-contexts.ts              # dry run: list only
//   node scripts/reclaim-contexts.ts --execute    # close them, rent back to the treasury
//   node scripts/reclaim-contexts.ts --accounts A,B   # candidates by address (RPC without getProgramAccounts)
//
// Env: TREASURY_KEYPAIR (path or inline), RPC_URL, like the backend. Never run automatically.
//
// Only a context that was VERIFIED with the treasury as authority can be closed (the backend's
// proof plan records the treasury as authority on every verify). A context created but never
// verified (tx 3's range context if tx 4 never ran) has no authority yet and cannot be closed by
// anyone; its rent is the documented residual.
//
// Safety: only accounts owned by the ZK proof program whose first 32 bytes are the treasury, and
// whose oldest signature is older than --min-age-minutes (default 10, above the 5 minute plan TTL),
// so a payment in flight is left alone. The close destination is always the treasury.
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const ageArg = args.indexOf("--min-age-minutes");
const minAgeMs = (ageArg >= 0 ? Number(args[ageArg + 1]) : 10) * 60_000;
if (!(minAgeMs >= 0)) throw new Error("--min-age-minutes must be a non-negative number");

const { env } = await import("../backend/src/env.ts");
const keys = await import("../backend/src/keys.ts");
const { ZK_ELGAMAL_PROOF_PROGRAM } = await import("../backend/src/contracts.ts");

if (env.treasuryKeypair === "") throw new Error("TREASURY_KEYPAIR is not set");
const treasury = Keypair.fromSecretKey(keys.parseKeyPairBytes(env.treasuryKeypair));
const zk = new PublicKey(ZK_ELGAMAL_PROOF_PROGRAM);
const connection = new Connection(env.rpcUrl, "confirmed");

// getProgramAccounts is unavailable on some RPC tiers (Helius free). --accounts a,b,c names the
// candidates explicitly instead (take them from the backend log or the failed payment's transactions);
// each is still checked to be ZK-owned with the treasury as authority before anything is closed.
const listArg = args.indexOf("--accounts");
const found =
  listArg >= 0
    ? (
        await Promise.all(
          (args[listArg + 1] ?? "").split(",").filter(Boolean).map(async (a) => {
            const pubkey = new PublicKey(a);
            const account = await connection.getAccountInfo(pubkey);
            const ours = account !== null && account.owner.equals(zk) && account.data.length >= 32 && new PublicKey(account.data.subarray(0, 32)).equals(treasury.publicKey);
            return ours ? [{ pubkey, account: { lamports: account.lamports } }] : [];
          }),
        )
      ).flat()
    : await connection.getProgramAccounts(zk, {
        filters: [{ memcmp: { offset: 0, bytes: treasury.publicKey.toBase58() } }],
        dataSlice: { offset: 0, length: 0 },
      });
console.log(`${execute ? "EXECUTE" : "dry run"}: ${found.length} context accounts with the treasury as authority`);
let closed = 0n;
for (const { pubkey, account } of found) {
  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 1000 });
  const oldest = sigs[sigs.length - 1]?.blockTime;
  const ageMs = oldest == null ? Infinity : Date.now() - oldest * 1000;
  const old = Number.isFinite(ageMs) && ageMs >= minAgeMs; // unknown age is NOT reclaimable: it may be a plan still in flight
  console.log(`  ${pubkey.toBase58()}  ${account.lamports} lamports  age ${Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) + " min" : "unknown"}  ${old ? "reclaimable" : "too recent, skipped"}`);
  if (!execute || !old) continue;
  const ix = new TransactionInstruction({
    programId: zk,
    keys: [
      { pubkey, isSigner: false, isWritable: true },
      { pubkey: treasury.publicKey, isSigner: false, isWritable: true },
      { pubkey: treasury.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([0]), // CloseContextState
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = treasury.publicKey;
  const sig = await connection.sendTransaction(tx, [treasury]);
  await connection.confirmTransaction(sig, "confirmed");
  closed += BigInt(account.lamports);
  console.log(`    closed: ${sig}`);
}
if (execute) console.log(`reclaimed ${closed} lamports`);
