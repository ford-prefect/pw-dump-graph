// Layer 3 (adapter) — elkjs implementation of LayoutEngine.
// This is the ONLY file that imports elkjs. It sizes the node boxes, hands elk
// a port-aware layered graph, and maps elk's result back into our neutral
// PositionedGraph. Replace this file to swap layout engines.

import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { Direction, Graph, Node, Port } from "../model.js";
import type { LaidOutEdge, LaidOutNode, LaidOutPort, LayoutEngine, PositionedGraph } from "./types.js";

// --- box sizing (kept here so the renderer just honours the geometry) ---
// The header band is reserved space: port rows start below it, so a node's
// name/media-class can never collide with the first port's channel label.
const HEADER_H = 42; // title + media.class band
const PORT_ROW_H = 20; // vertical spacing between port stubs
const PORT_PAD_Y = 9; // padding above/below the port block
const TITLE_CHAR_W = 6.6; // rough glyph width, 12px semibold
const PORT_CHAR_W = 5.6; // rough glyph width, 10px regular
const SIDE_PAD = 14; // gap between a node edge and its port label
const MID_GAP = 44; // clear space between the in- and out-label columns
const MIN_W = 160;
const MAX_W = 340;
const PORT_LABEL_CAP = 22; // cap chars of a port label counted toward width

function portLabel(p: Port): string {
  return p.channel ?? p.name;
}

function nodeSize(node: Node): { w: number; h: number } {
  const ins = node.ports.filter((p) => p.direction === "in");
  const outs = node.ports.filter((p) => p.direction === "out");
  const rows = Math.max(ins.length, outs.length);
  // Port-less nodes (drivers) collapse to just the header band.
  const h = HEADER_H + (rows > 0 ? rows * PORT_ROW_H + PORT_PAD_Y * 2 : 0);

  const titleW = node.name.length * TITLE_CHAR_W + 26;
  const widest = (ps: Port[]) =>
    ps.reduce((m, p) => Math.max(m, Math.min(portLabel(p).length, PORT_LABEL_CAP)), 0);
  // Both label columns plus the padding that keeps them apart.
  const portsW =
    (widest(ins) + widest(outs)) * PORT_CHAR_W + SIDE_PAD * 2 + (ins.length && outs.length ? MID_GAP : 0);
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.max(titleW, portsW)));
  return { w, h };
}

function elkPortSide(dir: Direction): "WEST" | "EAST" {
  return dir === "in" ? "WEST" : "EAST";
}

/** Row centre of the i-th port on a side, relative to the node's top edge. */
function portRowY(i: number): number {
  return HEADER_H + PORT_PAD_Y + i * PORT_ROW_H + PORT_ROW_H / 2;
}

const elk = new ELK();

export const elkLayout: LayoutEngine = async (graph: Graph): Promise<PositionedGraph> => {
  const sides = new Map<number, Direction>(); // port id -> side, for mapping back
  // port id -> stub centre relative to its node. Ports are handed to elk as
  // zero-size points at exactly this spot, so elk's edge endpoints land on the
  // dot the renderer draws; keeping the map avoids trusting elk's echoed coords.
  const centres = new Map<number, { dx: number; dy: number }>();

  const children: ElkNode[] = [];
  for (const node of graph.nodes.values()) {
    const { w, h } = nodeSize(node);
    // FIXED_POS (rather than FIXED_SIDE): we place the stubs on our own rows so
    // they clear the header band and line up with the labels the renderer draws.
    // The cost is that elk no longer reorders ports to reduce crossings — worth
    // it for stable rows in declaration order (FL before FR, etc.).
    const rowIndex = { in: 0, out: 0 };
    children.push({
      id: `n${node.id}`,
      width: w,
      height: h,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: node.ports.map((p) => {
        sides.set(p.id, p.direction);
        const i = rowIndex[p.direction]++;
        centres.set(p.id, { dx: p.direction === "in" ? 0 : w, dy: portRowY(i) });
        return {
          id: `p${p.id}`,
          // Zero-size: a port box would make elk anchor edges at its outer face
          // rather than at the dot, leaving a visible gap at every stub.
          width: 0,
          height: 0,
          x: p.direction === "in" ? 0 : w,
          y: portRowY(i),
          layoutOptions: { "elk.port.side": elkPortSide(p.direction) },
        };
      }),
    });
  }

  // Only wire edges whose endpoints are real, laid-out ports.
  const edges: ElkExtendedEdge[] = [];
  for (const link of graph.links) {
    if (!graph.ports.has(link.outPort) || !graph.ports.has(link.inPort)) continue;
    edges.push({
      id: `e${link.id}`,
      sources: [`p${link.outPort}`],
      targets: [`p${link.inPort}`],
    });
  }

  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "48",
      "elk.spacing.edgeNode": "24",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "elk.edgeRouting": "SPLINES",
    },
    children,
    edges,
  };

  const res = await elk.layout(root);

  const outNodes: LaidOutNode[] = (res.children ?? []).map((c) => {
    const nx = c.x ?? 0;
    const ny = c.y ?? 0;
    const ports: LaidOutPort[] = (c.ports ?? []).map((p) => {
      const id = Number(String(p.id).slice(1));
      const centre = centres.get(id);
      return {
        id,
        x: nx + (centre?.dx ?? p.x ?? 0),
        y: ny + (centre?.dy ?? p.y ?? 0),
        side: sides.get(id) ?? "in",
      };
    });
    return {
      id: Number(String(c.id).slice(1)),
      x: nx,
      y: ny,
      w: c.width ?? MIN_W,
      h: c.height ?? HEADER_H,
      headerH: HEADER_H,
      ports,
    };
  });

  const outEdges: LaidOutEdge[] = (res.edges ?? []).map((e) => {
    const section = e.sections?.[0];
    const points: { x: number; y: number }[] = [];
    if (section) {
      points.push(section.startPoint);
      for (const bp of section.bendPoints ?? []) points.push(bp);
      points.push(section.endPoint);
    }
    return {
      id: Number(String(e.id).slice(1)),
      from: Number(String(e.sources[0]).slice(1)),
      to: Number(String(e.targets[0]).slice(1)),
      points,
    };
  });

  return {
    nodes: outNodes,
    edges: outEdges,
    width: res.width ?? 0,
    height: res.height ?? 0,
  };
};
