#!/usr/bin/env bash
# Image size budget gate (implementation plan §6). Fails the build when the image
# exceeds the active budget in image/budgets.json. Raising a budget must happen in the
# same PR as the change that needs it.
#
# v0 checks the UNCOMPRESSED size of a locally-loaded image; the compressed
# (registry) size check lands with the push path in M0.2.
#
# usage: size-gate.sh <image-ref>   (requires jq; RUNTIME=docker|podman)
set -euo pipefail

IMAGE="${1:?usage: size-gate.sh <image-ref>}"
RUNTIME="${RUNTIME:-docker}"
BUDGETS="$(dirname "$0")/../../image/budgets.json"

active="$(jq -r '.active' "$BUDGETS")"
budget="$(jq -r ".[\"$active\"].uncompressed_max_bytes" "$BUDGETS")"
size="$("$RUNTIME" image inspect --format '{{.Size}}' "$IMAGE")"

human() { awk -v b="$1" 'BEGIN { printf "%.2f GB", b / 1073741824 }'; }
echo "image: $IMAGE — $(human "$size") uncompressed (budget '$active': $(human "$budget"))"

if [ "$size" -gt "$budget" ]; then
  echo "FAIL: image exceeds the '$active' size budget. If this growth is intentional," >&2
  echo "raise image/budgets.json in THIS change so reviewers see it." >&2
  exit 1
fi
echo "size gate OK"
