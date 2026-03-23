/**
 * usePocketTTS — On-device TTS via Pocket TTS (ONNX Runtime models)
 *
 * Pipeline: text → SentencePiece tokenize → text_conditioner → backbone AR loop → flow_net ODE → mimi_decoder → Float32 audio @ 24kHz
 *
 * Reference: https://huggingface.co/KevinAHM/pocket-tts-onnx
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { InferenceSession as OrtSession, Tensor as OrtTensor } from 'onnxruntime-react-native';

// --- Tuning Constants ---
const LSD_STEPS = 3;             // ODE steps per AR frame (1=fastest, 10=highest quality)
const NAN_WARMUP_FRAMES = 3;     // First N frames use NaN-BOS conditioning — decode through mimi to build state but drop audio
const FIRST_CHUNK_FRAMES = 7;    // Frames decoded (after warmup) before first audio is emitted
const NORMAL_CHUNK_FRAMES = 12;  // Frames per subsequent decode call
const EOS_THRESHOLD = -4.0;      // eos_logit threshold for end-of-speech
const FRAMES_AFTER_EOS = 3;      // Extra frames after EOS for natural tail
const MAX_FRAMES = 500;          // AR loop safety cap
const TEMPERATURE = 0.7;         // Gaussian noise temperature
const GAUSSIAN_STD = Math.sqrt(TEMPERATURE);

// --- Public Interface ---
export interface PocketTTSHook {
    isReady: boolean;
    isGenerating: boolean;
    error: Error | null;
    availableVoices: string[];
    stream(input: {
        text: string;
        onNext?: (audio: Float32Array) => void;
        onEnd?: () => void;
        onBegin?: () => void;
    }): Promise<void>;
    forward(input: { text: string }): Promise<Float32Array>;
    primeVoice(preference?: string): Promise<string>;
    streamStop(): void;
}

// --- ORT State Helpers ---
type OrtState = Record<string, OrtTensor>;

interface OnnxInputMeta {
    name: string;
    dims: number[];
    elemType: 'float32' | 'int64' | 'bool';
}

/** Extract out_state_N → state_N mappings from run outputs */
function extractState(
    outputs: Record<string, OrtTensor>,
    outputNames: readonly string[],
    inputNames: readonly string[],
): OrtState {
    const state: OrtState = {};
    for (const name of outputNames) {
        if (name.startsWith('out_state_')) {
            const idx = name.replace('out_state_', '');
            const inName = `state_${idx}`;
            if (inputNames.includes(inName) && outputs[name]) {
                state[inName] = outputs[name];
            }
        }
    }
    return state;
}

// --- ONNX Backbone Adapter (stateful AR backbone) ---
class ONNXBackboneAdapter {
    private stateMetas: OnnxInputMeta[] = [];
    private state: OrtState = {};

    // Discovered from ONNX input shapes
    private textEmbName = 'text_embeddings';
    textEmbDim          = 1024; // public — used for voice dim compatibility check
    private voiceEmbName: string | null = null;
    private voiceEmbDim  = 0;
    private seqDim       = 32;

    constructor(private readonly session: OrtSession) {
        console.log('[PocketTTS] Backbone inputNames:', session.inputNames.join(', '));
        console.log('[PocketTTS] Backbone outputNames:', session.outputNames.join(', '));
    }

    setAllInputMetas(metas: OnnxInputMeta[]): void {
        this.stateMetas = metas.filter(m => m.name.startsWith('state_'));

        // Discover sequence, text embedding, and voice embedding inputs
        for (const m of metas) {
            if (m.name.startsWith('state_')) continue;
            if (m.name === 'sequence') {
                this.seqDim = m.dims[m.dims.length - 1] ?? 32;
            } else if (m.name === 'text_embeddings' || m.name.includes('text')) {
                this.textEmbName = m.name;
                this.textEmbDim  = m.dims[m.dims.length - 1] ?? 1024;
            } else {
                // Assume any remaining float32 embedding input is voice
                if (m.elemType === 'float32') {
                    this.voiceEmbName = m.name;
                    this.voiceEmbDim  = m.dims[m.dims.length - 1] ?? 0;
                }
            }
        }
        console.log(`[PocketTTS] Backbone discovered inputs: seq=${this.seqDim} textEmb="${this.textEmbName}"(${this.textEmbDim}) voiceEmb="${this.voiceEmbName}"(${this.voiceEmbDim})`);
    }

    reset(): void {
        this.state = {};
        for (const { name, dims, elemType } of this.stateMetas) {
            const n = dims.reduce((a, b) => a * b, 1); // 0 when any dim is 0
            this.state[name] = elemType === 'int64' ? new OrtTensor('int64',   new BigInt64Array(n), dims)
                             : elemType === 'bool'  ? new OrtTensor('bool',    new Uint8Array(n),    dims)
                             :                        new OrtTensor('float32', new Float32Array(n),  dims);
        }
    }

    private async _run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>> {
        const allFeeds = { ...this.state, ...feeds };
        const outputs = await this.session.run(allFeeds) as Record<string, OrtTensor>;
        this.state = extractState(outputs, this.session.outputNames, this.session.inputNames);
        return outputs;
    }

    /** Build empty tensors for all non-state, non-sequence inputs (to pass alongside the active one). */
    private emptyEmbFeeds(exceptName?: string): Record<string, OrtTensor> {
        const feeds: Record<string, OrtTensor> = {};
        if (this.textEmbName !== exceptName) {
            feeds[this.textEmbName] = new OrtTensor('float32', new Float32Array(0), [1, 0, this.textEmbDim]);
        }
        if (this.voiceEmbName && this.voiceEmbName !== exceptName) {
            feeds[this.voiceEmbName] = new OrtTensor('float32', new Float32Array(0), [1, 0, this.voiceEmbDim]);
        }
        return feeds;
    }

