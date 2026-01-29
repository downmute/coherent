import * as FileSystem from 'expo-file-system/legacy';

export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;

export interface ModelSpec {
    name: string;
    files: {
        url: string;
        filename: string;
    }[];
}

export const QWEN_MODEL: ModelSpec = {
    name: 'Qwen3-4B-instruct-8bit',
    files: [{
        url: 'https://huggingface.co/pytorch/Qwen3-4B-INT8-INT4/resolve/main/model.pte',
        filename: 'Qwen3-4B-instruct-8bit.pte'
    }]
};

// Kokoro requires duration predictor and synthesizer.
// Using generic HF URLs typical for this model, or the specific repo user mentioned.
// The user gave: https://huggingface.co/software-mansion/react-native-executorch-kokoro/tree/main
// Be careful with filenames matching what we expect.
const KOKORO_HF_ROOT = 'https://huggingface.co/software-mansion/react-native-executorch-kokoro/resolve/main';

export const KOKORO_MODEL: ModelSpec = {
    name: 'Kokoro-TTS',
    files: [
        {
            url: `${KOKORO_HF_ROOT}/duration_predictor.pte`,
            filename: 'kokoro-duration-predictor.pte'
        },
        {
            url: `${KOKORO_HF_ROOT}/synthesizer.pte`,
            filename: 'kokoro-synthesizer.pte'
        }
    ]
};

export const ensureModelExists = async (model: ModelSpec, onProgress?: (progress: number) => void): Promise<Record<string, string>> => {
    const dirInfo = await FileSystem.getInfoAsync(MODELS_DIR);
    if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
    }

    const results: Record<string, string> = {};
    let totalBytesWritten = 0;
    // This simplistic progress estimate assumes equal size or we just track files count.
    // Better: separate progress per file? We'll just average it for UX.

    for (let i = 0; i < model.files.length; i++) {
        const file = model.files[i];
        const fileUri = `${MODELS_DIR}${file.filename}`;
        const fileInfo = await FileSystem.getInfoAsync(fileUri);

        if (fileInfo.exists) {
            console.log(`File ${file.filename} found at ${fileUri}`);
            results[file.filename] = fileUri;
            onProgress && onProgress((i + 1) / model.files.length);
            continue;
        }

        console.log(`Downloading ${file.filename} from ${file.url}...`);
        const downloadResumable = FileSystem.createDownloadResumable(
            file.url,
            fileUri,
            {},
            (downloadProgress) => {
                // Local progress for this file
                // We could calculate global, but for MVP just showing activity
            }
        );

        try {
            const result = await downloadResumable.downloadAsync();
            if (result && result.uri) {
                console.log(`Downloaded ${file.filename} to ${result.uri}`);
                results[file.filename] = result.uri;
                onProgress && onProgress((i + 1) / model.files.length);
            } else {
                throw new Error(`Download failed for ${file.filename}`);
            }
        } catch (e) {
            console.error(`Error downloading ${file.filename}:`, e);
            throw e;
        }
    }
    return results;
};

export const downloadAllModels = async (onProgress?: (progress: number) => void) => {
    const totalFiles = QWEN_MODEL.files.length + KOKORO_MODEL.files.length;
    let completedFiles = 0;

    const updateProgress = () => {
        completedFiles++;
        if (onProgress) onProgress(completedFiles / totalFiles);
    };

    // Parallel downloads
    await Promise.all([
        ensureModelExists(QWEN_MODEL, () => { /* Partial progress tracking complex, simplifying */ updateProgress(); }),
        ensureModelExists(KOKORO_MODEL, () => { updateProgress(); })
    ]);
};
