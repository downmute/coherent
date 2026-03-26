import { createRequire } from 'node:module';
import type { RtcCredentials } from '../shared/types.js';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { WorkerConfig } from '../shared/config.js';
import type { PcmFormat } from '../shared/types.js';

const require = createRequire(import.meta.url);
const realtimeKitBrowserBundlePath = require.resolve('@cloudflare/realtimekit/inlined');

export interface PublishMetrics {
  totalAudioBytes: number;
  estimatedFrames: number;
}

export interface RtcPublisher {
  join(): Promise<void>;
  publishAudioChunk(
    data: Buffer,
    options: { sampleRate: number; channels: number; format: PcmFormat },
  ): Promise<void>;
  publishEncodedFrames(frameDataUrls: string[]): Promise<void>;
  publishFrameBatch(count: number): Promise<void>;
  close(): Promise<void>;
  getMetrics(): PublishMetrics;
}

interface PublisherOptions {
  mode: WorkerConfig['WORKER_RTC_PUBLISHER'];
  browserExecutablePath: string;
  headless: boolean;
  width: number;
  height: number;
  fps: number;
}

class MockRtcPublisher implements RtcPublisher {
  private totalAudioBytes = 0;
  private estimatedFrames = 0;

  constructor(private readonly credentials: RtcCredentials) {}

  async join(): Promise<void> {
    console.log(
      `[worker] joined mock RTC room=${this.credentials.roomId} role=${this.credentials.role}`,
    );
  }

  async publishAudioChunk(data: Buffer): Promise<void> {
    this.totalAudioBytes += data.length;
  }

  async publishEncodedFrames(frameDataUrls: string[]): Promise<void> {
    this.estimatedFrames += frameDataUrls.length;
  }

  async publishFrameBatch(count: number): Promise<void> {
    this.estimatedFrames += count;
  }

  async close(): Promise<void> {
    console.log(`[worker] closed RTC publisher room=${this.credentials.roomId}`);
  }

  getMetrics(): PublishMetrics {
    return {
      totalAudioBytes: this.totalAudioBytes,
      estimatedFrames: this.estimatedFrames,
    };
  }
}

class BrowserRtcPublisher implements RtcPublisher {
  private totalAudioBytes = 0;
  private estimatedFrames = 0;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(
    private readonly credentials: RtcCredentials,
    private readonly options: PublisherOptions,
  ) {}

