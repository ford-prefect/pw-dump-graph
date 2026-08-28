# pw-dump-graph

Render [`pw-dump`](https://docs.pipewire.org/page_man_pw-dump_1.html) output as an
interactive PipeWire **patchbay** graph in the browser — nodes as boxes with
individual input/output port stubs, links routed port-to-port (like qpwgraph/helvum).

## Share a dump

Pipe `pw-dump` at a hosted instance and get a link back:

```bash
pw-dump | curl -sT- https://pw.arunraghavan.net
# → https://pw.arunraghavan.net/?g=kAvgEynPkG
```

Open the link to see the graph — nothing to install on either end, which makes this the
easy way to get a graph in front of someone else (a bug report, a colleague, IRC).

`curl` needs an upload flag to read stdin: `-T-` PUTs it, `--data-binary @-` POSTs it. A
bare `curl <url>` ignores the pipe and just fetches the page.

You can also open <https://pw.arunraghavan.net> directly and load a dump with **Open
file…**, by dragging a `pw-dump.json` onto the canvas, or with **Paste JSON…**. The
**Share…** button uploads whatever is on screen and copies the link.

Anyone with the link can view that dump, and links expire after a while — treat it as a
pastebin, not storage.

## View your own graph

`pw-dump-graph` runs `pw-dump` on the machine and serves the viewer to your browser. It's
one self-contained binary with the frontend baked in — grab the tarball for your
architecture from the
[Releases](https://github.com/ford-prefect/pw-dump-graph/releases) page and run it:

```bash
./pw-dump-graph               # gather one dump, open a browser, exit once the page loads
./pw-dump-graph -m            # live: stream `pw-dump -m`, update the page as things change
./pw-dump-graph -r -m         # bind 0.0.0.0, no browser — run on a device, view from another host
```

Nothing is stored or uploaded; it reads the local graph and serves it to you. `-p`/`--port`
(or `PWG_PORT`) changes the port.

Interactions: scroll to zoom, drag to pan, hover a node to highlight its links and
neighbours, click a node for a details panel (properties, ports, formats). Nodes sharing a
`node.link-group` — filter chains, loopbacks, echo-cancel — are drawn inside a labelled
box, laid out `source → filter → sink`. A node whose internal `audioconvert.filter-graph`
is loaded gets a `⧉` badge that opens a drawing of that graph.

If you just want to look at a dump you already have, any instance of the viewer will do:
drop the file on <https://pw.arunraghavan.net>, or run it from source below.

## Running from source

```bash
npm install
just app          # one-shot local viewer
just app-monitor  # live local viewer
just app-remote   # live, bind 0.0.0.0, no browser
just bin-app      # build the self-contained binary → target/release/pw-dump-graph
```

## Sharing (server)

`server/` is a small Rust (axum) service that stores a posted dump in memory under a short
random key, so you can hand a graph to someone else as a link — `pw-dump | curl -sT- <host>`
prints a ready-to-open URL. It's what runs at <https://pw.arunraghavan.net>.

See **[server/README.md](server/README.md)** for endpoints, configuration, the restart
handoff, and running it under systemd behind a reverse proxy.

## Development

Build instructions, architecture, data-model notes and the release process are in
[DEVELOPMENT.md](DEVELOPMENT.md). Release history is in
[CHANGELOG.md](CHANGELOG.md). Licensed under the terms in [LICENSE](LICENSE).
