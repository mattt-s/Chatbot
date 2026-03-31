#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-mybot:latest}"
REMOTE_HOST="${REMOTE_HOST:-192.168.2.215}"
REMOTE_USER="${REMOTE_USER:-siyushi}"
REMOTE_PORT="${REMOTE_PORT:-22}"
BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
OUT_DIR="${OUT_DIR:-./output/images}"
BUILDER_NAME="${BUILDER_NAME:-mybot-multiarch-builder}"

SAFE_IMAGE="${IMAGE_NAME//\//_}"
SAFE_IMAGE="${SAFE_IMAGE//:/_}"
AMD64_TAR="${OUT_DIR}/${SAFE_IMAGE}_linux_amd64.tar"
ARM64_TAR="${OUT_DIR}/${SAFE_IMAGE}_linux_arm64.tar"
REMOTE_TAR="/tmp/$(basename "${AMD64_TAR}")"

mkdir -p "${OUT_DIR}"

echo "[1/6] Checking docker buildx builder: ${BUILDER_NAME}"
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  docker buildx create --name "${BUILDER_NAME}" --use >/dev/null
else
  docker buildx use "${BUILDER_NAME}" >/dev/null
fi

docker buildx inspect --bootstrap >/dev/null

echo "[2/6] Building linux/amd64 image archive: ${AMD64_TAR}"
docker buildx build \
  --platform linux/amd64 \
  -t "${IMAGE_NAME}" \
  --output "type=docker,dest=${AMD64_TAR}" \
  "${BUILD_CONTEXT}"

echo "[3/6] Building linux/arm64 image archive: ${ARM64_TAR}"
docker buildx build \
  --platform linux/arm64 \
  -t "${IMAGE_NAME}" \
  --output "type=docker,dest=${ARM64_TAR}" \
  "${BUILD_CONTEXT}"

echo "[4/6] Loading amd64 image locally"
docker load -i "${AMD64_TAR}" >/dev/null

echo "[5/6] Copying amd64 archive to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_TAR}"
scp -P "${REMOTE_PORT}" "${AMD64_TAR}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_TAR}"

echo "[6/6] Loading image on remote host"
ssh -p "${REMOTE_PORT}" "${REMOTE_USER}@${REMOTE_HOST}" "docker load -i '${REMOTE_TAR}' && rm -f '${REMOTE_TAR}'"

echo "Done."
echo "- amd64 archive: ${AMD64_TAR}"
echo "- arm64 archive: ${ARM64_TAR}"
echo "- image tag: ${IMAGE_NAME}"
