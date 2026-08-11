#!/usr/bin/env bash
# THE acceptance script. The same file runs in every CI matrix cell (docker, rootful
# podman, incus) and locally. It grows with the milestones until it encodes the full
# Phase 0 exit: "Ade installs one container and Maya runs a query, each as themselves."
#
#   v0.3 (M0.3, current): boot as main; web tier on :8080 proxies pebblesd over the
#     unix socket (NFR-01 end to end); Ade creates maya through the privileged API
#     (real UNIX account, uid ∈ 70000+, 0700 home); Maya signs into the web UI with
#     her UNIX password; the role and the account survive a restart (REQ-03/11).
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

echo "==> the Flask shell serves (login page when signed out)"
curl -fsSL "$BASE/" | grep -q 'data-pb-theme' \
  || { echo "FAIL: / did not serve the shell page" >&2; exit 1; }

echo "==> Ade path: create maya through the privileged API (M0.3)"
pd() { "$RUNTIME" exec "$NAME" curl -fsS --unix-socket /run/pebbles/pebblesd.sock "$@"; }
created="$(pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"pebbles-demo-1"}' http://pebblesd/users)"
echo "    $created"
echo "$created" | grep -q '"uid":70000' \
  || { echo "FAIL: expected maya at uid 70000 (ADR-001 range)" >&2; exit 1; }

echo "==> the host agrees with the API (REQ-11)"
"$RUNTIME" exec "$NAME" getent passwd maya | grep -q ':70000:70000:' \
  || { echo "FAIL: getent disagrees about maya's uid/gid" >&2; exit 1; }
[ "$("$RUNTIME" exec "$NAME" stat -c '%u:%g:%a' /home/maya)" = "70000:70000:700" ] \
  || { echo "FAIL: /home/maya must be owned by maya, mode 0700" >&2; exit 1; }

echo "==> Maya path: sign into the web UI with her UNIX password"
jar="$(mktemp)"
code="$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" \
  -d 'username=maya&password=pebbles-demo-1' "$BASE/login")"
[ "$code" = "302" ] || { echo "FAIL: login expected 302, got $code" >&2; exit 1; }
curl -fsS -b "$jar" "$BASE/" | grep -q 'maya' \
  || { echo "FAIL: signed-in shell does not show maya" >&2; exit 1; }
badcode="$(curl -s -o /dev/null -w '%{http_code}' \
  -d 'username=maya&password=wrong-password' "$BASE/login")"
[ "$badcode" = "401" ] || { echo "FAIL: wrong password expected 401, got $badcode" >&2; exit 1; }
rm -f "$jar"

echo "==> restart preserves the sticky role and the account (REQ-03/11)"
"$RUNTIME" restart "$NAME" >/dev/null
sticky="$(wait_healthy)"
echo "$sticky" | grep -q '"role":"main"' \
  || { echo "FAIL: role lost across restart" >&2; exit 1; }
"$RUNTIME" exec "$NAME" getent passwd maya >/dev/null \
  || { echo "FAIL: maya vanished across restart" >&2; exit 1; }

echo "==> smoke OK ($RUNTIME)"
