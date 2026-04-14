#!/usr/bin/env bash
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-${1:-}}"
IMAGE_TAG="${IMAGE_TAG:-${2:-}}"

if [[ -z "${IMAGE_REPO}" || -z "${IMAGE_TAG}" ]]; then
  echo "Usage: $0 <image-repo> <image-tag>" >&2
  echo "Example: $0 downmute/coherent-backend-worker worker-v12" >&2
  exit 1
fi

IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"

echo "[push] Pushing ${IMAGE_REF}"
docker push "${IMAGE_REF}"
echo "[push] Pushed ${IMAGE_REF}"
