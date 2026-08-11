#!/usr/bin/env bash
# THE acceptance script — the encoded Phase 0 exit criterion, identical in every CI
# matrix cell (docker, rootful podman, incus) and locally:
#
#   "Ade installs one container and Maya runs a query, each as themselves."
#
#   Covered: web tier proxies pebblesd over the unix socket (NFR-01 end to end);
#   Ade creates users through the privileged API (real UNIX accounts, uid ∈ 70000+,
#   0700 homes); Maya signs in with her UNIX password; two users' sessions run under
#   distinct uids and cannot read each other's files (REQ-12/16); memory admission
#   refuses cleanly (REQ-20); Maya creates a DuckLake catalog, loads a CSV, queries,
#   time-travels a snapshot (REQ-24/25), and streams results over SSE (REQ-31); the
#   schema version is stamped (REQ-09); role and accounts survive a restart
#   (REQ-03/11). On docker/podman the container runs on an INTERNAL network with no
#   egress — the whole path works air-gapped (NFR-03).
#
# usage: RUNTIME=docker|podman|incus [CTR_CMD="sudo podman"] install-to-first-query.sh <image>
set -euo pipefail

IMAGE="${1:?usage: install-to-first-query.sh <image-ref>}"
RUNTIME="${RUNTIME:-docker}"
CMD="${CTR_CMD:-$RUNTIME}" # e.g. "sudo podman", "sudo incus"; word-splitting intended
NAME="pebbles-smoke-$$"
NET="pebbles-net-$$"
BASE="" # resolved after boot

ctr() { $CMD "$@"; }

ctr_exec() {
  case "$RUNTIME" in
    incus) ctr exec "$NAME" -- "$@" ;;
    *) ctr exec "$NAME" "$@" ;;
  esac
}

show_logs() {
  case "$RUNTIME" in
    incus) ctr info "$NAME" --show-log ;;
    *) ctr logs "$NAME" ;;
  esac
}

cleanup() {
  case "$RUNTIME" in
    incus) ctr delete -f "$NAME" >/dev/null 2>&1 || true ;;
    *)
      ctr rm -f "$NAME" >/dev/null 2>&1 || true
      ctr network rm "$NET" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup EXIT

resolve_base() {
  local ip=""
  for _ in $(seq 1 60); do
    case "$RUNTIME" in
      incus) ip="$(ctr list "$NAME" -c 4 --format csv 2>/dev/null | awk '{print $1}' | head -1)" ;;
      *) ip="$(ctr inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME" 2>/dev/null)" ;;
    esac
    [ -n "$ip" ] && { BASE="http://$ip:8080"; return 0; }
    sleep 1
  done
  echo "FAIL: container never got an IP" >&2
  show_logs >&2 || true
  return 1
}

boot_main() {
  case "$RUNTIME" in
    incus)
      # Unprivileged system container; the `pebbles` profile carries the ADR-001
      # idmap; pebblesd-as-init brings up lo + DHCP itself.
      ctr launch "$IMAGE" "$NAME" -p default -p pebbles \
        -c environment.PEBBLES_ROLE=main >/dev/null
      ;;
    *)
      # INTERNAL network: no egress, no NAT — the zero-network-calls proof (NFR-03).
      ctr network create --internal "$NET" >/dev/null
      ctr run -d --name "$NAME" --network "$NET" -e PEBBLES_ROLE=main "$IMAGE" >/dev/null
      ;;
  esac
  resolve_base
}

