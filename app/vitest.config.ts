import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Reuses the app's Vite config (the `@/` alias, import.meta.env, the wasm plugin), so modules
// under test resolve exactly as they do in the bundle. Run from the repo root: `npm run app:test`.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { root: __dirname, include: ["src/**/*.test.ts"], environment: "node" },
  }),
);
