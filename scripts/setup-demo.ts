// Prepares a network for the app: the test-USDC mint, and SOL + test USDC for the wallets you name
// (the ones you connect in the browser windows).
//   RPC=https://api.devnet.solana.com npx ts-node --transpile-only scripts/setup-demo.ts <wallet> [<wallet> ...]
// The payer (ANCHOR_WALLET or ~/.config/solana/id.json) becomes the mint authority and pays account rent.
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

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = anchor.web3;

const RPC = process.env.RPC ?? "http://localhost:8899";
const USDC = 1_000_000; // 6 decimals
const WALLET_USDC = 10_000 * USDC;

const load = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

async function main() {
  const wallets = process.argv.slice(2).map((a) => new PublicKey(a));
  if (!wallets.length) throw new Error("usage: setup-demo.ts <wallet> [<wallet> ...]");

  const conn = new Connection(RPC, "confirmed");
  const payer = load(process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json"));
  const mintKp = load(path.join(__dirname, "../tests/test-usdc-mint.json"));

  const topUp = async (key: anchor.web3.PublicKey, minSol: number) => {
    if ((await conn.getBalance(key)) >= minSol * LAMPORTS_PER_SOL) return;
    try {
      const sig = await conn.requestAirdrop(key, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
    } catch {
      console.warn(`could not airdrop SOL to ${key.toBase58()}: send it some from https://faucet.solana.com`);
    }
  };
  await topUp(payer.publicKey, 1);

  if (!(await conn.getAccountInfo(mintKp.publicKey))) {
    await createMint(conn, payer, payer.publicKey, null, 6, mintKp);
    console.log("created test-USDC mint", mintKp.publicKey.toBase58());
  }

  for (const wallet of wallets) {
    await topUp(wallet, 1);
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mintKp.publicKey, wallet);
    const have = Number((await getAccount(conn, ata.address)).amount);
    if (have < WALLET_USDC) await mintTo(conn, payer, mintKp.publicKey, ata.address, payer, WALLET_USDC - have);
    console.log(`${wallet.toBase58()}  ${WALLET_USDC / USDC} test USDC`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
