#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POD_ID="${1:-}"

echo "== Runpod pods =="
runpodctl pod list -a
echo

if [[ -n "${POD_ID}" ]]; then
  echo "== Pod details: ${POD_ID} =="
  runpodctl pod get "${POD_ID}"
  echo

  echo "== Pod health: ${POD_ID} =="
  curl -L --max-time 10 -i "https://${POD_ID}-8090.proxy.runpod.net/health" || true
  echo
fi

echo "== Registered workers (D1) =="
cd "${BACKEND_DIR}"
npx wrangler d1 execute coherent-control-plane \
  --remote \
  --command "SELECT worker_key, provider, status, active_sessions, max_sessions, public_ws_url, last_heartbeat_at FROM gpu_workers ORDER BY updated_at DESC LIMIT 10;" \
  --json
