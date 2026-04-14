# Akash testing notes

## The two problems in your current command

1. `npx wrangler login` must be on its own line.
2. `POST /sessions` only succeeds when either:
   - a worker has already registered itself as `warm`, or
   - the control plane has provider provisioning configured.

For Akash testing, the easiest path is to run a pre-warmed worker and skip automatic provisioning at first.

## Fast path: pre-warmed Akash worker

You do not need to change the control plane code for this path.

Use these files as-is:

- `Dockerfile.worker`
- `scripts/bootstrap_soulx_worker.sh`
- `src/worker/server.ts`
- `src/worker/control-plane-client.ts`

The main thing to configure is worker environment.

Start from:

- `.env.akash.worker.example`

Important values to replace:

- `WORKER_KEY`
- `WORKER_PUBLIC_WS_URL`
- `CONTROL_PLANE_URL`
- `WORKER_TOKEN_SECRET`

The most important requirement is that `WORKER_TOKEN_SECRET` on the worker matches the
`WORKER_TOKEN_SECRET` configured on the deployed control plane.

The Cloudflare account/app/token secrets are primarily needed by the control plane when
it creates RTC credentials. They are not what blocks worker registration.

Recommended local smoke-test commands:

```bash
npx wrangler login

cd /Users/ryan/Documents/Coherent/coherent-backend
bash scripts/test_remote_bridge.sh \
  https://coherent-control-plane.abot011235.workers.dev \
  ./podcast_sichuan_16k.wav
```

That helper script creates a session and immediately runs the bridge test without relying on fragile shell exports.

## If you want the Akash worker itself to run locally first

Use the local smoke env instead of the deployed Akash env. The deployed Akash template
assumes a container with `/opt/soulx-venv/bin/python` and the checked-out SoulX repo.

```bash
cd /Users/ryan/Documents/Coherent/coherent-backend
set -a
source .env.akash.local-smoke.example
set +a
npm run start:worker
```

Then in a second terminal:

```bash
cd /Users/ryan/Documents/Coherent/coherent-backend
bash scripts/test_remote_bridge.sh \
  https://coherent-control-plane.abot011235.workers.dev \
  ./podcast_sichuan_16k.wav
```

For a real Akash deployment, use `.env.akash.worker.example` instead and put those env vars
into the Akash manifest or console.

## Files to edit for true Akash auto-provisioning

If you want `POST /sessions` to create Akash capacity on demand, that is the part that still needs code changes.

Edit these files:

- `src/control-plane/adapters/simplepod.ts`
- `src/control-plane/server.ts`
- `src/control-plane/services/scheduler-service.ts`
- `src/shared/config.ts`
- `src/cloudflare-control-plane/index.ts`
- `src/cloudflare-control-plane/wrangler.jsonc`

What to change:

- replace the `SimplePod` request format with the Akash API call you want to use
- rename or generalize the `SIMPLEPOD_*` env vars
- update the error messages that currently mention `SimplePod`
- keep returning a `providerInstanceId` so the scheduler can wait for the new worker to register

Until that adapter is changed, Akash works best as a pre-started worker pool.
