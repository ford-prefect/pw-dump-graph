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

## Development

Build instructions, architecture, data-model notes and the release process are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Deferred (not yet implemented)

- **Port groups (n:1):** cluster ports by `Port.group` in the renderer / elk.
- **Server durability/limits:** the share service is in-memory only (no persistence,
  auth, rate limiting, or TLS — put it behind a reverse proxy if exposed).
