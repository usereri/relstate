// Local demonstration of the whole KYC flow (mock provider) against a running Surfpool and a
// running backend. Not part of any test gate; it is the "show me" run.
//
//   1. make demo-chain                      (Surfpool + program)
//   2. backend with FEE_PAYER_KEYPAIR / ATTESTATION_ISSUER_KEYPAIR files and RPC_URL set
//   3. E2E_DIR=<dir with admin.json, issuer.json> node scripts/kyc-e2e.ts
//
// Sequence: gate on -> apply is refused (KycRequired) -> start -> mock page -> approve webhook ->
// status shows the on-chain attestation -> apply succeeds.
import * as anchor from "@anchor-lang/core";
import fs from "node:fs";
import path from "node:path";
import type { Relstate } from "../target/types/relstate.ts";

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = anchor.web3;
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const API = process.env.API ?? "http://127.0.0.1:8787";
const dir = process.env.E2E_DIR;
if (!dir) throw new Error("E2E_DIR is required (holds admin.json and issuer.json)");
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
const admin = load("admin.json");
const issuer = load("issuer.json");
const landlord = Keypair.generate();
const tenant = Keypair.generate();

const conn = new Connection(RPC, "confirmed");
const idl: Relstate = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../target/idl/relstate.json"), "utf8"));
const as = (kp: anchor.web3.Keypair) => new anchor.Program<Relstate>(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));
const step = (msg: string) => console.log(`\n== ${msg}`);

for (const kp of [admin, landlord, tenant]) {
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
}
const program = as(admin);
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const attestationOf = (w: anchor.web3.PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("attestation"), w.toBuffer()], program.programId)[0];

step("config: claim, set issuer, turn the gate on");
if (!(await program.account.config.fetchNullable(config))) await program.methods.initConfig().accountsPartial({ admin: admin.publicKey, config }).rpc();
await program.methods.setIssuer(issuer.publicKey).accountsPartial({ admin: admin.publicKey, config }).rpc();
await program.methods.setRequireKyc(true).accountsPartial({ admin: admin.publicKey, config }).rpc();

step("landlord lists an apartment (not gated)");
const listing = PublicKey.findProgramAddressSync([Buffer.from("listing"), landlord.publicKey.toBuffer(), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId)[0];
await as(landlord).methods.createListing(new anchor.BN(1), new anchor.BN(1000), new anchor.BN(2000), [80, 76], "Flat", "Krakow", "Bright", "x").accountsPartial({ landlord: landlord.publicKey, listing }).rpc();

const apply = () => as(tenant).methods.apply().accountsPartial({ tenant: tenant.publicKey, listing, config, attestation: attestationOf(tenant.publicKey) }).rpc();

step("unverified tenant applies -> must be refused");
try {
  await apply();
  throw new Error("apply unexpectedly succeeded");
} catch (e) {
  const text = String((e as Error).message) + JSON.stringify((e as { error?: unknown }).error ?? "");
  if (!/KycRequired/.test(text)) throw e;
  console.log("refused with KycRequired, as intended");
}

step("session -> /api/kyc/start -> mock page -> approve webhook");
const wallet = tenant.publicKey.toBase58();
const { token } = (await (await fetch(`${API}/api/auth/mock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) })).json()) as { token: string };
const auth = { authorization: `Bearer ${token}` };
const started = (await (await fetch(`${API}/api/kyc/start`, { method: "POST", headers: auth })).json()) as { url: string; session: string; simulated: boolean };
console.log("verification page:", started.url);
const page = await fetch(started.url);
console.log("mock page status:", page.status);
const hook = await (await fetch(`${API}/api/webhooks/kyc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: started.session, decision: "approve" }) })).json();
console.log("webhook:", JSON.stringify(hook));

step("status reads the on-chain attestation");
const status = (await (await fetch(`${API}/api/kyc/status`, { headers: auth })).json()) as { verified: boolean; attestation: unknown };
console.log(JSON.stringify(status, null, 1));
if (!status.verified) throw new Error("expected verified");
const onchain = await program.account.attestation.fetch(attestationOf(tenant.publicKey));
console.log("issuer on chain:", onchain.issuer.toBase58(), "(fee payer is a different key)");

step("verified tenant applies -> allowed");
console.log("apply signature:", await apply());

step("replay of the same webhook does not attest twice");
const again = (await (await fetch(`${API}/api/webhooks/kyc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: started.session, decision: "approve" }) })).json()) as { replay: boolean };
console.log("replay:", again.replay);
console.log("\nOK");
