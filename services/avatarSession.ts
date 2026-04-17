import { Buffer } from 'buffer';

export interface AvatarRtcCredentials {
    provider: 'cloudflare' | 'mock';
    roomId: string;
    role: 'publisher' | 'subscriber';
    token: string;
    endpoint: string;
    appId?: string;
    meetingId?: string;
    participantId?: string;
    presetName?: string;
}

export interface AvatarSessionResponse {
    sessionId: string;
    workerWsUrl: string;
    workerToken: string;
    rtcCredentials: AvatarRtcCredentials;
    status: 'assigned';
}

export interface AvatarVideoSegment {
    sessionId: string;
    segmentIndex: number;
    url: string;
    final: boolean;
    durationSeconds?: number;
}

const MAX_REMOTE_AUDIO_SAMPLES_PER_MESSAGE = 4096;
const SESSION_READY_TIMEOUT_MS = 120000;

type AvatarClientEvent =
    | { type: 'session.ready'; sessionId: string; provider: string }
    | { type: 'audio.ack'; sessionId: string; sequence: number; totalAudioBytes: number; estimatedFrames: number }
    | { type: 'video.segment'; sessionId: string; segmentIndex: number; url: string; final: boolean; durationSeconds?: number }
    | { type: 'heartbeat.ack'; sessionId: string; active: boolean }
    | { type: 'session.stopped'; sessionId: string }
    | { type: 'session.error'; sessionId: string; code: string; message: string; recoverable: boolean }
    | { type: 'error'; code: string; message: string };

export interface AvatarSessionClientCallbacks {
    onReady?: () => void;
    onStopped?: () => void;
    onError?: (message: string) => void;
    onAck?: (event: Extract<AvatarClientEvent, { type: 'audio.ack' }>) => void;
    onVideoSegment?: (segment: AvatarVideoSegment) => void;
}

interface PendingAck {
    resolve: () => void;
    reject: (error: Error) => void;
}

interface AvatarSessionErrorPayload {
    error?: string;
    message?: string;
    details?: Record<string, unknown> | null;
}

export class AvatarSessionError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: Record<string, unknown> | null;

    constructor(message: string, status: number, code: string, details?: Record<string, unknown> | null) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function timeoutAfter<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function trimTrailingSlash(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}

function encodeBase64FromBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function assertPlausibleBase64Length(base64: string): string {
    const normalized = base64.trim();
    if (normalized.length % 4 === 1) {
        throw new Error(`Generated invalid base64 payload length ${normalized.length}.`);
    }
    return normalized;
}

export function encodeFloat32ToBase64(audio: Float32Array): string {
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    return encodeBase64FromBytes(bytes);
}

function encodeFloat32ToS16leBytes(audio: Float32Array): Uint8Array {
    const bytes = new Uint8Array(audio.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < audio.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, audio[index] ?? 0));
        const scaled = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
        view.setInt16(index * 2, scaled, true);
    }
    return bytes;
}

