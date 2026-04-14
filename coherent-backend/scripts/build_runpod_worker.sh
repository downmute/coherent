#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_REPO="${IMAGE_REPO:-${1:-}}"
IMAGE_TAG="${IMAGE_TAG:-${2:-}}"
IMAGE_PLATFORM="${IMAGE_PLATFORM:-linux/amd64}"

if [[ -z "${IMAGE_REPO}" || -z "${IMAGE_TAG}" ]]; then
  echo "Usage: $0 <image-repo> <image-tag>" >&2
  echo "Example: $0 downmute/coherent-backend-worker worker-v12" >&2
  exit 1
fi

IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"

echo "[build] Building ${IMAGE_REF} for ${IMAGE_PLATFORM}"
cd "${BACKEND_DIR}"
docker buildx build --platform "${IMAGE_PLATFORM}" --load -f Dockerfile.worker -t "${IMAGE_REF}" .
echo "[build] Built ${IMAGE_REF}"
