import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// `@target` is the Anchor build output (IDL + generated types), one level up.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@target": path.resolve(__dirname, "../target"),
    },
  },
  base: process.env.BASE ?? "/",
  define: { global: "globalThis" },
  server: { fs: { allow: [".."] } },
});
