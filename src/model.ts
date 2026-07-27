// Layer 2 — domain model
// Pure PipeWire semantics. NO coordinates, NO colors, NO layout/library types.
// This is the stable core; future extensions (port groups, richer formats) are
// additive fields here and do not ripple outward.

import { parseDump, type RawGroups, type RawObject } from "./parse.js";

export type Direction = "in" | "out";

export interface Port {
  id: number;
  nodeId: number;
  direction: Direction;
  name: string;
  channel?: string; // audio.channel (FL/FR/MONO/...)
  format?: string; // format.dsp ("32 bit float mono audio", "8 bit raw midi", ...)
  group?: string; // port.group — hook for future n:1 port grouping
  monitor?: boolean; // port.monitor
  alias?: string; // port.alias
}

export interface Node {
  id: number;
  name: string; // node.description || node.name || "node <id>"
  mediaClass?: string; // media.class (absent for driver nodes)
  ports: Port[]; // may be empty (e.g. driver nodes)
  props: Record<string, unknown>;
}

export interface Link {
  id: number;
  outNode: number;
  outPort: number;
  inNode: number;
  inPort: number;
  state?: string;
}

export interface Graph {
  nodes: Map<number, Node>;
  ports: Map<number, Port>;
  links: Link[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function normalizeDirection(raw: RawObject): Direction {
  // Prefer info.direction ("input"/"output"); fall back to props "port.direction" ("in"/"out").
  const d = str(raw.info?.direction) ?? str(raw.info?.props?.["port.direction"]);
  return d === "output" || d === "out" ? "out" : "in";
}

function buildNode(raw: RawObject): Node {
  const props = raw.info?.props ?? {};
  const name =
    str(props["node.description"]) ?? str(props["node.name"]) ?? `node ${raw.id}`;
  return {
    id: raw.id,
    name,
    mediaClass: str(props["media.class"]),
    ports: [],
    props,
  };
}

function buildPort(raw: RawObject): Port | undefined {
  const props = raw.info?.props ?? {};
  const nodeId = num(props["node.id"]);
  if (nodeId === undefined) return undefined; // a port with no owner is unusable
  return {
    id: raw.id,
    nodeId,
    direction: normalizeDirection(raw),
    name: str(props["port.name"]) ?? `port ${raw.id}`,
    channel: str(props["audio.channel"]),
    format: str(props["format.dsp"]),
    group: str(props["port.group"]),
    monitor: props["port.monitor"] === true,
    alias: str(props["port.alias"]),
  };
}

function buildLink(raw: RawObject): Link | undefined {
  const info = raw.info ?? {};
  const outNode = num(info["output-node-id"]);
  const outPort = num(info["output-port-id"]);
  const inNode = num(info["input-node-id"]);
  const inPort = num(info["input-port-id"]);
  if (
    outNode === undefined ||
    outPort === undefined ||
    inNode === undefined ||
    inPort === undefined
  ) {
    return undefined;
  }
  return { id: raw.id, outNode, outPort, inNode, inPort, state: str(info.state) };
}

/** Build the domain graph from grouped raw records. */
export function buildGraphFromGroups(groups: RawGroups): Graph {
  const nodes = new Map<number, Node>();
  for (const raw of groups.nodes) nodes.set(raw.id, buildNode(raw));

  const ports = new Map<number, Port>();
  for (const raw of groups.ports) {
    const port = buildPort(raw);
    if (!port) continue;
    ports.set(port.id, port);
    // Attach to owner if present; tolerate ports whose node is missing.
    nodes.get(port.nodeId)?.ports.push(port);
  }

  // Deterministic port order within a node: outputs then inputs, then by id.
  for (const node of nodes.values()) {
    node.ports.sort((a, b) =>
      a.direction === b.direction ? a.id - b.id : a.direction === "out" ? -1 : 1,
    );
  }

  const links: Link[] = [];
  for (const raw of groups.links) {
    const link = buildLink(raw);
    if (link) links.push(link);
  }

  return { nodes, ports, links };
}

/** Convenience: raw parsed JSON (array) → domain graph. */
export function buildGraph(data: unknown): Graph {
  return buildGraphFromGroups(parseDump(data));
}
