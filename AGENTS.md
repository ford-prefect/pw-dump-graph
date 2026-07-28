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

- **`src/model.ts` and `src/render/*` must never import a layout library** (elkjs or
  otherwise). Only `src/layout/elk.ts` may import `elkjs`.
- Swapping layout engines = reimplement `LayoutEngine` in `src/layout/elk.ts` against
  `src/layout/types.ts`; nothing upstream or downstream should change.
- The domain model (`src/model.ts`) holds **no** coordinates, colors, or library types.
  Keep new PipeWire fields additive there.

## Layers

| Layer | File(s) | May depend on |
|-------|---------|---------------|
| parse | `src/parse.ts` | nothing |
| model | `src/model.ts` | parse |
| layout | `src/layout/types.ts` (seam), `src/layout/elk.ts` (adapter) | elkjs — adapter only |
| render | `src/render/svg.ts`, `src/render/interact.ts` | model types + layout seam |

## Commands

```bash
npm run dev        # dev server (renders examples/pw-dump.json by default)
npm run build      # tsc + vite build → dist/
npm run typecheck  # tsc --noEmit

# share service (Rust, in server/)
cargo test  --manifest-path server/Cargo.toml            # store eviction/TTL tests
just bin                                                 # single binary, frontend embedded
```

## Share server (`server/`)

Rust (axum + tokio) service, kept deliberately small and stateless: `POST /api/dumps`
stores a JSON body in memory under a random key; `GET /api/dumps/:key` returns it. The
store (`src/main.rs`) is bounded by max-count + TTL — **no persistence, no auth**. The
built frontend is embedded via `rust-embed` behind the **`embed`** cargo feature, so a
`--features embed` release build is one self-contained binary (`just run`/`just bin`);
without the feature it serves the frontend from `PWG_DIST` on disk (and compiles without
`dist/`), which is the `just serve` dev path. It's
independent of the frontend layering above; the
frontend reaches it only via `POST /api/dumps` and the `?g=<key>` load path in `main.ts`.

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

## Commits

- Work in small, atomic commits: one self-contained change each, with the tree
  building and typechecking at every commit. Land a refactor separately from the
  behaviour change that motivated it.
- No `Co-Authored-By:` (or similar attribution) trailers in commit messages.

## Not yet implemented (deferred by design)

- Port groups (n:1): cluster by `Port.group` (distinct from `node.link-group`, which
  is already grouped into boxes).
- Upload service: Node.js endpoint for `pw-dump | curl host`; viewer already supports `?url=`.
