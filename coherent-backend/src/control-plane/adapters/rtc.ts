import { randomUUID } from 'node:crypto';
import { signToken } from '../../shared/token.js';
import type { RtcCredentials } from '../../shared/types.js';
import { ServiceError } from '../../shared/errors.js';

interface RtcCredentialConfig {
  provider: 'mock' | 'cloudflare';
  endpoint: string;
  secret: string;
  cloudflareApiBaseUrl: string;
  cloudflareAccountId: string;
  cloudflareAppId: string;
  cloudflareApiToken: string;
  subscriberPreset: string;
  publisherPreset: string;
}

export class RtcCredentialService {
  constructor(private readonly config: RtcCredentialConfig) {}

  async issuePair(sessionId: string): Promise<{ subscriber: RtcCredentials; publisher: RtcCredentials }> {
    if (this.config.provider === 'cloudflare') {
      return this.issueCloudflarePair(sessionId);
    }

    return {
      subscriber: this.issue(sessionId, 'subscriber'),
      publisher: this.issue(sessionId, 'publisher'),
    };
  }

  private issue(sessionId: string, role: 'publisher' | 'subscriber'): RtcCredentials {
    const token = signToken(
      {
        sessionId,
        role,
        provider: this.config.provider,
        exp: Math.floor(Date.now() / 1000) + 60 * 15,
      },
      this.config.secret,
    );

    return {
      provider: this.config.provider,
      roomId: sessionId,
      role,
      token,
      endpoint: this.config.endpoint,
    };
  }

  private ensureCloudflareConfigured(): void {
    if (
      !this.config.cloudflareAccountId ||
      !this.config.cloudflareAppId ||
      !this.config.cloudflareApiToken
    ) {
      throw new ServiceError(
        'Cloudflare RTC is enabled but the account, app, or API token env vars are missing.',
        500,
        'cloudflare_config_missing',
      );
    }
  }

  private async issueCloudflarePair(
    sessionId: string,
  ): Promise<{ subscriber: RtcCredentials; publisher: RtcCredentials }> {
    this.ensureCloudflareConfigured();

    const meetingId = await this.createMeeting();
    const subscriber = await this.addParticipant(
      meetingId,
      'subscriber',
      this.config.subscriberPreset,
      `app-${sessionId}`,
    );
    const publisher = await this.addParticipant(
      meetingId,
      'publisher',
      this.config.publisherPreset,
      `worker-${sessionId}`,
    );

    return { subscriber, publisher };
  }

  private async createMeeting(): Promise<string> {
    const response = await fetch(
      `${this.config.cloudflareApiBaseUrl}/accounts/${this.config.cloudflareAccountId}/realtime/kit/${this.config.cloudflareAppId}/meetings`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.cloudflareApiToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new ServiceError(
        `Cloudflare meeting creation failed with HTTP ${response.status}.`,
        502,
        'cloudflare_meeting_failed',
      );
    }

    const json = (await response.json()) as {
      success?: boolean;
      data?: { id?: string };
      errors?: Array<{ message?: string }>;
    };
    const meetingId = json.data?.id;
    if (!meetingId) {
      throw new ServiceError(
        json.errors?.[0]?.message ?? 'Cloudflare meeting creation did not return an ID.',
        502,
        'cloudflare_meeting_missing_id',
      );
    }

    return meetingId;
  }

  private async addParticipant(
    meetingId: string,
    role: 'publisher' | 'subscriber',
    presetName: string,
    name: string,
  ): Promise<RtcCredentials> {
    const customParticipantId = randomUUID();
    const response = await fetch(
      `${this.config.cloudflareApiBaseUrl}/accounts/${this.config.cloudflareAccountId}/realtime/kit/${this.config.cloudflareAppId}/meetings/${meetingId}/participants`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.cloudflareApiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          custom_participant_id: customParticipantId,
          preset_name: presetName,
          name,
        }),
      },
    );

    if (!response.ok) {
      throw new ServiceError(
        `Cloudflare addParticipant failed with HTTP ${response.status}.`,
        502,
        'cloudflare_participant_failed',
      );
    }

    const json = (await response.json()) as {
      success?: boolean;
      data?: { id?: string; token?: string };
      errors?: Array<{ message?: string }>;
    };

    if (!json.data?.id || !json.data.token) {
      throw new ServiceError(
        json.errors?.[0]?.message ?? 'Cloudflare participant response was missing ID or token.',
        502,
        'cloudflare_participant_missing_data',
      );
    }

    return {
      provider: 'cloudflare',
      roomId: meetingId,
      role,
      token: json.data.token,
      endpoint: this.config.endpoint,
      appId: this.config.cloudflareAppId,
      meetingId,
      participantId: json.data.id,
      presetName,
    };
  }
}