    /** Pass voice embeddings through backbone to build KV-cache. sequence=[1,0,seqDim]. */
    async conditionVoice(voiceData: Float32Array, shape: readonly number[]): Promise<void> {
        const voiceInput = this.voiceEmbName ?? this.textEmbName;
        console.log(`[PocketTTS] conditionVoice: passing to "${voiceInput}" shape=[${shape.join(',')}]`);
        await this._run({
            sequence: new OrtTensor('float32', new Float32Array(0), [1, 0, this.seqDim]),
            ...this.emptyEmbFeeds(voiceInput),
            [voiceInput]: new OrtTensor('float32', voiceData, [...shape]),
        });
        console.log('[PocketTTS] Backbone voice conditioning pass OK');
    }

    /** Pass text embeddings through backbone to build KV-cache. sequence=[1,0,seqDim]. */
    async conditionText(textData: Float32Array, shape: readonly number[]): Promise<void> {
        console.log(`[PocketTTS] conditionText: passing to "${this.textEmbName}" shape=[${shape.join(',')}]`);
        await this._run({
            sequence: new OrtTensor('float32', new Float32Array(0), [1, 0, this.seqDim]),
            ...this.emptyEmbFeeds(this.textEmbName),
            [this.textEmbName]: new OrtTensor('float32', textData, [...shape]),
        });
        console.log('[PocketTTS] Backbone text conditioning pass OK');
    }

    /**
     * One AR step: advance generation by one latent frame.
     * Returns backbone output[0]=conditioning, output[1]=eos_logit.
     */
    async stepAR(seq: Float32Array): Promise<{ conditioning: OrtTensor; eos: number }> {
        const outputs = await this._run({
            sequence: new OrtTensor('float32', seq, [1, 1, this.seqDim]),
            ...this.emptyEmbFeeds(),
        });
        // Backbone outputs: conditioning (index 0), eos_logit (index 1), out_state_* (rest)
        const conditioning = outputs['conditioning'] ?? outputs[this.session.outputNames[0]];
        const eosTensor    = outputs['eos_logit']    ?? outputs[this.session.outputNames[1]];
        const eos = (eosTensor.data as Float32Array)[0];
        return { conditioning, eos };
    }

    dispose(): void {
        try { this.session.release(); } catch {}
    }
}

// --- ONNX Mimi Decoder (stateful audio decoder) ---
class ONNXMimiDecoder {
    private stateMetas: OnnxInputMeta[] = [];
    private state: OrtState = {};

    constructor(private readonly session: OrtSession) {
        console.log('[PocketTTS] MimiDecoder inputNames:', session.inputNames.join(', '));
        console.log('[PocketTTS] MimiDecoder outputNames:', session.outputNames.join(', '));
    }

    setAllInputMetas(metas: OnnxInputMeta[]): void {
        this.stateMetas = metas.filter(m => m.name.startsWith('state_'));
    }

    /** Reset state between utterances. */
    reset(): void {
        this.state = {};
        for (const { name, dims, elemType } of this.stateMetas) {
            const n = dims.reduce((a, b) => a * b, 1);
            this.state[name] = elemType === 'int64' ? new OrtTensor('int64',   new BigInt64Array(n), dims)
                             : elemType === 'bool'  ? new OrtTensor('bool',    new Uint8Array(n),    dims)
                             :                        new OrtTensor('float32', new Float32Array(n),  dims);
        }
    }

    /** Decode a chunk of latent frames → audio samples. State is maintained between calls. */
    async decode(latents: Float32Array, frames: number): Promise<Float32Array> {
        const feeds = {
            latent: new OrtTensor('float32', latents, [1, frames, 32]),
            ...this.state,
        };
        const outputs = await this.session.run(feeds) as Record<string, OrtTensor>;
        // Index-based state extraction: output[1..N] → state_0..state_(N-1)
        // (mimi decoder output names may not follow out_state_* convention)
        const newState: OrtState = {};
        for (let i = 1; i < this.session.outputNames.length; i++) {
            const inName = `state_${i - 1}`;
            if (this.session.inputNames.includes(inName)) {
                const outTensor = outputs[this.session.outputNames[i]];
                if (outTensor) newState[inName] = outTensor;
            }
        }
        if (Object.keys(newState).length > 0) this.state = newState;
        const audioTensor = outputs[this.session.outputNames[0]];
        return audioTensor.data as Float32Array;
    }

    dispose(): void {
        try { this.session.release(); } catch {}
    }
}

// --- ONNX Mimi Encoder (converts raw PCM audio → voice embeddings) ---
class ONNXMimiEncoder {
    constructor(private readonly session: OrtSession) {
        console.log('[PocketTTS] MimiEncoder inputNames:', session.inputNames.join(', '));
        console.log('[PocketTTS] MimiEncoder outputNames:', session.outputNames.join(', '));
    }

    /** Encode raw PCM float32 audio → voice embeddings [1, N, 1024]. */
    async encode(audioData: Float32Array): Promise<{ data: Float32Array; shape: [number, number, number] }> {
        const outputs = await this.session.run({
            audio: new OrtTensor('float32', audioData, [1, 1, audioData.length]),
        }) as Record<string, OrtTensor>;
        const emb  = outputs[this.session.outputNames[0]];
        const dims = Array.from(emb.dims);
        const data = new Float32Array(emb.data as Float32Array);
        const shape: [number, number, number] = dims.length === 3
            ? [dims[0], dims[1], dims[2]]
            : [1, dims[0], dims[1]];
        return { data, shape };
    }

    dispose(): void { try { this.session.release(); } catch {} }
}

// --- Session Bundle ---
interface ONNXSessionBundle {
    textConditioner: OrtSession;
    backbone: ONNXBackboneAdapter;
    flowNet: OrtSession;
    mimiDecoder: ONNXMimiDecoder;
    mimiEncoder: ONNXMimiEncoder;
}

// --- Path Helpers ---
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
        throw new Error(`[PocketTTS] Required file missing at ${uri}`);
    }
}

// --- Gaussian Noise (Box-Muller) ---
function gaussianNoise32(): Float32Array {
    const out = new Float32Array(32);
    for (let i = 0; i < 32; i++) {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        out[i] = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * GAUSSIAN_STD;
    }
    return out;
}

