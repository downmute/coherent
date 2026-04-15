# coherent-backend

Standalone backend project for the SoulX talking-head control plane and GPU worker runtime.

## What is implemented

- `control-plane`
  - `POST /sessions`
  - `GET /sessions/:id`
  - `POST /sessions/:id/end`
  - worker registration and heartbeat endpoints
  - Postgres-backed worker/session scheduling
- `worker`
  - WebSocket endpoint for `session.start`, `audio.append`, `audio.end`, `heartbeat`, `session.stop`
  - mock SoulX runtime and mock RTC publisher boundaries
- `db`
  - SQL migration for `gpu_workers`, `sessions`, and `session_events`
- provider/RTC adapters
  - `SimplePodAdapter` for provisioning requests
  - `RtcCredentialService` for Cloudflare RealtimeKit meeting + participant credentials

The current implementation is production-shaped but intentionally leaves the vendor-specific media publishing and SoulX inference internals behind clean interfaces. That keeps the routing, auth, DB state, and worker lifecycle real while making the GPU/runtime integration the only remaining specialized work.

## Layout

```text
coherent-backend/
  src/
    cloudflare-control-plane/
    control-plane/
    worker/
    shared/
  tests/
  src/db/migrations/
```

## Local development

1. Create a Postgres database.
2. Copy `.env.example` to `.env`.
3. Install dependencies:

```bash
npm install
```

4. Start the control plane:

```bash
npm run dev:control
```

5. Start a local worker in a second terminal:

```bash
npm run dev:worker
```

The worker registers itself with the control plane. Once both are up, `POST /sessions` will return a session assignment and a worker WebSocket token.

## Cloudflare Workers control plane

If you want to move the control plane to Cloudflare now, use the Workers-native package under [src/cloudflare-control-plane](/Users/ryan/Documents/Coherent/coherent-backend/src/cloudflare-control-plane).

It keeps the same external API shape as the Node control plane:

- `GET /health`
- `POST /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/end`
- `POST /internal/workers/register`
- `POST /internal/workers/heartbeat`
- `POST /internal/workers/:workerKey/unhealthy`
- `POST /internal/sessions/:sessionId/activity`

What changes:

- Postgres is replaced with `Cloudflare D1`
- the control plane runs as a `Cloudflare Worker`
- the GPU worker stays a normal long-running Node service

Quick setup:

1. Create a D1 database:

```bash
npx wrangler d1 create coherent-control-plane
```

2. Copy the returned `database_id` into [wrangler.jsonc](/Users/ryan/Documents/Coherent/coherent-backend/src/cloudflare-control-plane/wrangler.jsonc).

3. Apply the schema:

```bash
npx wrangler d1 execute coherent-control-plane --file src/cloudflare-control-plane/schema.sql
```

4. Set secrets:

```bash
npx wrangler secret put WORKER_TOKEN_SECRET
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_REALTIME_APP_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

5. Run locally:

```bash
npm run dev:cf-control
```

6. Deploy:

```bash
npm run deploy:cf-control
```

This is the recommended control-plane path if you want to stay inside Cloudflare for now while keeping the GPU worker on SimplePod.

## Control plane API

### `POST /sessions`

Request body:

```json
{
  "userId": "user-123",
  "appVersion": "0.1.0",
  "avatarConfig": {
    "avatarId": "default-female"
  }
}
```

Response body:

```json
{
  "sessionId": "uuid",
  "workerWsUrl": "ws://127.0.0.1:8090/ws",
  "workerToken": "signed-token",
  "rtcCredentials": {
    "provider": "mock",
    "roomId": "session-uuid",
    "role": "subscriber",
    "token": "mock-token",
    "endpoint": "https://rtc.example.com",
    "appId": null,
    "meetingId": null,
    "participantId": null,
    "presetName": null
  },
  "status": "assigned"
}
```

### Worker WebSocket flow

1. Connect to `workerWsUrl?token=...` or send the token as `workerToken` in your first `session.start`.
2. Send:

```json
{ "type": "session.start", "sessionId": "uuid" }
```

3. Stream PocketTTS PCM:

```json
{
  "type": "audio.append",
  "sequence": 1,
  "pcmBase64": "....",
  "sampleRate": 24000,
  "channels": 1,
  "format": "f32le"
}
```

4. End the stream:

```json
{ "type": "audio.end" }
```

5. Stop the session:

```json
{ "type": "session.stop" }
```

## Cloudflare RealtimeKit configuration

Set the following env vars when you want real RTC credentials instead of mock ones:

- `RTC_PROVIDER=cloudflare`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_REALTIME_APP_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_SUBSCRIBER_PRESET`
- `CLOUDFLARE_PUBLISHER_PRESET`

