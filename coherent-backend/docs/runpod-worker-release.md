# Runpod worker release

## Goal

Cut a new worker image from the current repo so Runpod pods pick up:

- Runpod-aware public WebSocket URL resolution
- the current video fallback behavior
- provider value `runpod`
- the current worker/runtime code instead of the older `worker-v11` image

## Recommended next tag

Use:

```text
downmute/coherent-backend-worker:worker-v12
```

## Build

From:

- `/Users/ryan/Documents/Coherent/coherent-backend`

Run:

```bash
npm run docker:build:worker -- downmute/coherent-backend-worker worker-v12
```

This wraps:

```bash
docker build -f Dockerfile.worker -t downmute/coherent-backend-worker:worker-v12 .
```

## Push

```bash
npm run docker:push:worker -- downmute/coherent-backend-worker worker-v12
```

## Update the smoke pod first

After the image is pushed:

```bash
runpodctl pod update 1wvqs8tqxagxww --image downmute/coherent-backend-worker:worker-v12
runpodctl pod restart 1wvqs8tqxagxww
```

With the current repo code, the worker can derive the Runpod proxy host automatically,
so you should no longer need to hardcode `WORKER_PUBLIC_WS_URL` when the pod exposes
`8090/http`.

## Verify registration

```bash
cd /Users/ryan/Documents/Coherent/coherent-backend

npx wrangler d1 execute DB \
  --config src/cloudflare-control-plane/wrangler.jsonc \
  --remote \
  --command "SELECT worker_key, provider, status, active_sessions, max_sessions, public_ws_url, last_heartbeat_at FROM gpu_workers ORDER BY updated_at DESC LIMIT 10;"
```

You want the Runpod row to stay:

- `provider = runpod`
- `status = warm`
- `public_ws_url = wss://<pod-id>-8090.proxy.runpod.net/ws`

## If Docker is not running locally

Start Docker Desktop first, then rerun the build command.

Current local blocker observed on this machine:

- Docker CLI is installed
- Docker daemon is not running on either `desktop-linux` or `default`
