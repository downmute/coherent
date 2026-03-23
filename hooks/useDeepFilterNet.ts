import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { InferenceSession as OrtSession, Tensor as OrtTensor } from 'onnxruntime-react-native';

const RUNTIME_THRESHOLDS = {
    minDb: -10,
    maxDbErb: 30,
    maxDbDf: 20,
};

interface DeepFilterNetHook {
    isReady: boolean;
    error: Error | null;
    processBuffered(input48k: Float32Array): Promise<Float32Array[]>;
    processBufferedWithProfile(input48k: Float32Array): Promise<BufferedDenoiseResult>;
    reset(): void;
}

export interface DeepFilterNetProfile {
    inputSamples48k: number;
    hopCount: number;
    outputSamples16k: number;
    totalMs: number;
    nativeMs: number;
    bridgeMs: number;
    analysisMs: number;
    encoderMs: number;
    erbDecoderMs: number;
    dfDecoderMs: number;
    synthesisMs: number;
    downsampleMs: number;
}

interface DenoiseDebugChunk16k {
    referenceRms: number;
    denoisedRms: number;
    leveledRms: number;
}

interface BufferedDenoiseResult {
    chunks48k: Float32Array[];
    chunks16k: Float32Array[];
    debug16k: DenoiseDebugChunk16k[];
    profile: DeepFilterNetProfile;
}

interface DfConfig {
    sr: number;
    fftSize: number;
    hopSize: number;
    nbErb: number;
    nbDf: number;
    minNbErbFreqs: number;
    dfOrder: number;
    dfLookahead: number;
    convLookahead: number;
    alpha: number;
}

interface ComplexFrame {
    re: Float32Array;
    im: Float32Array;
}

interface DeepFilterRuntimeLike {
    processBuffered(input48k: Float32Array): Promise<Float32Array[]>;
    processBufferedWithProfile(input48k: Float32Array): Promise<BufferedDenoiseResult>;
    reset(): void;
    dispose(): void;
}

interface NativeLibDFModule {
    initialize(modelDir: string, attenLim: number): Promise<{ frameLength: number }>;
    processFrame(samples: number[]): Promise<{ output: number[]; lsnr: number; processMs: number }>;
    reset(): void;
    dispose(): void;
}

type IniMap = Record<string, Record<string, string>>;

let fftCosTable: Float32Array | null = null;
let fftSinTable: Float32Array | null = null;
let fftTableSize = 0;
let fftFreqSize = 0;
const nativeLibDF = (NativeModules.LibDFBridge ?? null) as NativeLibDFModule | null;

function nowMs(): number {
    return globalThis.performance?.now?.() ?? Date.now();
}