wait_healthy() {
  local out=""
  for _ in $(seq 1 60); do
    out="$(curl -fsS "$BASE/healthz" 2>/dev/null || true)"
    [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 1
  done
  echo "FAIL: /healthz never came up; container logs:" >&2
  show_logs >&2 || true
  return 1
}

expect() { # expect <pattern> <label> <payload>
  grep -q "$1" <<<"$3" || { echo "FAIL: $2 — got: $3" >&2; exit 1; }
}

pd() { ctr_exec curl -fsS --unix-socket /run/pebbles/pebblesd.sock "$@"; }
pd_code() { ctr_exec curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/pebbles/pebblesd.sock "$@"; }
json_num() { sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" <<<"$1" | head -1; }

echo "==> [$RUNTIME] booting $IMAGE as main"
boot_main

echo "==> waiting for the web tier"
health="$(wait_healthy)"
echo "    $health"
expect '"status":"ok"' "web tier healthy (pebblesd reachable over the socket?)" "$health"
expect '"role":"main"' "role=main via the pebblesd proxy" "$health"

echo "==> schema version is stamped in the config volume (REQ-09)"
[ "$(ctr_exec cat /var/lib/pebbles/schema-version)" = "1" ] \
  || { echo "FAIL: schema-version file missing or wrong" >&2; exit 1; }

echo "==> the Flask shell serves (login page when signed out)"
curl -fsSL "$BASE/" | grep -q 'data-pb-theme' \
  || { echo "FAIL: / did not serve the shell page" >&2; exit 1; }

echo "==> Ade path: create maya through the privileged API (M0.3)"
# -s (not -f): a failing create must SHOW its error body, not swallow it.
created="$(ctr_exec curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"pebbles-demo-1"}' http://pebblesd/users)"
echo "    $created"
expect '"uid":70000' "maya at uid 70000 (ADR-001 range)" "$created"

echo "==> the host agrees with the API (REQ-11)"
ctr_exec getent passwd maya | grep -q ':70000:70000:' \
  || { echo "FAIL: getent disagrees about maya's uid/gid" >&2; exit 1; }
[ "$(ctr_exec stat -c '%u:%g:%a' /home/maya)" = "70000:70000:700" ] \
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
s_maya="$(pd -H 'Content-Type: application/json' -d '{"username":"maya"}' http://pebblesd/sessions)"
s_tomas="$(pd -H 'Content-Type: application/json' -d '{"username":"tomas"}' http://pebblesd/sessions)"
id_maya="$(json_num "$s_maya" id)"; pid_maya="$(json_num "$s_maya" pid)"
id_tomas="$(json_num "$s_tomas" id)"; pid_tomas="$(json_num "$s_tomas" pid)"
echo "    maya: session $id_maya pid $pid_maya · tomas: session $id_tomas pid $pid_tomas"
uid_of() { ctr_exec sed -n 's/^Uid:[[:space:]]*\([0-9]*\).*/\1/p' "/proc/$1/status"; }
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
expect '"ok":false' "maya must NOT read tomas's file — isolation" "$denied"
pd -H 'Content-Type: application/json' \
  -d '{"id":3,"op":"read","path":"/home/tomas/secret.txt"}' \
  "http://pebblesd/sessions/$id_tomas/exec" | grep -q 'tomas-only' \
  || { echo "FAIL: tomas cannot read his own file back" >&2; exit 1; }

echo "==> memory admission refuses cleanly (REQ-20)"
refuse_code="$(pd_code -H 'Content-Type: application/json' \
  -d '{"username":"maya","memory_limit_bytes":99999999999999}' http://pebblesd/sessions)"
[ "$refuse_code" = "409" ] \
  || { echo "FAIL: over-budget session expected 409, got $refuse_code" >&2; exit 1; }

echo "==> M0.5: Maya creates the claims catalog (REQ-24/25)"
created_cat=""
for _ in $(seq 1 30); do # postgres may still be running initdb on first boot
  created_cat="$(ctr_exec curl -s --unix-socket /run/pebbles/pebblesd.sock \
    -H 'Content-Type: application/json' \
    -d '{"name":"claims","owner":"maya"}' http://pebblesd/catalogs)"
  grep -q '"database":"ducklake_claims"' <<<"$created_cat" && break
  sleep 2
done
echo "    $created_cat"
expect '"database":"ducklake_claims"' "catalog creation" "$created_cat"

echo "==> Maya loads a CSV and runs her first query"
pd -H 'Content-Type: application/json' \
  -d '{"id":10,"op":"write","path":"/home/maya/claims.csv","content":"claim_id,amount\nC-1,120.50\nC-2,80.00\n"}' \
  "http://pebblesd/sessions/$id_maya/exec" | grep -q '"ok":true' \
  || { echo "FAIL: could not write maya's CSV" >&2; exit 1; }
sql() { ctr_exec curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d "{\"id\":11,\"op\":\"sql\",\"catalog\":\"claims\",\"sql\":\"$1\"}" \
  "http://pebblesd/sessions/$id_maya/exec"; }
expect '"ok":true' "CREATE TABLE from CSV" \
  "$(sql "CREATE TABLE claims_t AS SELECT * FROM read_csv_auto('/home/maya/claims.csv');")"
expect '"ok":true' "INSERT" "$(sql "INSERT INTO claims_t VALUES ('C-3', 42.00);")"
expect '"c":3' "count after insert" "$(sql "SELECT count(*) AS c FROM claims_t;")"

echo "==> time travel: the pre-insert snapshot still answers (REQ-24)"
snaps="$(sql "SELECT snapshot_id FROM ducklake_snapshots('claims') ORDER BY snapshot_id;")"
echo "    snapshots: $snaps"
prev_ver="$({ grep -o '"snapshot_id":[0-9]*' <<<"$snaps" || true; } | tail -2 | head -1 | cut -d: -f2)"
[ -n "$prev_ver" ] || { echo "FAIL: no snapshots listed" >&2; exit 1; }
tt="$(sql "SELECT count(*) AS c FROM claims_t AT (VERSION => $prev_ver);")"
echo "    at version $prev_ver: $tt"
expect '"c":2' "time-travel to snapshot $prev_ver" "$tt"

echo "==> M1.2: catalog access is denied before a grant (REQ-13)"
sql_as() { ctr_exec curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d "{\"id\":12,\"op\":\"sql\",\"catalog\":\"claims\",\"sql\":\"$2\"}" \
  "http://pebblesd/sessions/$1/exec"; }
before="$(sql_as "$id_tomas" "SELECT count(*) AS c FROM claims_t;")"
expect '"ok":false' "tomas must NOT reach maya's catalog before a grant" "$before"

echo "==> grant via group: analysts gets the claims catalog"
pd -H 'Content-Type: application/json' -d '{"name":"analysts"}' http://pebblesd/groups >/dev/null
pd -H 'Content-Type: application/json' -d '{"username":"tomas"}' \
  http://pebblesd/groups/analysts/members >/dev/null
pd -H 'Content-Type: application/json' -d '{"group":"analysts"}' \
  http://pebblesd/catalogs/claims/grants >/dev/null
# Group membership is picked up at spawn (initgroups): a NEW session is the test.
s_tomas2="$(pd -H 'Content-Type: application/json' -d '{"username":"tomas"}' http://pebblesd/sessions)"
id_tomas2="$(json_num "$s_tomas2" id)"
after="$(sql_as "$id_tomas2" "SELECT count(*) AS c FROM claims_t;")"
echo "    $after"
expect '"c":3' "tomas queries the catalog through the analysts grant" "$after"

echo "==> results stream over SSE through the web tier (REQ-31)"
jar5="$(mktemp)"
curl -s -o /dev/null -c "$jar5" -d 'username=maya&password=pebbles-demo-1' "$BASE/login"
sse="$(curl -sN --max-time 60 -b "$jar5" \
  "$BASE/sql/stream?catalog=claims&q=SELECT%20count(*)%20AS%20c%20FROM%20claims_t")"
rm -f "$jar5"
grep -q 'event: result' <<<"$sse" && grep -q '"c": 3' <<<"$sse" \
  || { echo "FAIL: SSE stream missing the result event: $sse" >&2; exit 1; }

echo "==> M1.3: a dedicated request drains, never refuses (REQ-18/19)"
resv_out="$(ctr_exec curl -s -w '\n%{http_code}' --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d '{"username":"tomas","mode":"dedicated"}' http://pebblesd/sessions)"
resv_code="$(tail -1 <<<"$resv_out")"
[ "$resv_code" = "202" ] \
  || { echo "FAIL: dedicated on a busy engine expected 202 reservation, got: $resv_out" >&2; exit 1; }
expect '"state":"pending"' "reservation visible" \
  "$(pd http://pebblesd/sessions/reservation)"
pd http://pebblesd/engines | grep -q '"state":"draining (reserved for tomas)"' \
  || { echo "FAIL: engine state should show draining" >&2; exit 1; }
shared_code="$(pd_code -H 'Content-Type: application/json' \
  -d '{"username":"maya"}' http://pebblesd/sessions)"
[ "$shared_code" = "409" ] \
  || { echo "FAIL: shared session during drain expected 409, got $shared_code" >&2; exit 1; }

echo "==> the drain completes when the last shared session closes"
for sid in $(pd http://pebblesd/sessions | grep -o '"id":[0-9]*' | cut -d: -f2); do
  pd -X DELETE "http://pebblesd/sessions/$sid" >/dev/null
done
ready=""
for _ in $(seq 1 30); do
  ready="$(pd http://pebblesd/sessions/reservation)"
  grep -q '"state":"ready"' <<<"$ready" && break
  sleep 1
done
echo "    $ready"
expect '"state":"ready"' "dedicated session started after the drain" "$ready"
ded_id="$(json_num "$ready" id)"
pd -H 'Content-Type: application/json' -d '{"id":20,"op":"ping"}' \
  "http://pebblesd/sessions/$ded_id/exec" | grep -q '"uid":70001' \
  || { echo "FAIL: dedicated session is not tomas" >&2; exit 1; }

echo "==> a second reservation is cancellable (REQ-19)"
ctr_exec curl -s -o /dev/null --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d '{"username":"maya","mode":"dedicated"}' http://pebblesd/sessions
expect '"cancelled":true' "cancel clears the pending reservation" \
  "$(pd -X DELETE http://pebblesd/sessions/reservation)"
pd -X DELETE "http://pebblesd/sessions/$ded_id" >/dev/null

echo "==> restart preserves the sticky role and the account (REQ-03/11)"
ctr restart "$NAME" >/dev/null
resolve_base
sticky="$(wait_healthy)"
expect '"role":"main"' "role after restart" "$sticky"
ctr_exec getent passwd maya >/dev/null \
  || { echo "FAIL: maya vanished across restart" >&2; exit 1; }

echo "==> smoke OK ($RUNTIME)"
