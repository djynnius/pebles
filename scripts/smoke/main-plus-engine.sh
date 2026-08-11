#!/usr/bin/env bash
# The M1.1 duo-topology acceptance: a main and a separately-booted engine sharing
# homes and lake storage. Proves join-token registration (REQ-05), identity
# replication (REQ-11/14), and that a session opened THROUGH THE MAIN runs on the
# engine as the requesting user's uid — the whole point of the identity model.
# Runs under docker or rootful podman (CTR_CMD="sudo podman"); incus duo
# follows once shared-volume devices are wired for system containers.
#
# usage: [CTR_CMD="sudo podman"] main-plus-engine.sh <image-ref>
set -euo pipefail

IMAGE="${1:?usage: main-plus-engine.sh <image-ref>}"
CMD="${CTR_CMD:-docker}" # word-splitting intended (e.g. "sudo podman")
ctr() { $CMD "$@"; }
NET="pebbles-duo-net-$$"
MAIN="pebbles-duo-main-$$"
ENGINE="pebbles-duo-engine-$$"
HOMES="pebbles-duo-homes-$$"
LAKE="pebbles-duo-lake-$$"

cleanup() {
  ctr rm -f "$MAIN" "$ENGINE" >/dev/null 2>&1 || true
  ctr network rm "$NET" >/dev/null 2>&1 || true
  ctr volume rm -f "$HOMES" "$LAKE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pd() { ctr exec "$MAIN" curl -fsS --max-time 120 --unix-socket /run/pebbles/pebblesd.sock "$@"; }
expect() { grep -q "$1" <<<"$3" || { echo "FAIL: $2 — got: $3" >&2; exit 1; }; }
json_str() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" <<<"$1" | head -1; }
json_num() { sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" <<<"$1" | head -1; }

echo "==> booting the main (internal network, shared homes + lake)"
ctr network create --internal "$NET" >/dev/null
ctr run -d --name "$MAIN" --network "$NET" \
  -v "$HOMES":/home -v "$LAKE":/var/lib/pebbles/lake \
  -e PEBBLES_ROLE=main "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  pd http://pebblesd/healthz >/dev/null 2>&1 && break
  sleep 1
done
pd http://pebblesd/healthz >/dev/null || { ctr logs "$MAIN" >&2; exit 1; }
main_ip="$(ctr inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$MAIN")"

echo "==> Ade mints a single-use join token (REQ-05)"
minted="$(pd -X POST http://pebblesd/cluster/tokens)"
token="$(json_str "$minted" token)"
[ -n "$token" ] || { echo "FAIL: no token minted: $minted" >&2; exit 1; }

echo "==> booting the engine with the token"
ctr run -d --name "$ENGINE" --network "$NET" \
  -v "$HOMES":/home -v "$LAKE":/var/lib/pebbles/lake \
  -e PEBBLES_ROLE=engine \
  -e PEBBLES_MAIN="http://$main_ip:7443" \
  -e PEBBLES_JOIN_TOKEN="$token" \
  -e PEBBLES_ENGINE_NAME=worker-1 "$IMAGE" >/dev/null

echo "==> engine appears in the registry as available"
engines=""
for _ in $(seq 1 60); do
  engines="$(pd http://pebblesd/engines 2>/dev/null || true)"
  grep -q '"name":"worker-1".*"state":"available"' <<<"$engines" && break
  sleep 2
done
echo "    $engines"
expect '"name":"worker-1"' "engine registered" "$engines"
expect '"state":"available"' "engine available" "$engines"

echo "==> the used token cannot register a second engine (single-use)"
code="$(ctr exec "$MAIN" curl -s -o /dev/null -w '%{http_code}' \
  "http://$main_ip:7443/cluster/register" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$token\",\"name\":\"evil\",\"address\":\"http://x:1\",\"resources\":{\"cpus\":1,\"memory_bytes\":1},\"existing_users\":[],\"lake_ok\":true}")"
[ "$code" = "401" ] || { echo "FAIL: reused token expected 401, got $code" >&2; exit 1; }

echo "==> maya is created on the main and replicated to the engine (REQ-11/14)"
pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"pebbles-demo-1"}' http://pebblesd/users >/dev/null
for _ in $(seq 1 30); do
  ctr exec "$ENGINE" getent passwd maya >/dev/null 2>&1 && break
  sleep 1
done
ctr exec "$ENGINE" getent passwd maya | grep -q ':70000:70000:' \
  || { echo "FAIL: maya not replicated to the engine" >&2; exit 1; }