// --- Binary File Reading ---
function decodeBase64ToBytes(base64: string): Uint8Array {
    if (typeof atob === 'function') {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    const maybeBuffer = (globalThis as any).Buffer;
    if (maybeBuffer) {
        return new Uint8Array(maybeBuffer.from(base64, 'base64'));
    }
    throw new Error('[PocketTTS] Base64 decode is not supported in this runtime.');
}

async function readBinaryFile(path: string): Promise<Uint8Array> {
    const b64 = await FileSystem.readAsStringAsync(path, {
        encoding: FileSystem.EncodingType.Base64,
    });
    return decodeBase64ToBytes(b64);
}

function encodeBase64FromBuffer(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

async function ensureDirectory(path: string): Promise<void> {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
        await FileSystem.makeDirectoryAsync(path, { intermediates: true });
    }
}

// --- Voice Types ---
interface Voice {
    name: string;
    data: Float32Array;
    shape: [number, number, number];
}

type VoiceSource = 'compiled' | 'reference';

interface VoiceDescriptor {
    name: string;
    source: VoiceSource;
    voice: Voice;
}

// --- Reference Voice Assets (bundled .wav) ---
const REFERENCE_VOICE_ASSETS: { name: string; moduleId: number }[] = [
    { name: 'female1', moduleId: require('../voices/female1.wav') as number },
    { name: 'female2', moduleId: require('../voices/female2.wav') as number },
    { name: 'female3', moduleId: require('../voices/female3.wav') as number },
    { name: 'female4', moduleId: require('../voices/female4.wav') as number },
    { name: 'female5', moduleId: require('../voices/female5.wav') as number },
    { name: 'male1',   moduleId: require('../voices/male1.wav')   as number },
    { name: 'male2',   moduleId: require('../voices/male2.wav')   as number },
    { name: 'male3',   moduleId: require('../voices/male3.wav')   as number },
    { name: 'male4',   moduleId: require('../voices/male4.wav')   as number },
];

// --- WAV PCM Parser ---
const TTS_SAMPLE_RATE = 24000;

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const lo = Math.floor(pos);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = pos - lo;
        out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return out;
}

function parseWavToFloat32(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let audioFormat = 1, numChannels = 1, sampleRate = 24000, bitsPerSample = 16;
    let dataOffset = 0, dataSize = 0;
    let pos = 12;
    while (pos + 8 <= bytes.byteLength) {
        const id = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
        const size = view.getUint32(pos + 4, true);
        pos += 8;
        if (id === 'fmt ') {
            audioFormat   = view.getUint16(pos,      true);
            numChannels   = view.getUint16(pos + 2,  true);
            sampleRate    = view.getUint32(pos + 4,  true);
            bitsPerSample = view.getUint16(pos + 14, true);
        } else if (id === 'data') {
            dataOffset = pos; dataSize = size; break;
        }
        pos += size + (size & 1);
    }
    if (dataOffset === 0) throw new Error('[PocketTTS] WAV data chunk not found');
    const bytesPerSample = bitsPerSample / 8;
    const frameSize = bytesPerSample * numChannels;
    const numFrames = Math.min(Math.floor(dataSize / frameSize), sampleRate * 5); // cap at 5s
    const out = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
        const p = dataOffset + i * frameSize;
        if (bitsPerSample === 16) {
            out[i] = view.getInt16(p, true) / 32768.0;
        } else if (bitsPerSample === 32 && audioFormat === 3) {
            out[i] = view.getFloat32(p, true);
        }
        // channel 0 only (skip other channels for stereo)
    }
    return sampleRate === TTS_SAMPLE_RATE ? out : resampleLinear(out, sampleRate, TTS_SAMPLE_RATE);
}

async function ensureReferenceVoiceFiles(referenceDir: string): Promise<void> {
    await ensureDirectory(referenceDir);
    for (const assetDef of REFERENCE_VOICE_ASSETS) {
        const targetPath = `${referenceDir}/${assetDef.name}.wav`;
        const targetInfo = await FileSystem.getInfoAsync(targetPath);
        if (targetInfo.exists && targetInfo.size > 1000) continue;
        const asset = Asset.fromModule(assetDef.moduleId);
        await asset.downloadAsync();
        const sourceUri = asset.localUri ?? asset.uri;
        if (!sourceUri) throw new Error(`[PocketTTS] Missing asset URI for '${assetDef.name}'.`);
        await FileSystem.copyAsync({ from: sourceUri, to: targetPath });
    }
}

async function loadReferenceWavPCM(referenceDir: string): Promise<{ name: string; pcm: Float32Array }[]> {
    const dirInfo = await FileSystem.getInfoAsync(referenceDir);
    if (!dirInfo.exists) return [];
    const entries = await FileSystem.readDirectoryAsync(referenceDir);
    const result: { name: string; pcm: Float32Array }[] = [];
    for (const entry of entries.filter(n => n.endsWith('.wav')).sort()) {
        const name  = entry.replace(/\.wav$/i, '');
        const bytes = await readBinaryFile(`${referenceDir}/${entry}`);
        result.push({ name, pcm: parseWavToFloat32(bytes) });
    }
    return result;
}

// --- Protobuf Varint (for SentencePiece tokenizer) ---
function readVarint(bytes: Uint8Array, pos: number): [number, number] {
    let result = 0, shift = 0;
    while (pos < bytes.length) {
        const b = bytes[pos++];
        result |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return [result, pos];
}

function skipProtoField(bytes: Uint8Array, pos: number, wireType: number): number {
    switch (wireType) {
        case 0: { while (pos < bytes.length && bytes[pos++] & 0x80) {} return pos; }
        case 1: return pos + 8;
        case 2: { const [len, p] = readVarint(bytes, pos); return p + len; }
        case 5: return pos + 4;
        default: throw new Error(`[PocketTTS] Unknown proto wire type: ${wireType}`);
    }
}

// --- ONNX Model Shape Parser ---
// Parses ModelProto → GraphProto → input[] to extract state_* tensor shapes.
// Large fields (initializers, nodes) are skipped in O(1) by tracking positions only.

function parseDimProto(bytes: Uint8Array, start: number, end: number): number {
    let pos = start, dimValue = 0;
    while (pos < end) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 1 && wire === 0) {
            const [v, p2] = readVarint(bytes, pos); pos = p2;
            dimValue = v; // dim_value (static int64); 0 if not set → dynamic
        } else {
            pos = skipProtoField(bytes, pos, wire); // skip dim_param (dynamic string)
        }
    }
    return dimValue;
}