function toNativeFsPath(path: string): string {
    const raw = path.startsWith('file://') ? path.slice('file://'.length) : path;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

async function assertFileExists(path: string): Promise<void> {
    const uri = path.startsWith('file://') ? path : `file://${path}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
        throw new Error(`[DeepFilterNet] Required file missing at ${uri}`);
    }
}

function parseIni(content: string): IniMap {
    const out: IniMap = {};
    let current = '';
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            current = line.slice(1, -1).trim();
            out[current] ??= {};
            continue;
        }
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        out[current] ??= {};
        out[current][key] = value;
    }
    return out;
}

function calcNormAlpha(sr: number, hopSize: number, tau: number): number {
    const dt = hopSize / sr;
    const alpha = Math.exp(-dt / tau);
    let rounded = 1.0;
    let precision = 3;
    while (rounded >= 1.0) {
        const scale = 10 ** precision;
        rounded = Math.round(alpha * scale) / scale;
        precision += 1;
    }
    return rounded;
}

function getRequiredConfig(ini: IniMap): DfConfig {
    const df = ini.df ?? {};
    const model = ini.deepfilternet ?? {};
    const sr = Number(df.sr);
    const fftSize = Number(df.fft_size);
    const hopSize = Number(df.hop_size);
    const nbErb = Number(df.nb_erb);
    const nbDf = Number(df.nb_df);
    const minNbErbFreqs = Number(df.min_nb_erb_freqs);
    const dfOrder = Number(df.df_order ?? model.df_order);
    const dfLookahead = Number(df.df_lookahead ?? model.df_lookahead ?? 0);
    const convLookahead = Number(model.conv_lookahead ?? 0);
    const alpha = df.norm_alpha ? Number(df.norm_alpha) : calcNormAlpha(sr, hopSize, Number(df.norm_tau ?? 1));

    if (!sr || !fftSize || !hopSize || !nbErb || !nbDf || !dfOrder) {
        throw new Error('[DeepFilterNet] Invalid config.ini');
    }

    return {
        sr,
        fftSize,
        hopSize,
        nbErb,
        nbDf,
        minNbErbFreqs,
        dfOrder,
        dfLookahead,
        convLookahead,
        alpha,
    };
}

function ensureFftTables(fftSize: number): { cos: Float32Array; sin: Float32Array; freqSize: number } {
    const freqSize = Math.floor(fftSize / 2) + 1;
    if (fftCosTable && fftSinTable && fftTableSize === fftSize && fftFreqSize === freqSize) {
        return { cos: fftCosTable, sin: fftSinTable, freqSize };
    }
    const cos = new Float32Array(fftSize * freqSize);
    const sin = new Float32Array(fftSize * freqSize);
    for (let n = 0; n < fftSize; n++) {
        const row = n * freqSize;
        for (let k = 0; k < freqSize; k++) {
            const angle = (2 * Math.PI * k * n) / fftSize;
            cos[row + k] = Math.cos(angle);
            sin[row + k] = Math.sin(angle);
        }
    }
    fftCosTable = cos;
    fftSinTable = sin;
    fftTableSize = fftSize;
    fftFreqSize = freqSize;
    return { cos, sin, freqSize };
}

function freq2erb(freqHz: number): number {
    return 9.265 * Math.log1p(freqHz / (24.7 * 9.265));
}

function erb2freq(erb: number): number {
    return 24.7 * 9.265 * (Math.exp(erb / 9.265) - 1.0);
}

function buildErbBands(sr: number, fftSize: number, nbBands: number, minNbFreqs: number): number[] {
    const nyquist = sr / 2;
    const freqWidth = sr / fftSize;
    const erbLow = freq2erb(0);
    const erbHigh = freq2erb(nyquist);
    const erb = new Array<number>(nbBands).fill(0);
    const step = (erbHigh - erbLow) / nbBands;
    let prevFreq = 0;
    let freqOver = 0;

    for (let i = 1; i <= nbBands; i++) {
        const freq = erb2freq(erbLow + i * step);
        const fb = Math.round(freq / freqWidth);
        let nbFreqs = fb - prevFreq - freqOver;
        if (nbFreqs < minNbFreqs) {
            freqOver = minNbFreqs - nbFreqs;
            nbFreqs = minNbFreqs;
        } else {
            freqOver = 0;
        }
        erb[i - 1] = nbFreqs;
        prevFreq = fb;
    }

    erb[nbBands - 1] += 1;
    const expected = Math.floor(fftSize / 2) + 1;
    const tooLarge = erb.reduce((sum, value) => sum + value, 0) - expected;
    if (tooLarge > 0) erb[nbBands - 1] -= tooLarge;
    return erb;
}

function createZeroFrame(freqSize: number): ComplexFrame {
    return {
        re: new Float32Array(freqSize),
        im: new Float32Array(freqSize),
    };
}

function cloneFrame(frame: ComplexFrame): ComplexFrame {
    return {
        re: new Float32Array(frame.re),
        im: new Float32Array(frame.im),
    };
}

function appendFrame(queue: ComplexFrame[], frame: ComplexFrame): void {
    queue.shift();
    queue.push(frame);
}

function createDecimatorTaps(length: number, cutoffCyclesPerSample: number): Float32Array {
    const taps = new Float32Array(length);
    const center = (length - 1) / 2;
    let sum = 0;
    for (let i = 0; i < length; i++) {
        const n = i - center;
        const sinc = Math.abs(n) < 1e-8
            ? 2 * cutoffCyclesPerSample
            : Math.sin(2 * Math.PI * cutoffCyclesPerSample * n) / (Math.PI * n);
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (length - 1));
        const coeff = sinc * window;
        taps[i] = coeff;
        sum += coeff;
    }
    for (let i = 0; i < length; i++) taps[i] /= sum;
    return taps;
}

class StreamingDownsampler3 {
    private readonly history: Float32Array;
    private phase = 0;

    constructor(private readonly taps: Float32Array) {
        this.history = new Float32Array(taps.length);
    }

    reset(): void {
        this.history.fill(0);
        this.phase = 0;
    }

    process(input: Float32Array): Float32Array {
        const outLen = Math.floor((this.phase + input.length) / 3);
        const out = new Float32Array(outLen);
        let outIndex = 0;

        for (let i = 0; i < input.length; i++) {
            this.history.copyWithin(0, 1);
            this.history[this.history.length - 1] = input[i];
            this.phase += 1;

            if (this.phase === 3) {
                this.phase = 0;
                let sample = 0;
                for (let k = 0; k < this.taps.length; k++) {
                    sample += this.history[k] * this.taps[k];
                }
                out[outIndex++] = sample;
            }
        }

        return outIndex === out.length ? out : out.subarray(0, outIndex);
    }
}

function computeRms(input: Float32Array): number {
    if (input.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
        const sample = input[i];
        sum += sample * sample;
    }
    return Math.sqrt(sum / input.length);
}

class StreamingSpeechLeveler {
    private smoothedGain = 1;

    reset(): void {
        this.smoothedGain = 1;
    }

    process(reference: Float32Array, input: Float32Array): Float32Array {
        if (input.length === 0) return input;

        const referenceRms = computeRms(reference);
        const inputRms = computeRms(input);
        const speechFloor = 0.02;
        const silenceFloor = 0.0025;
        const maxGain = 1.0;
        const targetSpeechRms = 0.02;

        let desiredGain = 1;
        if (referenceRms >= speechFloor && inputRms > 1e-5) {
            const targetRms = Math.max(targetSpeechRms, referenceRms);
            desiredGain = Math.min(maxGain, Math.max(1, targetRms / inputRms));
        } else if (referenceRms <= silenceFloor || inputRms < silenceFloor) {
            desiredGain = 1;
        }

        const smoothing = desiredGain > this.smoothedGain ? 0.25 : 0.65;
        this.smoothedGain += (desiredGain - this.smoothedGain) * smoothing;

        const out = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const sample = input[i] * this.smoothedGain;
            out[i] = Math.max(-1, Math.min(1, sample));
        }
        return out;
    }
}

function createEmptyProfile(inputSamples48k: number): DeepFilterNetProfile {
    return {
        inputSamples48k,
        hopCount: 0,
        outputSamples16k: 0,
        totalMs: 0,
        nativeMs: 0,
        bridgeMs: 0,
        analysisMs: 0,
        encoderMs: 0,
        erbDecoderMs: 0,
        dfDecoderMs: 0,
        synthesisMs: 0,
        downsampleMs: 0,
    };
}

class DfState {
    readonly freqSize: number;
    readonly erbBands: number[];
    readonly wnorm: number;
    private readonly analysisMem: Float32Array;
    private readonly synthesisMem: Float32Array;
    private readonly window: Float32Array;
    private readonly fftCos: Float32Array;
    private readonly fftSin: Float32Array;
    private readonly fftSize: number;
    private readonly hopSize: number;
    private readonly nbErb: number;
    private readonly nbDf: number;
    private readonly alpha: number;
    private meanNormState: Float32Array;
    private unitNormState: Float32Array;

    constructor(config: DfConfig) {
        this.fftSize = config.fftSize;
        this.hopSize = config.hopSize;
        this.nbErb = config.nbErb;
        this.nbDf = config.nbDf;
        this.alpha = config.alpha;
        this.freqSize = Math.floor(config.fftSize / 2) + 1;
        this.erbBands = buildErbBands(config.sr, config.fftSize, config.nbErb, config.minNbErbFreqs);
        this.analysisMem = new Float32Array(config.fftSize - config.hopSize);
        this.synthesisMem = new Float32Array(config.fftSize - config.hopSize);
        const { cos, sin } = ensureFftTables(config.fftSize);
        this.fftCos = cos;
        this.fftSin = sin;

        this.window = new Float32Array(config.fftSize);
        const half = config.fftSize / 2;
        for (let i = 0; i < config.fftSize; i++) {
            const inner = Math.sin((0.5 * Math.PI * (i + 0.5)) / half);
            this.window[i] = Math.sin(0.5 * Math.PI * inner * inner);
        }
        this.wnorm = 1 / ((config.fftSize ** 2) / (2 * config.hopSize));

        this.meanNormState = new Float32Array(this.nbErb);
        this.unitNormState = new Float32Array(this.nbDf);
        this.reset();
    }

    reset(): void {
        this.analysisMem.fill(0);
        this.synthesisMem.fill(0);
        for (let i = 0; i < this.nbErb; i++) {
            this.meanNormState[i] = -60 + (i * (-30)) / Math.max(1, this.nbErb - 1);
        }
        for (let i = 0; i < this.nbDf; i++) {
            this.unitNormState[i] = 0.001 + (i * (0.0001 - 0.001)) / Math.max(1, this.nbDf - 1);
        }
    }

    analysis(input: Float32Array): ComplexFrame {
        const windowed = new Float32Array(this.fftSize);
        const head = this.fftSize - this.hopSize;
        for (let i = 0; i < head; i++) {
            windowed[i] = this.analysisMem[i] * this.window[i];
        }
        for (let i = 0; i < this.hopSize; i++) {
            windowed[head + i] = input[i] * this.window[head + i];
        }
        this.analysisMem.set(input);

        const out = createZeroFrame(this.freqSize);
        for (let k = 0; k < this.freqSize; k++) {
            let re = 0;
            let im = 0;
            for (let n = 0; n < this.fftSize; n++) {
                const sample = windowed[n];
                const idx = n * this.freqSize + k;
                re += sample * this.fftCos[idx];
                im -= sample * this.fftSin[idx];
            }
            out.re[k] = re * this.wnorm;
            out.im[k] = im * this.wnorm;
        }
        return out;
    }

    synthesis(frame: ComplexFrame): Float32Array {
        const time = new Float32Array(this.fftSize);
        const nyquist = this.freqSize - 1;
        for (let n = 0; n < this.fftSize; n++) {
            const row = n * this.freqSize;
            let sample = frame.re[0] + ((n & 1) === 0 ? frame.re[nyquist] : -frame.re[nyquist]);
            for (let k = 1; k < nyquist; k++) {
                const idx = row + k;
                sample += 2 * (frame.re[k] * this.fftCos[idx] - frame.im[k] * this.fftSin[idx]);
            }
            time[n] = sample * this.window[n];
        }

        const out = new Float32Array(this.hopSize);
        for (let i = 0; i < this.hopSize; i++) {
            out[i] = time[i] + this.synthesisMem[i];
        }
        this.synthesisMem.set(time.subarray(this.hopSize));
        return out;
    }

    featErb(frame: ComplexFrame): Float32Array {
        const out = new Float32Array(this.nbErb);
        let offset = 0;
        for (let band = 0; band < this.nbErb; band++) {
            const bandSize = this.erbBands[band];
            let sum = 0;
            for (let j = 0; j < bandSize; j++) {
                const idx = offset + j;
                sum += (frame.re[idx] * frame.re[idx] + frame.im[idx] * frame.im[idx]) / bandSize;
            }
            offset += bandSize;
            const db = 10 * Math.log10(sum + 1e-10);
            this.meanNormState[band] = db * (1 - this.alpha) + this.meanNormState[band] * this.alpha;
            out[band] = (db - this.meanNormState[band]) / 40;
        }
        return out;
    }

    featSpec(frame: ComplexFrame): Float32Array {
        const out = new Float32Array(this.nbDf * 2);
        for (let i = 0; i < this.nbDf; i++) {
            const norm = Math.hypot(frame.re[i], frame.im[i]);
            this.unitNormState[i] = norm * (1 - this.alpha) + this.unitNormState[i] * this.alpha;
            const scale = 1 / Math.sqrt(Math.max(this.unitNormState[i], 1e-12));
            out[i] = frame.re[i] * scale;
            out[this.nbDf + i] = frame.im[i] * scale;
        }
        return out;
    }

    applyMask(frame: ComplexFrame, gains: Float32Array): void {
        let offset = 0;
        for (let band = 0; band < this.nbErb; band++) {
            const gain = gains[band];
            const bandSize = this.erbBands[band];
            for (let j = 0; j < bandSize; j++) {
                const idx = offset + j;
                frame.re[idx] *= gain;
                frame.im[idx] *= gain;
            }
            offset += bandSize;
        }
    }
}

class DeepFilterNetRuntime implements DeepFilterRuntimeLike {
    private readonly dfState: DfState;
    private readonly config: DfConfig;
    private readonly rollingSpec: ComplexFrame[];
    private readonly outputFrameIndex: number;
    private readonly downsampler = new StreamingDownsampler3(createDecimatorTaps(15, 0.15));
    private readonly referenceDownsampler = new StreamingDownsampler3(createDecimatorTaps(15, 0.15));
    private readonly speechLeveler = new StreamingSpeechLeveler();
    private pending48k = new Float32Array(0);

    constructor(
        private readonly encSession: OrtSession,
        private readonly erbDecSession: OrtSession,
        private readonly dfDecSession: OrtSession,
        config: DfConfig,
    ) {
        this.config = config;
        this.dfState = new DfState(config);
        const lookahead = Math.max(this.config.dfLookahead, this.config.convLookahead);
        this.outputFrameIndex = Math.max(0, this.config.dfOrder - lookahead - 1);
        const zeroFrame = () => createZeroFrame(this.dfState.freqSize);
        this.rollingSpec = Array.from({ length: this.config.dfOrder }, zeroFrame);
    }

    reset(): void {
        this.pending48k = new Float32Array(0);
        this.dfState.reset();
        this.downsampler.reset();
        this.referenceDownsampler.reset();
        this.speechLeveler.reset();
        for (let i = 0; i < this.rollingSpec.length; i++) this.rollingSpec[i] = createZeroFrame(this.dfState.freqSize);
    }

    async processBuffered(input48k: Float32Array): Promise<Float32Array[]> {
        const result = await this.processBufferedWithProfile(input48k);
        return result.chunks16k;
    }

    async processBufferedWithProfile(input48k: Float32Array): Promise<BufferedDenoiseResult> {
        const batchStart = nowMs();
        const nextPending = new Float32Array(this.pending48k.length + input48k.length);
        nextPending.set(this.pending48k, 0);
        nextPending.set(input48k, this.pending48k.length);
        this.pending48k = nextPending;
        const outputs: Float32Array[] = [];
        const outputs48k: Float32Array[] = [];
        const debug16k: DenoiseDebugChunk16k[] = [];
        const profile = createEmptyProfile(input48k.length);
        while (this.pending48k.length >= this.config.hopSize) {
            const hop = this.pending48k.subarray(0, this.config.hopSize);
            this.pending48k = new Float32Array(this.pending48k.subarray(this.config.hopSize));
            const hopResult = await this.processHop(new Float32Array(hop));
            const downsampleStart = nowMs();
            const downsampled = this.downsampler.process(hopResult.audio48k);
            const reference16k = this.referenceDownsampler.process(hop);
            const leveled = this.speechLeveler.process(reference16k, downsampled);
            debug16k.push({
                referenceRms: computeRms(reference16k),
                denoisedRms: computeRms(downsampled),
                leveledRms: computeRms(leveled),
            });
            profile.downsampleMs += nowMs() - downsampleStart;
            profile.hopCount += 1;
            profile.analysisMs += hopResult.profile.analysisMs;
            profile.encoderMs += hopResult.profile.encoderMs;
            profile.erbDecoderMs += hopResult.profile.erbDecoderMs;
            profile.dfDecoderMs += hopResult.profile.dfDecoderMs;
            profile.synthesisMs += hopResult.profile.synthesisMs;
            profile.outputSamples16k += leveled.length;
            outputs48k.push(hopResult.audio48k);
            outputs.push(leveled);
        }
        profile.totalMs = nowMs() - batchStart;
        return { chunks48k: outputs48k, chunks16k: outputs, debug16k, profile };
    }

    private async processHop(input: Float32Array): Promise<{ audio48k: Float32Array; profile: DeepFilterNetProfile }> {
        const profile = createEmptyProfile(input.length);
        const analysisStart = nowMs();
        const noisySpec = this.dfState.analysis(input);
        profile.analysisMs = nowMs() - analysisStart;
        appendFrame(this.rollingSpec, cloneFrame(noisySpec));

        const featErb = this.dfState.featErb(noisySpec);
        const featSpec = this.dfState.featSpec(noisySpec);
        const encStart = nowMs();
        const encOutputs = await this.encSession.run({
            [this.encSession.inputNames[0]]: new OrtTensor('float32', featErb, [1, 1, 1, this.config.nbErb]),
            [this.encSession.inputNames[1]]: new OrtTensor('float32', featSpec, [1, 2, 1, this.config.nbDf]),
        }) as Record<string, OrtTensor>;
        profile.encoderMs = nowMs() - encStart;

        const encGet = (name: string, index: number) => encOutputs[name] ?? encOutputs[this.encSession.outputNames[index]];
        const e0 = encGet('e0', 0);
        const e1 = encGet('e1', 1);
        const e2 = encGet('e2', 2);
        const e3 = encGet('e3', 3);
        const emb = encGet('emb', 4);
        const c0 = encGet('c0', 5);
        const lsnrTensor = encGet('lsnr', 6);
        const lsnr = Number((lsnrTensor.data as Float32Array)[0] ?? -15);

        let gains: Float32Array | null = null;
        let coefs: Float32Array | null = null;
        let alpha = 1;

        if (lsnr < RUNTIME_THRESHOLDS.minDb) {
            gains = new Float32Array(this.config.nbErb);
        } else if (lsnr <= RUNTIME_THRESHOLDS.maxDbErb) {
            const erbStart = nowMs();
            const gainOutputs = await this.erbDecSession.run({
                [this.erbDecSession.inputNames[0]]: emb,
                [this.erbDecSession.inputNames[1]]: e3,
                [this.erbDecSession.inputNames[2]]: e2,
                [this.erbDecSession.inputNames[3]]: e1,
                [this.erbDecSession.inputNames[4]]: e0,
            }) as Record<string, OrtTensor>;
            profile.erbDecoderMs = nowMs() - erbStart;
            const gainTensor = gainOutputs[this.erbDecSession.outputNames[0]];
            gains = new Float32Array(gainTensor.data as Float32Array);

            if (lsnr <= RUNTIME_THRESHOLDS.maxDbDf) {
                const dfStart = nowMs();
                const coefOutputs = await this.dfDecSession.run({
                    [this.dfDecSession.inputNames[0]]: emb,
                    [this.dfDecSession.inputNames[1]]: c0,
                }) as Record<string, OrtTensor>;
                profile.dfDecoderMs = nowMs() - dfStart;
                const coefTensor = coefOutputs[this.dfDecSession.outputNames[0]];
                const alphaTensor = this.dfDecSession.outputNames[1]
                    ? coefOutputs[this.dfDecSession.outputNames[1]]
                    : undefined;
                coefs = new Float32Array(coefTensor.data as Float32Array);
                if (alphaTensor) {
                    alpha = Math.max(0, Math.min(1, Number((alphaTensor.data as Float32Array)[0] ?? 1)));
                }
            }
        }

        const stage1 = cloneFrame(this.rollingSpec[this.outputFrameIndex]);
        if (gains) this.dfState.applyMask(stage1, gains);

        const enhanced = cloneFrame(stage1);
        if (coefs) {
            enhanced.re.fill(0, 0, this.config.nbDf);
            enhanced.im.fill(0, 0, this.config.nbDf);
            for (let tap = 0; tap < this.config.dfOrder; tap++) {
                const specFrame = this.rollingSpec[tap];
                for (let bin = 0; bin < this.config.nbDf; bin++) {
                    const coefBase = ((bin * this.config.dfOrder) + tap) * 2;
                    const coefRe = coefs[coefBase];
                    const coefIm = coefs[coefBase + 1];
                    enhanced.re[bin] += specFrame.re[bin] * coefRe - specFrame.im[bin] * coefIm;
                    enhanced.im[bin] += specFrame.re[bin] * coefIm + specFrame.im[bin] * coefRe;
                }
            }
            if (alpha < 0.9999) {
                const keep = 1 - alpha;
                for (let bin = 0; bin < this.config.nbDf; bin++) {
                    enhanced.re[bin] = enhanced.re[bin] * alpha + stage1.re[bin] * keep;
                    enhanced.im[bin] = enhanced.im[bin] * alpha + stage1.im[bin] * keep;
                }
            }
        }

        const synthesisStart = nowMs();
        const audio48k = this.dfState.synthesis(enhanced);
        profile.synthesisMs = nowMs() - synthesisStart;
        return { audio48k, profile };
    }

    dispose(): void {
        try { this.encSession.release(); } catch {}
        try { this.erbDecSession.release(); } catch {}
        try { this.dfDecSession.release(); } catch {}
    }
}

class NativeDeepFilterNetRuntime implements DeepFilterRuntimeLike {
    private pending48k = new Float32Array(0);
    private readonly downsampler = new StreamingDownsampler3(createDecimatorTaps(15, 0.15));
    private readonly referenceDownsampler = new StreamingDownsampler3(createDecimatorTaps(15, 0.15));
    private readonly speechLeveler = new StreamingSpeechLeveler();

    constructor(
        private readonly nativeModule: NativeLibDFModule,
        private readonly frameLength: number,
    ) {}

    reset(): void {
        this.pending48k = new Float32Array(0);
        this.downsampler.reset();
        this.referenceDownsampler.reset();
        this.speechLeveler.reset();
        this.nativeModule.reset();
    }

    dispose(): void {
        this.pending48k = new Float32Array(0);
        this.nativeModule.dispose();
    }

    async processBuffered(input48k: Float32Array): Promise<Float32Array[]> {
        const result = await this.processBufferedWithProfile(input48k);
        return result.chunks16k;
    }

    async processBufferedWithProfile(input48k: Float32Array): Promise<BufferedDenoiseResult> {
        const batchStart = nowMs();
        const nextPending = new Float32Array(this.pending48k.length + input48k.length);
        nextPending.set(this.pending48k, 0);
        nextPending.set(input48k, this.pending48k.length);
        this.pending48k = nextPending;

        const outputs: Float32Array[] = [];
        const outputs48k: Float32Array[] = [];
        const debug16k: DenoiseDebugChunk16k[] = [];
        const profile = createEmptyProfile(input48k.length);

        while (this.pending48k.length >= this.frameLength) {
            const hop = this.pending48k.subarray(0, this.frameLength);
            this.pending48k = new Float32Array(this.pending48k.subarray(this.frameLength));

            const nativeStart = nowMs();
            const result = await this.nativeModule.processFrame(Array.from(hop));
            const nativeEnd = nowMs();

            const output48k = Float32Array.from(result.output);
            const downsampleStart = nowMs();
            const downsampled = this.downsampler.process(output48k);
            const reference16k = this.referenceDownsampler.process(hop);
            const leveled = this.speechLeveler.process(reference16k, downsampled);
            debug16k.push({
                referenceRms: computeRms(reference16k),
                denoisedRms: computeRms(downsampled),
                leveledRms: computeRms(leveled),
            });
            profile.downsampleMs += nowMs() - downsampleStart;
            profile.hopCount += 1;
            profile.nativeMs += result.processMs;
            profile.bridgeMs += Math.max(0, (nativeEnd - nativeStart) - result.processMs);
            profile.outputSamples16k += leveled.length;
            outputs48k.push(output48k);
            outputs.push(leveled);
        }

        profile.totalMs = nowMs() - batchStart;
        return { chunks48k: outputs48k, chunks16k: outputs, debug16k, profile };
    }
}

export function useDeepFilterNet(modelDir: string | null): DeepFilterNetHook {
    const [isReady, setIsReady] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const runtimeRef = useRef<DeepFilterRuntimeLike | null>(null);
    const modelDirRef = useRef<string | null>(null);

    useEffect(() => {
        if (!modelDir || modelDir === modelDirRef.current) return;
        modelDirRef.current = modelDir;
        setIsReady(false);
        setError(null);

        let cancelled = false;
        const dispose = () => {
            runtimeRef.current?.dispose();
            runtimeRef.current = null;
        };

        dispose();

        (async () => {
            try {
                const encPath = toNativeFsPath(`${modelDir}/enc.onnx`);
                const erbPath = toNativeFsPath(`${modelDir}/erb_dec.onnx`);
                const dfPath = toNativeFsPath(`${modelDir}/df_dec.onnx`);
                const configPath = `${modelDir}/config.ini`;

                for (const path of [encPath, erbPath, dfPath, toNativeFsPath(configPath)]) {
                    await assertFileExists(path);
                }

                if (Platform.OS === 'ios' && nativeLibDF) {
                    const nativeInit = await nativeLibDF.initialize(toNativeFsPath(modelDir), 100);
                    if (cancelled) {
                        nativeLibDF.dispose();
                        return;
                    }
                    runtimeRef.current = new NativeDeepFilterNetRuntime(nativeLibDF, nativeInit.frameLength);
                    console.log('[DeepFilterNet] Ready (native libDF)');
                    setIsReady(true);
                    return;
                }

                const iniContent = await FileSystem.readAsStringAsync(configPath);
                const config = getRequiredConfig(parseIni(iniContent));

                const [encSession, erbDecSession, dfDecSession] = await Promise.all([
                    OrtSession.create(encPath),
                    OrtSession.create(erbPath),
                    OrtSession.create(dfPath),
                ]);

                if (cancelled) {
                    try { encSession.release(); } catch {}
                    try { erbDecSession.release(); } catch {}
                    try { dfDecSession.release(); } catch {}
                    return;
                }

                runtimeRef.current = new DeepFilterNetRuntime(encSession, erbDecSession, dfDecSession, config);
                console.log('[DeepFilterNet] Ready (JS fallback)');
                setIsReady(true);
            } catch (e) {
                const err = e instanceof Error ? e : new Error(String(e));
                console.warn('[DeepFilterNet] Init failed:', err);
                setError(err);
            }
        })();

        return () => {
            cancelled = true;
            dispose();
            setIsReady(false);
        };
    }, [modelDir]);

    const processBuffered = useCallback(async (input48k: Float32Array): Promise<Float32Array[]> => {
        if (!runtimeRef.current) return [];
        return runtimeRef.current.processBuffered(input48k);
    }, []);

    const processBufferedWithProfile = useCallback(async (input48k: Float32Array): Promise<BufferedDenoiseResult> => {
        if (!runtimeRef.current) {
            return {
                chunks48k: [],
                chunks16k: [],
                debug16k: [],
                profile: createEmptyProfile(input48k.length),
            };
        }
        return runtimeRef.current.processBufferedWithProfile(input48k);
    }, []);

    const reset = useCallback(() => {
        runtimeRef.current?.reset();
    }, []);

    return { isReady, error, processBuffered, processBufferedWithProfile, reset };
}
