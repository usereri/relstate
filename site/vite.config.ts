import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Standalone from app/: its own dependencies, its own build. The site is static, so it is a
// multi-page build (one HTML entry per page) rather than a router -- /events is a real file, not a
// client-side route, which keeps the first paint free of JavaScript and the page crawlable.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // SITE_APP_URL is the one knob the site has: where "Find a home" and "Book nearby" point.
  // Vite only exposes VITE_*-prefixed variables by default; SITE_ is added so the variable can be
  // named the way the rest of the repo names it. See docs/site.md.
  envPrefix: ["VITE_", "SITE_"],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The source is ordinary React (same idiom as app/), but a marketing page should not ship a
      // 72 kB runtime to render six static sections, a theme toggle and a city filter. preact/compat
      // serves the same API in ~10 kB. Nothing here uses more than useState/useEffect/createRoot,
      // so the swap is invisible in the source -- drop these three lines to go back to React.
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react-dom/client": "preact/compat/client",
    },
  },
  base: process.env.BASE ?? "/",
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, "index.html"),
        events: path.resolve(import.meta.dirname, "events/index.html"),
      },
      // Both pages share the runtime and the icons; without this the shared chunk is named after
      // whichever module rollup happened to see first.
      output: { manualChunks: (id) => (id.includes("node_modules") ? "vendor" : undefined) },
    },
  },
});
