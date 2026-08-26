# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

A static, browser-based viewer that renders `pw-dump` (PipeWire) output as an
interactive patchbay graph. No backend yet. See `README.md` for usage.

## Architecture invariant (do not break)

Dependencies flow one way only, with a neutral `PositionedGraph` as the seam:

```
parse → model → layout adapter → PositionedGraph → render
```

- **`frontend/model.ts` and `frontend/render/*` must never import a layout library** (elkjs or
  otherwise). Only `frontend/layout/elk.ts` may import `elkjs`.
- Swapping layout engines = reimplement `LayoutEngine` in `frontend/layout/elk.ts` against
  `frontend/layout/types.ts`; nothing upstream or downstream should change.
- The domain model (`frontend/model.ts`) holds **no** coordinates, colors, or library types.
  Keep new PipeWire fields additive there.

## Layers

| Layer | File(s) | May depend on |
|-------|---------|---------------|
| parse | `frontend/parse.ts` | nothing |
| model | `frontend/model.ts` | parse |
| layout | `frontend/layout/types.ts` (seam), `frontend/layout/elk.ts` (adapter) | elkjs — adapter only |
| render | `frontend/render/svg.ts`, `frontend/render/interact.ts` | model types + layout seam |

## Commands

```bash
npm run dev        # dev server (renders examples/pw-dump.json by default)
npm run build      # tsc + vite build → dist/
npm run typecheck  # tsc --noEmit

# Rust workspace (common + server + app)
cargo test         # workspace tests (share store eviction/TTL, live-merge)
just bin           # share-server single binary; `just bin-app` for the live viewer
```

## Rust workspace (`common` / `server` / `app`)

A Cargo workspace at the repo root; the frontend (`frontend/`, `dist/`) sits alongside it.

- **`common/`** — the frontend-serving `frontend` axum handler: `rust-embed` of `../dist`
  behind the **`embed`** feature, else `PWG_DIST` disk serving (compiles without `dist/`),
  with SPA fallback + traversal guard. Both binaries embed via `--features embed` (→ one
  self-contained binary) and depend on this.
- **`server/`** (binary `pw-dump-graph-server`) — the **share** service: `POST /api/dumps`
  stores a JSON body in memory under a random key (max-count + TTL, **no persistence,
  no auth**); `GET /api/dumps/:key` returns it. `just run`/`serve`.
- **`app/`** (binary `pw-dump-graph`) — the **local viewer**. Default is one-shot: gather
  one `pw-dump`, serve `GET /api/graph`, and exit after the UI fetches it (a `Notify`
  fires graceful shutdown). With `-m` it runs `pw-dump -m` on a monitor thread, merges
  batches by object id into an in-memory map, and adds live updates via `GET /api/events`
  (SSE); `/api/graph` sets `x-pwg-live: 1` so the frontend knows to subscribe. `--remote`
  binds 0.0.0.0 / no browser. `PWG_DUMP_CMD` overrides the source. `just app`/`app-monitor`/`app-remote`/`bin-app`.

Both services are independent of the frontend layering above; the frontend reaches them
only via HTTP (`?g=<key>` / `POST /api/dumps` for share; `/api/graph` + `/api/events` for
live) — all through the existing `renderText`/`loadFromUrl` pipeline in `main.ts`.

## Releases (dist / cargo-dist)

Tag-triggered binary releases via [`dist`](https://opensource.axo.dev/cargo-dist/), configured
in `[workspace.metadata.dist]` (root `Cargo.toml`) + `app/[package.metadata.dist]`.

- **`.github/workflows/release.yml` is generated — do not hand-edit it.** Change
  `[workspace.metadata.dist]` (or the crate metadata) and run `dist generate` to regenerate.
- **`.github/build-setup.yml` is load-bearing:** it's spliced into the build job (via
  `github-build-setup`) to run `npm ci && npm run build` *before* the Rust compile, because the
  release builds `app` with `--features embed` and rust-embed reads `dist/` at compile time.
  If you change how the frontend builds or where it outputs, update this file. (It lives at
  `.github/` root, not `.github/workflows/`, so GitHub Actions doesn't try to run the fragment
  as a workflow — the path in `[workspace.metadata.dist]` is `../build-setup.yml`.)
- Scope: **app-only** (`server` has `dist = false`), targets `x86_64`/`aarch64`
  `-unknown-linux-gnu`, no installer, `.tar.xz` + SHA256 checksums. Native runners, no container.
- **Changelog is manual.** `CHANGELOG.md` (Keep a Changelog format) is the source of release
  notes: `dist` extracts the `## [X.Y.Z]` section matching the tag. Add entries under
  `## [Unreleased]` as you go; when cutting a release, rename that heading to the version with a
  date and add a fresh empty `## [Unreleased]`.
- Cutting a release: bump the workspace `version`, update `CHANGELOG.md`, commit,
  `git tag vX.Y.Z && git push --tags`.

## Conventions

- TypeScript, `strict` mode; keep `tsc` clean (no new errors/warnings).
- ES modules; import paths use `.js` extensions (bundler resolution maps to `.ts`).
- Match the existing style: small focused modules, comments explaining *why* a layer
  exists rather than restating code.
- Keep runtime dependencies minimal (currently just `elkjs`).

## Verifying changes

- `npm run typecheck` and `npm run build` must pass.
- Sanity-check against a real `pw-dump`: nodes render as boxes with input ports on the
  left / output ports on the right; nodes sharing a `node.link-group` (filter chains,
  loopbacks, echo-cancel) render inside a labelled box, laid out `source → filter → sink`.
- Prefer verifying model/layout changes headlessly (they are DOM-free); render/interact
  need a DOM.
- Test dumps that shouldn't ship live in `fixtures/` (NOT `examples/`, which is Vite's
  `publicDir` and gets bundled into `dist/` + embedded in the binary). `examples/` holds only
  the one bundled sample (`pw-dump.json`). E.g. `fixtures/pw-node-audioconvert-graph.json` is a
  dump with a loaded `audioconvert.filter-graph` for exercising the internal-filter-graph view.

## Commits

- Work in small, atomic commits: one self-contained change each, with the tree
  building and typechecking at every commit. Land a refactor separately from the
  behaviour change that motivated it.
- No `Co-Authored-By:` (or similar attribution) trailers in commit messages.

## Not yet implemented (deferred by design)

- Port groups (n:1): cluster by `Port.group` (distinct from `node.link-group`, which
  is already grouped into boxes).
- Upload service: Node.js endpoint for `pw-dump | curl host`; viewer already supports `?url=`.
