// Layer 2 — domain model
// Pure PipeWire semantics. NO coordinates, NO colors, NO layout/library types.
// This is the stable core; future extensions (port groups, richer formats) are
// additive fields here and do not ripple outward.

import { parseDump, type RawGroups, type RawInfo, type RawObject } from "./parse.js";

export type Direction = "in" | "out";

export interface Port {
  id: number;
  nodeId: number;
  direction: Direction;
  name: string;
  channel?: string; // audio.channel (FL/FR/MONO/...)
  // The negotiated port format — what flows between nodes — from the `Format`
  // param, summarized (e.g. "DSP F32P", "MJPG · 1920×1080 · 30 fps").
  format?: string;
  group?: string; // port.group — hook for future n:1 port grouping
  monitor?: boolean; // port.monitor
  alias?: string; // port.alias
}

export interface Node {
  id: number;
  name: string; // node.description || node.name || "node <id>"
  mediaClass?: string; // media.class (absent for driver nodes)
  linkGroup?: string; // node.link-group — nodes sharing one are internally linked
  // The format of the wrapped implementation (the stream/device behind the
  // audio/video adapter), from the node's `Format` param — e.g.
  // "S32LE · 48 kHz · 2ch". Distinct from a port's between-nodes format.
  format?: string;
  // Filter graph(s) running *inside* this node (audioconvert.filter-graph.N).
  // Undefined for the vast majority of nodes; present only when one is actually
  // loaded, so this edge case never touches the common path.
  filterGraphs?: FilterGraph[];
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

/** Nodes the session manager keeps internally linked (a filter-chain's sink+source,
 *  a loopback's capture+playback, an echo-cancel unit). PipeWire never draws Links
 *  between them; we box them together instead. */
export interface NodeGroup {
  id: string; // the shared node.link-group value
  nodeIds: number[];
}

export interface Graph {
  nodes: Map<number, Node>;
  ports: Map<number, Port>;
  links: Link[];
  groups: NodeGroup[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** A SPA `Format` pod as it appears in pw-dump JSON (fields vary by media type). */
interface FormatPod {
  mediaType?: string;
  mediaSubtype?: string;
  format?: string; // audio sample format (S32LE, F32P) or raw-video fourcc (YUY2)
  rate?: number;
  channels?: number;
  size?: { width?: number; height?: number };
  framerate?: { num?: number; denom?: number };
}

/** A filter graph running inside an audioconvert node (from
 *  `audioconvert.filter-graph.N`). A little PipeWire graph in its own right:
 *  DSP nodes (builtin/ladspa/…) wired output→input. Pure data, no geometry. */
export interface FilterGraphNode {
  name: string;
  label?: string; // the DSP algorithm, e.g. "bq_peaking"
  type?: string; // "builtin", "ladspa", …
  controls?: Record<string, unknown>; // e.g. { Freq: 950, Q: 2, Gain: -6 }
}
export interface FilterGraphLink {
  output: string; // "node:port", e.g. "eq_band_1:Out"
  input: string;
}
export interface FilterGraph {
  index: number; // the N in audioconvert.filter-graph.N (0 for the bare key)
  nodes: FilterGraphNode[];
  links: FilterGraphLink[];
}

/** Read the flat SPA `[key, value, key, value, …]` list PipeWire uses for a
 *  Props param entry as key→value pairs. */
function spaKeyValues(params: unknown): Array<[string, unknown]> {
  if (!Array.isArray(params)) return [];
  const out: Array<[string, unknown]> = [];
  for (let i = 0; i + 1 < params.length; i += 2) {
    const k = params[i];
    if (typeof k === "string") out.push([k, params[i + 1]]);
  }
  return out;
}

const FILTER_GRAPH_KEY = /^audioconvert\.filter-graph(?:\.(\d+))?$/;

/** Extract loaded internal filter graphs from a node's `Props` param. Returns
 *  undefined unless at least one graph carries a non-empty, parseable value —
 *  the empty string that most nodes advertise (schema only) is skipped. */
function parseFilterGraphs(info: RawInfo | undefined): FilterGraph[] | undefined {
  const propsParams = info?.params?.["Props"];
  if (!Array.isArray(propsParams)) return undefined;
  const graphs: FilterGraph[] = [];
  for (const entry of propsParams) {
    const kvs = spaKeyValues((entry as { params?: unknown } | undefined)?.params);
    for (const [key, value] of kvs) {
      const m = FILTER_GRAPH_KEY.exec(key);
      if (!m || typeof value !== "string" || value.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue; // tolerate non-strict-JSON dumps: skip rather than crash
      }
      const nodes = Array.isArray((parsed as { nodes?: unknown })?.nodes)
        ? ((parsed as { nodes: unknown[] }).nodes.map(toFilterGraphNode))
        : [];
      const links = Array.isArray((parsed as { links?: unknown })?.links)
        ? ((parsed as { links: unknown[] }).links.map(toFilterGraphLink))
        : [];
      graphs.push({ index: m[1] ? Number(m[1]) : 0, nodes, links });
    }
  }
  if (graphs.length === 0) return undefined;
  graphs.sort((a, b) => a.index - b.index);
  return graphs;
}

function toFilterGraphNode(n: unknown): FilterGraphNode {
  const o = (n ?? {}) as Record<string, unknown>;
  return {
    name: str(o.name) ?? "?",
    label: str(o.label),
    type: str(o.type),
    controls:
      o.control && typeof o.control === "object"
        ? (o.control as Record<string, unknown>)
        : undefined,
  };
}
function toFilterGraphLink(l: unknown): FilterGraphLink {
  const o = (l ?? {}) as Record<string, unknown>;
  return { output: str(o.output) ?? "", input: str(o.input) ?? "" };
}

function khz(rate: number): string {
  return rate % 1000 === 0 ? `${rate / 1000} kHz` : `${rate} Hz`;
}
function fps(fr: { num?: number; denom?: number }): string {
  const v = (fr.num ?? 0) / (fr.denom || 1);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Human summary of a Format pod, covering audio (dsp + raw) and video. */
function summarizeFormat(f: FormatPod): string | undefined {
  if (f.mediaType === "audio") {
    if (f.mediaSubtype === "dsp") return f.format ? `DSP ${f.format}` : "DSP";
    const parts: string[] = [];
    if (f.format) parts.push(f.format);
    if (f.rate) parts.push(khz(f.rate));
    if (f.channels) parts.push(`${f.channels}ch`);
    return parts.length ? parts.join(" · ") : "audio";
  }
  if (f.mediaType === "video") {
    const parts: string[] = [];
    const codec = f.format ?? f.mediaSubtype; // raw video → fourcc; mjpg/h264 → subtype
    if (codec) parts.push(codec.toUpperCase());
    if (f.size?.width && f.size?.height) parts.push(`${f.size.width}×${f.size.height}`);
    if (f.framerate?.num) parts.push(`${fps(f.framerate)} fps`);
    return parts.length ? parts.join(" · ") : "video";
  }
  return [f.mediaType, f.mediaSubtype].filter(Boolean).join("/") || undefined;
}

/** Summarize the current `Format` param of a node or port, if present. */
function formatParam(info: RawInfo | undefined): string | undefined {
  const pod = info?.params?.["Format"]?.[0] as FormatPod | undefined;
  return pod ? summarizeFormat(pod) : undefined;
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
    linkGroup: str(props["node.link-group"]),
    format: formatParam(raw.info),
    filterGraphs: parseFilterGraphs(raw.info),
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
    format: formatParam(raw.info),
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

// Canonical channel order (WAV/PipeWire convention) so every node stacks its
// ports the same way (FL above FR, etc.). Object ids do NOT follow channel order
// — e.g. a node may have FR at a lower id than FL — so ordering by id leaves
// matching channels on mismatched rows and forces links to cross. Ordering by
// channel keeps FL→FL / FR→FR runs parallel.
const CHANNEL_ORDER = [
  "MONO",
  "FL", "FR", "FC", "LFE", "RL", "RR", "RC", "SL", "SR",
  "FLC", "FRC", "TC", "TFL", "TFC", "TFR", "TRL", "TRC", "TRR",
];
const CHANNEL_RANK = new Map(CHANNEL_ORDER.map((c, i) => [c, i]));

function channelRank(ch?: string): number {
  if (!ch) return Number.MAX_SAFE_INTEGER; // no channel (e.g. MIDI) — fall back to id
  const known = CHANNEL_RANK.get(ch);
  if (known !== undefined) return known;
  const aux = /^AUX(\d+)$/.exec(ch); // AUX0, AUX1, … kept in numeric order after named channels
  if (aux) return 1000 + Number(aux[1]);
  return 900; // other named channels: grouped, before AUX, then by id
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

  // Deterministic port order within a node: outputs then inputs, then by
  // canonical channel (FL before FR, …), then id. Channel-first ordering keeps
  // the same channel on the same row across nodes so links don't needlessly cross.
  for (const node of nodes.values()) {
    node.ports.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "out" ? -1 : 1;
      const ra = channelRank(a.channel);
      const rb = channelRank(b.channel);
      return ra !== rb ? ra - rb : a.id - b.id;
    });
  }

  const links: Link[] = [];
  for (const raw of groups.links) {
    const link = buildLink(raw);
    if (!link) continue;
    // Drop links internal to a link-group. PipeWire doesn't create these (the
    // connection is internal), but if a dump ever carries one we don't want to
    // draw a line inside a box that's already meant to imply the relationship.
    const lg = nodes.get(link.outNode)?.linkGroup;
    if (lg && lg === nodes.get(link.inNode)?.linkGroup) continue;
    links.push(link);
  }

  // Collect link-groups (only those with >1 member — a lone node needs no box).
  const byGroup = new Map<string, number[]>();
  for (const node of nodes.values()) {
    if (!node.linkGroup) continue;
    (byGroup.get(node.linkGroup) ?? byGroup.set(node.linkGroup, []).get(node.linkGroup)!).push(node.id);
  }
  const nodeGroups: NodeGroup[] = [];
  for (const [id, nodeIds] of byGroup) {
    if (nodeIds.length > 1) nodeGroups.push({ id, nodeIds });
  }

  return { nodes, ports, links, groups: nodeGroups };
}

/** Convenience: raw parsed JSON (array) → domain graph. */
export function buildGraph(data: unknown): Graph {
  return buildGraphFromGroups(parseDump(data));
}