function parseShapeProto(bytes: Uint8Array, start: number, end: number): number[] {
    const dims: number[] = [];
    let pos = start;
    while (pos < end) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 1 && wire === 2) {
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            dims.push(parseDimProto(bytes, pos, pos + len)); pos += len;
        } else {
            pos = skipProtoField(bytes, pos, wire);
        }
    }
    return dims;
}

function parseTensorTypeProto(bytes: Uint8Array, start: number, end: number): { dims: number[]; elemType: 'float32' | 'int64' } {
    let pos = start, dims: number[] = [], elemType: 'float32' | 'int64' = 'float32';
    while (pos < end) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 1 && wire === 0) {
            const [v, p2] = readVarint(bytes, pos); pos = p2;
            elemType = v === 7 ? 'int64' : v === 9 ? 'bool' : 'float32'; // 1=FLOAT, 7=INT64, 9=BOOL
        } else if (field === 2 && wire === 2) {
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            dims = parseShapeProto(bytes, pos, pos + len); pos += len;
        } else {
            pos = skipProtoField(bytes, pos, wire);
        }
    }
    return { dims, elemType };
}

function parseTypeProto(bytes: Uint8Array, start: number, end: number): { dims: number[]; elemType: 'float32' | 'int64' } {
    let pos = start, dims: number[] = [], elemType: 'float32' | 'int64' = 'float32';
    while (pos < end) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 1 && wire === 2) { // TypeProto.tensor_type
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            const r = parseTensorTypeProto(bytes, pos, pos + len);
            dims = r.dims; elemType = r.elemType; pos += len;
        } else {
            pos = skipProtoField(bytes, pos, wire);
        }
    }
    return { dims, elemType };
}

function parseValueInfoProto(bytes: Uint8Array, start: number, end: number): OnnxInputMeta | null {
    let pos = start, name = '', dims: number[] = [], elemType: 'float32' | 'int64' = 'float32';
    while (pos < end) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 1 && wire === 2) { // name
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            name = new TextDecoder().decode(bytes.subarray(pos, pos + len)); pos += len;
        } else if (field === 2 && wire === 2) { // type
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            const r = parseTypeProto(bytes, pos, pos + len);
            dims = r.dims; elemType = r.elemType; pos += len;
        } else {
            pos = skipProtoField(bytes, pos, wire);
        }
    }
    return name ? { name, dims, elemType } : null;
}

function parseGraphProtoAllInputs(bytes: Uint8Array, start: number, end: number): OnnxInputMeta[] {
    const results: OnnxInputMeta[] = [];
    let pos = start;
    while (pos < end) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 11 && wire === 2) { // GraphProto.input (repeated ValueInfoProto)
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            const meta = parseValueInfoProto(bytes, pos, pos + len);
            if (meta) results.push(meta);
            pos += len;
        } else {
            pos = skipProtoField(bytes, pos, wire); // skip nodes, initializers, etc.
        }
    }
    return results;
}

function parseOnnxModelAllInputs(bytes: Uint8Array): OnnxInputMeta[] {
    let pos = 0;
    while (pos < bytes.length) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const field = tag >> 3, wire = tag & 7;
        if (field === 7 && wire === 2) { // ModelProto.graph
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            return parseGraphProtoAllInputs(bytes, pos, pos + len);
        }
        pos = skipProtoField(bytes, pos, wire);
    }
    return [];
}

/**
 * Load all input shapes from an ONNX model file.
 * Results are cached as a JSON sidecar to avoid re-parsing on every launch.
 */
const CACHE_VERSION = 2; // bump when OnnxInputMeta format changes
interface ShapeCache { v: number; metas: OnnxInputMeta[] }

async function loadAllInputMetasCached(modelFilePath: string): Promise<OnnxInputMeta[]> {
    const cachePath = modelFilePath.replace(/\.onnx$/i, '.input_shapes.json');
    try {
        const info = await FileSystem.getInfoAsync(cachePath.startsWith('file://') ? cachePath : `file://${cachePath}`);
        if (info.exists) {
            const json = await FileSystem.readAsStringAsync(cachePath);
            const parsed = JSON.parse(json) as ShapeCache | OnnxInputMeta[];
            // Support old format (array) and new format ({ v, metas })
            const isNew = !Array.isArray(parsed) && (parsed as ShapeCache).v === CACHE_VERSION;
            if (isNew) {
                const cached = (parsed as ShapeCache).metas;
                console.log(`[PocketTTS] Loaded ${cached.length} input shapes from cache for ${modelFilePath.split('/').pop()}`);
                return cached;
            }
            // Version mismatch — fall through to re-parse
        }
    } catch { /* cache miss or corrupt */ }

    console.log(`[PocketTTS] Parsing ONNX input shapes from ${modelFilePath.split('/').pop()} (one-time)...`);
    const bytes = await readBinaryFile(modelFilePath);
    const metas = parseOnnxModelAllInputs(bytes);
    console.log(`[PocketTTS] Found ${metas.length} inputs: ${metas.map(m => `${m.name}:[${m.dims.join(',')}]`).join(' ')}`);

    try {
        await FileSystem.writeAsStringAsync(cachePath, JSON.stringify({ v: CACHE_VERSION, metas } satisfies ShapeCache));
    } catch { /* cache write failure is non-fatal */ }

    return metas;
}

interface SPPiece { piece: string; score: number; type: number }

function parseSentencePiece(bytes: Uint8Array): SPPiece {
    let piece = '', score = 0, type = 1, pos = 0;
    const decoder = new TextDecoder();
    while (pos < bytes.length) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const fieldNum = tag >> 3;
        const wireType = tag & 0x7;
        if (fieldNum === 1 && wireType === 2) {
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            piece = decoder.decode(bytes.subarray(pos, pos + len)); pos += len;
        } else if (fieldNum === 2 && wireType === 5) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
            score = view.getFloat32(0, true); pos += 4;
        } else if (fieldNum === 3 && wireType === 0) {
            const [v, p2] = readVarint(bytes, pos); type = v; pos = p2;
        } else {
            pos = skipProtoField(bytes, pos, wireType);
        }
    }
    return { piece, score, type };
}

