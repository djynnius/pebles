#!/usr/bin/env bash
# The M1.1 duo-topology acceptance: a main and a separately-booted engine sharing
# homes and lake storage. Proves join-token registration (REQ-05), identity
# replication (REQ-11/14), that a session opened THROUGH THE MAIN runs on the
# engine as the requesting user's uid — the whole point of the identity model —
# and NFR-08: a main-host failure leaves existing engine sessions running and
# answering, starts nothing new, and the engine is back in service (no re-join
# needed — registration is sticky on both sides) when the main returns.
#
# Runs under docker, rootful podman (CTR_CMD="sudo podman"), and incus
# (RUNTIME=incus CTR_CMD="sudo incus"). What's genuinely different on incus:
#   - two unprivileged SYSTEM containers on the same incus bridge, addressed by
#     their DHCP IPs (resolved the same way install-to-first-query.sh does);
#   - the `pebbles` profile carries the ADR-001 identity idmap
#     (deploy/incus/profile.yaml), so uid 70000 means the same thing on the
#     host and in BOTH containers;
#   - homes and lake are shared HOST DIRECTORIES attached as `disk` devices to
#     both containers (the incus equivalent of the named volumes below). The
#     dirs are pre-owned by uid 70000: that uid is identity-mapped, so container
#     root may provision homes inside them via DAC_OVERRIDE over a mapped uid —
#     no `shift=true` needed, and nothing depends on the containers' base map.
#     Host-dir setup/teardown shells out to sudo (CI-only, like the rest of the
#     incus tooling).
#
# usage: [RUNTIME=docker|podman|incus] [CTR_CMD="sudo podman"] main-plus-engine.sh <image-ref>
set -euo pipefail

IMAGE="${1:?usage: main-plus-engine.sh <image-ref>}"
RUNTIME="${RUNTIME:-docker}" # docker|podman share the OCI path; incus differs
CMD="${CTR_CMD:-$RUNTIME}"   # word-splitting intended (e.g. "sudo podman")
ctr() { $CMD "$@"; }
NET="pebbles-duo-net-$$"
MAIN="pebbles-duo-main-$$"
ENGINE="pebbles-duo-engine-$$"
ENGINE2="pebbles-duo-eng2-$$"
HOMES="pebbles-duo-homes-$$"
LAKE="pebbles-duo-lake-$$"
SHARE="" # incus only: host dir behind the shared homes+lake disk devices
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
TRIES=60
[ "$RUNTIME" = incus ] && TRIES=120 # the system-container boot is slower

ctr_exec() { # ctr_exec <container> <cmd...>
  local name="$1"
  shift
  case "$RUNTIME" in
    incus) ctr exec "$name" -- "$@" ;;
    *) ctr exec "$name" "$@" ;;
  esac
}

show_logs() { # show_logs <container> — incus: console ringbuffer, not driver log
  case "$RUNTIME" in
    incus) ctr console "$1" --show-log 2>/dev/null || ctr info "$1" --show-log ;;
    *) ctr logs "$1" ;;
  esac
}

cleanup() {
  case "$RUNTIME" in
    incus)
      ctr delete -f "$MAIN" "$ENGINE" "$ENGINE2" >/dev/null 2>&1 || true
      [ -n "$SHARE" ] && $SUDO rm -rf "$SHARE" || true
      ;;
    *)
      ctr rm -f "$MAIN" "$ENGINE" "$ENGINE2" >/dev/null 2>&1 || true
      ctr network rm "$NET" >/dev/null 2>&1 || true
      ctr volume rm -f "$HOMES" "$LAKE" >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup EXIT

pd() { ctr_exec "$MAIN" curl -fsS --max-time 120 --unix-socket /run/pebbles/pebblesd.sock "$@"; }
expect() { grep -q "$1" <<<"$3" || { echo "FAIL: $2 — got: $3" >&2; exit 1; }; }
json_str() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" <<<"$1" | head -1; }
json_num() { sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" <<<"$1" | head -1; }

incus_ip() { # DHCP on the incus bridge: the address can lag the launch
  local ip=""
  for _ in $(seq 1 60); do
    ip="$(ctr list "$1" -c 4 --format csv 2>/dev/null | awk '{print $1}' | head -1)"
    [ -n "$ip" ] && { echo "$ip"; return 0; }
    sleep 1
  done
  echo "FAIL: $1 never got an IP" >&2
  return 1
}

launch_incus() { # launch_incus <name> [-c key=value ...] — shared disks attached pre-start
  local name="$1"
  shift
  ctr init "$IMAGE" "$name" -p default -p pebbles "$@" >/dev/null
  ctr config device add "$name" homes disk "source=$SHARE/homes" path=/home >/dev/null
  ctr config device add "$name" lake disk "source=$SHARE/lake" path=/var/lib/pebbles/lake >/dev/null
  ctr start "$name" >/dev/null
}

wait_main_healthy() {
  for _ in $(seq 1 "$TRIES"); do
    pd http://pebblesd/healthz >/dev/null 2>&1 && break
    sleep 1
  done
  pd http://pebblesd/healthz >/dev/null || { show_logs "$MAIN" >&2; exit 1; }
}

echo "==> [$RUNTIME] booting the main (shared homes + lake)"
case "$RUNTIME" in
  incus)
    SHARE="$($SUDO mktemp -d /tmp/pebbles-duo-share-XXXXXX)"
    $SUDO mkdir -p "$SHARE/homes" "$SHARE/lake"
    $SUDO chown 70000:70000 "$SHARE/homes" "$SHARE/lake"
    $SUDO chmod 0755 "$SHARE" "$SHARE/homes" "$SHARE/lake"
    launch_incus "$MAIN" -c environment.PEBBLES_ROLE=main
    ;;
  *)
    # INTERNAL network: container-to-container only, no egress (NFR-03 posture).
    ctr network create --internal "$NET" >/dev/null
    ctr run -d --name "$MAIN" --network "$NET" \
      -v "$HOMES":/home -v "$LAKE":/var/lib/pebbles/lake \
      -e PEBBLES_ROLE=main "$IMAGE" >/dev/null
    ;;
