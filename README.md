# pw-dump-graph

Render [`pw-dump`](https://docs.pipewire.org/page_man_pw-dump_1.html) output as an
interactive PipeWire **patchbay** graph in the browser — nodes as boxes with
individual input/output port stubs, links routed port-to-port (like qpwgraph/helvum).

## Quick start

```bash
npm install
npm run dev        # open the printed http://localhost:5173/
```

On load it renders the bundled sample (`examples/pw-dump.json`). To view your own graph:

- **Open file…** or drag a `pw-dump.json` onto the canvas, or
- **Paste JSON…** and paste the output of `pw-dump`, or
- pass a URL: `http://localhost:5173/?url=/path-or-href-to.json`

Generate a dump on a PipeWire host with:

```bash
pw-dump > pw-dump.json
```

Interactions: scroll to zoom, drag to pan, hover a node to highlight its links and
neighbours, click a node for a details panel (properties, ports, formats).

```bash
npm run build      # static site -> dist/
npm run typecheck  # tsc --noEmit
```

## Sharing (server)

`server/` is a small Rust (axum) service that stores a posted dump **in memory** under a
short random key and serves the built frontend. No persistence: the store is bounded by
`PWG_MAX_ENTRIES` (default 500) and `PWG_TTL_SECS` (default 24 h), and everything is lost
on restart.

```bash
npm run build                                   # produce dist/ first
cargo run --release --manifest-path server/Cargo.toml -- --dist "$PWD/dist"
# → serves API + frontend on 0.0.0.0:8787
```

Share a dump straight from a PipeWire host — the response includes a ready-to-open link:

```bash
pw-dump | curl -s --data-binary @- http://<host>:8787/api/dumps
# → {"key":"kAvgEynPkG","url":"http://<host>:8787/?g=kAvgEynPkG"}
```

Opening `…/?g=<key>` loads that dump. In the browser, the **Share…** button POSTs the
currently-loaded dump and copies the `?g=` link to the clipboard.

Endpoints: `POST /api/dumps` (JSON body, `400` if not JSON, `413` over `PWG_BODY_LIMIT`,
default 8 MiB) → `{key,url}`; `GET /api/dumps/:key` → the JSON (`404` if evicted).
Config via env: `PWG_ADDR`, `PWG_DIST`, `PWG_MAX_ENTRIES`, `PWG_TTL_SECS`, `PWG_BODY_LIMIT`.
`npm run dev` proxies `/api` to `localhost:8787`, so the Share button works in dev too.

## Architecture

Strict one-way layering; a neutral `PositionedGraph` type is the seam between the
domain model and any layout engine, so the layout/render choice is swappable and the
core stays library-free.

```
parse ──▶ model ──▶ layout adapter ──▶ PositionedGraph ──▶ render
```

| Layer | File(s) | Responsibility | Depends on |
|-------|---------|----------------|------------|
| 1 parse | `src/parse.ts` | raw pw-dump JSON → typed records grouped by interface type | — |
| 2 model | `src/model.ts` | domain `Graph`/`Node`/`Port`/`Link`, no geometry/colors | parse |
| 3 layout | `src/layout/types.ts` (seam), `src/layout/elk.ts` (adapter) | domain graph → absolute geometry | elkjs (adapter only) |
| 4 render | `src/render/svg.ts`, `src/render/interact.ts` | draw SVG, pan/zoom/hover/select | model types + seam |

**`elkjs` is imported only by `src/layout/elk.ts`.** `model.ts` and `render/*` never
touch it — swapping to another layout engine means reimplementing that one file's
`LayoutEngine` (`(graph) => Promise<PositionedGraph>`).

## Data model notes

Built against real `pw-dump` output. A `Port` carries `group` (`port.group`),
`format` (`format.dsp`) and `channel` (`audio.channel`); ports are ordered by canonical
channel (FL, FR, …) so matching channels line up across nodes. A `Node` carries
`linkGroup` (`node.link-group`); nodes sharing one are collected into `Graph.groups` and
rendered as a labelled box, with the layout engine ordering the group next to the nodes
it connects to. Driver nodes with no ports render as plain boxes; ports whose owning node
is missing are tolerated.

## Deferred (not yet implemented)

- **Port groups (n:1):** cluster ports by `Port.group` in the renderer / elk.
- **Server durability/limits:** the share service is in-memory only (no persistence,
  auth, rate limiting, or TLS — put it behind a reverse proxy if exposed).
