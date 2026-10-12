// Help dialog: what's running (frontend + backend build), where the code is, and
// what to expect of persistence — tailored to whichever backend answered.

import { esc } from "./render/svg.js";
import { frontendBuild, REPO_URL } from "./build.js";

export interface BackendInfo {
  service: string;
  version: string;
  commit: string;
}

const SHARE_SERVER = "pw-dump-graph-server";
const LOCAL_VIEWER = "pw-dump-graph";

/** `GET /api/version`, or null when nothing of ours answers (static hosting, or an
 *  unrelated server's catch-all page — hence the JSON and shape checks). */
export async function fetchBackend(): Promise<BackendInfo | null> {
  try {
    const res = await fetch("/api/version");
    if (!res.ok || !res.headers.get("content-type")?.startsWith("application/json")) return null;
    const v = (await res.json()) as Partial<BackendInfo>;
    if (typeof v.service !== "string" || typeof v.version !== "string" || typeof v.commit !== "string") {
      return null;
    }
    return { service: v.service, version: v.version, commit: v.commit };
  } catch {
    return null;
  }
}

function persistence(backend: BackendInfo | null): string {
  switch (backend?.service) {
    case SHARE_SERVER:
      return "Shared dumps live in memory, are limited in number and expire after a while, and aren't retained on disk. Treat a link as a pastebin, not storage.";
    case LOCAL_VIEWER:
      return "Reads the graph from this machine and serves it to your browser. Nothing is stored or uploaded.";
    default:
      return "No backend: a dump you open, drop or paste is rendered in your browser and not uploaded.";
  }
}

/** The dialog body. `origin` is the page origin, for the share one-liner. */
export function helpHTML(backend: BackendInfo | null, origin: string): string {
  const row = (k: string, v: string) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const backendText = backend
    ? `${esc(backend.service)} ${esc(backend.version)} (${esc(backend.commit)})`
    : "none (static hosting)";
  const repoText = REPO_URL.replace(/^https?:\/\//, "");
  const share =
    backend?.service === SHARE_SERVER
      ? row("Share", `<code>pw-dump | curl -sT- ${esc(origin)}</code> prints a link to open.`)
      : "";
  return `<dl class="help">
    ${row("Frontend", esc(frontendBuild))}
    ${row("Backend", backendText)}
    ${row("Source", `<a href="${esc(REPO_URL)}" target="_blank" rel="noreferrer">${esc(repoText)}</a>`)}
    ${row("Persistence", esc(persistence(backend)))}
    ${share}
  </dl>`;
}