export async function createAvatarSession(
    controlPlaneUrl: string,
    avatarConfig: Record<string, unknown>,
): Promise<AvatarSessionResponse> {
    const response = await timeoutAfter(
        fetch(`${trimTrailingSlash(controlPlaneUrl)}/sessions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                appVersion: 'expo-video',
                avatarConfig,
            }),
        }),
        20000,
        'Timed out creating avatar session after 20s.',
    );

    if (!response.ok) {
        const body = await response.text();
        let parsed: AvatarSessionErrorPayload | null = null;
        try {
            parsed = JSON.parse(body) as AvatarSessionErrorPayload;
        } catch {
            parsed = null;
        }

        const message = parsed?.message?.trim() || `Session creation failed with HTTP ${response.status}.`;
        const code = parsed?.error?.trim() || 'session_creation_failed';
        throw new AvatarSessionError(message, response.status, code, parsed?.details ?? null);
    }

    return (await response.json()) as AvatarSessionResponse;
}

export class AvatarSessionClient {
    private socket: WebSocket | null = null;
    private ready = false;
    private sequence = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private openPromise: Promise<void> | null = null;
    private readonly pendingAcks = new Map<number, PendingAck>();

    constructor(
        private readonly session: AvatarSessionResponse,
        private readonly callbacks: AvatarSessionClientCallbacks = {},
    ) {}

    async connect(): Promise<void> {
        if (this.openPromise) {
            return this.openPromise;
        }

        this.openPromise = timeoutAfter(new Promise<void>((resolve, reject) => {
            const joiner = this.session.workerWsUrl.includes('?') ? '&' : '?';
            const socket = new WebSocket(
                `${this.session.workerWsUrl}${joiner}token=${encodeURIComponent(this.session.workerToken)}`,
            );
            this.socket = socket;

            let settled = false;
            const fail = (message: string) => {
                for (const waiter of this.pendingAcks.values()) {
                    waiter.reject(new Error(message));
                }
                this.pendingAcks.clear();
                if (!settled) {
                    settled = true;
                    reject(new Error(message));
                }
                this.callbacks.onError?.(message);
            };

            socket.onopen = () => {
                socket.send(
                    JSON.stringify({
                        type: 'session.start',
                        sessionId: this.session.sessionId,
                    }),
                );
            };

            socket.onmessage = (event) => {
                const raw = typeof event.data === 'string' ? event.data : '';
                if (!raw) {
                    return;
                }

                let payload: AvatarClientEvent;
                try {
                    payload = JSON.parse(raw) as AvatarClientEvent;
                } catch {
                    return;
                }

                if (payload.type === 'session.ready') {
                    this.ready = true;
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                    this.startHeartbeat();
                    this.callbacks.onReady?.();
                    return;
                }

                if (payload.type === 'audio.ack') {
                    const waiter = this.pendingAcks.get(payload.sequence);
                    if (waiter) {
                        this.pendingAcks.delete(payload.sequence);
                        waiter.resolve();
                    }
                    this.callbacks.onAck?.(payload);
                    return;
                }

                if (payload.type === 'video.segment') {
                    this.callbacks.onVideoSegment?.({
                        sessionId: payload.sessionId,
                        segmentIndex: payload.segmentIndex,
                        url: payload.url,
                        final: payload.final,
                        durationSeconds: payload.durationSeconds,
                    });
                    return;
                }

                if (payload.type === 'session.error' || payload.type === 'error') {
                    fail(payload.message);
                    return;
                }

                if (payload.type === 'session.stopped') {
                    this.callbacks.onStopped?.();
                }
            };

            socket.onerror = () => {
                fail('Worker WebSocket failed.');
            };

            socket.onclose = () => {
                this.stopHeartbeat();
                this.ready = false;
                this.socket = null;
                for (const waiter of this.pendingAcks.values()) {
                    waiter.reject(new Error('Worker WebSocket closed before audio chunk was acknowledged.'));
                }
                this.pendingAcks.clear();
                this.callbacks.onStopped?.();
                if (!settled) {
                    settled = true;
                    reject(new Error('Worker WebSocket closed before session became ready.'));
                }
            };
        }), SESSION_READY_TIMEOUT_MS, `Timed out waiting ${Math.round(SESSION_READY_TIMEOUT_MS / 1000)}s for worker session.ready.`);

        return this.openPromise;
    }

    private startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 5000);
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    isReady(): boolean {
        return this.ready;
    }

    getRtcCredentials(): AvatarRtcCredentials {
        return this.session.rtcCredentials;
    }

    async appendFloat32Chunk(audio: Float32Array, sampleRate: number, channels: number = 1): Promise<void> {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) {
            throw new Error('Avatar worker session is not ready.');
        }

        for (let start = 0; start < audio.length; start += MAX_REMOTE_AUDIO_SAMPLES_PER_MESSAGE) {
            const chunk = audio.subarray(start, Math.min(audio.length, start + MAX_REMOTE_AUDIO_SAMPLES_PER_MESSAGE));
            if (chunk.length === 0) {
                continue;
            }

            this.sequence += 1;
            const s16leBytes = encodeFloat32ToS16leBytes(chunk);
            const sequence = this.sequence;
            const ackPromise = new Promise<void>((resolve, reject) => {
                this.pendingAcks.set(sequence, { resolve, reject });
            });
            this.socket.send(
                JSON.stringify({
                    type: 'audio.append.binary',
                    sequence,
                    sampleRate,
                    channels,
                    format: 's16le',
                    byteLength: s16leBytes.byteLength,
                }),
            );
            console.log(
                `[Avatar Session] send audio metadata sequence=${sequence} byteLength=${s16leBytes.byteLength} samples=${chunk.length} sampleRate=${sampleRate} channels=${channels}`,
            );
            const buffer = s16leBytes.buffer.slice(
                s16leBytes.byteOffset,
                s16leBytes.byteOffset + s16leBytes.byteLength,
            );
            this.socket.send(buffer);
            console.log(
                `[Avatar Session] send audio binary sequence=${sequence} byteLength=${s16leBytes.byteLength}`,
            );
            await ackPromise;
            console.log(`[Avatar Session] audio ack received sequence=${sequence}`);
        }
    }

    signalAudioEnd(): void {
        if (this.socket?.readyState === WebSocket.OPEN) {
            console.log('[Avatar Session] send audio.end');
            this.socket.send(JSON.stringify({ type: 'audio.end' }));
        }
    }

    async stop(): Promise<void> {
        this.stopHeartbeat();
        this.ready = false;
        this.sequence = 0;
        for (const waiter of this.pendingAcks.values()) {
            waiter.reject(new Error('Avatar session stopped before audio chunk was acknowledged.'));
        }
        this.pendingAcks.clear();

        if (this.socket?.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify({ type: 'session.stop' }));
            } catch {}
            try {
                this.socket.close();
            } catch {}
        }

        this.socket = null;
        this.openPromise = null;
    }
}
