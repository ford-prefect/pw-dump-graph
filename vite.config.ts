import { defineConfig } from "vite";

// Static SPA. The bundled sample under examples/ is served as a static asset
// so the viewer has something to render on first load.
export default defineConfig({
  root: ".",
  publicDir: "examples",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // In dev, forward the share API to the locally-running Rust server so the
    // Share button and ?g= links work against `npm run dev`.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