echo "==> a session opened through the main runs ON the engine, as maya"
sess="$(pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","engine":"worker-1"}' http://pebblesd/sessions)"
echo "    $sess"
expect '"engine":"worker-1"' "session routed to the engine" "$sess"
sid="$(json_num "$sess" id)"
pid="$(json_num "$sess" pid)"
[ "$(ctr exec "$ENGINE" sed -n 's/^Uid:[[:space:]]*\([0-9]*\).*/\1/p' "/proc/$pid/status")" = "70000" ] \
  || { echo "FAIL: engine-side session process is not uid 70000" >&2; exit 1; }

echo "==> the session answers SQL and writes into the shared home"
ping_resp="$(pd -H 'Content-Type: application/json' -d '{"id":1,"op":"ping"}' \
  "http://pebblesd/sessions/$sid/exec")"
expect '"uid":70000' "proxied ping reports maya's uid" "$ping_resp"
sql_resp="$(pd -H 'Content-Type: application/json' \
  -d '{"id":2,"op":"sql","sql":"SELECT 42 AS answer;"}' \
  "http://pebblesd/sessions/$sid/exec")"
expect '"answer":42' "SQL on the engine" "$sql_resp"
pd -H 'Content-Type: application/json' \
  -d '{"id":3,"op":"write","path":"/home/maya/from-engine.txt","content":"hello"}' \
  "http://pebblesd/sessions/$sid/exec" | grep -q '"ok":true' \
  || { echo "FAIL: session write failed" >&2; exit 1; }
[ "$(ctr exec "$MAIN" stat -c '%u' /home/maya/from-engine.txt)" = "70000" ] \
  || { echo "FAIL: file not visible/owned in the shared home on the MAIN" >&2; exit 1; }

echo "==> closing the proxied session"
pd -X DELETE "http://pebblesd/sessions/$sid" | grep -q 'closed' \
  || { echo "FAIL: close failed" >&2; exit 1; }

echo "==> M1.2: engine access is group-gated (REQ-07)"
pd -H 'Content-Type: application/json' -d '{"name":"analysts"}' http://pebblesd/groups >/dev/null
pd -H 'Content-Type: application/json' -d '{"access":"group:analysts"}' \
  http://pebblesd/engines/worker-1/access >/dev/null
denied_code="$(ctr exec "$MAIN" curl -s -o /dev/null -w '%{http_code}' \
  --unix-socket /run/pebbles/pebblesd.sock -H 'Content-Type: application/json' \
  -d '{"username":"maya","engine":"worker-1"}' http://pebblesd/sessions)"
[ "$denied_code" = "403" ] \
  || { echo "FAIL: non-member session expected 403, got $denied_code" >&2; exit 1; }
pd -H 'Content-Type: application/json' -d '{"username":"maya"}' \
  http://pebblesd/groups/analysts/members >/dev/null
allowed="$(pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","engine":"worker-1"}' http://pebblesd/sessions)"
expect '"engine":"worker-1"' "member may attach after joining analysts" "$allowed"

echo "==> M1.8: tokenless engines wait for approval (REQ-06), removal invalidates (REQ-08)"
ENGINE2="pebbles-duo-engine2-$$"
cleanup2() { ctr rm -f "$ENGINE2" >/dev/null 2>&1 || true; }
trap 'cleanup2; cleanup' EXIT
ctr run -d --name "$ENGINE2" --network "$NET" \
  -v "$HOMES":/home -v "$LAKE":/var/lib/pebbles/lake \
  -e PEBBLES_ROLE=engine \
  -e PEBBLES_MAIN="http://$main_ip:7443" \
  -e PEBBLES_ENGINE_NAME=worker-2 "$IMAGE" >/dev/null
pending=""
for _ in $(seq 1 30); do
  pending="$(pd http://pebblesd/engines/pending 2>/dev/null || true)"
  grep -q '"name":"worker-2"' <<<"$pending" && break
  sleep 2
done
expect '"name":"worker-2"' "tokenless engine shows as pending" "$pending"
pd -X POST http://pebblesd/engines/pending/worker-2/approve >/dev/null
ready2=""
for _ in $(seq 1 30); do # the engine retries every 10s and completes registration
  ready2="$(pd http://pebblesd/engines 2>/dev/null || true)"
  grep -q '"name":"worker-2"' <<<"$ready2" && break
  sleep 2
done
expect '"name":"worker-2"' "approved engine registered" "$ready2"
pd -X DELETE http://pebblesd/engines/worker-2 >/dev/null
pd http://pebblesd/engines | grep -q '"name":"worker-2"' \
  && { echo "FAIL: deregistered engine still listed (REQ-08)" >&2; exit 1; }

echo "==> main+engine smoke OK"
