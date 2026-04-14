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
    if (typeof btoa === 'function') {
        let binary = '';
        for (let index = 0; index < bytes.length; index += 1) {
            binary += String.fromCharCode(bytes[index]!);
        }
        return btoa(binary);
    }

    const maybeBuffer = (globalThis as { Buffer?: { from: (input: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer;
    if (maybeBuffer?.from) {
        return maybeBuffer.from(bytes).toString('base64');
    }

    throw new Error('Base64 encoding is not supported in this runtime.');
}

export function encodeFloat32ToBase64(audio: Float32Array): string {
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    return encodeBase64FromBytes(bytes);
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
                this.callbacks.onStopped?.();
                if (!settled) {
                    settled = true;
                    reject(new Error('Worker WebSocket closed before session became ready.'));
                }
            };
        }), 30000, 'Timed out waiting 30s for worker session.ready.');

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

        this.sequence += 1;
        this.socket.send(
            JSON.stringify({
                type: 'audio.append',
                sequence: this.sequence,
                pcmBase64: encodeFloat32ToBase64(audio),
                sampleRate,
                channels,
                format: 'f32le',
            }),
        );
    }

    signalAudioEnd(): void {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'audio.end' }));
        }
    }

    async stop(): Promise<void> {
        this.stopHeartbeat();
        this.ready = false;
        this.sequence = 0;

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
