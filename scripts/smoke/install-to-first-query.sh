#!/usr/bin/env bash
# THE acceptance script. The same file runs in every CI matrix cell (docker, rootful
# podman, incus) and locally. It grows with the milestones until it encodes the full
# Phase 0 exit: "Ade installs one container and Maya runs a query, each as themselves."
#
#   v0.5 (M0.5, current): everything below plus THE FIRST REAL QUERY — Maya creates
#     a DuckLake catalog (Postgres metadata + Parquet data), loads a CSV, queries
#     it, time-travels to an earlier snapshot, and streams a result over SSE
#     through the web tier (REQ-24/25/31).
#   v0.4: sessions as the user — two users' kernels under distinct uids (/proc),
#     cross-user reads refused by the filesystem, over-budget sessions get 409.
#   v0.3: Ade creates maya through the privileged API; Maya signs into the web UI
#     with her UNIX password; role and account survive a restart (REQ-03/11).
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

echo "==> M0.4: two users, two sessions, two uids (REQ-12/16)"
pd -H 'Content-Type: application/json' \
  -d '{"username":"tomas","password":"pebbles-demo-2"}' http://pebblesd/users >/dev/null
json_num() { sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" <<<"$1" | head -1; }
s_maya="$(pd -H 'Content-Type: application/json' -d '{"username":"maya"}' http://pebblesd/sessions)"
s_tomas="$(pd -H 'Content-Type: application/json' -d '{"username":"tomas"}' http://pebblesd/sessions)"
id_maya="$(json_num "$s_maya" id)"; pid_maya="$(json_num "$s_maya" pid)"
id_tomas="$(json_num "$s_tomas" id)"; pid_tomas="$(json_num "$s_tomas" pid)"
echo "    maya: session $id_maya pid $pid_maya · tomas: session $id_tomas pid $pid_tomas"
uid_of() { "$RUNTIME" exec "$NAME" sed -n 's/^Uid:[[:space:]]*\([0-9]*\).*/\1/p' "/proc/$1/status"; }
[ "$(uid_of "$pid_maya")" = "70000" ] \
  || { echo "FAIL: maya's session process is not uid 70000" >&2; exit 1; }
[ "$(uid_of "$pid_tomas")" = "70001" ] \
  || { echo "FAIL: tomas's session process is not uid 70001" >&2; exit 1; }

echo "==> filesystem permissions ARE the permission system"
pd -H 'Content-Type: application/json' \
  -d '{"id":1,"op":"write","path":"/home/tomas/secret.txt","content":"tomas-only"}' \
  "http://pebblesd/sessions/$id_tomas/exec" | grep -q '"ok":true' \
  || { echo "FAIL: tomas cannot write his own file" >&2; exit 1; }
denied="$(pd -H 'Content-Type: application/json' \
  -d '{"id":2,"op":"read","path":"/home/tomas/secret.txt"}' \
  "http://pebblesd/sessions/$id_maya/exec")"
echo "$denied" | grep -q '"ok":false' \
  || { echo "FAIL: maya READ tomas's file — isolation broken: $denied" >&2; exit 1; }
pd -H 'Content-Type: application/json' \
  -d '{"id":3,"op":"read","path":"/home/tomas/secret.txt"}' \
  "http://pebblesd/sessions/$id_tomas/exec" | grep -q 'tomas-only' \
  || { echo "FAIL: tomas cannot read his own file back" >&2; exit 1; }

echo "==> memory admission refuses cleanly (REQ-20)"
refuse_code="$("$RUNTIME" exec "$NAME" curl -s -o /dev/null -w '%{http_code}' \
  --unix-socket /run/pebbles/pebblesd.sock -H 'Content-Type: application/json' \
  -d '{"username":"maya","memory_limit_bytes":99999999999999}' http://pebblesd/sessions)"
[ "$refuse_code" = "409" ] \
  || { echo "FAIL: over-budget session expected 409, got $refuse_code" >&2; exit 1; }
pd "http://pebblesd/sessions" | grep -o '"id":' | wc -l | grep -qx '[[:space:]]*2' \
  || { echo "FAIL: expected exactly 2 live sessions" >&2; exit 1; }

echo "==> M0.5: Maya creates the claims catalog (REQ-24/25)"
created_cat=""
for _ in $(seq 1 30); do # postgres may still be running initdb on first boot
  created_cat="$("$RUNTIME" exec "$NAME" curl -s --unix-socket /run/pebbles/pebblesd.sock \
    -H 'Content-Type: application/json' \
    -d '{"name":"claims","owner":"maya"}' http://pebblesd/catalogs)"
  echo "$created_cat" | grep -q '"database":"ducklake_claims"' && break
  sleep 2
done
echo "    $created_cat"
echo "$created_cat" | grep -q '"database":"ducklake_claims"' \
  || { echo "FAIL: catalog creation never succeeded" >&2; exit 1; }

echo "==> Maya loads a CSV and runs her first query"
pd -H 'Content-Type: application/json' \
  -d '{"id":10,"op":"write","path":"/home/maya/claims.csv","content":"claim_id,amount\nC-1,120.50\nC-2,80.00\n"}' \
  "http://pebblesd/sessions/$id_maya/exec" | grep -q '"ok":true' \
  || { echo "FAIL: could not write maya's CSV" >&2; exit 1; }
sql() { pd -H 'Content-Type: application/json' \
  -d "{\"id\":11,\"op\":\"sql\",\"catalog\":\"claims\",\"sql\":\"$1\"}" \
  "http://pebblesd/sessions/$id_maya/exec"; }
sql "CREATE TABLE claims_t AS SELECT * FROM read_csv_auto('/home/maya/claims.csv');" \
  | grep -q '"ok":true' || { echo "FAIL: CREATE TABLE from CSV failed" >&2; exit 1; }
sql "INSERT INTO claims_t VALUES ('C-3', 42.00);" | grep -q '"ok":true' \
  || { echo "FAIL: INSERT failed" >&2; exit 1; }
sql "SELECT count(*) AS c FROM claims_t;" | grep -q '"c":3' \
  || { echo "FAIL: expected 3 rows after insert" >&2; exit 1; }

echo "==> time travel: the pre-insert snapshot still answers (REQ-24)"
snaps="$(sql "SELECT snapshot_id FROM ducklake_snapshots('claims') ORDER BY snapshot_id;")"
prev_ver="$(grep -o '"snapshot_id":[0-9]*' <<<"$snaps" | tail -2 | head -1 | cut -d: -f2)"
[ -n "$prev_ver" ] || { echo "FAIL: no snapshots listed: $snaps" >&2; exit 1; }
sql "SELECT count(*) AS c FROM claims_t AT (VERSION => $prev_ver);" | grep -q '"c":2' \
  || { echo "FAIL: time-travel to snapshot $prev_ver did not return 2 rows" >&2; exit 1; }

echo "==> results stream over SSE through the web tier (REQ-31)"
jar5="$(mktemp)"
curl -s -o /dev/null -c "$jar5" -d 'username=maya&password=pebbles-demo-1' "$BASE/login"
sse="$(curl -sN --max-time 60 -b "$jar5" \
  "$BASE/sql/stream?catalog=claims&q=SELECT%20count(*)%20AS%20c%20FROM%20claims_t")"
rm -f "$jar5"
grep -q 'event: result' <<<"$sse" && grep -q '"c": 3' <<<"$sse" \
  || { echo "FAIL: SSE stream missing the result event: $sse" >&2; exit 1; }

echo "==> restart preserves the sticky role and the account (REQ-03/11)"
"$RUNTIME" restart "$NAME" >/dev/null
sticky="$(wait_healthy)"
echo "$sticky" | grep -q '"role":"main"' \
  || { echo "FAIL: role lost across restart" >&2; exit 1; }
"$RUNTIME" exec "$NAME" getent passwd maya >/dev/null \
  || { echo "FAIL: maya vanished across restart" >&2; exit 1; }

echo "==> smoke OK ($RUNTIME)"
