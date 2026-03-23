import * as FileSystem from 'expo-file-system/legacy';

export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;
export const POCKET_TTS_MODEL_DIR = `${FileSystem.documentDirectory}models/pocket-tts`;

export interface ModelSpec {
    name: string;
    files: {
        url: string;
        filename: string;
    }[];
}

const URL_PREFIX = 'https://huggingface.co/software-mansion/react-native-executorch';
const QWEN_TAG = 'resolve/v0.6.0';
const WHISPER_TAG = 'resolve/v0.6.0';
const KOKORO_TAG = 'resolve/v0.7.0';

export const PHI_MODEL: ModelSpec = {
    name: 'Phi-4-Mini-Instruct',
    files: [
        {
            url: 'https://huggingface.co/pytorch/Phi-4-mini-instruct-parq-3w-4e-shared/resolve/main/phi4_model_3bit.pte',
            filename: 'phi4_model_3bit.pte'
        },
        {
            url: 'https://huggingface.co/pytorch/Phi-4-mini-instruct-parq-3w-4e-shared/resolve/main/tokenizer.json',
            filename: 'phi4-tokenizer.json'
        },
        {
            url: 'https://huggingface.co/pytorch/Phi-4-mini-instruct-parq-3w-4e-shared/resolve/main/tokenizer_config.json',
            filename: 'phi4-tokenizer_config.json'
        },
        // Whisper Tokenizer (Shared/Used by Qwen flow in VoiceScreen)
        {
            url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/tokenizer.json`,
            filename: 'whisper-tokenizer.json'
        },
        // Whisper Models (Split: Encoder + Decoder for XNNPACK)
        {
            url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/xnnpack/whisper_tiny_en_encoder_xnnpack.pte`,
            filename: 'whisper_tiny_encoder.pte'
        },
        {
            url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/xnnpack/whisper_tiny_en_decoder_xnnpack.pte`,
            filename: 'whisper_tiny_decoder.pte'
        }
    ]
};

const LFM2_5_REPO_MAIN = 'https://huggingface.co/software-mansion/react-native-executorch-lfm2.5-1.2B-instruct/resolve/main/';
const FSMN_VAD_REPO_MAIN = 'https://huggingface.co/software-mansion/react-native-executorch-fsmn-vad/resolve/main/';

export const LFM2_5_1_2B_INSTRUCT_MODEL: ModelSpec = {
    name: 'LFM2.5-1.2B-Instruct-Quantized',
    files: [
        {
            url: `${LFM2_5_REPO_MAIN}lfm2_5_1_2b_8da4w.pte`,
            filename: 'lfm2_5_1_2b_8da4w.pte'
        },
        {
            url: `${LFM2_5_REPO_MAIN}tokenizer.json`,
            filename: 'lfm-tokenizer.json'
        },
        {
            url: `${LFM2_5_REPO_MAIN}tokenizer_config.json`,
            filename: 'lfm-tokenizer_config.json'
        },
        // Whisper Models (Still needed for STT)
        {
            url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/tokenizer.json`,
            filename: 'whisper-tokenizer.json'
        },
        {
            url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/xnnpack/whisper_tiny_en_encoder_xnnpack.pte`,
            filename: 'whisper_tiny_encoder.pte'
        },
        {
            url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/xnnpack/whisper_tiny_en_decoder_xnnpack.pte`,
            filename: 'whisper_tiny_decoder.pte'
        },
        // FSMN VAD (used for end-of-speech detection)
        {
            url: `${FSMN_VAD_REPO_MAIN}xnnpack/fsmn-vad_xnnpack.pte`,
            filename: 'fsmn-vad_xnnpack.pte'
        }
    ]
};

export const STT_VAD_MODEL: ModelSpec = {
    name: 'STT-VAD',
    files: [
        { url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/tokenizer.json`, filename: 'whisper-tokenizer.json' },
        { url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/xnnpack/whisper_tiny_en_encoder_xnnpack.pte`, filename: 'whisper_tiny_encoder.pte' },
        { url: `${URL_PREFIX}-whisper-tiny.en/${WHISPER_TAG}/xnnpack/whisper_tiny_en_decoder_xnnpack.pte`, filename: 'whisper_tiny_decoder.pte' },
        { url: `${FSMN_VAD_REPO_MAIN}xnnpack/fsmn-vad_xnnpack.pte`, filename: 'fsmn-vad_xnnpack.pte' },
    ]
};

