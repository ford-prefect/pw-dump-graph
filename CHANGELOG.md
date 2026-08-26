# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`dist` reads this file at release time: when you tag `vX.Y.Z` it uses the body of the matching
`## [X.Y.Z]` section as the GitHub Release notes. Keep the newest entries under
`## [Unreleased]`, then rename that heading to the version (with a date) when you cut the release.

## [Unreleased]

- Add `pw-dump-graph -r` as an alternative to `--remote`
- Surface a node's internal audio filter graph (`audioconvert.filter-graph`): a `⧉` badge on
  such nodes (click it, or a "View" button in the details panel) opens a left→right drawing of
  the graph's DSP nodes and links in a popup, each node's controls listed in its body

## [0.1.0] - 2026-07-30

### Added

- Interactive browser **patchbay** viewer for `pw-dump` output: nodes as boxes with individual
  input/output port stubs, links routed port-to-port. Pan, zoom, hover-to-highlight, and a
  click-through details panel (properties, ports, formats).
- Ports ordered by canonical channel (FL, FR, …) so matching channels line up across nodes;
  monitor ports and unconnected ports/links are visually distinguished, with a legend.
- Node and port **format** display (from the `Format` params — audio DSP, audio raw, and video).
- `node.link-group` members drawn inside a labelled box, laid out `source → filter → sink`.
- Load a graph from a file, pasted JSON, a `?url=` query, or a shared `?g=<key>` link.
- **`pw-dump-graph`** standalone local viewer binary: one-shot by default (gather a dump, open a
  browser, exit); `-m` streams `pw-dump -m` and live-updates via SSE; `--remote` binds `0.0.0.0`
  without opening a browser. Frontend embedded — a single self-contained binary.
- **`pw-dump-graph-server`** share service: stores a posted dump in memory under a short key
  (no persistence), so `pw-dump | curl -T- <host>` returns a ready-to-open link.
- Prebuilt `x86_64` and `aarch64` Linux (glibc) release binaries via `dist`.

[Unreleased]: https://github.com/ford-prefect/pw-dump-graph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ford-prefect/pw-dump-graph/releases/tag/v0.1.0
