// Points a network's Config at the KYC issuer and switches the identity gate on or off
// (docs/contracts/attestation.md, "Config and admin instructions"). Run after setup-demo.ts.
//
//   ADMIN_KEYPAIR=~/.config/relstate/admin.json ATTESTATION_ISSUER=<pubkey> \
//     RPC=https://api.devnet.solana.com node scripts/setup-kyc.ts [on|off]
//
// ADMIN_KEYPAIR must be the Config admin (whoever ran init_config). It is deliberately a required
// variable and never defaults to ~/.config/solana/id.json. ATTESTATION_ISSUER is the *public* key
// of the backend's ATTESTATION_ISSUER_KEYPAIR; the private key is never needed here. `on` is
// refused by the program while no issuer is set, so the order below matters.
import * as anchor from "@anchor-lang/core";
import fs from "node:fs";
import path from "node:path";
import type { Relstate } from "../target/types/relstate.ts";

const { Connection, Keypair, PublicKey } = anchor.web3;

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const adminPath = process.env.ADMIN_KEYPAIR;
const issuerKey = process.env.ATTESTATION_ISSUER;
const mode = process.argv[2] ?? "on";
if (!adminPath) throw new Error("ADMIN_KEYPAIR is required (the Config admin's keypair file)");
if (mode !== "on" && mode !== "off") throw new Error(`mode must be "on" or "off", not ${mode}`);
if (mode === "on" && !issuerKey) throw new Error("ATTESTATION_ISSUER (the issuer's public key) is required to turn the gate on");

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(adminPath.replace(/^~/, process.env.HOME ?? "~"), "utf8"))));
const idl: Relstate = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../target/idl/relstate.json"), "utf8"));
const program = new anchor.Program<Relstate>(idl, new anchor.AnchorProvider(new Connection(RPC, "confirmed"), new anchor.Wallet(admin), { commitment: "confirmed" }));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const accounts = { admin: admin.publicKey, config };

if (issuerKey) {
  await program.methods.setIssuer(new PublicKey(issuerKey)).accountsPartial(accounts).rpc();
  console.log(`issuer set to ${issuerKey}`);
}
await program.methods.setRequireKyc(mode === "on").accountsPartial(accounts).rpc();
console.log(`require_kyc is now ${mode}`);