// Qwen 2.5 0.5B (Tiny!)
const QWEN25_TAG = 'resolve/v0.6.0';
export const QWEN_05B_MODEL: ModelSpec = {
    name: 'Qwen-2.5-0.5B-Instruct',
    files: [
        {
            url: `${URL_PREFIX}-qwen-2.5/${QWEN25_TAG}/qwen-2.5-0.5B/quantized/qwen2_5_0_5b_8da4w.pte`,
            filename: 'qwen-2.5-0.5b-quantized.pte'
        },
        {
            url: `${URL_PREFIX}-qwen-2.5/${QWEN25_TAG}/tokenizer.json`,
            filename: 'qwen-tokenizer.json'
        },
        {
            url: `${URL_PREFIX}-qwen-2.5/${QWEN25_TAG}/tokenizer_config.json`,
            filename: 'qwen-tokenizer_config.json'
        }
    ]
};

const POCKET_TTS_BASE = 'https://huggingface.co/sivasub987/Pocket-TTS-ExecuTorch/resolve/main';
const POCKET_TTS_ASSET_BASE = 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main';
const POCKET_TTS_ONNX_BASE = 'https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx';

export const POCKET_TTS_ONNX_MODEL_DIR = `${FileSystem.documentDirectory}models/pocket-tts-onnx`;
export const DEEPFILTERNET_NORMAL_MODEL_DIR = `${FileSystem.documentDirectory}models/deepfilternet-serverless-normal`;

export const POCKET_TTS_ONNX_MODEL: ModelSpec = {
    name: 'Pocket-TTS-ONNX',
    files: [
        { url: `${POCKET_TTS_ONNX_BASE}/text_conditioner.onnx`,  filename: 'pocket-tts-onnx/text_conditioner.onnx' },
        { url: `${POCKET_TTS_ONNX_BASE}/flow_lm_main_int8.onnx`, filename: 'pocket-tts-onnx/flow_lm_main.onnx' },
        { url: `${POCKET_TTS_ONNX_BASE}/flow_lm_flow_int8.onnx`, filename: 'pocket-tts-onnx/flow_lm_flow.onnx' },
        { url: `${POCKET_TTS_ONNX_BASE}/mimi_decoder_int8.onnx`, filename: 'pocket-tts-onnx/mimi_decoder.onnx' },
        { url: `${POCKET_TTS_ONNX_BASE}/mimi_encoder.onnx`,      filename: 'pocket-tts-onnx/mimi_encoder.onnx' },
        { url: `${POCKET_TTS_ASSET_BASE}/tokenizer.model`,        filename: 'pocket-tts-onnx/tokenizer.model' },
        { url: `${POCKET_TTS_ASSET_BASE}/voices.bin`,             filename: 'pocket-tts-onnx/voices.bin' },
    ]
};

const DEEPFILTERNET_HF_BASE = 'https://huggingface.co/niobures/DeepFilterNet/resolve/main/models/onnx/DeepFilterNet-Serverless/normal';

export const DEEPFILTERNET_NORMAL_MODEL: ModelSpec = {
    name: 'DeepFilterNet-Serverless-Normal',
    files: [
        { url: `${DEEPFILTERNET_HF_BASE}/config.ini`,  filename: 'deepfilternet-serverless-normal/config.ini' },
        { url: `${DEEPFILTERNET_HF_BASE}/enc.onnx`,    filename: 'deepfilternet-serverless-normal/enc.onnx' },
        { url: `${DEEPFILTERNET_HF_BASE}/erb_dec.onnx`, filename: 'deepfilternet-serverless-normal/erb_dec.onnx' },
        { url: `${DEEPFILTERNET_HF_BASE}/df_dec.onnx`,  filename: 'deepfilternet-serverless-normal/df_dec.onnx' },
    ]
};

