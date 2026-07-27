// Layer 3 (adapter) — elkjs implementation of LayoutEngine.
// This is the ONLY file that imports elkjs. It sizes the node boxes, hands elk
// a port-aware layered graph, and maps elk's result back into our neutral
// PositionedGraph. Replace this file to swap layout engines.

import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { Direction, Graph, Node, Port } from "../model.js";
import type { LaidOutEdge, LaidOutNode, LaidOutPort, LayoutEngine, PositionedGraph } from "./types.js";

// --- box sizing (kept here so the renderer just honours the geometry) ---
const HEADER_H = 34; // title band
const PORT_ROW_H = 18; // vertical spacing between port stubs
const PORT_PAD_Y = 10; // padding above/below the port block
const CHAR_W = 6.5; // rough glyph width for width estimation
const MIN_W = 150;
const MAX_W = 340;
const PORT_LABEL_CAP = 22; // cap chars of a port label counted toward width

function portLabel(p: Port): string {
  return p.channel ?? p.name;
}

function nodeSize(node: Node): { w: number; h: number } {
  const ins = node.ports.filter((p) => p.direction === "in");
  const outs = node.ports.filter((p) => p.direction === "out");
  const rows = Math.max(ins.length, outs.length);
  const h = HEADER_H + (rows > 0 ? rows * PORT_ROW_H + PORT_PAD_Y * 2 : 8);

  const titleW = node.name.length * CHAR_W + 24;
  const widest = (ps: Port[]) =>
    ps.reduce((m, p) => Math.max(m, Math.min(portLabel(p).length, PORT_LABEL_CAP)), 0);
  const portsW = (widest(ins) + widest(outs)) * CHAR_W + 60;
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.max(titleW, portsW)));
  return { w, h };
}

function elkPortSide(dir: Direction): "WEST" | "EAST" {
  return dir === "in" ? "WEST" : "EAST";
}

const elk = new ELK();

export const elkLayout: LayoutEngine = async (graph: Graph): Promise<PositionedGraph> => {
  const sides = new Map<number, Direction>(); // port id -> side, for mapping back

  const children: ElkNode[] = [];
  for (const node of graph.nodes.values()) {
    const { w, h } = nodeSize(node);
    children.push({
      id: `n${node.id}`,
      width: w,
      height: h,
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: node.ports.map((p) => {
        sides.set(p.id, p.direction);
        return {
          id: `p${p.id}`,
          width: 8,
          height: 8,
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
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "40",
      "elk.spacing.portPort": String(PORT_ROW_H - 8),
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
      return {
        id,
        x: nx + (p.x ?? 0) + (p.width ?? 0) / 2,
        y: ny + (p.y ?? 0) + (p.height ?? 0) / 2,
        side: sides.get(id) ?? "in",
      };
    });
    return { id: Number(String(c.id).slice(1)), x: nx, y: ny, w: c.width ?? MIN_W, h: c.height ?? 40, ports };
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
