# pw-dump-graph — task runner (https://just.systems)
# Run `just` with no arguments to list recipes.

# Address the share server binds to (override: `just addr=127.0.0.1:9000 run`).
addr := "0.0.0.0:8787"

# List available recipes.
default:
    @just --list

# Install frontend dependencies.
install:
    npm install

# Type-check the frontend and run the workspace's unit tests.
test:
    npm run typecheck
    cargo test

# Build the frontend into dist/.
build:
    npm run build

# Build the single self-contained share-server binary (frontend embedded) into
# target/release/pw-dump-graph-server.
bin: build
    cargo build --release --features embed -p pw-dump-graph-server

# 32-bit variant for ... reasons
bin32: build
    cargo build --release --features embed -p pw-dump-graph-server --target i686-unknown-linux-musl

# Production-like: build the single share-server binary, then run it on {{addr}}.
run: bin
    PWG_ADDR={{ addr }} ./target/release/pw-dump-graph-server

# Dev: Vite with hot reload on http://localhost:5173 (proxies /api to :8787).
# Run `just serve` in another terminal so the Share button / ?g= links work.
dev:
    npm run dev

# Run the API and serve the built frontend from disk (debug) on {{addr}}.
# Depends on `build` so http://localhost:8787 shows a current frontend; pair with
# `just dev` for hot-reload on :5173 (which proxies /api here).
serve: build
    PWG_ADDR={{ addr }} cargo run -p pw-dump-graph-server

# Share a dump with a running server; reads a file argument or stdin, prints the URL.
# pw-dump | just share        or        just share dump.json
share file="/dev/stdin" host="http://localhost:8787":
    curl -sT- {{ host }} < {{ file }}

# Remove build artifacts.
clean:
    rm -rf dist target
