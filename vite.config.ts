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
});
