import { AudioContext, type AudioBufferSourceNode } from 'react-native-audio-api';

export interface StreamedAudioPlayerOptions {
    sampleRate?: number;
    targetPeak?: number;
    maxGain?: number;
    outputBoost?: number;
    firstChunkPrerollMs?: number;
    onActiveSourceCountChange?: (count: number) => void;
    onIdle?: () => void;
}

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_TARGET_PEAK = 0.7;
const DEFAULT_MAX_GAIN = 12.0;
const DEFAULT_OUTPUT_BOOST = 2.5;
const DEFAULT_FIRST_CHUNK_PREROLL_MS = 45;

const createAudioBufferFromVector = (
    audioContext: AudioContext,
    audioVector: Float32Array,
    sampleRate: number,
) => {
    const audioBuffer = audioContext.createBuffer(1, audioVector.length, sampleRate);
    audioBuffer.getChannelData(0).set(audioVector);
    return audioBuffer;
};

export class StreamedAudioPlayer {
    private nextStartTime = 0;
    private activeSourceCount = 0;
    private chunkCount = 0;
    private readonly activeSources = new Set<AudioBufferSourceNode>();

    constructor(
        private readonly audioContext: AudioContext,
        private readonly options: StreamedAudioPlayerOptions = {},
    ) { }

    private get sampleRate() {
        return this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    }

    private notifyActiveSourceCountChange() {
        this.options.onActiveSourceCountChange?.(this.activeSourceCount);
    }

    getActiveSourceCount(): number {
        return this.activeSourceCount;
    }

    startUtterance(): void {
        this.chunkCount = 0;
    }

    reset(): void {
        this.nextStartTime = 0;
        this.chunkCount = 0;
    }

    stopAll(): void {
        for (const source of this.activeSources) {
            (source as any).onEnded = undefined;
            (source as any).onended = undefined;
            try {
                source.stop();
            } catch { }
        }
        this.activeSources.clear();
        this.activeSourceCount = 0;
        this.notifyActiveSourceCountChange();
        this.reset();
    }

    scheduleChunk(audioVec: Float32Array): AudioBufferSourceNode | null {
        if (!audioVec || audioVec.length === 0) return null;

        this.chunkCount += 1;

        let peak = 0;
        for (let i = 0; i < audioVec.length; i++) {
            const amplitude = Math.abs(audioVec[i]);
            if (amplitude > peak) peak = amplitude;
        }

        const targetPeak = this.options.targetPeak ?? DEFAULT_TARGET_PEAK;
        const maxGain = this.options.maxGain ?? DEFAULT_MAX_GAIN;
        const outputBoost = this.options.outputBoost ?? DEFAULT_OUTPUT_BOOST;

        let gain = 1;
        if (peak > 0 && peak < targetPeak) {
            gain = Math.min(maxGain, targetPeak / peak);
        }

        const totalGain = gain * outputBoost;
        let playbackVec = audioVec;
        if (Math.abs(totalGain - 1) > 0.05) {
            playbackVec = new Float32Array(audioVec.length);
            for (let i = 0; i < audioVec.length; i++) {
                playbackVec[i] = Math.tanh(audioVec[i] * totalGain);
            }
        }

        const firstChunkPrerollMs = this.options.firstChunkPrerollMs ?? DEFAULT_FIRST_CHUNK_PREROLL_MS;
        if (this.chunkCount === 1 && firstChunkPrerollMs > 0) {
            const prerollSamples = Math.max(1, Math.round((firstChunkPrerollMs / 1000) * this.sampleRate));
            const padded = new Float32Array(prerollSamples + playbackVec.length);
            padded.set(playbackVec, prerollSamples);
            playbackVec = padded;
        }

        const audioBuffer = createAudioBufferFromVector(this.audioContext, playbackVec, this.sampleRate);
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);

        const currentTime = this.audioContext.currentTime;
        if (this.nextStartTime < currentTime) {
            this.nextStartTime = currentTime;
        }

        source.start(this.nextStartTime);
        this.nextStartTime += audioBuffer.duration;

        this.activeSourceCount += 1;
        this.activeSources.add(source);
        this.notifyActiveSourceCountChange();

        let ended = false;
        const handleEnded = () => {
            if (ended) return;
            ended = true;
            this.activeSources.delete(source);
            this.activeSourceCount = Math.max(0, this.activeSourceCount - 1);
            this.notifyActiveSourceCountChange();
            if (this.activeSourceCount === 0) {
                this.options.onIdle?.();
            }
        };

        (source as any).onEnded = handleEnded;
        (source as any).onended = handleEnded;

        return source;
    }
}
