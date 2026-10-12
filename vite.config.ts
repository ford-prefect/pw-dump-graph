import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The workspace Cargo.toml version is the one source of truth; the frontend reads it
// here at build time rather than keeping a second copy in package.json. A missing
// version is a real config error, so this fails the build loudly.
function workspaceVersion(): string {
  const toml = readFileSync(new URL("./Cargo.toml", import.meta.url), "utf8");
  const section = toml.split(/^\[workspace\.package\]\s*$/m)[1] ?? "";
  const m = /^version\s*=\s*"([^"]+)"/m.exec(section);
  if (!m) throw new Error("workspace version not found in Cargo.toml [workspace.package]");
  return m[1];
}

// Short git SHA, "-dirty" if tracked files are modified; "unknown" outside a git
// checkout. Mirrors common/build.rs so both halves report the same thing.
function gitCommit(): string {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  const sha = run("git rev-parse --short HEAD");
  if (!sha) return "unknown";
  return run("git status --porcelain --untracked-files=no") ? `${sha}-dirty` : sha;
}

// Static SPA. No static assets to copy — the viewer starts empty and loads a dump
// from a share key, a URL, the local live viewer, or an opened/dropped/pasted file.
export default defineConfig({
  root: ".",
  publicDir: false,
  define: {
    __PWG_VERSION__: JSON.stringify(workspaceVersion()),
    __PWG_COMMIT__: JSON.stringify(gitCommit()),
  },
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
