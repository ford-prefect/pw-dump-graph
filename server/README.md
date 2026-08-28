# pw-dump-graph share server

`pw-dump-graph-server` stores a posted `pw-dump` under a short random key and serves the
viewer back, so a dump can be handed to someone else as a link. It's the service behind
<https://pw.arunraghavan.net> — see the top-level [README](../README.md) for how to use a
hosted instance. This file is about running your own.

```bash
pw-dump | curl -sT- https://pw.arunraghavan.net
# → https://pw.arunraghavan.net/?g=kAvgEynPkG
```

## Endpoints

| Endpoint | Does |
|---|---|
| `POST`/`PUT /` | store a piped dump, reply with the share URL as `text/plain` |
| `POST /api/dumps` | the same, as JSON `{key,url}` (what the **Share…** button uses) |
| `GET /api/dumps/:key` | the stored dump (`404` once evicted or expired) |
| `GET /` and anything else | the viewer, with SPA fallback |

Bodies must be JSON (`400` otherwise) and within `PWG_BODY_LIMIT` (`413`). Opening
`…/?g=<key>` loads that dump in the viewer.

## Configuration

All via environment:

| Variable | Default | Meaning |
|---|---|---|
| `PWG_ADDR` | `0.0.0.0:8787` | listen address |
| `PWG_MAX_ENTRIES` | `500` | max dumps held; oldest evicted first |
| `PWG_TTL_SECS` | `86400` (24 h) | how long a dump lives |
| `PWG_BODY_LIMIT` | `8388608` (8 MiB) | max accepted body |
| `PWG_STATE_FILE` | unset | transient restart handoff (see below) |
| `PWG_DIST` | `dist` | where to serve the frontend from, without `--features embed` |

## Storage

Dumps are held **in memory only**, minified and gzip-compressed — about 20× smaller than
raw `pw-dump` output (17–24× measured across this repo's own sample and fixtures) — and
served back gzip-encoded to clients that accept it, so far more entries fit in a given
memory budget. The store is bounded by `PWG_MAX_ENTRIES` and `PWG_TTL_SECS`; there is no
persistence, and everything is lost on restart unless you set up the handoff below.

Budget roughly **43 KiB resident per entry** (measured on a release build; more than the
compressed payload alone, between per-entry slack and allocator retention), so
`PWG_MAX_ENTRIES × ~43 KiB`. Writing the handoff briefly costs about 1.4× that, since
`snapshot()` builds the whole blob in memory while the store still holds every entry.

## Restart handoff (`PWG_STATE_FILE`)

Set `PWG_STATE_FILE=<path>` to hand the store off **across a restart** (e.g. when
deploying a new binary): the store is written there once on graceful shutdown
(SIGTERM/Ctrl-C) and read back — **then deleted** — on the next start. This is a transient
handoff, **not** durable storage: nothing sits on disk while the server runs, and a hard
kill (SIGKILL) writes nothing (that share is lost). The file is written `0600`; point it at
a per-service location (a systemd `StateDirectory`, a Docker volume) so a restart reloads
it.

## Running under systemd

[`contrib/pw-dump-graph-server.service`](../contrib/pw-dump-graph-server.service) is a
reference unit — a hardened `DynamicUser=yes` service with the handoff in a
`StateDirectory`. Under systemd that pairing is the only one that works: `DynamicUser=yes`
implies `PrivateTmp=yes`, so a `/tmp` handoff is written into a per-start private `/tmp`
that is destroyed when the unit stops, and the restore silently comes up empty.

## Behind a reverse proxy

The share URL is built from the request's `Host`, and its scheme from
**`X-Forwarded-Proto`** — falling back to `http` when that header is absent. A TLS
terminator that doesn't set it will hand users `http://` links for an https site, so set
it:

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
```

There is **no auth, rate limiting, or TLS** in the service itself. Anyone who can reach it
can store and read dumps, so put it behind a proxy you control if it's exposed.

## Building

Built with the `embed` feature the frontend is baked into the binary, so the whole app is
**one self-contained executable** — no `dist/` to ship alongside:

```bash
just run          # build frontend, compile with --features embed, serve on :8787
# equivalently:
npm run build && cargo build --release --features embed -p pw-dump-graph-server
./target/release/pw-dump-graph-server
```

Without `--features embed` the binary serves the frontend from `dist/` on disk
(`PWG_DIST`) — so `just serve` still serves the app at `:8787` once `npm run build` has
run. Pair it with `just dev` for hot-reload on `:5173`, which proxies `/api` to `:8787` so
the **Share…** button works in dev too.
