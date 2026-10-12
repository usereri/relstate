import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import { existsSync } from "node:fs";
import path from "node:path";

// `@target` is the Anchor build output (IDL + generated types), one level up -- git-ignored, so CI
// and a fresh container clone never have it. `app/idl/` is a tracked copy of the same two files
// (`scripts/sync-idl.sh` regenerates it from a demo-feature `anchor build`). Local dev keeps reading
// the live `../target` build whenever it exists, so iterating on the program needs no extra step;
// only its absence falls back to the tracked copy.
const TARGET_IDL_JSON = path.resolve(__dirname, "../target/idl/relstate.json");
const hasBuiltTarget = existsSync(TARGET_IDL_JSON);

export default defineConfig({
  // `wasm` is for @solana/zk-sdk: its bundler build imports index_bg.wasm as an ES module, which
  // Vite does not support on its own (the "ESM integration proposal for Wasm" is still a proposal).
  // The plugin turns that import into an instantiation, which needs top-level await -- covered by
  // Vite 7's default browser target.
  plugins: [react(), tailwindcss(), wasm()],
  resolve: {
    alias: [
      // Exact-module aliases take priority over the general "@target" one below, since only the
      // tracked copy (not a whole `target/` tree) exists when the live build is absent.
      { find: "@target/idl/relstate.json", replacement: hasBuiltTarget ? TARGET_IDL_JSON : path.resolve(__dirname, "idl/relstate.json") },
      { find: "@target/types/relstate", replacement: hasBuiltTarget ? path.resolve(__dirname, "../target/types/relstate") : path.resolve(__dirname, "idl/relstate") },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      { find: "@target", replacement: path.resolve(__dirname, "../target") },
    ],
  },
  base: process.env.BASE ?? "/",
  // confidential-check.html is a developer entry, not a screen: building it is what proves the
  // confidential island and its wasm survive the production bundle, and opening it on the dev
  // server is the devnet smoke test. See app/src/lib/confidential-check.ts.
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        "confidential-check": path.resolve(__dirname, "confidential-check.html"),
      },
    },
  },
  define: { global: "globalThis" },
  server: { fs: { allow: [".."] } },
});
