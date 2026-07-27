// Layer 3 (seam) — the neutral positioned-graph type.
// This is the ONLY contract the renderer depends on. It contains no library
// types, so any layout engine can implement `LayoutEngine`, and the renderer
// never learns which one produced the coordinates.

import type { Direction, Graph } from "../model.js";

export interface LaidOutPort {
  id: number;
  x: number; // absolute, in scene coordinates
  y: number;
  side: Direction; // which edge of the node box the stub sits on
}

export interface LaidOutNode {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Height of the title band, measured from the node's top edge. No port row
   *  is placed inside it, so the renderer can draw the name/media.class there
   *  without checking for collisions. */
  headerH: number;
  ports: LaidOutPort[];
}

export interface LaidOutEdge {
  id: number;
  from: number; // port id
  to: number; // port id
  points: { x: number; y: number }[]; // polyline in scene coordinates
}

export interface PositionedGraph {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/** A layout engine maps the domain graph to absolute geometry. Async by design
 *  (elkjs and most serious layout engines are). Swapping engines = swapping the
 *  implementation of this one function. */
export type LayoutEngine = (graph: Graph) => Promise<PositionedGraph>;
