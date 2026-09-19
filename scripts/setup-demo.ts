// Prepares a network for the frontend demo: the test-USDC mint, two throwaway wallets
// (Landlord, Tenant) funded with SOL + test USDC, and app/src/demo.json holding their keys.
//   RPC=http://localhost:8899 npx ts-node --transpile-only scripts/setup-demo.ts
// The payer (ANCHOR_WALLET or ~/.config/solana/id.json) becomes the mint authority.
import * as anchor from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { Connection, Keypair, LAMPORTS_PER_SOL } = anchor.web3;

const RPC = process.env.RPC ?? "http://localhost:8899";
const USDC = 1_000_000; // 6 decimals
const TENANT_USDC = 10_000 * USDC;
const LANDLORD_USDC = 1_000 * USDC;

const load = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = load(
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json"),
  );
  const mintKp = load(path.join(__dirname, "../tests/test-usdc-mint.json"));

  const demoFile = path.join(__dirname, "../app/src/demo.json");
  const demo = fs.existsSync(demoFile)
    ? JSON.parse(fs.readFileSync(demoFile, "utf8"))
    : { landlord: Array.from(Keypair.generate().secretKey), tenant: Array.from(Keypair.generate().secretKey) };
  const landlord = Keypair.fromSecretKey(Uint8Array.from(demo.landlord));
  const tenant = Keypair.fromSecretKey(Uint8Array.from(demo.tenant));

  const topUp = async (kp: anchor.web3.Keypair, minSol: number) => {
    if ((await conn.getBalance(kp.publicKey)) >= minSol * LAMPORTS_PER_SOL) return;
    const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
  };
  await topUp(payer, 1);
  await topUp(landlord, 1);
  await topUp(tenant, 1);

  if (!(await conn.getAccountInfo(mintKp.publicKey))) {
    await createMint(conn, payer, payer.publicKey, null, 6, mintKp);
    console.log("created test-USDC mint", mintKp.publicKey.toBase58());
  }

  for (const [name, kp, target] of [
    ["landlord", landlord, LANDLORD_USDC],
    ["tenant", tenant, TENANT_USDC],
  ] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mintKp.publicKey, kp.publicKey);
    const have = Number((await getAccount(conn, ata.address)).amount);
    if (have < target) await mintTo(conn, payer, mintKp.publicKey, ata.address, payer, target - have);
    console.log(`${name} ${kp.publicKey.toBase58()}  ${target / USDC} test USDC`);
  }

  fs.writeFileSync(demoFile, JSON.stringify(demo));
  console.log("wrote", path.relative(process.cwd(), demoFile));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
