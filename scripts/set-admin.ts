// Hands the program's Config admin to another key (docs/contracts/program-interface.md §2/§4),
// signed by the CURRENT admin. The recovery path when the wrong wallet ran init_config first
// (scripts/setup-demo.ts claims it for whatever ANCHOR_WALLET is).
//
//   ADMIN_KEYPAIR=<current admin keypair path> RPC=https://api.devnet.solana.com \
//     node scripts/set-admin.ts <new admin public key>
//
// The current admin's keypair is required (never defaulted). Only paths and public keys are logged.
import * as anchor from "@anchor-lang/core";
import fs from "node:fs";
import path from "node:path";
import type { Relstate } from "../target/types/relstate.ts";

const { Connection, Keypair, PublicKey } = anchor.web3;

const newAdminArg = process.argv[2];
if (!newAdminArg) throw new Error("usage: ADMIN_KEYPAIR=<path> node scripts/set-admin.ts <new admin public key>");
const adminPath = process.env.ADMIN_KEYPAIR;
if (!adminPath) throw new Error("the current Config admin's keypair path is required: set ADMIN_KEYPAIR");
const rpc = process.env.RPC ?? "http://127.0.0.1:8899";

let newAdmin: InstanceType<typeof PublicKey>;
try {
  newAdmin = new PublicKey(newAdminArg);
} catch {
  throw new Error(`"${newAdminArg}" is not a valid public key`);
}

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(adminPath.replace(/^~/, process.env.HOME ?? "~"), "utf8"))));
const idl: Relstate = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../target/idl/relstate.json"), "utf8"));
const program = new anchor.Program<Relstate>(idl, new anchor.AnchorProvider(new Connection(rpc, "confirmed"), new anchor.Wallet(admin), { commitment: "confirmed" }));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

console.log(`rpc:        ${rpc}`);
console.log(`config:     ${config.toBase58()}`);
console.log(`old admin:  ${admin.publicKey.toBase58()} (from ${adminPath})`);
console.log(`new admin:  ${newAdmin.toBase58()}`);

await program.methods.setAdmin(newAdmin).accountsPartial({ admin: admin.publicKey, config }).rpc();

console.log("done: Config admin handed over");
