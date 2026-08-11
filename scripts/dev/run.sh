#!/usr/bin/env bash
# Native dev loop: pebblesd + Flask against a scratch config dir. No container needed —
# the image is a CI product (implementation plan §8).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PEBBLES_CONFIG="${PEBBLES_CONFIG:-$ROOT/.dev/pebbles}"
export PEBBLES_ROLE="${PEBBLES_ROLE:-main}"
export PEBBLES_HTTP_ADDR="${PEBBLES_HTTP_ADDR:-127.0.0.1:8081}"
export PEBBLES_SOCKET="$PEBBLES_CONFIG/pebblesd.sock"
mkdir -p "$PEBBLES_CONFIG"

echo "==> pebblesd (config: $PEBBLES_CONFIG, health: $PEBBLES_HTTP_ADDR)"
cargo run -p pebblesd &
DAEMON=$!
trap 'kill "$DAEMON" 2>/dev/null || true' EXIT

echo "==> flask on http://127.0.0.1:8080"
cd "$ROOT/web"
uv sync
uv run flask --app pebbles_web:create_app run --debug --port 8080
