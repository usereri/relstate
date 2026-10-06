// Fee relay: pays the network fee (and a small rent buffer) for signed-in users, so they never need SOL.
// The user signs a transaction whose fee payer is this relay's key; the relay checks it only calls
// Relstate (plus token / ATA setup), co-signs and submits it.
//   FEE_PAYER_KEYPAIR=~/.config/solana/id.json RPC=https://api.devnet.solana.com npx ts-node --transpile-only relay/server.ts
import * as anchor from "@anchor-lang/core";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmRawTransaction } = anchor.web3;

const RPC = process.env.RPC ?? "http://localhost:8899";
const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = process.env.ALLOW_ORIGIN ?? "*";
const keyFile = (process.env.FEE_PAYER_KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
const conn = new Connection(RPC, "confirmed");

const PROGRAM_ID = process.env.RELSTATE_PROGRAM_ID ?? "5J52oGfo7BjC529vizEaM96QtxVFD4Kbv22Tw8aXa1Ar"; // declare_id! in programs/relstate
const ALLOWED_PROGRAMS = new Set([
  PROGRAM_ID,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token account
  "ComputeBudget111111111111111111111111111111",
]);

const TOP_UP_BELOW = 0.02 * LAMPORTS_PER_SOL; // rent for the accounts a lease creates
const TOP_UP_TO = 0.04 * LAMPORTS_PER_SOL;
const MAX_TOP_UPS = 5; // per wallet, per relay run
const topUps = new Map<string, number>();

class Reject extends Error {}

function validate(tx: anchor.web3.Transaction) {
  if (!tx.feePayer?.equals(sponsor.publicKey)) throw new Reject("Fee payer must be the relay");
  if (!tx.instructions.length || tx.instructions.length > 8) throw new Reject("Unexpected instruction count");
  for (const ix of tx.instructions) {
    if (!ALLOWED_PROGRAMS.has(ix.programId.toBase58())) throw new Reject(`Program not allowed: ${ix.programId.toBase58()}`);
    // The relay key may only pay the fee: it must never appear as an account (no draining it).
    if (ix.keys.some((k) => k.pubkey.equals(sponsor.publicKey))) throw new Reject("The relay account cannot be used in instructions");
  }
  const user = tx.signatures.find((s) => !s.publicKey.equals(sponsor.publicKey) && s.signature);
  if (!user) throw new Reject("Missing user signature");
  return user.publicKey;
}

async function topUp(user: anchor.web3.PublicKey) {
  const key = user.toBase58();
  if ((topUps.get(key) ?? 0) >= MAX_TOP_UPS) return;
  const balance = await conn.getBalance(user);
  if (balance >= TOP_UP_BELOW) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: user, lamports: TOP_UP_TO - balance }));
  await anchor.web3.sendAndConfirmTransaction(conn, tx, [sponsor]);
  topUps.set(key, (topUps.get(key) ?? 0) + 1);
}

async function sponsorTx(base64: string) {
  const tx = Transaction.from(Buffer.from(base64, "base64"));
  const user = validate(tx);
  await topUp(user);
  tx.partialSign(sponsor);
  if (!tx.verifySignatures()) throw new Reject("Invalid signatures");
  return sendAndConfirmRawTransaction(conn, tx.serialize(), { commitment: "confirmed" });
}

const body = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c)).on("end", () => resolve(data)).on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 10_000);
  });

http
  .createServer(async (req, res) => {
    const reply = (code: number, json: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "content-type" });
      res.end(JSON.stringify(json));
    };
    if (req.method === "OPTIONS") return reply(204, {});
    try {
      if (req.method === "GET" && req.url === "/fee-payer") return reply(200, { feePayer: sponsor.publicKey.toBase58() });
      if (req.method === "POST" && req.url === "/sponsor") {
        const { tx } = JSON.parse(await body(req));
        return reply(200, { signature: await sponsorTx(tx) });
      }
      reply(404, { error: "Not found" });
    } catch (e) {
      const err = e as Error;
      reply(err instanceof Reject ? 400 : 500, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`fee relay on :${PORT}, fee payer ${sponsor.publicKey.toBase58()}, network ${RPC}`));