export const POCKET_TTS_MODEL: ModelSpec = {
    name: 'Pocket-TTS',
    files: [
        {
            url: `${POCKET_TTS_BASE}/text_conditioner.pte`,
            filename: 'pocket-tts/text_conditioner.pte'
        },
        {
            url: `${POCKET_TTS_BASE}/flow_lm_main_bundled.pte`,
            filename: 'pocket-tts/flow_lm_main_bundled.pte'
        },
        {
            url: `${POCKET_TTS_BASE}/flow_net.pte`,
            filename: 'pocket-tts/flow_net.pte'
        },
        {
            url: `${POCKET_TTS_BASE}/mimi_decoder.pte`,
            filename: 'pocket-tts/mimi_decoder.pte'
        },
        {
            url: `${POCKET_TTS_ASSET_BASE}/tokenizer.model`,
            filename: 'pocket-tts/tokenizer.model'
        },
        {
            url: `${POCKET_TTS_ASSET_BASE}/voices.bin`,
            filename: 'pocket-tts/voices.bin'
        },
    ]
};

export const KOKORO_MODEL: ModelSpec = {
    name: 'Kokoro-TTS',
    files: [
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/xnnpack/medium/duration_predictor.pte`,
            filename: 'kokoro-duration-predictor.pte'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/xnnpack/medium/synthesizer.pte`,
            filename: 'kokoro-synthesizer.pte'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/voices/af_heart.bin`,
            filename: 'kokoro-voice-af_heart.bin'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/voices/af_river.bin`,
            filename: 'kokoro-voice-af_river.bin'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/voices/af_sarah.bin`,
            filename: 'kokoro-voice-af_sarah.bin'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/voices/am_adam.bin`,
            filename: 'kokoro-voice-am_adam.bin'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/voices/am_michael.bin`,
            filename: 'kokoro-voice-am_michael.bin'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/voices/am_santa.bin`,
            filename: 'kokoro-voice-am_santa.bin'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/phonemizer/us_merged.json`,
            filename: 'kokoro-phonemizer-us_merged.json'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/phonemizer/tags.json`,
            filename: 'kokoro-phonemizer-tags.json'
        },
    ]
};

// Cache loaded paths to prevent re-checking/re-downloading within same session
const CACHED_PATHS: Record<string, Record<string, string>> = {};

const isValidFile = async (fileUri: string): Promise<boolean> => {
    try {
        const info = await FileSystem.getInfoAsync(fileUri);
        if (!info.exists) return false;

        // 1. Check size (filter out tiny error responses)
        if (info.size < 1000) {
            console.log(`[Validation] File ${fileUri} is too small (${info.size} bytes).`);
            return false;
        }

        // 2. Check content header (ensure it's not HTML, even for binaries)
        // Read first 50 bytes as string. If it starts with '<', it's likely an error page.
        try {
            const content = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.UTF8, length: 50 });
            const trimmed = content.trim();
            const isJson = fileUri.endsWith('.json');

            // Fail if HTML (any file) OR if JSON error (non-JSON files)
            // Valid JSON files can start with '{'
            if (trimmed.startsWith('<') || (!isJson && trimmed.startsWith('{'))) {
                console.log(`[Validation] FAILED. Uri: ${fileUri}, IsJson: ${isJson}, Header: ${trimmed.substring(0, 20)}`);
                //console.log(`[Validation] File ${fileUri} appears to be HTML or JSON error (invalid). Header: ${trimmed.substring(0, 20)}`);
                return false;
            }
        } catch (e) {
            // Reading binary as UTF8 failed, which is expected for .pte/.bin files.
            // This confirms it's not a text-based HTML error page.
            // console.log(`[Validation] Binary check passed for ${fileUri}`);
        }

        return true;
    } catch (e) {
        console.log(`[Validation] Error checking file ${fileUri}:`, e);
        return false;
    }
};

// Helper to sum values
const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

// Helper to format bytes
const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const activeDownloads = new Map<string, Promise<string>>();
const activeModelLoads = new Map<string, Promise<Record<string, string>>>();

