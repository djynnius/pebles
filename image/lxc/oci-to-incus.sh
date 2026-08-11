#!/usr/bin/env bash
# Convert the built Pebbles OCI image into an Incus system-container image
# (rootfs.tar.xz + metadata.tar.xz for `incus image import`). Runs in CI
# (image.yml) — LXC never gets its own build path, only this conversion.
#
# usage: oci-to-incus.sh <image-ref> <outdir> [arch] [version]
# requires: skopeo, umoci, xz
set -euo pipefail

IMAGE_REF="${1:?usage: oci-to-incus.sh <image-ref> <outdir> [arch] [version]}"
OUTDIR="${2:?missing outdir}"
ARCH="${3:-x86_64}"
VERSION="${4:-dev}"

# Unpacking preserves in-image file ownership (chown), which needs root; a system
# container image must also keep numeric uids/gids intact in the tarball.
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

WORK="$(mktemp -d)"
trap '$SUDO rm -rf "$WORK"' EXIT
mkdir -p "$OUTDIR"

echo "==> copying $IMAGE_REF to OCI layout"
skopeo copy "docker-daemon:${IMAGE_REF}" "oci:${WORK}/oci:pebbles"

echo "==> unpacking rootfs"
$SUDO umoci unpack --image "${WORK}/oci:pebbles" "${WORK}/bundle"

echo "==> packaging rootfs.tar.xz"
$SUDO tar -C "${WORK}/bundle/rootfs" --numeric-owner -cJf "${OUTDIR}/rootfs.tar.xz" .
[ -n "$SUDO" ] && $SUDO chown "$(id -u):$(id -g)" "${OUTDIR}/rootfs.tar.xz"

echo "==> packaging metadata.tar.xz"
sed -e "s/{{ARCH}}/${ARCH}/" \
    -e "s/{{EPOCH}}/$(date +%s)/" \
    -e "s/{{VERSION}}/${VERSION}/" \
    "$(dirname "$0")/metadata.yaml.tmpl" > "${WORK}/metadata.yaml"
tar -C "$WORK" -cJf "${OUTDIR}/metadata.tar.xz" metadata.yaml

cat <<EOF
==> done. Import with:
  incus image import ${OUTDIR}/metadata.tar.xz ${OUTDIR}/rootfs.tar.xz --alias pebbles/${VERSION}
  incus launch pebbles/${VERSION} pebbles-main -p pebbles-engine -c environment.PEBBLES_ROLE=main
EOF
