// Layer 3 (adapter) — elkjs implementation of LayoutEngine.
// This is the ONLY file that imports elkjs. It sizes the node boxes, hands elk
// a port-aware layered graph, and maps elk's result back into our neutral
// PositionedGraph. Replace this file to swap layout engines.

import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type { Direction, Graph, Node, Port } from "../model.js";
import type { LaidOutEdge, LaidOutGroup, LaidOutNode, LaidOutPort, LayoutEngine, PositionedGraph } from "./types.js";

// --- box sizing (kept here so the renderer just honours the geometry) ---
// The header band is reserved space: port rows start below it, so a node's
// name/media-class/format lines can never collide with the first port's label.
// It sizes to the number of header lines (title, + media.class, + format), and
// svg.ts places the text at the matching offsets (HEADER_TOP + i*HEADER_LINE).
const HEADER_TOP = 8; // padding above the first header line
const HEADER_LINE = 14; // per-line height in the header
const HEADER_BOTTOM = 8; // padding below the last header line
const PORT_ROW_H = 20; // vertical spacing between port stubs
const PORT_PAD_Y = 9; // padding above/below the port block
const TITLE_CHAR_W = 6.6; // rough glyph width, 12px semibold
const PORT_CHAR_W = 5.6; // rough glyph width, 10px regular
const SIDE_PAD = 14; // gap between a node edge and its port label
const MID_GAP = 44; // clear space between the in- and out-label columns
const MIN_W = 160;
const MAX_W = 340;
const PORT_LABEL_CAP = 22; // cap chars of a port label counted toward width
const GROUP_PAD_TOP = 28; // top inset of a group box, reserved for its label
const GROUP_PAD = 16; // left/right/bottom inset of a group box

/** Turn a raw node.link-group id ("echo-cancel-9549-32") into a readable label
 *  ("echo-cancel") by dropping the trailing numeric id segments. */
function groupLabel(id: string): string {
  return id.replace(/(-\d+)+$/, "") || id;
}

/** A node's dataflow lane and which side of it, inferred from media.class. Used to
 *  pair the two halves of a group on the same row: playback flows Audio/Sink ->
 *  Stream/Output, capture flows Stream/Input -> Audio/Source. Nodes with an
 *  unrecognised class get their own lane (a standalone row). */
function laneRole(n: Node): { lane: string; side: "in" | "out" } | undefined {
  const mc = n.mediaClass ?? "";
  if (mc.startsWith("Audio/Sink")) return { lane: "pb", side: "in" };
  if (mc.startsWith("Stream/Output")) return { lane: "pb", side: "out" };
  if (mc.startsWith("Stream/Input")) return { lane: "cap", side: "in" };
  if (mc.startsWith("Audio/Source")) return { lane: "cap", side: "out" };
  return undefined;
}

function portLabel(p: Port): string {
  return p.channel ?? p.name;
}

/** Header text lines: node name, then media.class and format when present. */
function headerLines(node: Node): number {
  return 1 + (node.mediaClass ? 1 : 0) + (node.format ? 1 : 0);
}
function headerHeight(node: Node): number {
  return HEADER_TOP + headerLines(node) * HEADER_LINE + HEADER_BOTTOM;
}

function nodeSize(node: Node): { w: number; h: number; headerH: number } {
  const ins = node.ports.filter((p) => p.direction === "in");
  const outs = node.ports.filter((p) => p.direction === "out");
  const rows = Math.max(ins.length, outs.length);
  const headerH = headerHeight(node);
  // Port-less nodes (drivers) collapse to just the header band.
  const h = headerH + (rows > 0 ? rows * PORT_ROW_H + PORT_PAD_Y * 2 : 0);

  const titleW = node.name.length * TITLE_CHAR_W + 26;
  // Header sub-lines (media.class, format) must fit too, else they'd clip.
  const subW = Math.max(node.mediaClass?.length ?? 0, node.format?.length ?? 0) * PORT_CHAR_W + 26;
  const widest = (ps: Port[]) =>
    ps.reduce((m, p) => Math.max(m, Math.min(portLabel(p).length, PORT_LABEL_CAP)), 0);
  // Both label columns plus the padding that keeps them apart.
  const portsW =
    (widest(ins) + widest(outs)) * PORT_CHAR_W + SIDE_PAD * 2 + (ins.length && outs.length ? MID_GAP : 0);
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.max(titleW, subW, portsW)));
  return { w, h, headerH };
}

function elkPortSide(dir: Direction): "WEST" | "EAST" {
  return dir === "in" ? "WEST" : "EAST";
}

/** Row centre of the i-th port on a side, relative to the node's top edge. */
function portRowY(headerH: number, i: number): number {
  return headerH + PORT_PAD_Y + i * PORT_ROW_H + PORT_ROW_H / 2;
}

const elk = new ELK();

