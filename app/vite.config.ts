import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import path from "node:path";

// `@target` is the Anchor build output (IDL + generated types), one level up.
export default defineConfig({
  // `wasm` is for @solana/zk-sdk: its bundler build imports index_bg.wasm as an ES module, which
  // Vite does not support on its own (the "ESM integration proposal for Wasm" is still a proposal).
  // The plugin turns that import into an instantiation, which needs top-level await -- covered by
  // Vite 7's default browser target.
  plugins: [react(), tailwindcss(), wasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@target": path.resolve(__dirname, "../target"),
    },
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
