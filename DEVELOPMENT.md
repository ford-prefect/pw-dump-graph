# Development

How to build, and how the pieces fit together. Guidance specific to AI agents working in
this repo lives in [AGENTS.md](AGENTS.md); user-facing usage is in the
[README](README.md).

## Frontend

```bash
npm install
npm run dev        # dev server with hot reload → http://localhost:5173/
npm run build      # static site → dist/
npm run typecheck  # tsc --noEmit
```

`npm run dev` renders the bundled sample (`examples/pw-dump.json`) on load. To view
another graph, use **Open file…**, drag a `pw-dump.json` onto the canvas, **Paste JSON…**,
or pass `?url=/path-or-href-to.json`.

`npm run dev` also proxies `/api` to `localhost:8787`, so the **Share…** button and `?g=`
links work against a locally running share server (`just serve`).

## Rust workspace

A Cargo workspace at the repo root; the frontend (`frontend/`, `dist/`) sits alongside it.

- **`common/`** — the frontend-serving axum handler, shared by both binaries: `rust-embed`
  of `../dist` behind the **`embed`** feature, else `PWG_DIST` disk serving, with SPA
  fallback and a traversal guard.
- **`app/`** (binary `pw-dump-graph`) — the local viewer. See the README.
- **`server/`** (binary `pw-dump-graph-server`) — the share service. See
  [server/README.md](server/README.md).

```bash
cargo test        # workspace tests (share store eviction/TTL, live-merge)
just bin          # single self-contained share-server binary
just bin-app      # single self-contained local-viewer binary
```

## Local viewer internals

`GET /api/graph` returns the current objects (with `x-pwg-live: 1` in monitor mode) and,
when monitoring, `GET /api/events` emits a debounced SSE tick on change. Monitor mode
merges each `pw-dump -m` batch by top-level `id` — replace on update, remove when `info`
or `props` is null. The frontend detects `/api/graph`, renders it, and, if live,
re-fetches on each event.

Flags and env: `-m`/`--monitor`, `--remote`/`-r`, `--port`/`PWG_PORT`, `PWG_ADDR`,
`PWG_DIST`, and `PWG_DUMP_CMD` (overrides the source command — handy for a pipeline or a
test capture).

## Architecture

Strict one-way layering; a neutral `PositionedGraph` type is the seam between the domain
model and any layout engine, so the layout/render choice is swappable and the core stays
library-free.

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

## Releases

Prebuilt `pw-dump-graph` binaries for `x86_64` and `aarch64` Linux (glibc) are cut by
[`dist`](https://opensource.axo.dev/cargo-dist/) on a version tag:

```bash
# bump the workspace version in Cargo.toml, move CHANGELOG.md's "Unreleased"
# entries under a new "## [X.Y.Z] - <date>" heading, commit, then:
git tag vX.Y.Z && git push --tags
```

The version in `Cargo.toml` must match the tag, or `dist` refuses to release ("this
workspace doesn't have anything for dist to Release").

Release notes come from `CHANGELOG.md`: `dist` uses the body of the `## [X.Y.Z]` section
matching the tag (falling back to a download table if there's no match).

Each target builds on a native runner (`ubuntu-22.04` / `ubuntu-22.04-arm`); the release
workflow runs `npm ci && npm run build` first (`.github/build-setup.yml`) so the `app`
crate can be compiled with `--features embed` — the published binary is
**self-contained** (frontend baked in). Only `app` is shipped (`server` sets
`dist = false`); artifacts are `.tar.xz` archives with per-file `.sha256` plus an
aggregate `sha256.sum`. Configure via `[workspace.metadata.dist]` in `Cargo.toml`, and
regenerate the workflow with `dist generate` after changing it.
