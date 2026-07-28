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
short random key. No persistence: the store is bounded by `PWG_MAX_ENTRIES` (default 500)
and `PWG_TTL_SECS` (default 24 h), and everything is lost on restart.

Built with the `embed` feature it bakes the frontend into the binary, so the whole app is
**one self-contained executable** — no `dist/` to ship alongside:

```bash
just run          # build frontend, compile with --features embed, serve on :8787
# equivalently:
npm run build && cargo build --release --features embed --manifest-path server/Cargo.toml
./server/target/release/pw-dump-graph-server
```

Without `--features embed` the binary serves only the API (the Vite dev server serves the
frontend and proxies `/api` to it) — that's the `just dev` + `just serve` flow.

Share a dump straight from a PipeWire host — pipe it at the root URL and get back a
ready-to-open link (plain text):

```bash
pw-dump | curl -sT- http://<host>:8787        # → http://<host>:8787/?g=kAvgEynPkG
```

(`curl` needs an upload flag to read stdin — `-T-` PUTs it, `--data-binary @-` POSTs it;
a bare `curl <url>` ignores the pipe and just fetches the page.) Opening `…/?g=<key>`
loads that dump. In the browser, the **Share…** button does the same and copies the link.

Endpoints: `POST`/`PUT /` (piped dump) → the share URL as text; `POST /api/dumps` → the
same as JSON `{key,url}` (used by the Share button); `GET /api/dumps/:key` → the stored
JSON (`404` if evicted). Bodies must be JSON (`400` otherwise) and under `PWG_BODY_LIMIT`
(`413`, default 8 MiB).
Config via env: `PWG_ADDR`, `PWG_MAX_ENTRIES`, `PWG_TTL_SECS`, `PWG_BODY_LIMIT`.
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

Built against real `pw-dump` output. A `Port` carries `group` (`port.group`), `channel`
(`audio.channel`), and a `format` summarized from its `Format` **param** — the format
flowing between nodes (e.g. `DSP F32P`, `MJPG · 1920×1080 · 30 fps`). A `Node` carries a
`format` from *its* `Format` param — what the wrapped implementation (stream/device
behind the audio/video adapter) uses (e.g. `S32LE · 48 kHz · 2ch`). Both are shown on
hover and in the node details; audio and video are handled (the old `format.dsp` prop was
audio-only). Ports are ordered by canonical channel (FL, FR, …) so matching channels line
up across nodes. A `Node` also carries `linkGroup` (`node.link-group`); nodes sharing one
are collected into `Graph.groups` and rendered as a labelled box, with the layout engine
ordering the group next to the nodes it connects to. Driver nodes with no ports render as
plain boxes; ports whose owning node is missing are tolerated.

## Deferred (not yet implemented)

- **Port groups (n:1):** cluster ports by `Port.group` in the renderer / elk.
- **Server durability/limits:** the share service is in-memory only (no persistence,
  auth, rate limiting, or TLS — put it behind a reverse proxy if exposed).
