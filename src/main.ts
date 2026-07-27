// Entry point — wiring only.
// Pipeline: text -> JSON.parse -> buildGraph -> elkLayout -> renderGraph -> attachInteractions.
// Data source precedence: ?url= -> dropped/selected file -> pasted JSON -> bundled sample.

import "./styles.css";
import { buildGraph, type Graph } from "./model.js";
import { elkLayout } from "./layout/elk.js";
import { renderGraph } from "./render/svg.js";
import { attachInteractions } from "./render/interact.js";

const svg = must<SVGSVGElement>("#canvas");
const stage = must<HTMLElement>("#stage");
const statusEl = must<HTMLElement>("#status");
const details = must<HTMLElement>("#details");
const fileInput = must<HTMLInputElement>("#file-input");
const pasteBtn = must<HTMLButtonElement>("#paste-btn");
const pasteDialog = must<HTMLDialogElement>("#paste-dialog");
const pasteArea = must<HTMLTextAreaElement>("#paste-area");
const pasteLoad = must<HTMLButtonElement>("#paste-load");

function must<T extends Element>(sel: string): T {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element ${sel}`);
  return node;
}

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.style.color = error ? "#e07070" : "";
}

async function renderText(text: string, sourceLabel: string): Promise<void> {
  let graph: Graph;
  try {
    graph = buildGraph(JSON.parse(text));
  } catch (err) {
    setStatus(`Failed to parse ${sourceLabel}: ${(err as Error).message}`, true);
    return;
  }
  setStatus("Laying out…");
  const positioned = await elkLayout(graph);
  const { sceneEl } = renderGraph(svg, graph, positioned);
  attachInteractions(svg, sceneEl, graph, positioned, details);
  details.hidden = true;
  stage.classList.add("has-graph");
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

// --- initial load ---
(async () => {
  const url = new URLSearchParams(location.search).get("url");
  try {
    if (url) {
      await loadFromUrl(url);
    } else {
      // bundled sample (served from examples/ via Vite publicDir)
      await loadFromUrl("/pw-dump.json");
    }
  } catch (err) {
    setStatus(`No graph loaded (${(err as Error).message}). Drop or paste a pw-dump JSON.`, true);
  }
})();
