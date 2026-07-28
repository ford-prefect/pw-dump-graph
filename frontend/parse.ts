// Layer 1 — parse
// Knows pw-dump specifics only: it turns the raw JSON array into loosely-typed
// records grouped by interface type. It does NOT know about layout or rendering,
// and it produces no domain semantics beyond "these are the nodes/ports/links".

export interface RawObject {
  id: number;
  type: string;
  info?: RawInfo;
}

export interface RawInfo {
  direction?: string; // ports: "input" | "output"
  state?: string; // links: "active" | "init" | ...
  props?: Record<string, unknown>;
  // params keyed by SPA param name ("Format", "EnumFormat", …); each an array of pods.
  params?: Record<string, unknown[]>;
  // links carry these at info level:
  "output-node-id"?: number;
  "output-port-id"?: number;
  "input-node-id"?: number;
  "input-port-id"?: number;
  [k: string]: unknown;
}

export const PW_TYPE = {
  node: "PipeWire:Interface:Node",
  port: "PipeWire:Interface:Port",
  link: "PipeWire:Interface:Link",
} as const;

export interface RawGroups {
  nodes: RawObject[];
  ports: RawObject[];
  links: RawObject[];
}

/** Accepts the parsed pw-dump JSON (an array) and returns it grouped by type. */
export function parseDump(data: unknown): RawGroups {
  if (!Array.isArray(data)) {
    throw new Error("pw-dump output must be a JSON array of objects");
  }
  const groups: RawGroups = { nodes: [], ports: [], links: [] };
  for (const raw of data as RawObject[]) {
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") continue;
    switch (raw.type) {
      case PW_TYPE.node:
        groups.nodes.push(raw);
        break;
      case PW_TYPE.port:
        groups.ports.push(raw);
        break;
      case PW_TYPE.link:
        groups.links.push(raw);
        break;
      // other interfaces (Client, Module, Device, ...) are ignored for the graph
    }
  }
  return groups;
}
