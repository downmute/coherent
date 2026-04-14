#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-${1:-}}"
AUDIO_FILE="${AUDIO_FILE:-${2:-${BACKEND_DIR}/podcast_sichuan_16k.wav}}"
USER_ID="${USER_ID:-background-test}"
APP_VERSION="${APP_VERSION:-manual}"
AVATAR_ID="${AVATAR_ID:-default-female}"
SAMPLE_RATE="${SAMPLE_RATE:-16000}"
CHANNELS="${CHANNELS:-1}"
PCM_FORMAT="${PCM_FORMAT:-s16le}"
CHUNK_BYTES="${CHUNK_BYTES:-16000}"
CHUNK_INTERVAL_MS="${CHUNK_INTERVAL_MS:-700}"
MAX_CHUNKS="${MAX_CHUNKS:-3}"
STOP_DELAY_MS="${STOP_DELAY_MS:-12000}"

if [[ -z "${CONTROL_PLANE_URL}" ]]; then
  echo "Usage: $0 <control-plane-url> [audio-file]" >&2
  echo "Example: $0 https://coherent-control-plane.example.workers.dev" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for ${0##*/}" >&2
  exit 1
fi

TMP_BODY="$(mktemp)"
trap 'rm -f "${TMP_BODY}"' EXIT

HTTP_STATUS="$(
  curl -sS \
    -o "${TMP_BODY}" \
    -w "%{http_code}" \
    -X POST "${CONTROL_PLANE_URL%/}/sessions" \
    -H "content-type: application/json" \
    -d "{
      \"userId\": \"${USER_ID}\",
      \"appVersion\": \"${APP_VERSION}\",
      \"avatarConfig\": {
        \"avatarId\": \"${AVATAR_ID}\"
      }
    }"
)"

if [[ "${HTTP_STATUS}" -ge 400 ]]; then
  echo "Session creation failed with HTTP ${HTTP_STATUS}" >&2
  jq . "${TMP_BODY}" >&2 || cat "${TMP_BODY}" >&2
  echo >&2
  echo "Make sure a warm worker is already registered before testing." >&2
  echo "This script is for a pre-warmed remote worker, not on-demand provisioning." >&2
  exit 1
fi

SESSION_ID="$(jq -r '.sessionId' "${TMP_BODY}")"
WORKER_TOKEN="$(jq -r '.workerToken' "${TMP_BODY}")"
WORKER_URL="$(jq -r '.workerWsUrl' "${TMP_BODY}")"

if [[ -z "${SESSION_ID}" || "${SESSION_ID}" == "null" || -z "${WORKER_TOKEN}" || "${WORKER_TOKEN}" == "null" || -z "${WORKER_URL}" || "${WORKER_URL}" == "null" ]]; then
  echo "Session response was missing required fields:" >&2
  jq . "${TMP_BODY}" >&2 || cat "${TMP_BODY}" >&2
  exit 1
fi

echo "Assigned session ${SESSION_ID}"
echo "Worker URL: ${WORKER_URL}"

cd "${BACKEND_DIR}"
npm run test:bridge -- \
  --session-id "${SESSION_ID}" \
  --worker-token "${WORKER_TOKEN}" \
  --worker-url "${WORKER_URL}" \
  --audio-file "${AUDIO_FILE}" \
  --sample-rate "${SAMPLE_RATE}" \
  --channels "${CHANNELS}" \
  --format "${PCM_FORMAT}" \
  --chunk-bytes "${CHUNK_BYTES}" \
  --chunk-interval-ms "${CHUNK_INTERVAL_MS}" \
  --max-chunks "${MAX_CHUNKS}" \
  --stop-delay-ms "${STOP_DELAY_MS}"
