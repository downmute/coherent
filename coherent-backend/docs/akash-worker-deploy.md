# Akash worker deploy

This repo does not auto-launch Akash workers yet. The control plane only assigns
workers that have already registered themselves as `warm`.

That means the fastest path is:

1. build and push the worker image
2. deploy one pre-warmed worker on Akash
3. set `WORKER_PUBLIC_WS_URL` to a known custom domain or do a two-pass deploy
4. confirm the worker appears in `gpu_workers`
5. switch from mock mode to the real runtime only after registration works

## 1. Build and push the image

Example with Docker:

```bash
cd /Users/ryan/Documents/Coherent/coherent-backend
docker build -f Dockerfile.worker -t YOUR_REGISTRY/coherent-backend-worker:TAG .
docker push YOUR_REGISTRY/coherent-backend-worker:TAG
```

Use a registry Akash can pull from, such as Docker Hub or GHCR.

## 2. First deploy in mock mode

Start with the SDL template:

- `deploy/akash-worker.sdl.yaml`

It intentionally uses:

- `SOULX_RUNTIME_MODE=mock`
- `WORKER_RTC_PUBLISHER=mock`

This avoids the Python bridge and Chrome path while proving that:

- the container starts
- the worker can reach the Cloudflare control plane
- the worker registers and heartbeats correctly
- the public WebSocket URL is correct

Only switch to the real runtime after you see a `warm` Akash worker in D1.

## 3. How to identify the WebSocket URL

There are two ways to know `WORKER_PUBLIC_WS_URL`:

1. Best: use a custom domain you already control
2. Fallback: do a two-pass deploy with the provider-generated Akash URL

### Option A: custom domain

If you map a custom domain to the Akash service, set:

- `WORKER_PUBLIC_WS_URL=wss://YOUR_CUSTOM_DOMAIN/ws`

before deployment.

### Option B: two-pass deploy

On the first deploy, use a temporary placeholder value for `WORKER_PUBLIC_WS_URL`.
After the deployment is live, open the deployment in Akash Console and look for the
public **URL** shown for the service. Then redeploy with that host in
`WORKER_PUBLIC_WS_URL`.

Example:

- Console URL: `https://abc123.provider-domain.example`
- Final worker WebSocket URL: `wss://abc123.provider-domain.example/ws`

Also verify:

- `https://abc123.provider-domain.example/health`

should return the worker health payload.

This works because the worker exposes HTTP on port `8090` and the SDL maps it as
public web traffic using:

```yaml
expose:
  - port: 8090
    as: 80
    to:
      - global: true
```

Inference: because the worker service is exposed as public HTTP traffic on port `80`,
the browser-facing WebSocket URL should be the same host with `wss://` and the `/ws`
path.

## 4. Values to update before deploy

In `deploy/akash-worker.sdl.yaml`, replace:

- `YOUR_REGISTRY/coherent-backend-worker:TAG`
- `WORKER_PUBLIC_WS_URL`
- `WORKER_TOKEN_SECRET`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_REALTIME_APP_ID`
- `CLOUDFLARE_API_TOKEN`

Keep:

- `CONTROL_PLANE_URL=https://coherent-control-plane.abot011235.workers.dev`
- `WORKER_PROVIDER=akash`

## 5. Confirm registration

After the Akash worker starts, run:

```bash
cd /Users/ryan/Documents/Coherent/coherent-backend

npx wrangler d1 execute DB \
  --config src/cloudflare-control-plane/wrangler.jsonc \
  --remote \
  --command "SELECT worker_key, provider, status, active_sessions, max_sessions, public_ws_url, last_heartbeat_at FROM gpu_workers ORDER BY updated_at DESC;"
```

You want to see:

- `worker_key = akash-worker-1` or your chosen key
- `provider = akash`
- `status = warm`
- `public_ws_url = wss://.../ws`

## 6. Switch from mock mode to the real runtime

Once registration works, change:

- `WORKER_RTC_PUBLISHER=browser`
- `SOULX_RUNTIME_MODE=python_bridge`

and add the remaining SoulX env vars from:

- `.env.akash.worker.example`

Do that second. If you start with the full runtime and it crashes during prewarm,
the worker never reaches the registration step.
