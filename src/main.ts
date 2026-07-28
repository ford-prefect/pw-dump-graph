// Entry point — wiring only.
// Pipeline: text -> JSON.parse -> buildGraph -> elkLayout -> renderGraph -> attachInteractions.
// Data source precedence: ?url= -> dropped/selected file -> pasted JSON -> bundled sample.

import "./styles.css";
import { buildGraph, type Graph } from "./model.js";
import { elkLayout } from "./layout/elk.js";
import { renderGraph } from "./render/svg.js";
import { attachInteractions, type View } from "./render/interact.js";

const svg = must<SVGSVGElement>("#canvas");
const stage = must<HTMLElement>("#stage");
const statusEl = must<HTMLElement>("#status");
const details = must<HTMLElement>("#details");
const fileInput = must<HTMLInputElement>("#file-input");
const pasteBtn = must<HTMLButtonElement>("#paste-btn");
const pasteDialog = must<HTMLDialogElement>("#paste-dialog");
const pasteArea = must<HTMLTextAreaElement>("#paste-area");
const pasteLoad = must<HTMLButtonElement>("#paste-load");
const shareBtn = must<HTMLButtonElement>("#share-btn");

// The most recently rendered dump text, so Share can POST it to the server.
let lastDumpText: string | null = null;
// Cached share link for the currently-shown dump: primed when we arrive via ?g=,
// set after a first Share, and cleared when a different dump loads — so repeated
// Share clicks reuse the same link instead of minting a new key each time.
let shareUrl: string | null = null;

function must<T extends Element>(sel: string): T {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element ${sel}`);
  return node;
}

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.style.color = error ? "#e07070" : "";
}

// Getter for the current pan/zoom, so a live re-render can keep the viewport steady.
let viewGetter: (() => View) | undefined;

async function renderText(text: string, sourceLabel: string, keepView = false): Promise<void> {
  let graph: Graph;
  try {
    graph = buildGraph(JSON.parse(text));
  } catch (err) {
    setStatus(`Failed to parse ${sourceLabel}: ${(err as Error).message}`, true);
    return;
  }
  const prevView = keepView ? viewGetter?.() : undefined; // carry pan/zoom on live updates
  setStatus("Laying out…");
  const positioned = await elkLayout(graph);
  const { sceneEl } = renderGraph(svg, graph, positioned);
  viewGetter = attachInteractions(svg, sceneEl, graph, positioned, details, prevView);
  details.hidden = true;
  stage.classList.add("has-graph");
  lastDumpText = text;
  shareUrl = null; // a different dump is showing; any cached link no longer applies
  shareBtn.disabled = false;
  setStatus(
    `${graph.nodes.size} nodes · ${graph.ports.size} ports · ${graph.links.length} links — ${sourceLabel}`,
  );
}

async function loadFromUrl(url: string): Promise<void> {
  setStatus(`Fetching ${url}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await renderText(await res.text(), url);
}

// --- file open + drag/drop ---
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (file) await renderText(await file.text(), file.name);
});

stage.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  stage.classList.add("drag-over");
});
stage.addEventListener("dragleave", () => stage.classList.remove("drag-over"));
stage.addEventListener("drop", async (ev) => {
  ev.preventDefault();
  stage.classList.remove("drag-over");
  const file = ev.dataTransfer?.files?.[0];
  if (file) await renderText(await file.text(), file.name);
});

// --- paste dialog ---
pasteBtn.addEventListener("click", () => pasteDialog.showModal());
pasteLoad.addEventListener("click", async () => {
  const text = pasteArea.value.trim();
  pasteDialog.close();
  if (text) await renderText(text, "pasted JSON");
});

// --- share: reuse the existing link if we have one, else POST for a new ?g= key ---
async function copyShare(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    setStatus(`Share link copied: ${url}`);
  } catch {
    // Clipboard may be unavailable (non-secure context); show the link to copy.
    setStatus(`Share link: ${url}`);
  }
}

shareBtn.addEventListener("click", async () => {
  if (!lastDumpText) return;
  if (shareUrl) {
    await copyShare(shareUrl); // already shared / arrived via ?g= — don't mint a new key
    return;
  }
  shareBtn.disabled = true;
  setStatus("Sharing…");
  try {
    const res = await fetch("/api/dumps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: lastDumpText,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { key, url } = (await res.json()) as { key: string; url: string };
    shareUrl = url;
    history.replaceState(null, "", `?g=${key}`); // reflect the shareable link in the address bar
    await copyShare(url);
  } catch (err) {
    setStatus(`Share failed (${(err as Error).message}). Is the server running?`, true);
  } finally {
    shareBtn.disabled = false;
  }
});

// The local viewer (pw-dump-graph) serves the live graph at /api/graph; the share
// server and static hosting don't. Try it so those deployments fall through.
async function tryLoadLive(): Promise<boolean> {
  try {
    const res = await fetch("/api/graph");
    if (!res.ok) return false;
    await renderText(await res.text(), "live (pw-dump -m)");
    startLive();
    return true;
  } catch {
    return false;
  }
}

// Subscribe to /api/events; on each (debounced) tick re-fetch /api/graph and re-render.
// EventSource auto-reconnects, so a restarted server just resumes the stream.
let liveTimer: ReturnType<typeof setTimeout> | undefined;
function startLive(): void {
  const es = new EventSource("/api/events");
  es.onmessage = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      try {
        const res = await fetch("/api/graph");
        if (res.ok) await renderText(await res.text(), "live (pw-dump -m)", true); // keep view
      } catch {
        /* transient; EventSource will keep us posted */
      }
    }, 120);
  };
}

// --- initial load ---
// Precedence: ?g=<key> (server-stored dump) → ?url=<href> → live /api/graph → sample.
(async () => {
  const params = new URLSearchParams(location.search);
  const key = params.get("g");
  const url = params.get("url");
  try {
    if (key) {
      await loadFromUrl(`/api/dumps/${encodeURIComponent(key)}`);
      shareUrl = location.href; // we're already at the share link; Share just re-copies it
    } else if (url) {
      await loadFromUrl(url);
    } else if (await tryLoadLive()) {
      // served by the local viewer — graph loaded from /api/graph
    } else {
      // bundled sample (served from examples/ via Vite publicDir)
      await loadFromUrl("/pw-dump.json");
    }
  } catch (err) {
    setStatus(`No graph loaded (${(err as Error).message}). Drop or paste a pw-dump JSON.`, true);
  }
})();
