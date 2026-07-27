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
```

## Conventions

- TypeScript, `strict` mode; keep `tsc` clean (no new errors/warnings).
- ES modules; import paths use `.js` extensions (bundler resolution maps to `.ts`).
- Match the existing style: small focused modules, comments explaining *why* a layer
  exists rather than restating code.
- Keep runtime dependencies minimal (currently just `elkjs`).

## Verifying changes

- `npm run typecheck` and `npm run build` must pass.
- Sanity-check against `examples/pw-dump.json`: 12 nodes, 24 ports, 7 links; driver
  nodes (`Dummy-Driver`, `Freewheel-Driver`) have no ports.
- Prefer verifying model/layout changes headlessly (they are DOM-free); render/interact
  need a DOM.

## Not yet implemented (deferred by design)

- Port groups (n:1): cluster by `Port.group`.
- Upload service: Node.js endpoint for `pw-dump | curl host`; viewer already supports `?url=`.
