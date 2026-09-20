// Prepares a network for the app: the test-USDC mint, SOL + test USDC for the wallets you name
// (the ones you connect in the browser windows) and, on a local network, for the app's built-in
// landlord and tenant test wallets, plus four default listings so the tenant's view is not empty.
// Safe to run again: existing accounts are left alone.
//   RPC=https://api.devnet.solana.com npx ts-node --transpile-only scripts/setup-demo.ts [<wallet> ...]
// The payer (ANCHOR_WALLET or ~/.config/solana/id.json) becomes the mint authority, pays account rent
// and owns the default listings (import that keypair into a wallet to lease them yourself).
import * as anchor from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = anchor.web3;

const RPC = process.env.RPC ?? "http://localhost:8899";
const USDC = 1_000_000; // 6 decimals
const WALLET_USDC = 10_000 * USDC;

const DEFAULT_LISTINGS = [
  { id: 1, title: "Sunlit 1-bedroom, Kazimierz", city: "Kraków", blurb: "Furnished · 42 m² · fibre internet · desk by the window", photo: "/listings/kazimierz.jpg", rent: 850 },
  { id: 2, title: "Studio by the Planty", city: "Kraków", blurb: "Unfurnished · 28 m² · quiet courtyard · bikes welcome", photo: "/listings/planty.jpg", rent: 620 },
  { id: 3, title: "Brick loft with a view, Praga", city: "Warsaw", blurb: "Furnished · 65 m² · 2 rooms · balcony", photo: "/listings/praga.jpg", rent: 1200 },
  { id: 4, title: "Garden flat, Zabłocie", city: "Kraków", blurb: "Furnished · 55 m² · pets allowed · private garden", photo: "/listings/zablocie.jpg", rent: 990 },
];

const load = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

async function programReady(conn: anchor.web3.Connection, id: anchor.web3.PublicKey, seconds = 90) {
  for (let waited = 0; ; waited += 2) {
    if ((await conn.getAccountInfo(id))?.executable) return true;
    if (waited >= seconds) return false;
    if (waited === 0) console.log("waiting for the program to be deployed (make demo-chain does it right after starting)...");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function seedListings(conn: anchor.web3.Connection, payer: anchor.web3.Keypair) {
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/relstate.json"), "utf8"));
  if (!(await programReady(conn, new PublicKey(idl.address)))) {
    console.warn(`program ${idl.address} is not deployed on ${RPC}: skipped the default listings. Deploy it, then run this again.`);
    return;
  }
  const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" }));
  let created = 0;
  for (const l of DEFAULT_LISTINGS) {
    const id = new anchor.BN(l.id);
    const [listing] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), payer.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    if (await conn.getAccountInfo(listing)) continue;
    await program.methods
      .createListing(id, new anchor.BN(l.rent * USDC), new anchor.BN(l.rent * USDC), [80, 76], l.title, l.city, l.blurb, l.photo)
      .accountsPartial({ landlord: payer.publicKey, listing })
      .rpc();
    created++;
  }
  console.log(`default listings: ${created} created, owned by ${payer.publicKey.toBase58()}`);
}

async function main() {
  // the app's built-in test wallets (local networks only): same derivation as localKeypair in app/src/lib/chain.ts
  const local = /devnet|mainnet|testnet/.test(RPC)
    ? []
    : (["landlord", "tenant"] as const).map((r) => Keypair.fromSeed(createHash("sha256").update(`relstate-local-${r}`).digest()).publicKey);
  const wallets = [...local, ...process.argv.slice(2).map((a) => new PublicKey(a))];

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

  await seedListings(conn, payer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
