// Registers the demo's appraisers on the program's registry and flags exactly one as the default
// (docs/contracts/dispute-mediation.md §3, §4). Run after the program is upgraded and setup-demo.ts
// has initialised Config.
//
//   ADMIN_KEYPAIR=<path> APPRAISERS='[{"name":"Rzeczoznawca A","wallet":"<pubkey>","fee":"2000000"},...]' \
//     node scripts/setup-appraisers.ts [--dry-run]
//
// The directory is the same APPRAISERS value the backend serves at GET /api/appraisers, so the
// registry and the directory cannot disagree. Only PUBLIC keys are needed here: the appraisers'
// private keys live in APPRAISER_KEYPAIRS on the backend and never touch this script.
//
// ADMIN_KEYPAIR (or --admin-keypair) must be the Config admin, and is never defaulted to
// ~/.config/solana/id.json. Idempotent: an entry already registered is left alone, a default flag is
// only written where it differs, and a second run sends nothing. Never prints a secret.
//
// Imported through ../backend/src for the reason make-rusdc.ts gives: scripts/ has no node_modules.
import { accountExists, associatedToken, fetchAllowedMints, fetchAppraiser, fetchMintTokenProgram, singleInstructionPlan, getCreateAppraiserAtaInstruction, getRegisterAppraiserInstruction, getSetAppraiserActiveInstruction, getSetDefaultAppraiserInstruction, type AppraiserRecord } from "../backend/src/appraiser-chain.ts";
import { appraiserNameHash, hex, parseAppraiserDirectory } from "../backend/src/appraisers.ts";
import { env, redactedRpcUrl } from "../backend/src/env.ts";
import { loadKeyPairSigner } from "../backend/src/keys.ts";
import { createPlanRunner, getSolanaClient } from "../backend/src/rpc.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = args.includes("--dry-run");

async function main(): Promise<void> {
  const directory = parseAppraiserDirectory(env.appraisers.directory);
  if (directory.length === 0) throw new Error("APPRAISERS is not set: nothing to register");

  const adminSpec = flag("admin-keypair") ?? process.env.ADMIN_KEYPAIR;
  if (!adminSpec) throw new Error("the Config admin's keypair is required: set ADMIN_KEYPAIR or pass --admin-keypair <path> (never defaulted)");
  const admin = await loadKeyPairSigner(adminSpec, "ADMIN_KEYPAIR");

  const client = getSolanaClient();
  const run = createPlanRunner(client, console.log);
  console.log(`rpc       ${redactedRpcUrl()}`);
  console.log(`admin     ${admin.address}`);
  console.log(dryRun ? "mode      DRY RUN: nothing will be sent\n" : "mode      live\n");

  // Read the whole registry state first, so a dry run and a real run plan identically.
  const current = new Map<string, AppraiserRecord | null>();
  for (const entry of directory) current.set(entry.wallet, await fetchAppraiser(client.rpc, entry.wallet));

  const send = async (label: string, instruction: Parameters<typeof singleInstructionPlan>[0]) => {
    console.log(`${dryRun ? "would " : ""}${label}`);
    if (!dryRun) await run(admin, singleInstructionPlan(instruction), label);
  };

  let changes = 0;
  // Unflag first: if a different entry is the default today, two flagged defaults must never coexist.
  for (const entry of directory) {
    const record = current.get(entry.wallet);
    if (record?.isDefault && !entry.isDefault) {
      changes++;
      await send(`unflag default ${entry.name} (${entry.wallet})`, await getSetDefaultAppraiserInstruction({ admin, wallet: entry.wallet, isDefault: false }));
    }
  }
  for (const entry of directory) {
    const record = current.get(entry.wallet);
    const nameHash = appraiserNameHash(entry.name);
    if (record === null || record === undefined) {
      changes++;
      await send(`register ${entry.name} (${entry.wallet}) fee ${entry.fee}`, await getRegisterAppraiserInstruction({ admin, wallet: entry.wallet, fee: entry.fee, nameHash }));
    } else {
      // register_appraiser cannot be repeated or edited; a mismatch is reported, never overwritten.
      if (record.fee !== entry.fee || record.nameHash !== hex(nameHash)) {
        console.warn(`WARN ${entry.name}: on-chain fee/name hash differ from APPRAISERS and cannot be changed by this script`);
      }
      if (!record.active) {
        changes++;
        await send(`reactivate ${entry.name}`, await getSetAppraiserActiveInstruction({ admin, wallet: entry.wallet, active: true }));
      }
    }
    if (entry.isDefault && !record?.isDefault) {
      changes++;
      await send(`flag default ${entry.name}`, await getSetDefaultAppraiserInstruction({ admin, wallet: entry.wallet, isDefault: true }));
    }
  }
  // F4: submit_verdict transfers fee_paid (even 0) to the appraiser's token account for the lease
  // mint, so each appraiser needs one per allowed mint or a mediation silently expires. Admin pays.
  for (const mint of await fetchAllowedMints(client.rpc)) {
    const tokenProgram = await fetchMintTokenProgram(client.rpc, mint);
    for (const entry of directory) {
      const ata = await associatedToken(entry.wallet, mint, tokenProgram);
      if (await accountExists(client.rpc, ata)) continue;
      changes++;
      console.log(`${dryRun ? "would " : ""}create token account ${ata} for ${entry.name} on mint ${mint}`);
      if (!dryRun) {
        const ix = await getCreateAppraiserAtaInstruction({ payer: admin, owner: entry.wallet, mint, tokenProgram });
        await run(admin, singleInstructionPlan(ix), `ata ${entry.name} ${mint}`);
      }
    }
  }
  console.log(changes === 0 ? "\nregistry already matches APPRAISERS: nothing to do" : `\n${dryRun ? "planned" : "sent"} ${changes} instruction(s)`);
}

main().catch(async (error: unknown) => {
  const { redactSecrets } = await import("../backend/src/keys.ts");
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