With those values present, the control plane will:

1. create a Cloudflare meeting
2. add a subscriber participant for the app
3. add a publisher participant for the GPU worker
4. return the participant token to each side

## Worker-side RTC publishing

The worker now has a real browser-based RTC publishing boundary:

- it launches headless Chromium
- loads the official `@cloudflare/realtimekit` web SDK bundle from local `node_modules`
- joins the meeting with the publisher participant token
- publishes a real audio track from incoming PCM chunks
- publishes a real video track from a canvas placeholder stream

This means the RTC side is no longer a mock transport boundary. The remaining placeholder is the actual SoulX frame generation, which should eventually replace the canvas placeholder video updates.

## Docker/bootstrap review

The worker bootstrap now supports two modes:

- `SOULX_START_MODE=service`
  - installs Python + Torch + optional SoulX dependencies
  - starts the integrated backend worker service
  - this is the right mode for production because it keeps the WebSocket protocol, worker lifecycle, and RTC publishing inside one process boundary

- `SOULX_START_MODE=repo-infer`
  - clones the official SoulX repo if `SOULX_REPO_URL` is set
  - optionally checks out `SOULX_REPO_REF`
  - installs `requirements.txt`
  - optionally downloads model weights with `huggingface-cli`
  - runs either:
    - `SOULX_INFERENCE_COMMAND`, or
    - `SOULX_INFERENCE_SCRIPT` such as `inference_script_single_gpu_lite.sh`

This makes it easy to validate the official repo on SimplePod without rewriting anything first.

## What still needs vendor integration

- Replace `MockSoulxRuntime` with the real SoulX runtime.
- Adjust `SimplePodAdapter` request mapping once your exact SimplePod template contract is finalized.

Those changes are isolated to:

- `src/worker/soulx-runtime.ts`
- `src/control-plane/adapters/simplepod.ts`

## GPU worker Docker bootstrap

The backend now also includes:

- [Dockerfile.worker](/Users/ryan/Documents/Coherent/coherent-backend/Dockerfile.worker)
- [bootstrap_soulx_worker.sh](/Users/ryan/Documents/Coherent/coherent-backend/scripts/bootstrap_soulx_worker.sh)

These are intended for a CUDA/PyTorch SimplePod-style worker image and install:

- Node.js
- Python + venv
- ffmpeg and build tools
- Google Chrome for the headless RTC publisher
- the backend worker dependencies
- optional SoulX Python dependencies from a checked-out SoulX repo

The validation path is now aligned more closely with the official SoulX quickstart:

- `torch==2.7.1`
- `torchvision==0.22.1`
- `flash_attn==2.8.0.post2 --no-build-isolation`
- `sageattention==2.2.0 --no-build-isolation` when enabled
- `ffmpeg` from `apt`
- a CUDA `devel` base image so CUDA extension builds are more likely to succeed

Recommended SimplePod validation path:

1. Build from [Dockerfile.worker](/Users/ryan/Documents/Coherent/coherent-backend/Dockerfile.worker)
2. Set:
   - `SOULX_REPO_URL` to the official SoulX repo URL
   - `SOULX_REPO_REF` to the tag or branch you want to pin
   - `SOULX_START_MODE=repo-infer`
   - `SOULX_MODEL_ID=Soul-AILab/SoulX-FlashHead-1_3B`
   - `SOULX_WAV2VEC_MODEL_ID=facebook/wav2vec2-base-960h`
   - `SOULX_INFERENCE_COMMAND` to the exact repo command you want to validate
3. Start the container and confirm the official repo runs on your chosen GPU image

If you provision those workers through the control plane, you can also constrain
host placement by CUDA driver compatibility with:

```dotenv
SIMPLEPOD_ALLOWED_CUDA_VERSIONS=12.8
```