  async join(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.options.headless,
      executablePath: this.options.browserExecutablePath || undefined,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    this.page = await this.browser.newPage({
      viewport: {
        width: this.options.width,
        height: this.options.height,
      },
    });

    this.page.on('console', (message) => {
      console.log(`[rtc-browser] ${message.type()}: ${message.text()}`);
    });

    await this.page.setContent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            html, body {
              margin: 0;
              width: 100%;
              height: 100%;
              background: #08111f;
              overflow: hidden;
            }
            canvas {
              display: block;
              width: 100%;
              height: 100%;
              background: radial-gradient(circle at top, #19304f 0%, #08111f 65%);
            }
          </style>
        </head>
        <body>
          <canvas id="stage" width="${this.options.width}" height="${this.options.height}"></canvas>
        </body>
      </html>
    `);

    await this.page.addScriptTag({ path: realtimeKitBrowserBundlePath });
    await this.page.evaluate(
      async ({ token, fps }) => {
        const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
        if (!canvas) {
          throw new Error('Publisher canvas was not created.');
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('2D canvas context is unavailable.');
        }

        const sdk = (globalThis as Record<string, unknown>).RealtimeKitClient as
          | { init: (input: { authToken: string; defaults: { audio: boolean; video: boolean } }) => Promise<any> }
          | undefined;
        if (!sdk?.init) {
          throw new Error('RealtimeKit browser bundle did not expose RealtimeKitClient.init.');
        }

        const captureStream = canvas.captureStream(fps);
        const videoTrack = captureStream.getVideoTracks()[0];
        const audioContext = new AudioContext({ latencyHint: 'interactive' });
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const audioTrack = destination.stream.getAudioTracks()[0];

        const drawFrame = (mouth: number, tick: number) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#08111f';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#133255';
          ctx.beginPath();
          ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.24, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ecf4ff';
          ctx.beginPath();
          ctx.arc(canvas.width / 2 - 58, canvas.height / 2 - 30, 18, 0, Math.PI * 2);
          ctx.arc(canvas.width / 2 + 58, canvas.height / 2 - 30, 18, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#0b1625';
          ctx.beginPath();
          ctx.arc(canvas.width / 2 - 58, canvas.height / 2 - 30, 7, 0, Math.PI * 2);
          ctx.arc(canvas.width / 2 + 58, canvas.height / 2 - 30, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ecf4ff';
          ctx.lineWidth = 12;
          ctx.beginPath();
          ctx.moveTo(canvas.width / 2 - 70, canvas.height / 2 + 76);
          ctx.quadraticCurveTo(
            canvas.width / 2,
            canvas.height / 2 + 76 + Math.max(12, mouth),
            canvas.width / 2 + 70,
            canvas.height / 2 + 76,
          );
          ctx.stroke();
          ctx.fillStyle = '#7cc7ff';
          ctx.font = '18px sans-serif';
          ctx.fillText('Coherent GPU Publisher', 24, 36);
          ctx.fillText(`tick ${tick}`, 24, 62);
        };

        drawFrame(12, 0);

        const meeting = await sdk.init({
          authToken: token,
          defaults: {
            audio: false,
            video: false,
          },
        });

        await meeting.self.enableAudio(audioTrack);
        await meeting.self.enableVideo(videoTrack);
        await meeting.join();

        let nextAudioTime = audioContext.currentTime + 0.05;
        let tick = 0;
        const frameQueue: string[] = [];
        const maxQueuedFrames = Math.max(8, fps * 2);
        let framePumpStarted = false;

        const drawEncodedFrame = (dataUrl: string) => {
          const image = new Image();
          image.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          };
          image.src = dataUrl;
        };

        const ensureFramePump = () => {
          if (framePumpStarted) {
            return;
          }
          framePumpStarted = true;
          const pump = () => {
            if (frameQueue.length > 0) {
              const nextFrame = frameQueue.shift();
              if (nextFrame) {
                drawEncodedFrame(nextFrame);
              }
            }
            requestAnimationFrame(pump);
          };
          requestAnimationFrame(pump);
        };

        (globalThis as Record<string, unknown>).__rtcPublisher = {
          async pushPcmBase64(base64: string, sampleRate: number, channels: number, format: string) {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }

            let frameCount = 0;
            if (format === 'f32le') {
              frameCount = Math.floor(bytes.byteLength / 4 / channels);
            } else {
              frameCount = Math.floor(bytes.byteLength / 2 / channels);
            }

            const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRate);
            const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let channel = 0; channel < channels; channel += 1) {
              const channelData = audioBuffer.getChannelData(channel);
              for (let frame = 0; frame < frameCount; frame += 1) {
                const sampleIndex = frame * channels + channel;
                if (format === 'f32le') {
                  channelData[frame] = dataView.getFloat32(sampleIndex * 4, true);
                } else {
                  channelData[frame] = dataView.getInt16(sampleIndex * 2, true) / 32768;
                }
              }
            }

            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(destination);
            const startAt = Math.max(nextAudioTime, audioContext.currentTime + 0.01);
            source.start(startAt);
            nextAudioTime = startAt + audioBuffer.duration;

            let rms = 0;
            const firstChannel = audioBuffer.getChannelData(0);
            for (let index = 0; index < firstChannel.length; index += 1) {
              rms += firstChannel[index]! * firstChannel[index]!;
            }
            rms = Math.sqrt(rms / Math.max(1, firstChannel.length));
            tick += 1;
            drawFrame(24 + rms * 160, tick);
          },
          pushEncodedFrames(frames: string[]) {
            ensureFramePump();
            for (const frame of frames) {
              while (frameQueue.length >= maxQueuedFrames) {
                frameQueue.shift();
              }
              frameQueue.push(frame);
            }
          },
          pulsePlaceholder(count: number) {
            for (let index = 0; index < count; index += 1) {
              tick += 1;
              drawFrame(20 + ((tick % 7) + 1) * 4, tick);
            }
          },
          async close() {
            await meeting.leave();
            await audioContext.close();
          },
        };
      },
      {
        token: this.credentials.token,
        fps: this.options.fps,
      },
    );
  }

  async publishAudioChunk(
    data: Buffer,
    options: { sampleRate: number; channels: number; format: PcmFormat },
  ): Promise<void> {
    if (!this.page) {
      throw new Error('RTC publisher page is not ready.');
    }

    this.totalAudioBytes += data.length;
    await this.page.evaluate(
      async ({ base64, sampleRate, channels, format }) => {
        const publisher = (globalThis as Record<string, unknown>).__rtcPublisher as
          | { pushPcmBase64: (base64: string, sampleRate: number, channels: number, format: string) => Promise<void> }
          | undefined;
        if (!publisher) {
          throw new Error('RTC publisher bridge is unavailable.');
        }
        await publisher.pushPcmBase64(base64, sampleRate, channels, format);
      },
      {
        base64: data.toString('base64'),
        sampleRate: options.sampleRate,
        channels: options.channels,
        format: options.format,
      },
    );
  }

  async publishEncodedFrames(frameDataUrls: string[]): Promise<void> {
    if (!this.page) {
      throw new Error('RTC publisher page is not ready.');
    }

    this.estimatedFrames += frameDataUrls.length;
    await this.page.evaluate(async (frames) => {
      const publisher = (globalThis as Record<string, unknown>).__rtcPublisher as
        | { pushEncodedFrames: (frames: string[]) => void }
        | undefined;
      publisher?.pushEncodedFrames(frames);
    }, frameDataUrls);
  }

  async publishFrameBatch(count: number): Promise<void> {
    if (!this.page) {
      throw new Error('RTC publisher page is not ready.');
    }

    this.estimatedFrames += count;
    await this.page.evaluate(async (frameCount) => {
      const publisher = (globalThis as Record<string, unknown>).__rtcPublisher as
        | { pulsePlaceholder: (count: number) => void }
        | undefined;
      publisher?.pulsePlaceholder(frameCount);
    }, count);
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.evaluate(async () => {
        const publisher = (globalThis as Record<string, unknown>).__rtcPublisher as
          | { close: () => Promise<void> }
          | undefined;
        if (publisher) {
          await publisher.close();
        }
      });
    }

    await this.page?.close();
    await this.browser?.close();
    this.page = null;
    this.browser = null;
  }

  getMetrics(): PublishMetrics {
    return {
      totalAudioBytes: this.totalAudioBytes,
      estimatedFrames: this.estimatedFrames,
    };
  }
}

export function createRtcPublisher(
  credentials: RtcCredentials,
  options: PublisherOptions,
): RtcPublisher {
  if (options.mode === 'browser') {
    return new BrowserRtcPublisher(credentials, options);
  }

  return new MockRtcPublisher(credentials);
}
