# Runpod worker deploy

## Public WebSocket URL

For Runpod, you do not need to hardcode `WORKER_PUBLIC_WS_URL` in the common case.
On `worker-v12+`, you also do not need to hardcode `WORKER_KEY` or
`WORKER_PROVIDER_INSTANCE_ID` in the common case.

The worker now resolves its public URL in this order:

1. `WORKER_PUBLIC_WS_URL`
2. `WORKER_PUBLIC_BASE_URL`
3. Runpod HTTP proxy URL from `RUNPOD_POD_ID`
4. Runpod direct TCP URL from `RUNPOD_PUBLIC_IP` and `RUNPOD_TCP_PORT_*`
5. local fallback `ws://127.0.0.1:<WORKER_PORT>/ws`

The worker identity now resolves in this order:

1. `WORKER_KEY`
2. Runpod worker key from `RUNPOD_POD_ID` as `runpod-<pod-id>`
3. local fallback `worker-local-1`

The provider instance ID resolves in this order:

1. `WORKER_PROVIDER_INSTANCE_ID`
2. `RUNPOD_POD_ID`
3. empty

Code:

- `src/worker/public-url.ts`
- `src/worker/server.ts`

## Recommended Runpod setup

Expose the worker port as an HTTP port in Runpod.
Leave `WORKER_PUBLIC_WS_URL`, `WORKER_KEY`, and `WORKER_PROVIDER_INSTANCE_ID`
blank in the template if you want the pod to self-identify at runtime.

If you provision pods through the control plane instead of the Runpod UI, you can
now pass a CUDA host constraint with:

```dotenv
SIMPLEPOD_ALLOWED_CUDA_VERSIONS=12.8
```

That value is forwarded as `allowedCudaVersions` in the provider create request.
Use a comma-separated list like `12.8,12.6` if you want multiple acceptable host
driver targets.

## Control-plane provisioning env

The control plane can now provision Runpod directly without going through the
older SimplePod-shaped adapter. Configure these env vars on the control plane:

```dotenv
RUNPOD_API_BASE_URL=https://rest.runpod.io/v1
RUNPOD_TEMPLATE_ID=e3j3ft3qbz
RUNPOD_GPU_TYPE_IDS=NVIDIA GeForce RTX 4090
RUNPOD_CLOUD_TYPE=SECURE
RUNPOD_ALLOWED_CUDA_VERSIONS=12.8
RUNPOD_DATA_CENTER_IDS=
RUNPOD_COUNTRY_CODES=
RUNPOD_NAME_PREFIX=coherent-worker
```

And set `RUNPOD_API_KEY` as a secret in the deployed control plane environment.

When `RUNPOD_API_KEY` and `RUNPOD_TEMPLATE_ID` are present, the control plane
prefers the direct Runpod provisioning path over the legacy SimplePod-shaped
request.

If the worker listens on `8090`, the worker can derive:

```text
wss://<RUNPOD_POD_ID>-8090.proxy.runpod.net/ws
```

This is based on Runpod's documented web proxy format:

```text
https://[pod-id]-[port].proxy.runpod.net
```

Inference: because the worker WebSocket endpoint is served by the same HTTP service,
the matching WebSocket URL is the same host with `wss://` and the `/ws` path.

## When to use explicit values anyway

Set `WORKER_PUBLIC_BASE_URL` when:

- you use a custom domain
- you put Cloudflare or another proxy in front of Runpod
- you want stable public URLs across pod replacement

Example:

```dotenv
WORKER_PUBLIC_BASE_URL=https://avatar-worker.example.com
```

The worker will register:

```text
wss://avatar-worker.example.com/ws
```

## Direct TCP fallback

If you expose a TCP port instead of HTTP, the worker can fall back to:

```text
ws://<RUNPOD_PUBLIC_IP>:<mapped-port>/ws
```

That is useful for debugging, but it is a weaker long-term choice than HTTP proxy
or a custom domain because the public IP or mapped port can change when the pod resets.

## Example env

Start from:

- `.env.runpod.worker.example`

For a first registration test, use:

```dotenv
SOULX_RUNTIME_MODE=mock
WORKER_RTC_PUBLISHER=mock
```

That gets the pod registering before you add the full Python bridge and browser RTC path.