esac
wait_main_healthy
case "$RUNTIME" in
  incus) main_ip="$(incus_ip "$MAIN")" ;;
  *) main_ip="$(ctr inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$MAIN")" ;;
esac

echo "==> Ade mints a single-use join token (REQ-05)"
minted="$(pd -X POST http://pebblesd/cluster/tokens)"
token="$(json_str "$minted" token)"
[ -n "$token" ] || { echo "FAIL: no token minted: $minted" >&2; exit 1; }

echo "==> booting the engine with the token"
case "$RUNTIME" in
  incus)
    launch_incus "$ENGINE" \
      -c environment.PEBBLES_ROLE=engine \
      -c "environment.PEBBLES_MAIN=https://$main_ip:7443" \
      -c "environment.PEBBLES_JOIN_TOKEN=$token" \
      -c environment.PEBBLES_ENGINE_NAME=worker-1
    ;;
  *)
    ctr run -d --name "$ENGINE" --network "$NET" \
      -v "$HOMES":/home -v "$LAKE":/var/lib/pebbles/lake \
      -e PEBBLES_ROLE=engine \
      -e PEBBLES_MAIN="https://$main_ip:7443" \
      -e PEBBLES_JOIN_TOKEN="$token" \
      -e PEBBLES_ENGINE_NAME=worker-1 "$IMAGE" >/dev/null
    ;;
esac

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
code="$(ctr_exec "$MAIN" curl -s -o /dev/null -w '%{http_code}' \
  -k "https://$main_ip:7443/cluster/register" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$token\",\"name\":\"evil\",\"address\":\"http://x:1\",\"resources\":{\"cpus\":1,\"memory_bytes\":1},\"existing_users\":[],\"lake_ok\":true}")"
[ "$code" = "401" ] || { echo "FAIL: reused token expected 401, got $code" >&2; exit 1; }

echo "==> maya is created on the main and replicated to the engine (REQ-11/14)"
pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"pebbles-demo-1"}' http://pebblesd/users >/dev/null
for _ in $(seq 1 30); do
  ctr_exec "$ENGINE" getent passwd maya >/dev/null 2>&1 && break
  sleep 1
done
ctr_exec "$ENGINE" getent passwd maya | grep -q ':70000:70000:' \
  || { echo "FAIL: maya not replicated to the engine" >&2; exit 1; }

echo "==> a session opened through the main runs ON the engine, as maya"
sess="$(pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","engine":"worker-1"}' http://pebblesd/sessions)"
echo "    $sess"
expect '"engine":"worker-1"' "session routed to the engine" "$sess"
sid="$(json_num "$sess" id)"
pid="$(json_num "$sess" pid)"
[ "$(ctr_exec "$ENGINE" sed -n 's/^Uid:[[:space:]]*\([0-9]*\).*/\1/p' "/proc/$pid/status")" = "70000" ] \
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
[ "$(ctr_exec "$MAIN" stat -c '%u' /home/maya/from-engine.txt)" = "70000" ] \
  || { echo "FAIL: file not visible/owned in the shared home on the MAIN" >&2; exit 1; }

echo "==> closing the proxied session"
pd -X DELETE "http://pebblesd/sessions/$sid" | grep -q 'closed' \
  || { echo "FAIL: close failed" >&2; exit 1; }

echo "==> M1.2: engine access is group-gated (REQ-07)"
pd -H 'Content-Type: application/json' -d '{"name":"analysts"}' http://pebblesd/groups >/dev/null
pd -H 'Content-Type: application/json' -d '{"access":"group:analysts"}' \
  http://pebblesd/engines/worker-1/access >/dev/null
denied_code="$(ctr_exec "$MAIN" curl -s -o /dev/null -w '%{http_code}' \
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
case "$RUNTIME" in
  incus)
    launch_incus "$ENGINE2" \
      -c environment.PEBBLES_ROLE=engine \
      -c "environment.PEBBLES_MAIN=https://$main_ip:7443" \
      -c environment.PEBBLES_ENGINE_NAME=worker-2
    ;;
  *)
    ctr run -d --name "$ENGINE2" --network "$NET" \
      -v "$HOMES":/home -v "$LAKE":/var/lib/pebbles/lake \
      -e PEBBLES_ROLE=engine \
      -e PEBBLES_MAIN="https://$main_ip:7443" \
      -e PEBBLES_ENGINE_NAME=worker-2 "$IMAGE" >/dev/null
    ;;
