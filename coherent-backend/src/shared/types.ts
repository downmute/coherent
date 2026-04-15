export type WorkerStatus =
  | 'provisioning'
  | 'warm'
  | 'busy'
  | 'draining'
  | 'unhealthy'
  | 'terminated';

export type SessionStatus =
  | 'assigned'
  | 'streaming'
  | 'ended'
  | 'failed';

export interface AvatarConfig {
  [key: string]: unknown;
}

export interface SessionCreateRequest {
  userId?: string;
  appVersion?: string;
  avatarConfig?: AvatarConfig;
}

export interface WorkerRecord {
  id: string;
  workerKey: string;
  provider: string;
  providerInstanceId: string | null;
  region: string;
  gpuModel: string;
  status: WorkerStatus;
  maxSessions: number;
  activeSessions: number;
  publicWsUrl: string;
  metadata: Record<string, unknown>;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  workerId: string;
  status: SessionStatus;
  avatarConfig: AvatarConfig;
  appMetadata: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
}

export interface SessionAllocation {
  session: SessionRecord;
  worker: WorkerRecord;
}

export interface RtcCredentials {
  provider: 'mock' | 'cloudflare';
  roomId: string;
  role: 'publisher' | 'subscriber';
  token: string;
  endpoint: string;
  appId?: string;
  meetingId?: string;
  participantId?: string;
  presetName?: string;
}

export type PcmFormat = 'f32le' | 's16le';

export interface WorkerTokenPayload {
  sessionId: string;
  workerKey: string;
  avatarConfig: AvatarConfig;
  publisherRtc: RtcCredentials;
  exp: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  workerWsUrl: string;
  workerToken: string;
  rtcCredentials: RtcCredentials;
  status: 'assigned';
}

export interface RegisterWorkerRequest {
  workerKey: string;
  provider: string;
  providerInstanceId?: string | null;
  region: string;
  gpuModel: string;
  maxSessions: number;
  publicWsUrl: string;
  status: WorkerStatus;
  metadata?: Record<string, unknown>;
}

export interface WorkerHeartbeatRequest {
  workerKey: string;
  status?: WorkerStatus;
  activeSessions?: number;
  metadata?: Record<string, unknown>;
}

export type ClientToWorkerMessage =
  | {
      type: 'session.start';
      sessionId: string;
      workerToken?: string;
    }
  | {
      type: 'audio.append';
      sequence: number;
      pcmBase64: string;
      sampleRate: number;
      channels: number;
      format?: PcmFormat;
    }
  | {
      type: 'audio.append.binary';
      sequence: number;
      sampleRate: number;
      channels: number;
      format?: PcmFormat;
      byteLength: number;
    }
  | {
      type: 'audio.end';
    }
  | {
      type: 'session.stop';
    }
  | {
      type: 'heartbeat';
    };

export type WorkerToClientMessage =
  | {
      type: 'session.ready';
      sessionId: string;
      provider: string;
    }
  | {
      type: 'audio.ack';
      sessionId: string;
      sequence: number;
      totalAudioBytes: number;
      estimatedFrames: number;
    }
  | {
      type: 'video.segment';
      sessionId: string;
      segmentIndex: number;
      url: string;
      final: boolean;
      durationSeconds?: number;
    }
  | {
      type: 'heartbeat.ack';
      sessionId: string;
      active: boolean;
    }
  | {
      type: 'session.stopped';
      sessionId: string;
    }
  | {
      type: 'session.error';
      sessionId: string;
      code: string;
      message: string;
      recoverable: boolean;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    };
