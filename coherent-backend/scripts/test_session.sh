#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${CONTROL_PLANE_URL:-}}"

if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: $0 <control-plane-base-url>" >&2
  echo "Example: $0 https://coherent-control-plane.<your-subdomain>.workers.dev" >&2
  exit 1
fi

TMP_BODY="$(mktemp)"
HTTP_STATUS="$(
  curl -sS \
    -o "${TMP_BODY}" \
    -w "%{http_code}" \
    -X POST "${BASE_URL%/}/sessions" \
    -H "content-type: application/json" \
    -d '{
      "userId": "manual-test-user",
      "appVersion": "manual-test",
      "avatarConfig": {
        "avatarId": "default-female"
      }
    }'
)"

echo "HTTP ${HTTP_STATUS}"
if command -v jq >/dev/null 2>&1; then
  jq . "${TMP_BODY}" || cat "${TMP_BODY}"
else
  cat "${TMP_BODY}"
fi
echo

if [[ "${HTTP_STATUS}" -ge 400 ]]; then
  echo
  echo "Session creation failed." >&2
  echo "Make sure either:" >&2
  echo "1. a warm worker has already registered with the control plane, or" >&2
  echo "2. SimplePod provisioning is configured in the control plane." >&2
  exit 1
fi
