#!/usr/bin/env bash
# THE acceptance script. The same file runs in every CI matrix cell (docker, rootful
# podman, incus) and locally. It grows with the milestones until it encodes the full
# Phase 0 exit: "Ade installs one container and Maya runs a query, each as themselves."
#
#   v0 (M0.1, current): boot the image as main, health-check, verify role stickiness.
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

cleanup() { "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> [$RUNTIME] booting $IMAGE as main"
"$RUNTIME" run -d --name "$NAME" -e PEBBLES_ROLE=main -p "127.0.0.1:${PORT}:8080" "$IMAGE" >/dev/null

echo "==> waiting for /healthz"
health=""
for _ in $(seq 1 30); do
  health="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
  [ -n "$health" ] && break
  sleep 1
done
if [ -z "$health" ]; then
  echo "FAIL: /healthz never came up; container logs:" >&2
  "$RUNTIME" logs "$NAME" >&2 || true
  exit 1
fi
echo "    $health"
echo "$health" | grep -q '"status":"ok"' || { echo "FAIL: unexpected health payload" >&2; exit 1; }
echo "$health" | grep -q '"role":"main"' || { echo "FAIL: expected role=main" >&2; exit 1; }

version="$(curl -fsS "http://127.0.0.1:${PORT}/version")"
echo "==> version: $version"

echo "==> restart preserves the sticky role (REQ-03)"
"$RUNTIME" restart "$NAME" >/dev/null
sticky=""
for _ in $(seq 1 30); do
  sticky="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
  [ -n "$sticky" ] && break
  sleep 1
done
echo "$sticky" | grep -q '"role":"main"' || { echo "FAIL: role lost across restart" >&2; exit 1; }

echo "==> smoke OK ($RUNTIME)"
