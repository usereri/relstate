// Entry point. `npm run dev` from backend/, or `node backend/src/index.ts`.
import { serve } from "@hono/node-server";
import { assertMockKycAllowed } from "./boot.ts";
import { getSolanaClient } from "./rpc.ts";
import { assertEnvConsistent, env, redactedRpcUrl } from "./env.ts";
import { createApp } from "./server.ts";

assertEnvConsistent();
await assertMockKycAllowed(async () => String(await getSolanaClient().rpc.getGenesisHash().send()));

serve({ fetch: createApp().fetch, port: env.port }, (info) => {
  console.log(`relstate backend on :${info.port}`);
  console.log(`  mode      ${env.mode} (auth: ${env.authMode})`);
  console.log(`  rpc       ${redactedRpcUrl()}${env.rpcIsHelius ? " (helius)" : ""}`);
  console.log(`  rUSDC     ${env.rusdcMint === "" ? "not created — run scripts/make-rusdc.ts" : env.rusdcMint}`);
  // Said out loud, because the difference between the two is whether a redeploy forgets the
  // invitations, the webhook idempotency keys and today's budgets (store.ts, docs/deploy.md).
  console.log(`  store     ${env.databasePath === "" ? "in memory — set DATABASE_PATH to survive a restart" : env.databasePath}`);
  if (env.mode === "mock") {
    console.log("  mock mode: no keys required, throwaway keys generated per process, transactions are co-signed but not broadcast");
  }
});