The control plane forwards that as `allowedCudaVersions` in the provider create
request, which is useful on Runpod when you want to keep a `cu128`-tuned image.

For the direct Runpod control-plane path, configure:

```dotenv
RUNPOD_API_BASE_URL=https://rest.runpod.io/v1
RUNPOD_TEMPLATE_ID=e3j3ft3qbz
RUNPOD_GPU_TYPE_IDS=NVIDIA GeForce RTX 4090
RUNPOD_CLOUD_TYPE=SECURE
RUNPOD_ALLOWED_CUDA_VERSIONS=12.8
RUNPOD_NAME_PREFIX=coherent-worker
```

and set `RUNPOD_API_KEY` as a secret on the deployed control plane.

Example SimplePod env block for validating the official `generate_video.py` flow:

```dotenv
SOULX_REPO_URL=https://github.com/Soul-AILab/SoulX-FlashHead.git
SOULX_REPO_REF=main
SOULX_START_MODE=repo-infer
TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
TORCH_VERSION=2.7.1
TORCHVISION_VERSION=0.22.1
FLASH_ATTN_VERSION=2.8.0.post2
SAGEATTENTION_VERSION=2.2.0
INSTALL_FLASH_ATTN=true
INSTALL_SAGEATTENTION=false
SKIP_SOULX_NCCL_PIN=true
SOULX_MODEL_ID=Soul-AILab/SoulX-FlashHead-1_3B
SOULX_MODEL_EXCLUDE_PATTERNS=Model_Pro/*
SOULX_WAV2VEC_MODEL_ID=facebook/wav2vec2-base-960h
SOULX_INFERENCE_COMMAND=CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-0} python generate_video.py --ckpt_dir models/SoulX-FlashHead-1_3B --wav2vec_dir models/wav2vec2-base-960h --model_type lite --cond_image examples/girl.png --audio_path examples/podcast_sichuan_16k.wav --audio_encode_mode stream
```

With that configuration, the bootstrap will:

1. clone the repo into `SOULX_DIR`
2. install Torch and the repo's Python dependencies
3. download the FlashHead checkpoint into `models/SoulX-FlashHead-1_3B` while excluding `Model_Pro/*` by default
4. download wav2vec into `models/wav2vec2-base-960h`
5. run the exact official `generate_video.py` command

Unlike the earlier version of the bootstrap, the current setup does not silently ignore `flash_attn` or `sageattention` installation failures. That makes the container behavior much closer to the official instructions and easier to debug when a GPU image is missing the right CUDA toolchain.

The official `requirements.txt` currently pins `nvidia-nccl-cu12==2.27.3`, which conflicts with the `torch==2.7.1` quickstart on Linux x86. For single-GPU SimplePod validation, the bootstrap now strips that NCCL pin by default with `SKIP_SOULX_NCCL_PIN=true`.

The official script produces a final `.mp4` that already contains the input audio. In `generate_video.py`, `save_video()` first writes the generated frames to a temporary MP4 and then runs:

```bash
ffmpeg -i temp_video.mp4 -i input_audio.wav -c:v copy -c:a aac -shortest output.mp4
```

That means the file output is muxed video plus audio. For your product, that is still a batch file-generation pipeline rather than the live RTC pipeline, but it does confirm the repo's default output artifact includes synced audio.

## Face Selection

The worker can now automatically choose a condition image from backend-local face folders:

- `/app/faces/male`
- `/app/faces/female`

Selection rules:

- if `avatarConfig.avatarId` matches a filename stem like `male1` or `female2`, that exact image is used
- if `avatarConfig.gender` is `male` or `female`, the worker picks a deterministic image from that folder
- `default-male` and `default-female` map to the corresponding face folder
- if no match is found, the worker falls back to `SOULX_COND_IMAGE`

The backend image now includes copies of the current root face assets under [faces](/Users/ryan/Documents/Coherent/coherent-backend/faces), and the worker uses `SOULX_FACES_DIR=/app/faces` by default.

Recommended production path after validation:

1. Keep the same base image
2. Switch to `SOULX_START_MODE=service`
3. Replace the placeholder frame generation in [soulx-runtime.ts](/Users/ryan/Documents/Coherent/coherent-backend/src/worker/soulx-runtime.ts)
4. Use the official repo code or imported Python modules from the repo as the underlying inference engine