esac
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

echo "==> NFR-08: open a session, then the main host 'fails'"
# Close the group-gate session so the survivor below is the engine's only one.
pd -X DELETE "http://pebblesd/sessions/$(json_num "$allowed" id)" >/dev/null
surv="$(pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","engine":"worker-1"}' http://pebblesd/sessions)"
expect '"engine":"worker-1"' "survivor session routed to the engine" "$surv"
surv_pid="$(json_num "$surv" pid)"
pre="$(pd -H 'Content-Type: application/json' \
  -d '{"id":90,"op":"sql","sql":"SELECT 6*7 AS answer;"}' \
  "http://pebblesd/sessions/$(json_num "$surv" id)/exec")"
expect '"answer":42' "survivor answers before the failure" "$pre"

# The engine serves its sessions on its own cluster API (:7443), bearer-authed
# with the secret minted at registration — the very credential the main uses.
# It is sticky at /var/lib/pebbles/cluster/engine.json on the engine, so the
# smoke can speak to the engine exactly the way the main would; the engine-local
# session id differs from the main's proxied id, so match the session by pid.
secret="$(ctr_exec "$ENGINE" sed -n 's/.*"secret": *"\([^"]*\)".*/\1/p' \
  /var/lib/pebbles/cluster/engine.json)"
[ -n "$secret" ] || { echo "FAIL: engine has no sticky cluster secret" >&2; exit 1; }
eng() { ctr_exec "$ENGINE" curl -fsSk --http1.1 --max-time 30 -H "Authorization: Bearer $secret" "$@"; }
rid="$(eng https://127.0.0.1:7443/engine/sessions | grep -o '{[^}]*}' \
  | grep "\"pid\":$surv_pid" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
[ -n "$rid" ] || { echo "FAIL: survivor not listed on the engine's own API" >&2; exit 1; }

echo "==> stopping the main (graceful stop ≈ main-host failure to the engine)"
ctr stop "$MAIN" >/dev/null

echo "==> the existing session keeps running and still answers SQL"
ctr_exec "$ENGINE" sh -c "kill -0 $surv_pid" \
  || { echo "FAIL: survivor process died with the main (NFR-08)" >&2; exit 1; }
alive="$(eng -H 'Content-Type: application/json' \
  -d '{"id":91,"op":"sql","sql":"SELECT 6*7 AS answer;"}' \
  "https://127.0.0.1:7443/engine/sessions/$rid/exec")"
expect '"answer":42' "survivor answers with the main down (NFR-08)" "$alive"

echo "==> nothing new starts: without the main's credential the engine refuses"
# Session creation exists ONLY behind the cluster secret the main holds; with
# the main down, an unauthenticated request must fail cleanly (401).
# --http1.1 + tolerated exit: the TLS port negotiates h2 via ALPN, and curl can
# exit 92 on an abrupt h2 stream teardown AFTER receiving the status — the
# %{http_code} it already wrote is the whole assertion.
newcode="$(ctr_exec "$ENGINE" curl -sk --http1.1 -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' -d '{"username":"maya"}' \
  https://127.0.0.1:7443/engine/sessions || true)"
[ "$newcode" = "401" ] \
  || { echo "FAIL: engine must refuse unauthenticated session creation, got $newcode" >&2; exit 1; }

echo "==> the main returns; the engine is back in service without re-joining"
ctr start "$MAIN" >/dev/null
wait_main_healthy
# Registration is sticky on both sides (engines.json on the main, engine.json on
# the engine): recovery is the main's live /engine/state probe succeeding again.
back=""
for _ in $(seq 1 30); do
  back="$(pd http://pebblesd/engines 2>/dev/null || true)"
  # The survivor session is still open, so the engine truthfully reports
  # "in use" (sessions:1) — that IS recovery. "available" appears only if the
  # survivor happened to idle out. Either serving state proves NFR-08; what
  # must NOT appear is lost/stopped.
  grep -Eq '"name":"worker-1".*"state":"(available|in use)"' <<<"$back" && break
  sleep 2
done
expect '"name":"worker-1".*"state":"\(available\|in use\)"' "engine serving after the main returns" "$back"
ctr_exec "$ENGINE" sh -c "kill -0 $surv_pid" \
  || { echo "FAIL: survivor did not outlive the outage" >&2; exit 1; }
post="$(pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","engine":"worker-1"}' http://pebblesd/sessions)"
expect '"engine":"worker-1"' "new cross-engine session after recovery" "$post"
post_sql="$(pd -H 'Content-Type: application/json' \
  -d '{"id":92,"op":"sql","sql":"SELECT 6*7 AS answer;"}' \
  "http://pebblesd/sessions/$(json_num "$post" id)/exec")"
expect '"answer":42' "recovered main→engine path answers SQL end to end" "$post_sql"

echo "==> main+engine smoke OK ($RUNTIME)"
