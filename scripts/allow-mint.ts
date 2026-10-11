// Adds (or removes) a mint on the program's Config allowlist (docs/contracts/program-interface.md
// §2), signed by whoever holds Config admin (whoever ran init_config first -- see
// scripts/setup-demo.ts). Exists because set_mint_allowed otherwise has no standalone entry point:
// setup-demo.ts only ever allows its own test-USDC mint, so a mint created afterwards (rUSDC,
// scripts/make-rusdc.ts) has nowhere else to be allowed from. Idempotent either way (the program
// does not error on re-allowing an already-allowed mint, or re-removing an already-removed one).
//
//   ADMIN_KEYPAIR=<path> RPC=https://api.devnet.solana.com node scripts/allow-mint.ts <mint> [off]
//   node scripts/allow-mint.ts <mint> --admin-keypair <path> --rpc <url>
//
// `off` removes the mint instead of adding it. The admin keypair is NEVER defaulted to
// ~/.config/solana/id.json -- pass it with ADMIN_KEYPAIR or --admin-keypair, so running this
// against the wrong wallet by accident is not the easy path. Nothing here ever prints a secret key;
// only the keypair's path and its public key are logged.
import * as anchor from "@anchor-lang/core";
import fs from "node:fs";
import path from "node:path";
import type { Relstate } from "../target/types/relstate.ts";

const { Connection, Keypair, PublicKey } = anchor.web3;

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

const { positionals, flags } = parseArgs(process.argv.slice(2));
const [mintArg, modeArg] = positionals;

if (!mintArg) {
  throw new Error("usage: node scripts/allow-mint.ts <mint address> [off] [--admin-keypair <path>] [--rpc <url>]");
}
if (modeArg !== undefined && modeArg !== "off") {
  throw new Error(`unknown argument "${modeArg}": expected "off" or nothing (default: allow)`);
}
const allowed = modeArg !== "off";

const adminPath = flags["admin-keypair"] ?? process.env.ADMIN_KEYPAIR;
if (!adminPath) {
  throw new Error("the Config admin's keypair path is required: set ADMIN_KEYPAIR or pass --admin-keypair <path> (never defaulted to ~/.config/solana/id.json)");
}

const rpc = flags.rpc ?? process.env.RPC ?? "http://127.0.0.1:8899";

let mint: InstanceType<typeof PublicKey>;
try {
  mint = new PublicKey(mintArg);
} catch {
  throw new Error(`"${mintArg}" is not a valid mint address`);
}

const resolvedAdminPath = adminPath.replace(/^~/, process.env.HOME ?? "~");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolvedAdminPath, "utf8"))));
const idl: Relstate = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../target/idl/relstate.json"), "utf8"));
const program = new anchor.Program<Relstate>(idl, new anchor.AnchorProvider(new Connection(rpc, "confirmed"), new anchor.Wallet(admin), { commitment: "confirmed" }));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

console.log(`rpc:      ${rpc}`);
console.log(`config:   ${config.toBase58()}`);
console.log(`admin:    ${admin.publicKey.toBase58()} (from ${adminPath})`);
console.log(`mint:     ${mint.toBase58()}`);
console.log(`setting:  allowed = ${allowed}`);

await program.methods.setMintAllowed(allowed).accountsPartial({ admin: admin.publicKey, config, mint }).rpc();

console.log(`done: mint ${allowed ? "allowed" : "removed"} on ${rpc}`);
