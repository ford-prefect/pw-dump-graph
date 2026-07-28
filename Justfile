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

# Type-check the frontend and run the server's unit tests.
test:
    npm run typecheck
    cargo test --manifest-path server/Cargo.toml

# Build the frontend into dist/.
build:
    npm run build

# Build the single self-contained binary (frontend embedded) into
# server/target/release/pw-dump-graph-server.
bin: build
    cargo build --release --features embed --manifest-path server/Cargo.toml

# 32-bit variant for ... reasons
bin32: build
    cargo build --release --features embed --manifest-path server/Cargo.toml  --target i686-unknown-linux-musl

# Production-like: build the single binary, then run it on {{addr}}.
run: bin
    PWG_ADDR={{ addr }} ./server/target/release/pw-dump-graph-server

# Dev: Vite with hot reload on http://localhost:5173 (proxies /api to :8787).
# Run `just serve` in another terminal so the Share button / ?g= links work.
dev:
    npm run dev

# Run only the share API (debug build) on {{addr}} — pair with `just dev`.
serve:
    PWG_ADDR={{ addr }} cargo run --manifest-path server/Cargo.toml

# Share a dump with a running server; reads a file argument or stdin, prints the URL.
# pw-dump | just share        or        just share dump.json
share file="/dev/stdin" host="http://localhost:8787":
    curl -sT- {{ host }} < {{ file }}

# Remove build artifacts.
clean:
    rm -rf dist server/target
