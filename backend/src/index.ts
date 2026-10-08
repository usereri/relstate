// Entry point. `npm run dev` from backend/, or `node backend/src/index.ts`.
import { serve } from "@hono/node-server";
import { assertEnvConsistent, env, redactedRpcUrl } from "./env.ts";
import { createApp } from "./server.ts";

assertEnvConsistent();

serve({ fetch: createApp().fetch, port: env.port }, (info) => {
  console.log(`relstate backend on :${info.port}`);
  console.log(`  mode      ${env.mode} (auth: ${env.authMode})`);
  console.log(`  rpc       ${redactedRpcUrl()}${env.rpcIsHelius ? " (helius)" : ""}`);
  console.log(`  rUSDC     ${env.rusdcMint === "" ? "not created — run scripts/make-rusdc.ts" : env.rusdcMint}`);
  if (env.mode === "mock") {
    console.log("  mock mode: no keys required, throwaway keys generated per process, transactions are co-signed but not broadcast");
  }
});