function parseTokenizerModel(bytes: Uint8Array): SPPiece[] {
    const pieces: SPPiece[] = [];
    let pos = 0;
    while (pos < bytes.length) {
        const [tag, p1] = readVarint(bytes, pos); pos = p1;
        const fieldNum = tag >> 3;
        const wireType = tag & 0x7;
        if (fieldNum === 1 && wireType === 2) {
            const [len, p2] = readVarint(bytes, pos); pos = p2;
            pieces.push(parseSentencePiece(bytes.subarray(pos, pos + len))); pos += len;
        } else {
            pos = skipProtoField(bytes, pos, wireType);
        }
    }
    return pieces;
}

interface VocabEntry { id: number; score: number }

function buildVocab(pieces: SPPiece[]): {
    vocab: Map<string, VocabEntry>;
    unkId: number;
    maxLen: number;
} {
    const vocab = new Map<string, VocabEntry>();
    let unkId = 0, maxLen = 0;
    for (let id = 0; id < pieces.length; id++) {
        const { piece, score, type } = pieces[id];
        if (type === 2) { unkId = id; continue; }
        if (type === 3 || type === 7) continue;
        vocab.set(piece, { id, score });
        if (piece.length > maxLen) maxLen = piece.length;
    }
    return { vocab, unkId, maxLen };
}

function tokenize(
    text: string,
    vocab: Map<string, VocabEntry>,
    unkId: number,
    maxPieceLen: number
): number[] {
    const input = ('\u2581' + text.trim()).replace(/ /g, '\u2581');
    const n = input.length;
    const dp   = new Float64Array(n + 1).fill(-Infinity);
    const prev = new Int32Array(n + 1).fill(-1);
    const tid  = new Int32Array(n + 1).fill(unkId);
    dp[0] = 0;

    for (let i = 0; i < n; i++) {
        if (dp[i] === -Infinity) continue;
        for (let len = 1; len <= Math.min(maxPieceLen, n - i); len++) {
            const sub   = input.slice(i, i + len);
            const entry = vocab.get(sub);
            if (entry) {
                const ns = dp[i] + entry.score;
                if (ns > dp[i + len]) { dp[i + len] = ns; prev[i + len] = i; tid[i + len] = entry.id; }
            }
        }
        const unkScore = dp[i] - 20;
        if (unkScore > dp[i + 1]) { dp[i + 1] = unkScore; prev[i + 1] = i; tid[i + 1] = unkId; }
    }

    const result: number[] = [];
    let pos = n;
    while (pos > 0) { result.unshift(tid[pos]); pos = prev[pos]; }
    return result;
}

// --- voices.bin parser ---
function parseVoicesBin(bytes: Uint8Array): Voice[] {
    const voices: Voice[] = [];
    const decoder = new TextDecoder();
    const view    = new DataView(bytes.buffer, bytes.byteOffset);
    let offset    = 0;

    const numVoices = view.getUint32(offset, true); offset += 4;

    for (let i = 0; i < numVoices && offset < bytes.byteLength; i++) {
        const nameBytes = bytes.subarray(offset, offset + 32);
        const nullIdx   = nameBytes.indexOf(0);
        const name      = decoder.decode(nameBytes.subarray(0, nullIdx >= 0 ? nullIdx : 32)).trim();
        offset += 32;

        const numFrames = view.getUint32(offset, true); offset += 4;
        const embDim    = view.getUint32(offset, true); offset += 4;

        const numFloats = numFrames * embDim;
        const raw       = new Float32Array(bytes.buffer, bytes.byteOffset + offset, numFloats);
        offset += numFloats * 4;

        // voices.bin stores data in [numFrames, embDim] row-major order — no transpose needed.
        const data = new Float32Array(numFloats);
        data.set(raw);

        voices.push({ name, data, shape: [1, numFrames, embDim] });
        console.log(`[PocketTTS] Voice loaded: '${name}' [1,${numFrames},${embDim}]`);
    }
    return voices;
}

// --- Text preprocessing ---
function preprocessText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function chooseVoiceName(preference: string | undefined, names: string[]): string | null {
    if (names.length === 0) return null;
    if (!preference) return names[0];
    const normalized = preference.trim().toLowerCase();
    const exact    = names.find(n => n.toLowerCase() === normalized);
    if (exact) return exact;
    const prefixed = names.find(n => n.toLowerCase().startsWith(normalized));
    if (prefixed) return prefixed;
    const included = names.find(n => n.toLowerCase().includes(normalized));
    if (included) return included;
    return names[0];
}