const downloadFileSafely = async (
    url: string,
    filename: string,
    onProgress?: (written: number, total: number) => void
): Promise<string> => {
    const fileUri = `${MODELS_DIR}${filename}`;

    // 1. Deduplication Check
    if (activeDownloads.has(filename)) {
        console.log(`[Flow] Joining active download for ${filename}...`);
        return activeDownloads.get(filename)!;
    }

    // 2. Validation Check (Skipped if downloading, checked if exists)
    // Note: Caller might have already checked existence, but we check again to be safe 
    // or we assume caller did it. ideally we check.
    // However, for ensureModelExists loop, we might want to skip this if we just deleted it.
    // Let's assume validation happens inside here to be safe, OR we force download.
    // Actually, let's keep it simple: This function DOWNLOADS. It assumes you want to download.

    console.log(`[Flow] Starting download for ${filename}...`);

    // Ensure parent directory exists (supports subdirectories like pocket-tts/)
    const parentDir = fileUri.substring(0, fileUri.lastIndexOf('/'));
    const parentInfo = await FileSystem.getInfoAsync(parentDir);
    if (!parentInfo.exists) {
        await FileSystem.makeDirectoryAsync(parentDir, { intermediates: true });
    }

    let lastLogTime = 0;

    const downloadPromise = (async () => {
        const downloadResumable = FileSystem.createDownloadResumable(
            url,
            fileUri,
            {},
            (downloadProgress) => {
                const total = downloadProgress.totalBytesExpectedToWrite;
                const written = downloadProgress.totalBytesWritten;

                if (onProgress) onProgress(written, total);

                const now = Date.now();
                if (now - lastLogTime > 2000) {
                    console.log(`[${filename}] ${formatBytes(written)} / ${total > 0 ? formatBytes(total) : '?'}`);
                    lastLogTime = now;
                }
            }
        );

        try {
            const result = await downloadResumable.downloadAsync();
            if (result && result.uri && await isValidFile(result.uri)) {
                return result.uri;
            } else {
                // Read and log the file content if it's small (to see if it's a 404 or git-lfs pointer)
                if (result?.uri) {
                    try {
                        const content = await FileSystem.readAsStringAsync(result.uri);
                        console.error(`[Download Fail] Content of ${filename} (${content.length} bytes): ${content.substring(0, 100)}`);
                    } catch (readErr) {
                        console.error(`[Download Fail] Could not read ${filename}`);
                    }
                }
                throw new Error(`Download failed/invalid for ${filename}`);
            }
        } catch (e) {
            console.error(`Error downloading ${filename}:`, e);
            throw e;
        }
    })();

    activeDownloads.set(filename, downloadPromise);
    try {
        return await downloadPromise;
    } finally {
        activeDownloads.delete(filename);
    }
};

export const ensureModelExists = async (model: ModelSpec, onProgress?: (progress: number) => void): Promise<Record<string, string>> => {
    if (activeModelLoads.has(model.name)) {
        console.log(`[ModelLoader] Joining active model load for ${model.name}...`);
        return activeModelLoads.get(model.name)!;
    }

    const loadPromise = (async () => {
    // Return cached if available AND complete
        if (CACHED_PATHS[model.name]) {
            const cachedKeys = Object.keys(CACHED_PATHS[model.name]);
            const requiredKeys = model.files.map(f => f.filename);
            const isComplete = requiredKeys.every(k => cachedKeys.includes(k));

            if (isComplete) {
                console.log(`Using cached paths for ${model.name}`);
                onProgress && onProgress(1);
                return CACHED_PATHS[model.name];
            } else {
                console.log(`Cache for ${model.name} is incomplete. Re-verifying.`);
                delete CACHED_PATHS[model.name];
            }
        }

        const dirInfo = await FileSystem.getInfoAsync(MODELS_DIR);
        if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
        }

        const results: Record<string, string> = {};

        for (let i = 0; i < model.files.length; i++) {
            const { filename, url } = model.files[i];
            const fileUri = `${MODELS_DIR}${filename}`;

            // Validation / Existence Check
            let valid = await isValidFile(fileUri);
            if (valid) {
                console.log(`File ${filename} valid.`);
                results[filename] = fileUri;
                onProgress && onProgress((i + 1) / model.files.length);
                continue;
            } else {
                const info = await FileSystem.getInfoAsync(fileUri);
                if (info.exists) {
                    console.log(`Deleting invalid file: ${filename}`);
                    await FileSystem.deleteAsync(fileUri);
                }
            }

            // Sequential Download via Shared Helper
            results[filename] = await downloadFileSafely(url, filename, (written, total) => {
                const fileContribution = total > 0 ? (written / total) / model.files.length : 0;
                const baseProgress = i / model.files.length;
                if (onProgress) onProgress(baseProgress + fileContribution);
            });
        }

        // Cache success
        CACHED_PATHS[model.name] = results;
        return results;
    })();

    activeModelLoads.set(model.name, loadPromise);
    try {
        return await loadPromise;
    } finally {
        activeModelLoads.delete(model.name);
    }
};

