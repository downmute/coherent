import * as FileSystem from 'expo-file-system/legacy';

export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;

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
// Kokoro seems to use v0.7.0 in the library (NEXT_VERSION_TAG)
const KOKORO_TAG = 'resolve/v0.7.0';

export const QWEN_MODEL: ModelSpec = {
    name: 'Qwen3-4B-instruct-8bit',
    files: [
        {
            url: 'https://huggingface.co/pytorch/Qwen3-4B-INT8-INT4/resolve/main/model.pte',
            filename: 'Qwen3-4B-instruct-8bit.pte'
        },
        {
            url: `${URL_PREFIX}-qwen-3/${QWEN_TAG}/tokenizer.json`,
            filename: 'qwen-tokenizer.json'
        },
        {
            url: `${URL_PREFIX}-qwen-3/${QWEN_TAG}/tokenizer_config.json`,
            filename: 'qwen-tokenizer_config.json'
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
        // Voices
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
        // Phonemizer assets
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/phonemizer/us_merged.json`,
            filename: 'kokoro-phonemizer-us_merged.json'
        },
        {
            url: `${URL_PREFIX}-kokoro/${KOKORO_TAG}/phonemizer/tags.json`,
            filename: 'kokoro-phonemizer-tags.json'
        }
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
};

export const downloadAllModels = async (
    onProgress?: (progress: number) => void,
    onStatus?: (status: string) => void
) => {
    const allFiles = [
        ...QWEN_MODEL.files.map(f => ({ ...f, model: QWEN_MODEL.name })),
        ...KOKORO_MODEL.files.map(f => ({ ...f, model: KOKORO_MODEL.name }))
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
