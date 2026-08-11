#!/usr/bin/env bash
# THE acceptance script. The same file runs in every CI matrix cell (docker, rootful
# podman, incus) and locally. It grows with the milestones until it encodes the full
# Phase 0 exit: "Ade installs one container and Maya runs a query, each as themselves."
#
#   v0.2 (M0.2, current): boot as main; the FLASK tier answers on :8080 and its
#     /healthz proxies pebblesd over the unix socket (the NFR-01 boundary, end to
#     end); the shell page serves; the role survives a restart (REQ-03).
#   M0.3 adds: create user maya via API, assert uid ∈ 60000+ and home ownership.
#   M0.5 adds: CREATE CATALOG + query DuckLake as maya; SSE round-trip.
#   M0.6 adds: zero-egress assertion (NFR-03) and the main+engine topology.
#
# usage: RUNTIME=docker|podman scripts/smoke/install-to-first-query.sh <image-ref>
set -euo pipefail

IMAGE="${1:?usage: install-to-first-query.sh <image-ref>}"
RUNTIME="${RUNTIME:-docker}"
NAME="pebbles-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"

cleanup() { "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_healthy() {
  local out=""
  for _ in $(seq 1 45); do
    out="$(curl -fsS "$BASE/healthz" 2>/dev/null || true)"
    [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 1
  done
  echo "FAIL: /healthz never came up; container logs:" >&2
  "$RUNTIME" logs "$NAME" >&2 || true
  return 1
}

echo "==> [$RUNTIME] booting $IMAGE as main"
"$RUNTIME" run -d --name "$NAME" -e PEBBLES_ROLE=main -p "127.0.0.1:${PORT}:8080" "$IMAGE" >/dev/null

echo "==> waiting for the web tier"
health="$(wait_healthy)"
echo "    $health"
echo "$health" | grep -q '"status":"ok"' \
  || { echo "FAIL: web tier is degraded (pebblesd unreachable over the socket?)" >&2; exit 1; }
echo "$health" | grep -q '"role":"main"' \
  || { echo "FAIL: expected role=main via the pebblesd proxy" >&2; exit 1; }

echo "==> the Flask shell serves (M0.2 exit criterion)"
curl -fsS "$BASE/" | grep -q 'data-pb-theme' \
  || { echo "FAIL: / did not serve the shell page" >&2; exit 1; }

echo "==> restart preserves the sticky role (REQ-03)"
"$RUNTIME" restart "$NAME" >/dev/null
sticky="$(wait_healthy)"
echo "$sticky" | grep -q '"role":"main"' \
  || { echo "FAIL: role lost across restart" >&2; exit 1; }

echo "==> smoke OK ($RUNTIME)"