export const downloadAllModels = async (
    onProgress?: (progress: number) => void,
    onStatus?: (status: string) => void
) => {
    const allFiles = [
        ...STT_VAD_MODEL.files.map(f => ({ ...f, model: STT_VAD_MODEL.name })),
        ...POCKET_TTS_ONNX_MODEL.files.map(f => ({ ...f, model: POCKET_TTS_ONNX_MODEL.name })),
        ...DEEPFILTERNET_NORMAL_MODEL.files.map(f => ({ ...f, model: DEEPFILTERNET_NORMAL_MODEL.name })),
    ];

    const totalFiles = allFiles.length;
    const fileProgress = new Array(totalFiles).fill(0);
    const fileWeights = allFiles.map(f => f.filename.includes('Qwen') ? 100 : 1);
    const totalWeight = sum(fileWeights);

    // We update this as we go
    const updateAggregateProgress = () => {
        if (!onProgress) return;
        const currentWeightedSum = fileProgress.reduce((acc, p, idx) => acc + (p * fileWeights[idx]), 0);
        onProgress(currentWeightedSum / totalWeight);
    };

    const dirInfo = await FileSystem.getInfoAsync(MODELS_DIR);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });

    // Sequential Download Loop
    for (let i = 0; i < allFiles.length; i++) {
        const { url, filename } = allFiles[i];
        const fileUri = `${MODELS_DIR}${filename}`;

        // Check if exists first
        if (await isValidFile(fileUri)) {
            console.log(`[Bulk] File ${filename} already exists.`);
            fileProgress[i] = 1;
            updateAggregateProgress();
            continue;
        }

        if (onStatus) onStatus(`Downloading ${filename}...`);

        // Download
        await downloadFileSafely(url, filename, (written, total) => {
            if (total > 0) fileProgress[i] = written / total;
            updateAggregateProgress();
        });

        fileProgress[i] = 1; // Ensure complete
        updateAggregateProgress();
    }

};

export const clearAllModels = async () => {
    try {
        const info = await FileSystem.getInfoAsync(MODELS_DIR);
        if (info.exists) {
            console.log('[ModelLoader] Deleting models directory...');
            await FileSystem.deleteAsync(MODELS_DIR);

            // Clear in-memory cache
            for (const key in CACHED_PATHS) {
                delete CACHED_PATHS[key];
            }
            console.log('[ModelLoader] Models deleted successfully.');
        }
    } catch (e) {
        console.error('[ModelLoader] Error clearing models:', e);
        throw e;
    }
};

export const injectChatTemplate = async (configPath: string) => {
    try {
        const content = await FileSystem.readAsStringAsync(configPath);
        const config = JSON.parse(content);

        if (!config.chat_template) {
            console.log('[ModelLoader] Injecting chat_template into tokenizer_config...');
            // Standard Phi-3 / Phi-4 template
            config.chat_template = "{{ bos_token }}{% for message in messages %}{{'<|' + message['role'] + '|>' + '\n' + message['content'] + '<|end|>' + '\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|assistant|>' + '\n' }}{% else %}{{ eos_token }}{% endif %}";

            await FileSystem.writeAsStringAsync(configPath, JSON.stringify(config, null, 2));
            console.log('[ModelLoader] chat_template injected successfully.');
        } else {
            console.log('[ModelLoader] chat_template already exists.');
        }
    } catch (e) {
        console.error('[ModelLoader] Error injecting chat_template:', e);
    }
};

export const preloadCoreModelsAtLaunch = async (): Promise<void> => {
    try {
        console.log('[ModelLoader] Launch preload started...');
        await ensureModelExists(STT_VAD_MODEL);
        await ensureModelExists(POCKET_TTS_ONNX_MODEL);
        await ensureModelExists(DEEPFILTERNET_NORMAL_MODEL);
        console.log('[ModelLoader] Launch preload complete.');
    } catch (e) {
        console.warn('[ModelLoader] Launch preload failed:', e);
    }
};