export const elkLayout: LayoutEngine = async (graph: Graph): Promise<PositionedGraph> => {
  const sides = new Map<number, Direction>(); // port id -> side, for mapping back
  // port id -> stub centre relative to its node. Ports are handed to elk as
  // zero-size points at exactly this spot, so elk's edge endpoints land on the
  // dot the renderer draws; keeping the map avoids trusting elk's echoed coords.
  const centres = new Map<number, { dx: number; dy: number }>();
  const headers = new Map<number, number>(); // node id -> header band height

  // Build one elk box per node. Ports sit at fixed positions on our own rows
  // (see portRowY) so the stubs clear the header band and match the renderer.
  const makeNode = (node: Node): ElkNode => {
    const { w, h, headerH } = nodeSize(node);
    headers.set(node.id, headerH);
    const rowIndex = { in: 0, out: 0 };
    return {
      id: `n${node.id}`,
      width: w,
      height: h,
      // FIXED_POS: we own the row placement; the cost is elk no longer reorders
      // ports to reduce crossings, which is fine — model.ts already channel-sorts.
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: node.ports.map((p) => {
        sides.set(p.id, p.direction);
        const i = rowIndex[p.direction]++;
        centres.set(p.id, { dx: p.direction === "in" ? 0 : w, dy: portRowY(headerH, i) });
        return {
          id: `p${p.id}`,
          // Zero-size: a port box would make elk anchor edges at its outer face
          // rather than at the dot, leaving a visible gap at every stub.
          width: 0,
          height: 0,
          x: p.direction === "in" ? 0 : w,
          y: portRowY(headerH, i),
          layoutOptions: { "elk.port.side": elkPortSide(p.direction) },
        };
      }),
    };
  };

  // Internally-linked nodes go inside an elk compound container so they lay out
  // together and yield a bounding box; everything else stays at the root.
  const groupOf = new Map<number, string>();
  for (const g of graph.groups) for (const id of g.nodeIds) groupOf.set(id, g.id);

  const groupMeta = new Map<string, { id: string; label: string }>(); // elk id -> group
  const containers = new Map<string, ElkNode>(); // group id -> elk container
  graph.groups.forEach((g, i) => {
    const cid = `grp${i}`;
    groupMeta.set(cid, { id: g.id, label: groupLabel(g.id) });
    containers.set(g.id, {
      id: cid,
      layoutOptions: {
        "elk.padding": `[top=${GROUP_PAD_TOP},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
        "elk.spacing.nodeNode": "36",
      },
      children: [],
    });
  });

  // Pure sources (no incoming link, has output ports) are pinned to the first
  // layer so every capture/playback chain starts at the left edge — otherwise
  // network-simplex pulls a source (e.g. the mic) rightward next to its consumer,
  // burying it mid-graph. Only ungrouped nodes; grouped ones are placed by their
  // container.
  const consumers = new Set(graph.links.map((l) => l.inNode));
  const isSource = (n: Node) => !consumers.has(n.id) && n.ports.some((p) => p.direction === "out");
  // Portless nodes (Dummy/Freewheel drivers) carry no signal flow and no edges, so
  // elk gains nothing from them and its component packer just interleaves them with
  // the real sources. Keep them out of the layout entirely and stack them in a
  // corner afterwards (see below).
  const floaterNodes: Node[] = [];

  const children: ElkNode[] = [];
  for (const node of graph.nodes.values()) {
    if (node.ports.length === 0) {
      floaterNodes.push(node);
      continue;
    }
    const elkNode = makeNode(node);
    const gid = groupOf.get(node.id);
    const container = gid ? containers.get(gid) : undefined;
    if (container) {
      container.children!.push(elkNode);
    } else {
      if (isSource(node)) {
        elkNode.layoutOptions = { ...elkNode.layoutOptions, "elk.layered.layering.layerConstraint": "FIRST" };
      }
      children.push(elkNode);
    }
  }
  children.push(...containers.values());

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

  // A group container has no real edges between its members (the connection is
  // internal), so elk would stack them vertically. Add invisible node-to-node
  // ordering edges within each dataflow lane (see laneRole) from the input side to
  // the output side. This lays each lane out left→right AND, because different
  // lanes share no edge, puts each lane on its own row — so a 4-node echo-cancel
  // reads as [sink → playback] above [capture → source] with no special-casing.
  // The fallback (unknown class) orders a node by its own ports. Skipped in render.
  const hintEdgeIds = new Set<string>();
  let hintId = 0;
  for (const g of graph.groups) {
    const lanes = new Map<string, { ins: Node[]; outs: Node[] }>();
    for (const id of g.nodeIds) {
      const n = graph.nodes.get(id);
      if (!n) continue;
      const role = laneRole(n);
      const lane = role?.lane ?? `solo${id}`;
      const side =
        role?.side ??
        (n.ports.some((p) => p.direction === "out") && !n.ports.some((p) => p.direction === "in") ? "out" : "in");
      const bucket = lanes.get(lane) ?? lanes.set(lane, { ins: [], outs: [] }).get(lane)!;
      (side === "in" ? bucket.ins : bucket.outs).push(n);
    }
    for (const { ins, outs } of lanes.values()) {
      for (const a of ins) {
        for (const b of outs) {
          const eid = `h${hintId++}`;
          hintEdgeIds.add(eid);
          edges.push({ id: eid, sources: [`n${a.id}`], targets: [`n${b.id}`] });
        }
      }
    }
  }

  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      // Let the layered algorithm see across container boundaries so a group is
      // ordered right next to the nodes it connects to (source -> filter -> sink)
      // instead of being packed off on its own.
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "48",
      "elk.spacing.edgeNode": "24",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      // A pw graph is usually several unrelated chains (a webcam pair, a browser
      // stream, the MIDI bridge...). Separating components much more than
      // spacing.nodeNode is what makes those read as distinct subgraphs rather
      // than one tall stack.
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "130",
      // Components are otherwise packed into one tall column, so fit-view has to
      // shrink the whole graph to fit a landscape window. The target is only
      // approximate — asking for 2.2 lands the example dump near 1.7, which fits
      // at 1:1; anything under ~2 leaves the packing portrait and no-ops.
      "elk.aspectRatio": "2.2",
      "elk.edgeRouting": "SPLINES",
    },
    children,
    edges,
  };

  const res = await elk.layout(root);

  // elk reports child coordinates relative to their parent container, so we walk
  // the hierarchy accumulating offsets to get absolute scene coordinates.
  const outNodes: LaidOutNode[] = [];
  const outGroups: LaidOutGroup[] = [];

  const walkNodes = (parent: ElkNode, offX: number, offY: number): void => {
    for (const c of parent.children ?? []) {
      const ax = offX + (c.x ?? 0);
      const ay = offY + (c.y ?? 0);
      const meta = groupMeta.get(String(c.id));
      if (meta) {
        outGroups.push({ id: meta.id, label: meta.label, x: ax, y: ay, w: c.width ?? 0, h: c.height ?? 0 });
        walkNodes(c, ax, ay);
        continue;
      }
      const ports: LaidOutPort[] = (c.ports ?? []).map((p) => {
        const id = Number(String(p.id).slice(1));
        const centre = centres.get(id);
        return {
          id,
          x: ax + (centre?.dx ?? p.x ?? 0),
          y: ay + (centre?.dy ?? p.y ?? 0),
          side: sides.get(id) ?? "in",
        };
      });
      const id = Number(String(c.id).slice(1));
      const headerH = headers.get(id) ?? HEADER_TOP + HEADER_LINE + HEADER_BOTTOM;
      outNodes.push({
        id,
        x: ax,
        y: ay,
        w: c.width ?? MIN_W,
        h: c.height ?? headerH,
        headerH,
        ports,
      });
    }
  };
  walkNodes(res, 0, 0);

  // Edges live on their lowest common ancestor; walk the same way so a container's
  // offset is added to any edge stored inside it (root edges get offset 0).
  const outEdges: LaidOutEdge[] = [];
  const walkEdges = (parent: ElkNode, offX: number, offY: number): void => {
    for (const e of parent.edges ?? []) {
      if (hintEdgeIds.has(String(e.id))) continue; // invisible ordering edge
      const section = e.sections?.[0];
      const points: { x: number; y: number }[] = [];
      if (section) {
        points.push(section.startPoint);
        for (const bp of section.bendPoints ?? []) points.push(bp);
        points.push(section.endPoint);
      }
      outEdges.push({
        id: Number(String(e.id).slice(1)),
        from: Number(String(e.sources[0]).slice(1)),
        to: Number(String(e.targets[0]).slice(1)),
        points: points.map((pt) => ({ x: offX + pt.x, y: offY + pt.y })),
      });
    }
    for (const c of parent.children ?? []) {
      if (groupMeta.has(String(c.id))) walkEdges(c, offX + (c.x ?? 0), offY + (c.y ?? 0));
    }
  };
  walkEdges(res, 0, 0);

  // Place the portless floaters (kept out of elk above) in a tidy column tucked
  // under the bottom-left of the real graph, so they're visible but out of the flow.
  if (floaterNodes.length > 0) {
    const leftX = outNodes.length ? Math.min(...outNodes.map((n) => n.x)) : 0;
    const bottom = outNodes.length ? Math.max(...outNodes.map((n) => n.y + n.h)) : 0;
    let y = bottom + 48;
    for (const node of floaterNodes) {
      const { w, h, headerH } = nodeSize(node);
      outNodes.push({ id: node.id, x: leftX, y, w, h, headerH, ports: [] });
      y += h + 16;
    }
  }

  // Recompute bounds over everything (the floaters may extend past elk's box).
  const right = Math.max(res.width ?? 0, ...outNodes.map((n) => n.x + n.w), ...outGroups.map((g) => g.x + g.w));
  const bottom = Math.max(res.height ?? 0, ...outNodes.map((n) => n.y + n.h), ...outGroups.map((g) => g.y + g.h));

  return {
    nodes: outNodes,
    edges: outEdges,
    groups: outGroups,
    width: right,
    height: bottom,
  };
};
