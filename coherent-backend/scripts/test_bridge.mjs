import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1];
};

const sessionId = getArg('--session-id', process.env.SESSION_ID);
const workerToken = getArg('--worker-token', process.env.WORKER_TOKEN);
const workerUrl = getArg('--worker-url', process.env.WORKER_URL ?? 'ws://127.0.0.1:8090/ws');
const audioPath = getArg('--audio-file', process.env.AUDIO_FILE ?? '/tmp/podcast.raw');
const sampleRate = Number(getArg('--sample-rate', process.env.SAMPLE_RATE ?? '16000'));
const channels = Number(getArg('--channels', process.env.CHANNELS ?? '1'));
const format = getArg('--format', process.env.PCM_FORMAT ?? 's16le');
const chunkBytes = Number(getArg('--chunk-bytes', process.env.CHUNK_BYTES ?? '32000'));
const chunkIntervalMs = Number(getArg('--chunk-interval-ms', process.env.CHUNK_INTERVAL_MS ?? '350'));
const maxChunks = Number(getArg('--max-chunks', process.env.MAX_CHUNKS ?? '6'));
const stopDelayMs = Number(getArg('--stop-delay-ms', process.env.STOP_DELAY_MS ?? '3000'));
const audioEndAckTimeoutMs = Number(
  getArg('--audio-end-ack-timeout-ms', process.env.AUDIO_END_ACK_TIMEOUT_MS ?? '60000'),
);

if (!sessionId || !workerToken) {
  console.error('Usage: node scripts/test_bridge.mjs --session-id <id> --worker-token <token> [--worker-url ws://host/ws] [--audio-file /tmp/podcast.raw]');
  process.exit(1);
}

let resolvedAudioPath = audioPath;
let tempRawPath = null;

if (path.extname(audioPath).toLowerCase() !== '.raw') {
  tempRawPath = path.join(os.tmpdir(), `coherent-bridge-${Date.now()}.raw`);
  const conversion = spawnSync(
    'ffmpeg',
    ['-y', '-i', audioPath, '-f', format, '-ac', String(channels), '-ar', String(sampleRate), tempRawPath],
    { stdio: 'inherit' },
  );
  if (conversion.status !== 0) {
    console.error(`Failed to convert ${audioPath} to raw ${format}.`);
    process.exit(conversion.status ?? 1);
  }
  resolvedAudioPath = tempRawPath;
}

const audio = fs.readFileSync(resolvedAudioPath);
const joiner = workerUrl.includes('?') ? '&' : '?';
const ws = new WebSocket(`${workerUrl}${joiner}token=${encodeURIComponent(workerToken)}`);
let started = false;
let finished = false;
let chunkCount = 0;
let chunkTimer = null;
let audioEndSent = false;
let audioEndAcked = false;
let audioEndAckTimeout = null;
let stopTimer = null;

const scheduleStop = () => {
  if (finished || stopTimer) {
    return;
  }

  stopTimer = setTimeout(() => {
    if (!finished) {
      finished = true;
      ws.send(JSON.stringify({ type: 'session.stop' }));
    }
  }, stopDelayMs);
};

const stopWithError = (message) => {
  console.error(message);
  if (chunkTimer) {
    clearInterval(chunkTimer);
  }
  if (audioEndAckTimeout) {
    clearTimeout(audioEndAckTimeout);
  }
  if (stopTimer) {
    clearTimeout(stopTimer);
  }
  if (tempRawPath) {
    fs.rmSync(tempRawPath, { force: true });
  }
  try {
    ws.close();
  } catch {}
  process.exit(1);
};

ws.addEventListener('open', () => {
  console.log(`ws open -> ${workerUrl}`);
  ws.send(JSON.stringify({ type: 'session.start', sessionId }));
});

ws.addEventListener('message', (event) => {
  console.log(`message: ${event.data.toString()}`);
  try {
    const payload = JSON.parse(event.data.toString());
    if (payload.type === 'session.ready' && !started) {
      started = true;
      chunkTimer = setInterval(() => {
        if (finished) {
          return;
        }

        const offset = chunkCount * chunkBytes;
        if (chunkCount >= maxChunks || offset >= audio.length) {
          clearInterval(chunkTimer);
          audioEndSent = true;
          ws.send(JSON.stringify({ type: 'audio.end' }));
          audioEndAckTimeout = setTimeout(() => {
            stopWithError(`Timed out waiting ${audioEndAckTimeoutMs}ms for audio.end flush ack.`);
          }, audioEndAckTimeoutMs);
          return;
        }

        const chunk = audio.subarray(offset, Math.min(offset + chunkBytes, audio.length));
        chunkCount += 1;
        ws.send(
          JSON.stringify({
            type: 'audio.append',
            sequence: chunkCount,
            pcmBase64: chunk.toString('base64'),
            sampleRate,
            channels,
            format,
          }),
        );
      }, chunkIntervalMs);
    }

    if (payload.type === 'session.stopped') {
      finished = true;
      if (audioEndAckTimeout) {
        clearTimeout(audioEndAckTimeout);
      }
      if (stopTimer) {
        clearTimeout(stopTimer);
      }
      if (chunkTimer) {
        clearInterval(chunkTimer);
      }
    }

    if (payload.type === 'heartbeat.ack' && audioEndSent && !audioEndAcked) {
      audioEndAcked = true;
      if (audioEndAckTimeout) {
        clearTimeout(audioEndAckTimeout);
      }
      scheduleStop();
    }
  } catch {}
});

ws.addEventListener('error', (event) => {
  stopWithError(`ws error: ${JSON.stringify(event)}`);
});

ws.addEventListener('close', () => {
  if (chunkTimer) {
    clearInterval(chunkTimer);
  }
  if (audioEndAckTimeout) {
    clearTimeout(audioEndAckTimeout);
  }
  if (stopTimer) {
    clearTimeout(stopTimer);
  }
  if (tempRawPath) {
    fs.rmSync(tempRawPath, { force: true });
  }
  console.log('ws closed');
  process.exit(0);
});
