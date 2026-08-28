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

## Local viewer (`pw-dump-graph`)

`app/` is a standalone Rust binary that runs `pw-dump` on the machine and serves the
viewer. By default it's **one-shot**: gather a single dump, open the browser, and exit
once the page has loaded it. With **`-m`** it runs `pw-dump -m` and streams live updates
(SSE), refreshing the page as the graph changes. No storage/sharing.

```bash
just app          # one-shot: gather a dump on 127.0.0.1:8787, open a browser, exit after it loads
just app-monitor  # live: stream pw-dump -m and update the page as things change
just app-remote   # live + bind 0.0.0.0, no browser — run on a device, view from another host
just bin-app      # single self-contained binary → target/release/pw-dump-graph
```

Endpoints: `GET /api/graph` (current objects; `x-pwg-live: 1` in monitor mode) and, when
monitoring, `GET /api/events` (debounced SSE tick on change). Monitor mode merges each
batch by top-level `id` (replace on update, remove on `info`/`props` null); the frontend
detects `/api/graph`, renders it, and — if live — re-fetches on each event. Flags/env:
`-m`/`--monitor`, `--remote`, `--port`/`PWG_PORT`, `PWG_ADDR`, `PWG_DIST`, and
`PWG_DUMP_CMD` (overrides the source command; handy for a pipeline or a test capture).

## Sharing (server)

`server/` is a small Rust (axum) service that stores a posted dump in memory under a short
random key, so you can hand a graph to someone else as a link — `pw-dump | curl -sT- <host>`
prints a ready-to-open URL. It's what runs at <https://pw.arunraghavan.net>.

See **[server/README.md](server/README.md)** for endpoints, configuration, the restart
handoff, and running it under systemd behind a reverse proxy.

## Releases

Prebuilt `pw-dump-graph` binaries for `x86_64` and `aarch64` Linux (glibc) are cut by
[`dist`](https://opensource.axo.dev/cargo-dist/) on a version tag:

```bash
# bump the workspace version in Cargo.toml, move CHANGELOG.md's "Unreleased"
# entries under a new "## [X.Y.Z] - <date>" heading, commit, then:
git tag v0.1.0 && git push --tags     # → .github/workflows/release.yml builds + publishes a GitHub Release
```

The release notes come from `CHANGELOG.md`: `dist` uses the body of the `## [X.Y.Z]` section
matching the tag (falling back to just a download table if there's no match).

Each target builds on a native runner (`ubuntu-22.04` / `ubuntu-22.04-arm`); the release
workflow runs `npm ci && npm run build` first (`.github/build-setup.yml`) so the
`app` crate can be compiled with `--features embed` — the published binary is
**self-contained** (frontend baked in). Only `app` is shipped; artifacts are `.tar.xz` archives
with per-file `.sha256` plus an aggregate `sha256.sum`. Configure via `[workspace.metadata.dist]`
in `Cargo.toml`; regenerate the workflow with `dist generate` after changing it.

## Architecture

Strict one-way layering; a neutral `PositionedGraph` type is the seam between the
domain model and any layout engine, so the layout/render choice is swappable and the
core stays library-free.

```
parse ──▶ model ──▶ layout adapter ──▶ PositionedGraph ──▶ render
```

| Layer | File(s) | Responsibility | Depends on |
|-------|---------|----------------|------------|
| 1 parse | `frontend/parse.ts` | raw pw-dump JSON → typed records grouped by interface type | — |
| 2 model | `frontend/model.ts` | domain `Graph`/`Node`/`Port`/`Link`, no geometry/colors | parse |
| 3 layout | `frontend/layout/types.ts` (seam), `frontend/layout/elk.ts` (adapter) | domain graph → absolute geometry | elkjs (adapter only) |
| 4 render | `frontend/render/svg.ts`, `frontend/render/interact.ts` | draw SVG, pan/zoom/hover/select | model types + seam |

**`elkjs` is imported only by `frontend/layout/elk.ts`.** `model.ts` and `render/*` never
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