// --- Main Hook ---
export function usePocketTTS(modelDir: string | null): PocketTTSHook {
    const [isReady,      setIsReady]      = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error,        setError]        = useState<Error | null>(null);
    const [availableVoices, setAvailableVoices] = useState<string[]>([]);

    const sessionsRef          = useRef<ONNXSessionBundle | null>(null);
    const vocabRef             = useRef<Map<string, VocabEntry> | null>(null);
    const unkIdRef             = useRef(0);
    const maxPieceLenRef       = useRef(16);
    const voiceMapRef          = useRef<Map<string, VoiceDescriptor>>(new Map());
    const abortRef             = useRef(false);
    const modelDirRef          = useRef<string | null>(null);
    const activeVoiceNameRef   = useRef<string | null>(null);
    const embeddingWidthRef    = useRef(1024);   // discovered from text_conditioner probe

    // --- Load all sessions and assets ---
    useEffect(() => {
        if (!modelDir || modelDir === modelDirRef.current) return;
        modelDirRef.current = modelDir;
        setIsReady(false);
        setError(null);
        setAvailableVoices([]);
        voiceMapRef.current.clear();
        activeVoiceNameRef.current = null;

        let cancelled = false;
        const referenceDir = `${modelDir}/voice-references`;
        let initPhase = 'start';

        const disposeSessions = (bundle: ONNXSessionBundle | null) => {
            if (!bundle) return;
            try { bundle.textConditioner.release(); } catch {}
            bundle.backbone.dispose();
            try { bundle.flowNet.release(); } catch {}
            bundle.mimiDecoder.dispose();
            bundle.mimiEncoder.dispose();
        };

        disposeSessions(sessionsRef.current);
        sessionsRef.current = null;

        (async () => {
            try {
                initPhase = 'load-sessions';
                console.log('[PocketTTS] Loading ONNX sessions...');

                const tcPath   = toNativeFsPath(`${modelDir}/text_conditioner.onnx`);
                const bbPath   = toNativeFsPath(`${modelDir}/flow_lm_main.onnx`);
                const flPath   = toNativeFsPath(`${modelDir}/flow_lm_flow.onnx`);
                const mimiPath = toNativeFsPath(`${modelDir}/mimi_decoder.onnx`);
                const encPath  = toNativeFsPath(`${modelDir}/mimi_encoder.onnx`);

                for (const p of [tcPath, bbPath, flPath, mimiPath, encPath]) {
                    await assertFileExists(p);
                }

                const [tcSession, bbSession, flSession, mimiSession, encSession] = await Promise.all([
                    OrtSession.create(tcPath),
                    OrtSession.create(bbPath),
                    OrtSession.create(flPath),
                    OrtSession.create(mimiPath),
                    OrtSession.create(encPath),
                ]);

                if (cancelled) {
                    try { tcSession.release(); } catch {}
                    try { bbSession.release(); } catch {}
                    try { flSession.release(); } catch {}
                    try { mimiSession.release(); } catch {}
                    try { encSession.release(); } catch {}
                    return;
                }

                const backbone    = new ONNXBackboneAdapter(bbSession);
                const mimiDecoder = new ONNXMimiDecoder(mimiSession);
                const mimiEncoder = new ONNXMimiEncoder(encSession);

                console.log('[PocketTTS] Flow net inputNames:', flSession.inputNames.join(', '));
                console.log('[PocketTTS] Flow net outputNames:', flSession.outputNames.join(', '));
                console.log('[PocketTTS] Text cond inputNames:', tcSession.inputNames.join(', '));
                console.log('[PocketTTS] Text cond outputNames:', tcSession.outputNames.join(', '));

                // Parse all input shapes from ONNX files (cached after first run)
                initPhase = 'parse-input-shapes';
                const [bbMetas, mimiMetas] = await Promise.all([
                    loadAllInputMetasCached(`${modelDir}/flow_lm_main.onnx`),
                    loadAllInputMetasCached(`${modelDir}/mimi_decoder.onnx`),
                ]);
                backbone.setAllInputMetas(bbMetas);
                backbone.reset(); // initialize zero state tensors with correct shapes
                mimiDecoder.setAllInputMetas(mimiMetas);
                mimiDecoder.reset();
                if (cancelled) { disposeSessions({ textConditioner: tcSession, backbone, flowNet: flSession, mimiDecoder, mimiEncoder }); return; }

                sessionsRef.current = { textConditioner: tcSession, backbone, flowNet: flSession, mimiDecoder, mimiEncoder };

                // Probe text_conditioner to discover embedding width
                initPhase = 'probe-text-conditioner';
                console.log('[PocketTTS] Probing text_conditioner...');
                const probeLen  = 5;
                const probeData = new BigInt64Array(probeLen).fill(10n);
                const probeOut  = await tcSession.run({
                    token_ids: new OrtTensor('int64', probeData, [1, probeLen]),
                }) as Record<string, OrtTensor>;
                const probeEmb  = probeOut[tcSession.outputNames[0]];
                const probeDims = Array.from(probeEmb.dims);
                embeddingWidthRef.current = probeDims[probeDims.length - 1];
                console.log(`[PocketTTS] text_conditioner probe OK: output dims=${JSON.stringify(probeDims)} embWidth=${embeddingWidthRef.current}`);

                // Parse tokenizer
                initPhase = 'parse-tokenizer';
                console.log('[PocketTTS] Parsing tokenizer...');
                const tokBytes = await readBinaryFile(`${modelDir}/tokenizer.model`);
                const pieces   = parseTokenizerModel(tokBytes);
                const { vocab, unkId, maxLen } = buildVocab(pieces);
                vocabRef.current       = vocab;
                unkIdRef.current       = unkId;
                maxPieceLenRef.current = maxLen;
                console.log(`[PocketTTS] Tokenizer ready: ${vocab.size} pieces, maxLen=${maxLen}`);

                // Load voices
                initPhase = 'prepare-reference-voices';
                await ensureDirectory(referenceDir);
                await ensureReferenceVoiceFiles(referenceDir);

                initPhase = 'parse-voices';
                console.log('[PocketTTS] Parsing voices.bin...');
                const voiceBytes     = await readBinaryFile(`${modelDir}/voices.bin`);
                const compiledVoices = parseVoicesBin(voiceBytes);
                console.log(`[PocketTTS] ${compiledVoices.length} compiled voice(s) loaded`);
                const referenceWavs = await loadReferenceWavPCM(referenceDir);
                console.log(`[PocketTTS] ${referenceWavs.length} reference WAV(s) loaded`);

                if (compiledVoices.length === 0 && referenceWavs.length === 0) {
                    throw new Error('[PocketTTS] No voice assets were available.');
                }

                const requiredEmbDim = backbone.textEmbDim;
                console.log(`[PocketTTS] Filtering voices to embDim=${requiredEmbDim}`);

                const voiceNames: string[] = [];
                for (const voice of compiledVoices) {
                    if (voice.shape[2] !== requiredEmbDim) {
                        console.log(`[PocketTTS] Compiled voice '${voice.name}' skipped (embDim=${voice.shape[2]} != ${requiredEmbDim})`);
                        continue;
                    }
                    voiceMapRef.current.set(voice.name, { name: voice.name, source: 'compiled', voice });
                    voiceNames.push(voice.name);
                    console.log(`[PocketTTS] Compiled voice '${voice.name}' registered`);
                }

                for (const { name, pcm } of referenceWavs) {
                    const cacheFile = `${referenceDir}/${name}.emb`;
                    let encoded: Voice;
                    const cacheInfo = await FileSystem.getInfoAsync(cacheFile);
                    if (cacheInfo.exists) {
                        const bytes = await readBinaryFile(cacheFile);
                        // Version check: first byte must be 0x03 (resampled-to-24kHz cache)
                        // Layout: [version:u32 LE=3][N:u32 LE][D:u32 LE][N*D float32] — 12-byte header (4-byte aligned)
                        if (bytes[0] !== 0x03) {
                            console.log(`[PocketTTS] Stale cache for '${name}', re-encoding...`);
                            await FileSystem.deleteAsync(cacheFile);
                            // fall through to encode
                        } else {
                            const dv = new DataView(bytes.buffer, bytes.byteOffset);
                            const N = dv.getUint32(4, true);
                            const D = dv.getUint32(8, true);
                            const raw = new Float32Array(bytes.buffer, bytes.byteOffset + 12, N * D);
                            const data = new Float32Array(N * D); data.set(raw);
                            encoded = { name, data, shape: [1, N, D] };
                            console.log(`[PocketTTS] Loaded cached embedding '${name}' [1,${N},${D}]`);
                            if (encoded.shape[2] === requiredEmbDim) {
                                voiceMapRef.current.set(encoded.name, { name: encoded.name, source: 'reference', voice: encoded });
                                voiceNames.push(encoded.name);
                            }
                            continue;
                        }
                    }

                    console.log(`[PocketTTS] Encoding '${name}' via mimi_encoder (pcm samples=${pcm.length})...`);
                    const result = await sessionsRef.current!.mimiEncoder.encode(pcm);
                    encoded = { name, data: result.data, shape: result.shape };
                    const [, N, D] = result.shape;
                    // Write versioned cache: [version:u32 LE=3][N:u32 LE][D:u32 LE][N*D float32]
                    // 12-byte header keeps float data 4-byte aligned (offset 12 % 4 == 0)
                    const buf = new ArrayBuffer(12 + N * D * 4);
                    new DataView(buf).setUint32(0, 3, true);  // version=3, so bytes[0]=0x03 (audio resampled to 24kHz)
                    new DataView(buf).setUint32(4, N, true);
                    new DataView(buf).setUint32(8, D, true);
                    new Float32Array(buf, 12).set(result.data);
                    await FileSystem.writeAsStringAsync(cacheFile,
                        encodeBase64FromBuffer(buf), { encoding: FileSystem.EncodingType.Base64 });
                    console.log(`[PocketTTS] Cached '${name}' [1,${N},${D}]`);

                    if (encoded.shape[2] === requiredEmbDim) {
                        voiceMapRef.current.set(encoded.name, { name: encoded.name, source: 'reference', voice: encoded });
                        voiceNames.push(encoded.name);
                        console.log(`[PocketTTS] Reference voice '${encoded.name}' registered`);
                    } else {
                        console.warn(`[PocketTTS] '${encoded.name}' encoded dim=${encoded.shape[2]} != ${requiredEmbDim} — skipping`);
                    }
                }

                const uniqueVoiceNames = Array.from(new Set(voiceNames));
                if (!cancelled) setAvailableVoices(uniqueVoiceNames);

                activeVoiceNameRef.current =
                    chooseVoiceName('female', uniqueVoiceNames) ??
                    chooseVoiceName(undefined, uniqueVoiceNames);
                console.log(`[PocketTTS] ${uniqueVoiceNames.length} voice(s) ready, active: ${activeVoiceNameRef.current}`);

                if (uniqueVoiceNames.length === 0) {
                    throw new Error('[PocketTTS] No voices were available after load.');
                }

                if (!cancelled) setIsReady(true);
            } catch (e: any) {
                console.warn(`[PocketTTS] Init error during phase='${initPhase}':`, e);
                if (!cancelled) {
                    setError(e instanceof Error ? e : new Error(String(e)));
                }
            }
        })();

        return () => { cancelled = true; };
    }, [modelDir]);

    // --- Core stream implementation ---
    const streamImpl = useCallback(async (
        text: string,
        onNext?:  (audio: Float32Array) => void,
        onEnd?:   () => void,
        onBegin?: () => void,
    ): Promise<void> => {
        const sessions = sessionsRef.current;
        const vocab    = vocabRef.current;
        if (!sessions || !vocab) throw new Error('[PocketTTS] Not ready');
        if (voiceMapRef.current.size === 0) throw new Error('[PocketTTS] No voices loaded');

        abortRef.current = false;
        setIsGenerating(true);
        onBegin?.();

        try {
            const { textConditioner, backbone, flowNet, mimiDecoder } = sessions;
            const embWidth = embeddingWidthRef.current;

            // 1. Tokenize
            const processed = preprocessText(text);
            const tokenIds  = tokenize(processed, vocab, unkIdRef.current, maxPieceLenRef.current);
            console.log(`[PocketTTS] Tokenized ${tokenIds.length} tokens for: "${processed}"`);
            if (tokenIds.length === 0) { onEnd?.(); return; }

            // 2. Run text_conditioner: (1, N) int64 → (1, N, embWidth) float32
            const tokenData = new BigInt64Array(tokenIds.map(BigInt));
            const tcOutputs = await textConditioner.run({
                token_ids: new OrtTensor('int64', tokenData, [1, tokenIds.length]),
            }) as Record<string, OrtTensor>;
            let textEmbTensor = tcOutputs[textConditioner.outputNames[0]];
            let textEmbDims   = Array.from(textEmbTensor.dims);

            // Normalize to 3D [1, T, embWidth]
            if (textEmbDims.length === 2) {
                textEmbTensor = new OrtTensor('float32', textEmbTensor.data as Float32Array,
                    [1, textEmbDims[0], textEmbDims[1]]);
                textEmbDims = [1, textEmbDims[0], textEmbDims[1]];
            }
            console.log(`[PocketTTS] text_conditioner OK: output dims=${JSON.stringify(textEmbDims)}`);

            // 3. Select voice
            const selectedVoiceName = activeVoiceNameRef.current
                ?? chooseVoiceName(undefined, availableVoices);
            if (!selectedVoiceName) throw new Error('[PocketTTS] No voice is selected.');
            const descriptor = voiceMapRef.current.get(selectedVoiceName);
            if (!descriptor) throw new Error(`[PocketTTS] Voice '${selectedVoiceName}' is unavailable.`);

            // 4. Reset backbone KV-cache state for this utterance
            backbone.reset();

            // 5. Voice conditioning pass: sequence=[1,0,32], text_embeddings=voiceEmb
            await backbone.conditionVoice(descriptor.voice.data, descriptor.voice.shape);
            if (abortRef.current) { onEnd?.(); return; }

            // 6. Text conditioning pass: sequence=[1,0,32], text_embeddings=textEmb
            await backbone.conditionText(
                textEmbTensor.data as Float32Array,
                textEmbDims as [number, number, number],
            );
            if (abortRef.current) { onEnd?.(); return; }

            // 7. Reset mimi decoder state for this utterance
            mimiDecoder.reset();

            // 8. AR generation loop
            let currSeq     = new Float32Array(32).fill(NaN); // BOS: NaN-filled [1,1,32]
            const allLatents: Float32Array[] = [];
            let decodedFrames = 0;
            let eosStep: number | null = null;
            const dt = 1.0 / LSD_STEPS;

            const decodeChunk = async (fromFrame: number, toFrame: number, emit = true) => {
                const count = toFrame - fromFrame;
                if (count <= 0 || abortRef.current) return;
                const packed = new Float32Array(count * 32);
                for (let i = 0; i < count; i++) packed.set(allLatents[fromFrame + i], i * 32);
                console.log(`[PocketTTS] Mimi decode frames=${count} (${fromFrame}–${toFrame - 1})${emit ? '' : ' [warmup, dropped]'}`);
                const audioData = await mimiDecoder.decode(packed, count);
                if (emit) {
                    console.log(`[PocketTTS] Decoded ${audioData.length} samples`);
                    if (!abortRef.current) onNext?.(new Float32Array(audioData));
                }
                decodedFrames = toFrame;
            };

            for (let step = 0; step < MAX_FRAMES; step++) {
                if (abortRef.current) break;

                // AR step: backbone advances by one frame
                const { conditioning, eos } = await backbone.stepAR(currSeq);
                const isEos = eos > EOS_THRESHOLD;
                if (isEos && eosStep === null) eosStep = step;
                console.log(`[PocketTTS] AR step ${step}: eos=${isEos} (${eos.toFixed(2)}) cond=${JSON.stringify(Array.from(conditioning.dims))}`);

                if (abortRef.current) break;

                // ODE flow steps: Euler integration
                let xData = gaussianNoise32();
                for (let j = 0; j < LSD_STEPS; j++) {
                    if (abortRef.current) break;
                    const sVal = j / LSD_STEPS;
                    const tVal = sVal + dt;
                    const flowOut = await flowNet.run({
                        c: conditioning,
                        s: new OrtTensor('float32', new Float32Array([sVal]), [1, 1]),
                        t: new OrtTensor('float32', new Float32Array([tVal]), [1, 1]),
                        x: new OrtTensor('float32', new Float32Array(xData), [1, 32]),
                    }) as Record<string, OrtTensor>;
                    const dir = (flowOut['flow_dir'] ?? flowOut[flowNet.outputNames[0]]).data as Float32Array;
                    for (let k = 0; k < 32; k++) xData[k] += dir[k] * dt;
                }

                if (abortRef.current) break;

                allLatents.push(new Float32Array(xData));
                currSeq = new Float32Array(xData); // next AR step input

                const shouldStop = eosStep !== null && step >= eosStep + FRAMES_AFTER_EOS;
                const pending    = allLatents.length - decodedFrames;

                if (shouldStop) {
                    // Ensure warmup frames are decoded (state built) even on early EOS
                    if (decodedFrames === 0 && allLatents.length > NAN_WARMUP_FRAMES) {
                        await decodeChunk(0, NAN_WARMUP_FRAMES, false);
                    }
                    await decodeChunk(decodedFrames, allLatents.length);
                    break;
                } else if (decodedFrames === 0 && pending >= NAN_WARMUP_FRAMES + FIRST_CHUNK_FRAMES) {
                    // First: run warmup frames through mimi to build state (no audio emitted)
                    await decodeChunk(0, NAN_WARMUP_FRAMES, false);
                    // Then: emit first real audio chunk
                    await decodeChunk(NAN_WARMUP_FRAMES, NAN_WARMUP_FRAMES + FIRST_CHUNK_FRAMES);
                } else if (decodedFrames > 0 && pending >= NORMAL_CHUNK_FRAMES) {
                    await decodeChunk(decodedFrames, decodedFrames + NORMAL_CHUNK_FRAMES);
                }
            }

            // Final flush
            if (allLatents.length > decodedFrames && !abortRef.current) {
                await decodeChunk(decodedFrames, allLatents.length);
            }
        } finally {
            setIsGenerating(false);
            if (!abortRef.current) onEnd?.();
        }
    }, [availableVoices]);

    const stream = useCallback(async (input: {
        text: string;
        onNext?: (audio: Float32Array) => void;
        onEnd?: () => void;
        onBegin?: () => void;
    }): Promise<void> => {
        return streamImpl(input.text, input.onNext, input.onEnd, input.onBegin);
    }, [streamImpl]);

    const primeVoice = useCallback(async (preference?: string): Promise<string> => {
        if (!sessionsRef.current) {
            throw new Error('[PocketTTS] TTS model is not ready to prime a voice.');
        }
        const selectedName = chooseVoiceName(preference, availableVoices);
        if (!selectedName) throw new Error('[PocketTTS] No available voices to prime.');
        if (!voiceMapRef.current.has(selectedName)) {
            throw new Error(`[PocketTTS] Voice '${selectedName}' is not loaded.`);
        }
        activeVoiceNameRef.current = selectedName;
        console.log(`[PocketTTS] Active voice set: ${selectedName}`);
        return selectedName;
    }, [availableVoices]);

    const forward = useCallback(async (input: { text: string }): Promise<Float32Array> => {
        const chunks: Float32Array[] = [];
        await streamImpl(input.text, audio => chunks.push(audio));
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Float32Array(totalLen);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        return out;
    }, [streamImpl]);

    const streamStop = useCallback(() => {
        abortRef.current = true;
    }, []);

    return { isReady, isGenerating, error, availableVoices, stream, forward, primeVoice, streamStop };
}
