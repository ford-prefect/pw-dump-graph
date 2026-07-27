// Layer 4 — SVG renderer.
// Consumes ONLY the neutral PositionedGraph (for geometry) plus the domain Graph
// (for labels/classes). It must NEVER import elkjs or any layout library.

import type { Graph, Node, Port } from "../model.js";
import type { PositionedGraph } from "../layout/types.js";

const SVGNS = "http://www.w3.org/2000/svg";

// media.class family -> accent color. Absent/unknown falls into "other".
function accentFor(mediaClass?: string): string {
  const c = mediaClass ?? "";
  if (c.startsWith("Audio/Sink")) return "#4a90d9";
  if (c.startsWith("Audio/Source")) return "#5fb56f";
  if (c.startsWith("Stream/Output")) return "#57c3c7";
  if (c.startsWith("Stream/Input")) return "#c78bd8";
  if (c.startsWith("Video")) return "#e0913a";
  if (c.startsWith("Midi")) return "#d86fa0";
  return "#7c8797"; // Other (incl. driver nodes with no media.class)
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars < 2) return "";
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}

// Glyph-width estimates matching the font sizes in styles.css. Used only to
// decide where to clip text inside the box the layout gave us.
const TITLE_CHAR_W = 6.6;
const PORT_CHAR_W = 5.6;
const SIDE_PAD = 14; // gap between the node edge and its port label
const MID_GAP = 44; // clear space kept between the in- and out-label columns
const GRID_MINOR = 28; // scene units between fine grid lines

/** Convert a polyline (elk spline control points) into a smooth path string. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    const [a, b] = points;
    const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  // Catmull-Rom -> cubic bezier through all points.
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function renderNode(node: Node, laid: PositionedGraph["nodes"][number]): SVGGElement {
  const g = el("g", { class: "node-group", "data-node-id": node.id });
  const accent = accentFor(node.mediaClass);

  const r = 7;
  g.appendChild(el("rect", { class: "node-box", x: laid.x, y: laid.y, width: laid.w, height: laid.h, rx: r }));
  // Header band: same rounded top corners as the box, square along the divider.
  // Port-less nodes (drivers) are all header, so the band would just repaint them.
  if (laid.ports.length > 0) {
    g.appendChild(
      el("path", {
        class: "node-header",
        d:
          `M ${laid.x} ${laid.y + laid.headerH} L ${laid.x} ${laid.y + r} ` +
          `A ${r} ${r} 0 0 1 ${laid.x + r} ${laid.y} L ${laid.x + laid.w - r} ${laid.y} ` +
          `A ${r} ${r} 0 0 1 ${laid.x + laid.w} ${laid.y + r} L ${laid.x + laid.w} ${laid.y + laid.headerH} Z`,
      }),
    );
  }
  g.appendChild(
    el("line", {
      class: "node-accent",
      x1: laid.x + 2,
      y1: laid.y + 8,
      x2: laid.x + 2,
      y2: laid.y + laid.h - 8,
      stroke: accent,
    }),
  );

  const title = el("text", { class: "node-title", x: laid.x + 13, y: laid.y + (node.mediaClass ? 16 : 21) });
  title.textContent = truncate(node.name, Math.floor((laid.w - 26) / TITLE_CHAR_W));
  g.appendChild(title);
  if (node.mediaClass) {
    const sub = el("text", { class: "node-sub", x: laid.x + 13, y: laid.y + 30 });
    sub.textContent = truncate(node.mediaClass, Math.floor((laid.w - 26) / PORT_CHAR_W));
    g.appendChild(sub);
  }

  // Separator marking the reserved header band, so the title reads as its own
  // row rather than crowding the first port.
  if (laid.ports.length > 0) {
    g.appendChild(
      el("line", {
        class: "node-divider",
        x1: laid.x + 1,
        y1: laid.y + laid.headerH,
        x2: laid.x + laid.w - 1,
        y2: laid.y + laid.headerH,
      }),
    );
  }

  // A label column only has to share the box when the other side has ports too.
  // Halving MID_GAP mirrors how the layout sized the box, so the two columns
  // keep that gap between them instead of meeting in the middle.
  const twoSided =
    laid.ports.some((p) => p.side === "in") && laid.ports.some((p) => p.side === "out");
  const labelRoom = twoSided ? laid.w / 2 - SIDE_PAD - MID_GAP / 2 : laid.w - SIDE_PAD * 2;
  const labelChars = Math.floor(labelRoom / PORT_CHAR_W);

  for (const lp of laid.ports) {
    const port = node.ports.find((p) => p.id === lp.id);
    if (!port) continue;
    const dot = el("circle", {
      class: port.monitor ? "port-dot monitor" : "port-dot",
      cx: lp.x,
      cy: lp.y,
      r: 4,
      "data-port-id": port.id,
    });
    g.appendChild(dot);

    const inside = lp.side === "in";
    const label = el("text", {
      class: "port-label",
      x: inside ? lp.x + SIDE_PAD : lp.x - SIDE_PAD,
      y: lp.y,
      "text-anchor": inside ? "start" : "end",
    });
    label.textContent = truncate(port.channel ?? port.name, labelChars);
    g.appendChild(label);
  }
  return g;
}

/** Backdrop + grid, drawn inside the SVG rather than as a CSS background on the
 *  element: the rects are unambiguous across browsers, and `updateGrid` can slide
 *  the pattern so the grid pans and zooms with the scene. */
