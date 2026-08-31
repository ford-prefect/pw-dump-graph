import { defineConfig } from "vite";

// Static SPA. No static assets to copy — the viewer starts empty and loads a dump
// from a share key, a URL, the local live viewer, or an opened/dropped/pasted file.
export default defineConfig({
  root: ".",
  publicDir: false,
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
