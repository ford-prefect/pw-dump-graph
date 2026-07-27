// Layer 4 — interactions: pan, zoom, hover-highlight, click-to-select.
// Operates purely on the rendered DOM plus the neutral PositionedGraph; no
// layout-library or model-internal knowledge beyond ids.

import type { Graph, Node } from "../model.js";
import type { PositionedGraph } from "../layout/types.js";
import { nodeDetailsHTML, updateGrid } from "./svg.js";

interface View {
  x: number;
  y: number;
  scale: number;
}

export function attachInteractions(
  svg: SVGSVGElement,
  scene: SVGGElement,
  graph: Graph,
  positioned: PositionedGraph,
  details: HTMLElement,
): void {
  // --- adjacency: port id -> node id, node id -> incident edge ids ---
  const portToNode = new Map<number, number>();
  for (const n of positioned.nodes) for (const p of n.ports) portToNode.set(p.id, n.id);
  const nodeEdges = new Map<number, Set<number>>();
  for (const e of positioned.edges) {
    const a = portToNode.get(e.from);
    const b = portToNode.get(e.to);
    if (a !== undefined) (nodeEdges.get(a) ?? setInit(nodeEdges, a)).add(e.id);
    if (b !== undefined) (nodeEdges.get(b) ?? setInit(nodeEdges, b)).add(e.id);
  }

  // --- view transform: fit the graph, then allow pan/zoom ---
  const view: View = fitView(svg, positioned);
  applyView(svg, scene, view);

  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    // zoom about the cursor
    const next = Math.min(4, Math.max(0.1, view.scale * factor));
    view.x = mx - (mx - view.x) * (next / view.scale);
    view.y = my - (my - view.y) * (next / view.scale);
    view.scale = next;
    applyView(svg, scene, view);
  }, { passive: false });

  let panning = false;
  let startX = 0;
  let startY = 0;
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if ((ev.target as Element).closest(".node-group")) return; // let clicks select
    panning = true;
    startX = ev.clientX - view.x;
    startY = ev.clientY - view.y;
    svg.classList.add("panning");
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!panning) return;
    view.x = ev.clientX - startX;
    view.y = ev.clientY - startY;
    applyView(svg, scene, view);
  });
  const endPan = () => {
    panning = false;
    svg.classList.remove("panning");
  };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);

  // --- hover highlight ---
  const edgeEls = new Map<number, Element>();
  scene.querySelectorAll<Element>(".edge").forEach((p) => edgeEls.set(Number(p.getAttribute("data-edge-id")), p));
  const nodeEls = new Map<number, Element>();
  scene.querySelectorAll<Element>(".node-group").forEach((g) => nodeEls.set(Number(g.getAttribute("data-node-id")), g));

  // Additive only: hovering brightens the node and its links, it never dims the
  // rest of the graph — a whole-canvas opacity change on every pointer move is
  // too distracting to read around.
  function clearHi() {
    scene.querySelectorAll(".hi").forEach((n) => n.classList.remove("hi"));
  }
  function highlightNode(id: number) {
    clearHi();
    nodeEls.get(id)?.classList.add("hi");
    for (const eid of nodeEdges.get(id) ?? []) {
      const edge = edgeEls.get(eid);
      edge?.classList.add("hi");
      // Raise it within the edge layer so it reads over its neighbours instead
      // of relying on everything else fading out.
      if (edge) edge.parentNode?.appendChild(edge);
      // also light up the node at the other end
      const from = Number(edge?.getAttribute("data-from"));
      const to = Number(edge?.getAttribute("data-to"));
      const other = portToNode.get(from) === id ? portToNode.get(to) : portToNode.get(from);
      if (other !== undefined) nodeEls.get(other)?.classList.add("hi");
    }
  }

  for (const [id, g] of nodeEls) {
    g.addEventListener("pointerenter", () => highlightNode(id));
    g.addEventListener("pointerleave", clearHi);
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      showDetails(graph.nodes.get(id));
    });
  }

  function showDetails(node: Node | undefined) {
    if (!node) return;
    details.innerHTML = nodeDetailsHTML(node);
    details.hidden = false;
    details.querySelector(".close")?.addEventListener("click", () => (details.hidden = true));
  }
}

function setInit(m: Map<number, Set<number>>, k: number): Set<number> {
  const s = new Set<number>();
  m.set(k, s);
  return s;
}

function applyView(svg: SVGSVGElement, scene: SVGGElement, v: View): void {
  scene.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.scale})`);
  updateGrid(svg, v.x, v.y, v.scale);
}

function fitView(svg: SVGSVGElement, positioned: PositionedGraph): View {
  const rect = svg.getBoundingClientRect();
  const pad = 40;
  const w = positioned.width || 1;
  const h = positioned.height || 1;
  const scale = Math.min(1, Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h));
  return {
    x: (rect.width - w * scale) / 2,
    y: (rect.height - h * scale) / 2,
    scale: scale > 0 ? scale : 1,
  };
}