function renderBackdrop(svg: SVGSVGElement): void {
  const defs = el("defs");
  for (const [id, size, cls] of [
    ["pw-grid-minor", GRID_MINOR, "grid-minor"],
    ["pw-grid-major", GRID_MINOR * 5, "grid-major"],
  ] as const) {
    const pattern = el("pattern", {
      id,
      "data-tile": size, // unzoomed spacing; updateGrid scales from this
      width: size,
      height: size,
      patternUnits: "userSpaceOnUse",
    });
    pattern.appendChild(el("path", { class: cls, d: `M ${size} 0 L 0 0 0 ${size}` }));
    defs.appendChild(pattern);
  }
  svg.appendChild(defs);

  svg.appendChild(el("rect", { class: "backdrop", x: 0, y: 0, width: "100%", height: "100%" }));
  for (const id of ["pw-grid-minor", "pw-grid-major"]) {
    svg.appendChild(
      el("rect", { class: "grid", "data-grid": id, width: "100%", height: "100%", fill: `url(#${id})` }),
    );
  }
}

/** Keep the grid patterns aligned with the scene transform. The tile is resized
 *  rather than scaled via patternTransform, which would scale the stroke too and
 *  make the lines disappear when zoomed out. */
export function updateGrid(svg: SVGSVGElement, x: number, y: number, scale: number): void {
  svg.querySelectorAll<SVGPatternElement>("pattern").forEach((p) => {
    const tile = Number(p.dataset.tile) * scale;
    p.setAttribute("width", String(tile));
    p.setAttribute("height", String(tile));
    p.setAttribute("patternTransform", `translate(${x} ${y})`);
    p.firstElementChild?.setAttribute("d", `M ${tile} 0 L 0 0 0 ${tile}`);
  });
  // Below ~12px apart the fine grid turns into noise; leave only the coarse one.
  const minor = svg.querySelector<SVGRectElement>('[data-grid="pw-grid-minor"]');
  minor?.setAttribute("opacity", GRID_MINOR * scale < 12 ? "0" : "1");
}

export interface RenderResult {
  sceneEl: SVGGElement;
}

/** Draw the whole graph into `svg`, returning the transformable scene group. */
export function renderGraph(svg: SVGSVGElement, graph: Graph, positioned: PositionedGraph): RenderResult {
  svg.replaceChildren();
  renderBackdrop(svg);
  const scene = el("g", { class: "scene" });

  // Edges first (behind nodes).
  const edgeLayer = el("g", { class: "edge-layer" });
  for (const e of positioned.edges) {
    const path = el("path", {
      class: "edge",
      d: smoothPath(e.points),
      "data-edge-id": e.id,
      "data-from": e.from,
      "data-to": e.to,
    });
    edgeLayer.appendChild(path);
  }
  scene.appendChild(edgeLayer);

  // Nodes on top.
  const nodeLayer = el("g", { class: "node-layer" });
  for (const laid of positioned.nodes) {
    const node = graph.nodes.get(laid.id);
    if (!node) continue;
    nodeLayer.appendChild(renderNode(node, laid));
  }
  scene.appendChild(nodeLayer);

  svg.appendChild(scene);
  return { sceneEl: scene };
}

/** Render a node's details into the side panel body. */
export function nodeDetailsHTML(node: Node): string {
  const row = (k: string, v: string) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  const portRow = (p: Port) =>
    `<tr><td class="k">${p.direction === "out" ? "▸" : "◂"} ${esc(p.channel ?? p.name)}</td><td>${esc(p.format ?? "")}</td></tr>`;

  const keyProps = ["media.class", "node.name", "node.description", "object.serial", "client.id"];
  const propRows = keyProps
    .filter((k) => node.props[k] !== undefined)
    .map((k) => row(k, String(node.props[k])))
    .join("");

  const ports = node.ports.map(portRow).join("") || `<tr><td colspan="2">(no ports)</td></tr>`;

  return `
    <span class="close">✕</span>
    <h3>${esc(node.name)}</h3>
    <div>id ${node.id}</div>
    <div class="section">Properties</div>
    <table>${propRows}</table>
    <div class="section">Ports (${node.ports.length})</div>
    <table>${ports}</table>
  `;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
