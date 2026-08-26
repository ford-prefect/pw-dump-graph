// Layer 4 — internal filter-graph drawing.
// Self-contained: lays out and draws a node's internal audio filter graph
// (audioconvert.filter-graph) as a small left→right SVG shown in a popup. No
// elkjs, fully synchronous — these graphs are tiny (a handful of DSP nodes,
// usually a linear chain). Reuses only the pure string helpers from svg.ts.

import type { FilterGraph, Node } from "../model.js";
import { esc, smoothPath, truncate } from "./svg.js";

const BOX_W = 164;
const BOX_H = 56;
const COL_GAP = 48; // horizontal gap between layers
const ROW_GAP = 22; // vertical gap between nodes sharing a layer
const PAD = 18;
const LABEL_CHAR_W = 7.1; // ~13px font
const NAME_CHAR_W = 6.1; // ~11px font

interface Box {
  name: string;
  label?: string;
  controls?: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Layout {
  boxes: Box[];
  edges: Array<{ from: number; to: number }>; // indices into boxes
  width: number;
  height: number;
}

/** Split a "node:port" link endpoint into its node name (we draw box-to-box, so
 *  the port half is unused for now). */
function endpointNode(s: string): string {
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(0, i);
}

/** Lay the filter graph out into left→right columns: a node's column is the
 *  longest path from any source (node with no inputs) to it, so signal flows
 *  rightward. Synchronous; guarded against cycles (filter graphs are DAGs). */
export function layoutFilterGraph(fg: FilterGraph): Layout {
  // Preserve first-appearance order; fold in any name referenced only by a link.
  const order: string[] = [];
  const byName = new Map<string, { label?: string; controls?: Record<string, unknown> }>();
  const see = (name: string, data?: { label?: string; controls?: Record<string, unknown> }) => {
    if (!byName.has(name)) {
      byName.set(name, data ?? {});
      order.push(name);
    } else if (data) {
      byName.set(name, data);
    }
  };
  for (const n of fg.nodes) see(n.name, { label: n.label, controls: n.controls });

  const preds = new Map<string, string[]>();
  const edgePairs: Array<[string, string]> = [];
  for (const l of fg.links) {
    const from = endpointNode(l.output);
    const to = endpointNode(l.input);
    see(from);
    see(to);
    (preds.get(to) ?? preds.set(to, []).get(to)!).push(from);
    edgePairs.push([from, to]);
  }

  // Longest-path column via memoized DFS with a visited guard (cycle → 0).
  const col = new Map<string, number>();
  const onStack = new Set<string>();
  const column = (name: string): number => {
    const cached = col.get(name);
    if (cached !== undefined) return cached;
    if (onStack.has(name)) return 0; // cycle guard
    onStack.add(name);
    const ps = preds.get(name) ?? [];
    const c = ps.length ? Math.max(...ps.map((p) => column(p) + 1)) : 0;
    onStack.delete(name);
    col.set(name, c);
    return c;
  };
  for (const name of order) column(name);

  // Rows: within each column, keep first-appearance order.
  const rows = new Map<string, number>();
  const colCount = new Map<number, number>();
  for (const name of order) {
    const c = col.get(name)!;
    const r = colCount.get(c) ?? 0;
    rows.set(name, r);
    colCount.set(c, r + 1);
  }

  const numCols = Math.max(0, ...order.map((n) => col.get(n)! + 1));
  const maxRows = Math.max(0, ...[...colCount.values()]);
  const contentH = maxRows > 0 ? maxRows * BOX_H + (maxRows - 1) * ROW_GAP : 0;

  const idx = new Map<string, number>();
  const boxes: Box[] = order.map((name, i) => {
    idx.set(name, i);
    const c = col.get(name)!;
    const r = rows.get(name)!;
    const k = colCount.get(c)!;
    const colH = k * BOX_H + (k - 1) * ROW_GAP;
    const yOffset = PAD + (contentH - colH) / 2; // vertically center each column
    const meta = byName.get(name)!;
    return {
      name,
      label: meta.label,
      controls: meta.controls,
      x: PAD + c * (BOX_W + COL_GAP),
      y: yOffset + r * (BOX_H + ROW_GAP),
      w: BOX_W,
      h: BOX_H,
    };
  });

  const edges = edgePairs
    .map(([from, to]) => ({ from: idx.get(from)!, to: idx.get(to)! }))
    .filter((e) => e.from !== undefined && e.to !== undefined);

  return {
    boxes,
    edges,
    width: numCols > 0 ? PAD * 2 + numCols * BOX_W + (numCols - 1) * COL_GAP : PAD * 2,
    height: PAD * 2 + contentH,
  };
}

function controlsText(c?: Record<string, unknown>): string {
  return c ? Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") : "";
}

/** Render the filter graph as a standalone SVG string (left→right). Each DSP
 *  node is a box (algorithm label + name); its controls are a hover tooltip. */
export function filterGraphSVG(fg: FilterGraph): string {
  const { boxes, edges, width, height } = layoutFilterGraph(fg);

  const edgeEls = edges
    .map(({ from, to }) => {
      const a = boxes[from];
      const b = boxes[to];
      const d = smoothPath([
        { x: a.x + a.w, y: a.y + a.h / 2 },
        { x: b.x, y: b.y + b.h / 2 },
      ]);
      return `<path class="fg-edge" d="${d}" />`;
    })
    .join("");

  const nodeEls = boxes
    .map((b) => {
      const cx = b.x + b.w / 2;
      const label = b.label ? truncate(b.label, Math.floor((b.w - 16) / LABEL_CHAR_W)) : "";
      const name = truncate(b.name, Math.floor((b.w - 16) / NAME_CHAR_W));
      const ctrl = controlsText(b.controls);
      const tip = ctrl ? `${b.name} — ${ctrl}` : b.name;
      return (
        `<g class="fg-node-g">` +
        `<title>${esc(tip)}</title>` +
        `<rect class="fg-node" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="7" />` +
        (label
          ? `<text class="fg-label" x="${cx}" y="${b.y + 23}" text-anchor="middle">${esc(label)}</text>`
          : "") +
        `<text class="fg-name" x="${cx}" y="${b.y + (label ? 40 : 32)}" text-anchor="middle">${esc(name)}</text>` +
        `</g>`
      );
    })
    .join("");

  return (
    `<svg class="fg-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}">${edgeEls}${nodeEls}</svg>`
  );
}

/** Populate and open the filter-graph popup for one of a node's graphs (matched
 *  by its `audioconvert.filter-graph.N` index). No-op if the dialog or graph is
 *  missing. */
export function openFilterGraph(node: Node, graphIndex: number): void {
  const dialog = document.getElementById("filter-graph-dialog") as HTMLDialogElement | null;
  if (!dialog) return;
  const fg = node.filterGraphs?.find((g) => g.index === graphIndex);
  if (!fg) return;
  const title = dialog.querySelector(".fg-title");
  if (title) title.textContent = `${node.name} · filter graph`;
  const body = dialog.querySelector(".fg-body");
  if (body) body.innerHTML = filterGraphSVG(fg);
  dialog.showModal();
}
