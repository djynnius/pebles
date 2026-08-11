#!/usr/bin/env bash
# The REQ-09 upgrade-path test: seed an OLD image, swap to a NEW image on the SAME
# volumes, and prove nothing was lost — accounts restored from the config volume,
# homes intact, the DuckLake catalog still answers, and (when the schema version
# moved) a pre-migration backup exists. The schema bump is forced here so the
# backup machinery is exercised on every run, not only when a release bumps it.
#
# usage: upgrade-path.sh <old-image> <new-image>   (docker only; runs in nightly.yml)
set -euo pipefail

OLD="${1:?usage: upgrade-path.sh <old-image> <new-image>}"
NEW="${2:?missing new image}"
CFG="pebbles-upg-cfg-$$"
HOMES="pebbles-upg-home-$$"
NAME="pebbles-upg-$$"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$CFG" "$HOMES" >/dev/null 2>&1 || true
}
trap cleanup EXIT

boot() {
  docker run -d --name "$NAME" \
    -v "$CFG":/var/lib/pebbles -v "$HOMES":/home \
    -e PEBBLES_ROLE=main "$1" >/dev/null
}
pd() { docker exec "$NAME" curl -fsS --unix-socket /run/pebbles/pebblesd.sock "$@"; }
wait_pd() {
  for _ in $(seq 1 60); do
    pd http://pebblesd/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FAIL: pebblesd never answered" >&2
  docker logs "$NAME" >&2 || true
  return 1
}

echo "==> boot OLD ($OLD) and seed data"
boot "$OLD"
wait_pd
pd -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"pebbles-demo-1"}' http://pebblesd/users >/dev/null
cat_ok=""
for _ in $(seq 1 30); do
  cat_ok="$(docker exec "$NAME" curl -s --unix-socket /run/pebbles/pebblesd.sock \
    -H 'Content-Type: application/json' \
    -d '{"name":"claims","owner":"maya"}' http://pebblesd/catalogs)"
  grep -q ducklake_claims <<<"$cat_ok" && break
  sleep 2
done
grep -q ducklake_claims <<<"$cat_ok" || { echo "FAIL: seeding catalog: $cat_ok" >&2; exit 1; }
sid="$(pd -H 'Content-Type: application/json' -d '{"username":"maya"}' http://pebblesd/sessions \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
pd -H 'Content-Type: application/json' \
  -d '{"id":1,"op":"sql","catalog":"claims","sql":"CREATE TABLE t AS SELECT * FROM (VALUES (1),(2)) v(x);"}' \
  "http://pebblesd/sessions/$sid/exec" | grep -q '"ok":true' \
  || { echo "FAIL: seeding table" >&2; exit 1; }

echo "==> force a schema bump so the backup machinery runs"
docker exec "$NAME" sh -c 'echo 0 > /var/lib/pebbles/schema-version'
docker rm -f "$NAME" >/dev/null

echo "==> boot NEW ($NEW) on the same volumes"
boot "$NEW"
wait_pd

echo "==> accounts restored from the config volume (REQ-11)"
restored=""
for _ in $(seq 1 30); do
  restored="$(docker exec "$NAME" getent passwd maya 2>/dev/null || true)"
  [ -n "$restored" ] && break
  sleep 1
done
grep -q ':70000:70000:' <<<"$restored" \
  || { echo "FAIL: maya not restored after upgrade: $restored" >&2; exit 1; }

echo "==> pre-migration backup exists and version is current (REQ-09)"
backup=""
for _ in $(seq 1 60); do # migration waits for postgres, then dumps
  backup="$(docker exec "$NAME" sh -c 'ls /var/lib/pebbles/backups/ 2>/dev/null' || true)"
  [ -n "$backup" ] && break
  sleep 2
done
grep -q 'pre-migration-v0-to-v' <<<"$backup" \
  || { echo "FAIL: no pre-migration backup found" >&2; exit 1; }
[ "$(docker exec "$NAME" cat /var/lib/pebbles/schema-version)" = "1" ] \
  || { echo "FAIL: schema version not stamped after migration" >&2; exit 1; }

echo "==> the lake still answers on the new image"
sid2="$(pd -H 'Content-Type: application/json' -d '{"username":"maya"}' http://pebblesd/sessions \
  | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
rows="$(docker exec "$NAME" curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d '{"id":2,"op":"sql","catalog":"claims","sql":"SELECT count(*) AS c FROM t;"}' \
  "http://pebblesd/sessions/$sid2/exec")"
grep -q '"c":2' <<<"$rows" \
  || { echo "FAIL: catalog data lost across upgrade: $rows" >&2; exit 1; }

echo "==> upgrade path OK ($OLD -> $NEW)"
