import React, { useContext, useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Keyboard,
    Platform,
    StyleSheet,
    Text,
    TouchableOpacity,
    TouchableWithoutFeedback,
    View
} from 'react-native';
import { GeneratingContext } from '../../context/GeneratingContext';

// Libraries
import { useIsFocused } from '@react-navigation/native';
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';
import {
    clearAllModels,
    ensureModelExists,
    PARAKEET_REALTIME_FP16_MODEL,
    PARAKEET_REALTIME_FP16_MODEL_DIR,
    POCKET_TTS_ONNX_MODEL,
    POCKET_TTS_ONNX_MODEL_DIR,
} from '../../services/ModelLoader';
import { useParakeetASR } from '../../hooks/useParakeetASR';
import { useGroqLLM } from '../../hooks/useGroqLLM';
import { usePocketTTS } from '../../hooks/usePocketTTS';
import { SoulxSegmentPlayer } from '../../components/SoulxSegmentPlayer';
import { StreamedAudioPlayer } from '../../services/StreamedAudioPlayer';
import {
    AvatarSessionError,
    AvatarSessionClient,
    createAvatarSession,
    type AvatarSessionResponse,
    type AvatarVideoSegment,
} from '../../services/avatarSession';

const { width } = Dimensions.get('window');

// --- Types & Constants ---

type Scenario = 'small_talk' | 'making_friends' | 'job_interview' | 'dating';
interface Message { role: 'system' | 'user' | 'assistant'; content: string; }

const SCENARIOS: { id: Scenario; label: string; icon: string; promptBase: string }[] = [
    {
        id: 'small_talk',
        label: 'Small Talk',
        icon: '☕',
        promptBase: 'You are a stranger at a coffee shop. We are making casual small talk.'
    },
    {
        id: 'making_friends',
        label: 'Making Friends',
        icon: '👋',
        promptBase: 'You are a potential new friend I just met at a mixer. Be friendly and open.'
    },
    {
        id: 'job_interview',
        label: 'Job Interview',
        icon: '💼',
        promptBase: 'You are a hiring manager for a tech company. Conduct a professional job interview with me.'
    },
    {
        id: 'dating',
        label: 'Date',
        icon: '❤️',
        promptBase: 'You are my date for the evening. Be charming, engaging, and flirtatious if appropriate.'
    },
];

const NAMES = {
    male: ['James', 'David', 'Michael', 'Chris', 'Robert'],
    female: ['Sarah', 'Emily', 'Jessica', 'Jennifer', 'Ashley']
};

const STYLES = ['calm', 'energetic', 'thoughtful', 'witty', 'direct'];
const DEFAULT_CONTEXT_WINDOW_LENGTH = 8;
const HARD_RESET_CONTEXT_WINDOW_LENGTH = 4;
const TOKENIZER_MAX_PLACEHOLDER_THRESHOLD = 1_000_000_000;

const getRandomPersona = (scenarioId: Scenario) => {
    const gender = (Math.random() > 0.5 ? 'male' : 'female') as 'male' | 'female';
    const name = NAMES[gender][Math.floor(Math.random() * NAMES[gender].length)];
    const age = Math.floor(Math.random() * (25 - 18) + 18);
    const style = STYLES[Math.floor(Math.random() * STYLES.length)];

    return {
        name,
        age,
        gender,
        style,
        description: `Name: ${name}. Age: ${age}. Gender: ${gender}. Speaking Style: ${style}.`
    };
};

// --- Helper Functions ---

const buildSystemPrompt = (scenarioPrompt: string, personaDescription: string) => {
    return [
        '#ROLE',
        "You talk like a college student or young adult in a casual voice conversation.\n\n# VOICE-SPECIFIC RULES (CRITICAL)\n1. BREVITY: Keep 90% of responses under 15 words. Never use bulleted lists or long intros. Speak in short bursts.\n2. FILLERS: Use \"um,\" \"uh,\" or \"wait...\" at the start of responses if the question is complex to mask latency.\n3. SPOKEN WORDS: Write how you would actually say it aloud. Use proper words, not texting shorthand. Say \"you,\" not \"u\"; \"though,\" not \"tho\"; \"through,\" not \"thru.\"\n4. CONTRACTIONS: Use natural spoken contractions like \"don't,\" \"can't,\" \"it's,\" and \"should've.\" Avoid stiff formal phrasing unless emphasis matters.\n5. NO DISCLAIMERS: Never say \"As an AI\" or \"I am programmed to.\" If you don't know, say it casually in spoken English.\n\n# TONE & STYLE\n- NO CRINGE SLANG: Do not use \"rizz,\" \"bussin,\" or \"cap.\" It sounds like you're trying too hard.\n- LIGHT CASUAL LANGUAGE: Words like \"lowkey,\" \"highkey,\" and \"literally\" are okay sparingly, but only if they sound natural aloud.\n- OPINIONATED: Have mild preferences. Instead of \"it's subjective,\" say \"honestly, [Option A] is way better.\"\n- SPOKEN, NOT TYPED: Sound like a relaxed person talking, not someone texting. Avoid chat abbreviations like \"lol,\" \"tbh,\" \"fr,\" \"lmk,\" or \"idk\" unless you would literally say them aloud.\n- ENERGY LEVEL: 3/10. You are slightly tired and unbothered. Do not try to be helpful; just be conversational.\n\n# EXAMPLES FOR VOICE CADENCE\nUser: \"What's the move for food?\"\nAI: \"Honestly, just hit the village. Study hall is cool, but everything else is kind of mid.\"\nUser: \"Should I stay up for this?\"\nAI: \"Um... nah, probably not. You should just crash and deal with it tomorrow.\"",
        '#SCENARIO',
        scenarioPrompt,
        '#PERSONA',
        personaDescription,
    ].join('\n');
};

const sanitizeTranscription = (raw: string): string => {
    return raw
        .replace(/\[BLANK_AUDIO\]/gi, '')
        // Remove non-speech markers commonly wrapped in parentheses: (mumbles), (laughs), etc.
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const isMeaningfulSpeech = (text: string): boolean => {
    // Require at least one alphanumeric character after cleanup.
    return /[a-zA-Z0-9]/.test(text);
};

const ensureTerminalPunctuation = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) return trimmed;
    if (/[.!?…,:;]$/.test(trimmed)) return trimmed;
    return `${trimmed}.`;
};

const capitalizeSentenceStart = (text: string): string => {
    return text.replace(/^\s*([a-z])/, (match, letter: string) => match.replace(letter, letter.toUpperCase()));
};

const isNoCapacitySessionError = (error: unknown): boolean => {
    if (error instanceof AvatarSessionError) {
        return error.code === 'no_capacity' || error.code === 'provisioning_timeout';
    }
    if (!(error instanceof Error)) {
        return false;
    }
    return /no warm worker|no warm gpu worker|provisioning.*ready in time/i.test(error.message);
};

const getFriendlyVideoSessionError = (error: unknown): string => {
    if (isNoCapacitySessionError(error)) {
        return 'Avatar video is temporarily unavailable because no warm GPU worker is registered. Continuing with local audio for now.';
    }
    return error instanceof Error ? error.message : String(error);
};

// --- Main Components ---

export type PracticeExperience = 'voice' | 'video';

export function PracticeChatScreenWrapper({
    experience = 'voice',
}: {
    experience?: PracticeExperience;
}) {
    const isFocused = useIsFocused();
    return isFocused ? <VoiceChatScreen experience={experience} /> : null;
}

export default function VoiceChatScreenWrapper() {
    return <PracticeChatScreenWrapper experience="voice" />;
}

function VoiceChatScreen({ experience = 'voice' }: { experience?: PracticeExperience }) {
    const { setGlobalGenerating } = useContext(GeneratingContext);
    const isVideoExperience = experience === 'video';
    const controlPlaneUrl = process.env.EXPO_PUBLIC_CONTROL_PLANE_URL?.trim() ?? '';

    // --- State ---
    const [isRecording, setIsRecording] = useState(false);
    const [recorder] = useState(() => new AudioRecorder());
    const [isPlaying, setIsPlaying] = useState(false);

    // Session State
    const [sessionActive, setSessionActive] = useState(false);
    // Ref to track session state for async callbacks (like onended)
    const sessionActiveRef = useRef(sessionActive);
    const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
    const [pendingSystemPrompt, setPendingSystemPrompt] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [remoteSession, setRemoteSession] = useState<AvatarSessionResponse | null>(null);
    const [remoteRtcConnected, setRemoteRtcConnected] = useState(false);
    const [videoSegments, setVideoSegments] = useState<AvatarVideoSegment[]>([]);
    const [videoSessionError, setVideoSessionError] = useState<string | null>(null);

    // Download State
    const [parakeetPaths, setParakeetPaths] = useState<Record<string, string> | null>(null);
    const [pocketTTSReady, setPocketTTSReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStatus, setDownloadStatus] = useState<string>('Preparing AI systems...');

    // Audio Context
    const audioContextRef = useRef<AudioContext | null>(null);
    const streamedAudioPlayerRef = useRef<StreamedAudioPlayer | null>(null);
    // TTS Streaming State
    // TTS Streaming State
    const sentenceBuffer = useRef<string>('');
    const ttsQueue = useRef<string[]>([]);
    const isProcessingQueue = useRef<boolean>(false);

    // VAD State
    const silenceStartRef = useRef<number | null>(null);
    const isSpeakingRef = useRef<boolean>(false);

    // Audio Scheduling & Auto-Listen Refs
    const activeSourcesRef = useRef<number>(0);
    const isPlayingRef = useRef<boolean>(false); // Sync with isPlaying for closures
    const isLLMGeneratingRef = useRef<boolean>(false);
    const isMountedRef = useRef<boolean>(true); // Track mount status
    const isStartingRef = useRef<boolean>(false); // Lock for setup
    const isRecordingRef = useRef<boolean>(false); // Sync state for loop
    const messagesRef = useRef<Message[]>([]);
    const playbackSpeechMsRef = useRef<number>(0);
    const bargingInRef = useRef<boolean>(false);
    const playbackSuppressUntilRef = useRef<number>(0);
    const llmSendChainRef = useRef<Promise<void>>(Promise.resolve());
    const noiseFloorRef = useRef<number>(0.006);
    const streamStartAtRef = useRef<number>(0);
    const noSpeechStopIssuedRef = useRef<boolean>(false);
    const lastVadLogRef = useRef<number>(0);
    const ttsReadyRef = useRef<boolean>(false);
    const llmReadyRef = useRef<boolean>(false);
    const pendingVoiceReloadRef = useRef<boolean>(false);
    const playbackGenerationRef = useRef<number>(0);
    const activeSystemPromptRef = useRef<string>('');
    const tokenizerModelMaxLengthRef = useRef<number | null>(null);
    const lastPromptTokenCountRef = useRef<number>(0);
    const maxPromptTokenCountRef = useRef<number>(0);
    const llmTurnRef = useRef<number>(0);
    const estimatedRunnerPosRef = useRef<number>(0);
    const sessionRunnerPosStartRef = useRef<number>(0);
    const inferredContextUpperBoundRef = useRef<number | null>(null);
    const llmWasReadyRef = useRef<boolean>(false);
    const vadReadyRef = useRef<boolean>(false);
    const vadGeneratingRef = useRef<boolean>(false);
    const vadChunksRef = useRef<Float32Array[]>([]);
    const vadBufferedSamplesRef = useRef<number>(0);
    const vadWindowStartSampleRef = useRef<number>(0);
    const vadStreamAbsSamplesRef = useRef<number>(0);
    const vadLastInferMsRef = useRef<number>(0);
    const vadLastSpeechEndAbsSampleRef = useRef<number | null>(null);
    const vadStopIssuedRef = useRef<boolean>(false);
    const vadHasSpeechRef = useRef<boolean>(false);
    const vadBusyRef = useRef<boolean>(false);
    const hasAutoLoadTriggeredRef = useRef<boolean>(false);
    const avatarSessionClientRef = useRef<AvatarSessionClient | null>(null);

    const BARGE_IN_MIN_MS = 300;
    const BARGE_IN_COOLDOWN_MS = 250;
    const MIN_BASE_THRESHOLD = 0.009;
    const SILENCE_DURATION_MS = 900;
    const PLAYBACK_THRESHOLD = 0.06;
    const NO_SPEECH_TIMEOUT_MS = 9000;
    const PLAYBACK_TARGET_PEAK = 0.7;
    const PLAYBACK_MAX_GAIN = 12.0;
    const PLAYBACK_OUTPUT_BOOST = 2.5;
    const TTS_FIRST_CHUNK_PREROLL_MS = 45;
    const FSMN_SAMPLE_RATE = 16000;
    const FSMN_VAD_INFER_INTERVAL_MS = 150;
    const FSMN_VAD_END_SILENCE_MS = 700;
    const FSMN_VAD_MIN_SEGMENT_MS = 250;
    const FSMN_VAD_MIN_WAVEFORM_SAMPLES = 3200;
    const FSMN_VAD_MAX_WINDOW_SECONDS = 12;

    const cleanupRemoteSession = React.useCallback(async (reason: string = 'unknown') => {
        console.log('[Avatar Session] cleanup requested:', reason);
        const client = avatarSessionClientRef.current;
        avatarSessionClientRef.current = null;
        setRemoteRtcConnected(false);
        setVideoSegments([]);
        setRemoteSession(null);
        if (client) {
            await client.stop().catch(() => undefined);
        }
    }, []);
    const handleRemoteRtcConnected = React.useCallback((value: boolean) => {
        setRemoteRtcConnected(value);
    }, []);
    const handleRemoteRtcError = React.useCallback((message: string) => {
        setVideoSessionError(message);
    }, []);

    // Animation
    const pulseAnim = useRef(new Animated.Value(1)).current;
    const setupSpinAnim = useRef(new Animated.Value(0)).current;
    const setupPulseAnim = useRef(new Animated.Value(0)).current;

    // 4. Orb Animation (Pulse)

    // --- Effects ---

    // Sync sessionActive to ref
    useEffect(() => {
        sessionActiveRef.current = sessionActive;
    }, [sessionActive]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        console.log('[Avatar Session] remoteSession state=', remoteSession?.sessionId ?? null);
    }, [remoteSession]);

    // 1. Load Models (Manual Trigger now)

    const handleLoadModels = async () => {
        try {
            setLoadError(null);
            setDownloadProgress(0);

            setDownloadStatus('Loading Parakeet realtime...');
            const pPaths = await ensureModelExists(PARAKEET_REALTIME_FP16_MODEL, (p) => setDownloadProgress(Math.max(0, Math.min(0.55, p * 0.55))));
            setParakeetPaths(pPaths);

            setDownloadStatus('Preparing Pocket TTS voices...');
            await ensureModelExists(POCKET_TTS_ONNX_MODEL, (p) => setDownloadProgress(0.55 + Math.max(0, Math.min(0.45, p * 0.45))));
            setPocketTTSReady(true);
            setDownloadProgress(1);

            setDownloadStatus('Ready');
        } catch (e) {
            console.error(e);
            setLoadError(String(e));
            setDownloadStatus('Unable to initialize AI models.');
        }
    };

    useEffect(() => {
        if (hasAutoLoadTriggeredRef.current) return;
        hasAutoLoadTriggeredRef.current = true;
        void handleLoadModels();
    }, []);

    const handleClearModels = async () => {
        try {
            await clearAllModels();
            // Reset paths to null to trigger "Download" UI
            setParakeetPaths(null);
            setPocketTTSReady(false);
            setLoadError(null);
            setDownloadStatus('Models cleared. Ready to download.');
            setDownloadProgress(0);
        } catch (e) {
            console.error(e);
            setDownloadStatus('Error clearing models: ' + e);
        }
    };

    // ...

    const llm = useGroqLLM();

    const parakeetModelDir = parakeetPaths ? PARAKEET_REALTIME_FP16_MODEL_DIR : null;
    const speechToText = useParakeetASR(parakeetModelDir);
    const vad = React.useMemo(() => ({
        isReady: false,
        isGenerating: false,
        error: null as Error | null,
        forward: async (_waveform: Float32Array) => [] as any[],
    }), []);

    const pocketTTSDir = pocketTTSReady ? POCKET_TTS_ONNX_MODEL_DIR : null;
    const tts = usePocketTTS(pocketTTSDir);

    // --- Logic ---

    // Sync global status
    useEffect(() => {
        setGlobalGenerating(
            llm.isGenerating || speechToText.isGenerating || tts.isGenerating
        );
    }, [llm.isGenerating, speechToText.isGenerating, tts.isGenerating, setGlobalGenerating]);

    // Audio Setup (Mount only)
    useEffect(() => {
        // Configure Audio Session for Play and Record
        AudioManager.setAudioSessionOptions({
            iosCategory: 'playAndRecord',
            iosMode: 'voiceChat',
            iosOptions: ['allowBluetoothHFP', 'defaultToSpeaker'],
        });

        // Initialize Audio Context for TTS (Pocket TTS uses 24000Hz)
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
        streamedAudioPlayerRef.current = new StreamedAudioPlayer(audioContextRef.current, {
            sampleRate: 24000,
            targetPeak: PLAYBACK_TARGET_PEAK,
            maxGain: PLAYBACK_MAX_GAIN,
            outputBoost: PLAYBACK_OUTPUT_BOOST,
            firstChunkPrerollMs: TTS_FIRST_CHUNK_PREROLL_MS,
            onActiveSourceCountChange: (count) => {
                activeSourcesRef.current = count;
            },
            onIdle: () => {
                const isActuallyDone =
                    !isLLMGeneratingRef.current &&
                    ttsQueue.current.length === 0 &&
                    !isProcessingQueue.current;

                if (isActuallyDone) {
                    if (sessionActiveRef.current && !isRecordingRef.current) {
                        console.log('[Auto-Listen] Finish detected. Restarting...');
                        startRecordingSafe();
                    }
                    setIsPlaying(false);
                    isPlayingRef.current = false;
                }
            },
        });
        console.log('[Audio] Context initialized');
        isMountedRef.current = true;

        return () => {
            console.log('[Audio] Cleanup...');
            isMountedRef.current = false;
            handleStop();
            void cleanupRemoteSession('audio effect unmount');
            streamedAudioPlayerRef.current?.stopAll();
            streamedAudioPlayerRef.current = null;
            audioContextRef.current?.close();
            audioContextRef.current = null;
        };
    }, [cleanupRemoteSession]);

    // 4. Orb Animation (Pulse)
    useEffect(() => {
        if (llm.isGenerating || isPlaying || isRecording) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 1.2,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [llm.isGenerating, isPlaying, isRecording]);

    const isSetupReady = Boolean(parakeetPaths) && llm.isReady && speechToText.isReady && tts.isReady;

    useEffect(() => {
        if (isSetupReady) return;

        const spinLoop = Animated.loop(
            Animated.timing(setupSpinAnim, {
                toValue: 1,
                duration: 1800,
                useNativeDriver: true,
            })
        );
        const pulseLoop = Animated.loop(
            Animated.sequence([
                Animated.timing(setupPulseAnim, {
                    toValue: 1,
                    duration: 1200,
                    useNativeDriver: true,
                }),
                Animated.timing(setupPulseAnim, {
                    toValue: 0,
                    duration: 1200,
                    useNativeDriver: true,
                }),
            ])
        );

        spinLoop.start();
        pulseLoop.start();
        return () => {
            spinLoop.stop();
            pulseLoop.stop();
            setupSpinAnim.setValue(0);
            setupPulseAnim.setValue(0);
        };
    }, [isSetupReady, setupPulseAnim, setupSpinAnim]);

    // Keep ref synchronized for queued audio completion checks.
    useEffect(() => {
        isLLMGeneratingRef.current = llm.isGenerating;
    }, [llm.isGenerating]);

    useEffect(() => {
        ttsReadyRef.current = tts.isReady;
    }, [tts.isReady]);

    useEffect(() => {
        llmReadyRef.current = llm.isReady;
        const wasReady = llmWasReadyRef.current;
        llmWasReadyRef.current = llm.isReady;
        if (llm.isReady && !wasReady) {
            estimatedRunnerPosRef.current = 0;
            sessionRunnerPosStartRef.current = 0;
            inferredContextUpperBoundRef.current = null;
            console.log('[LLM Diag] LLM loaded. Reset estimated runner position.');
        }
    }, [llm.isReady]);

    useEffect(() => {
        vadReadyRef.current = vad.isReady;
    }, [vad.isReady]);

    useEffect(() => {
        vadGeneratingRef.current = vad.isGenerating;
    }, [vad.isGenerating]);

    useEffect(() => {
        if (speechToText.error) {
            console.warn('[Parakeet] Model error:', speechToText.error);
            setLoadError(speechToText.error.message);
            setDownloadStatus('Parakeet failed to initialize.');
        }
    }, [speechToText.error]);

    useEffect(() => {
        if (!tts.error) return;
        setLoadError(tts.error.message);
        setDownloadStatus('Pocket TTS native module failed to initialize.');
    }, [tts.error]);


    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const waitUntil = async (
        predicate: () => boolean,
        timeoutMs: number,
        pollMs: number = 40
    ): Promise<boolean> => {
        const start = Date.now();
        while (!predicate()) {
            if (Date.now() - start >= timeoutMs) return false;
            await sleep(pollMs);
        }
        return true;
    };

    const waitForTTSReady = async (timeoutMs: number = 6000): Promise<boolean> => {
        return waitUntil(() => ttsReadyRef.current, timeoutMs);
    };

    const waitForTTSReloadCycle = async (): Promise<boolean> => {
        // If voice/model config changed, we expect delete->load to briefly flip readiness.
        const sawUnload = await waitUntil(() => !ttsReadyRef.current, 1500);
        if (sawUnload) {
            return waitUntil(() => ttsReadyRef.current, 8000);
        }
        return waitForTTSReady(8000);
    };

    const getUsableTokenizerMax = (): number | null => {
        const raw = tokenizerModelMaxLengthRef.current;
        if (!raw || !Number.isFinite(raw) || raw <= 0) return null;
        if (raw >= TOKENIZER_MAX_PLACEHOLDER_THRESHOLD) return null;
        return raw;
    };

    const logRunnerPosEstimate = (
        label: string,
        promptTokens: number,
        generatedTokens: number,
        accumulate: boolean
    ) => {
        const promptSafe = Math.max(0, promptTokens);
        const generatedSafe = Math.max(0, generatedTokens);
        const delta = promptSafe + generatedSafe;
        const before = estimatedRunnerPosRef.current;
        const after = accumulate ? before + delta : before;
        if (accumulate) {
            estimatedRunnerPosRef.current = after;
        }
        const sessionDelta = Math.max(0, after - sessionRunnerPosStartRef.current);
        const tokenizerMax = getUsableTokenizerMax();
        const usage = tokenizerMax
            ? ` tokenizerMax=${tokenizerMax} estRunnerUsage=${((after / tokenizerMax) * 100).toFixed(1)}%`
            : '';
        console.log(
            `[LLM Diag] ${label} estRunnerPos=${after}${accumulate ? ` (+${delta})` : ''} sessionPos=${sessionDelta}${usage}`
        );
    };

    const logLLMTokenStats = (label: string, options?: { accumulateRunnerPos?: boolean }) => {
        try {
            const promptTokens = llm.getPromptTokenCount();
            const generatedTokens = llm.getGeneratedTokenCount();
            const totalTokens = llm.getTotalTokenCount();
            lastPromptTokenCountRef.current = promptTokens;
            if (promptTokens > maxPromptTokenCountRef.current) {
                maxPromptTokenCountRef.current = promptTokens;
            }
            const tokenizerMax = getUsableTokenizerMax();
            const usage =
                tokenizerMax && tokenizerMax > 0
                    ? ` tokenizerMax=${tokenizerMax} usage=${((promptTokens / tokenizerMax) * 100).toFixed(1)}%`
                    : '';
            console.log(
                `[LLM Diag] ${label} prompt=${promptTokens} generated=${generatedTokens} total=${totalTokens} maxSeen=${maxPromptTokenCountRef.current}${usage}`
            );
            logRunnerPosEstimate(
                label,
                promptTokens,
                generatedTokens,
                options?.accumulateRunnerPos ?? false
            );
            return { promptTokens, generatedTokens, totalTokens };
        } catch (e) {
            console.warn('[LLM Diag] Token stats unavailable:', e);
            return null;
        }
    };

    const resetIntelligentVadState = () => {
        vadChunksRef.current = [];
        vadBufferedSamplesRef.current = 0;
        vadWindowStartSampleRef.current = 0;
        vadStreamAbsSamplesRef.current = 0;
        vadLastInferMsRef.current = 0;
        vadLastSpeechEndAbsSampleRef.current = null;
        vadStopIssuedRef.current = false;
        vadHasSpeechRef.current = false;
        vadBusyRef.current = false;
    };

    const pushVadAudioChunk = (chunk: Float32Array) => {
        const copied = new Float32Array(chunk.length);
        copied.set(chunk);
        vadChunksRef.current.push(copied);
        vadBufferedSamplesRef.current += copied.length;
        vadStreamAbsSamplesRef.current += copied.length;

        const maxWindowSamples = FSMN_SAMPLE_RATE * FSMN_VAD_MAX_WINDOW_SECONDS;
        while (vadBufferedSamplesRef.current > maxWindowSamples && vadChunksRef.current.length > 1) {
            const removed = vadChunksRef.current.shift();
            if (!removed) break;
            vadBufferedSamplesRef.current -= removed.length;
            vadWindowStartSampleRef.current += removed.length;
        }
    };

    const buildVadWaveform = (): Float32Array | null => {
        const total = vadBufferedSamplesRef.current;
        if (total < FSMN_VAD_MIN_WAVEFORM_SAMPLES) return null;
        const merged = new Float32Array(total);
        let offset = 0;
        for (const chunk of vadChunksRef.current) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return merged;
    };

    const maybeRunIntelligentVad = (nowMs: number) => {
        if (!vadReadyRef.current || vadBusyRef.current || vadGeneratingRef.current) return;
        if (nowMs - vadLastInferMsRef.current < FSMN_VAD_INFER_INTERVAL_MS) return;

        const waveform = buildVadWaveform();
        if (!waveform) return;

        vadLastInferMsRef.current = nowMs;
        vadBusyRef.current = true;
        const windowStartAbsSample = vadWindowStartSampleRef.current;

        void vad.forward(waveform)
            .then((segments: any) => {
                if (!Array.isArray(segments)) return;

                let latestAbsEnd: number | null = null;
                const minSegmentSamples = Math.floor((FSMN_VAD_MIN_SEGMENT_MS / 1000) * FSMN_SAMPLE_RATE);
                for (const seg of segments) {
                    const start = typeof seg?.start === 'number' ? seg.start : -1;
                    const end = typeof seg?.end === 'number' ? seg.end : -1;
                    if (start < 0 || end <= start) continue;
                    if (end - start < minSegmentSamples) continue;
                    const absEnd = windowStartAbsSample + end;
                    if (latestAbsEnd == null || absEnd > latestAbsEnd) {
                        latestAbsEnd = absEnd;
                    }
                }

                if (latestAbsEnd != null) {
                    vadHasSpeechRef.current = true;
                    vadLastSpeechEndAbsSampleRef.current = latestAbsEnd;
                    noSpeechStopIssuedRef.current = false;
                    isSpeakingRef.current = true;
                }

                const speechEndAbs = vadLastSpeechEndAbsSampleRef.current;
                if (speechEndAbs == null || vadStopIssuedRef.current) return;

                const trailingSilenceSamples = vadStreamAbsSamplesRef.current - speechEndAbs;
                const requiredSilenceSamples = Math.floor((FSMN_VAD_END_SILENCE_MS / 1000) * FSMN_SAMPLE_RATE);
                if (trailingSilenceSamples < requiredSilenceSamples) return;

                vadStopIssuedRef.current = true;
                isSpeakingRef.current = false;
                silenceStartRef.current = null;
                console.log(
                    `[VAD+FSMN] End-of-speech detected. trailingMs=${Math.round((trailingSilenceSamples / FSMN_SAMPLE_RATE) * 1000)}`
                );
                try {
                    speechToText.streamStop();
                    console.log('[VAD] Triggered streamStop() via FSMN.');
                } catch (e) {
                    console.error('[VAD+FSMN] streamStop failed:', e);
                }
            })
            .catch((e) => {
                console.warn('[VAD+FSMN] forward error:', e);
            })
            .finally(() => {
                vadBusyRef.current = false;
            });
    };

    // Deferred session start: configure LLM system prompt and trigger greeting.
    useEffect(() => {
        if (pendingSystemPrompt && tts.isReady && llm.isReady) {
            const systemPrompt = pendingSystemPrompt;
            const shouldWaitForVoiceReload = pendingVoiceReloadRef.current;
            pendingVoiceReloadRef.current = false;
            setPendingSystemPrompt(null);
            console.log('[Session] Configuring system prompt...');

            (async () => {
                try {
                    const ttsReady = shouldWaitForVoiceReload
                        ? await waitForTTSReloadCycle()
                        : await waitForTTSReady(6000);
                    if (!ttsReady) {
                        console.warn('[Session] TTS did not become ready in time. Requeueing session start.');
                        if (sessionActiveRef.current) {
                            setPendingSystemPrompt(systemPrompt);
                        }
                        return;
                    }
                    if (!sessionActiveRef.current || !llmReadyRef.current || !ttsReadyRef.current) {
                        return;
                    }
                    const shouldUseRemoteAvatar =
                        isVideoExperience && Boolean(remoteSession || avatarSessionClientRef.current);
                    if (shouldUseRemoteAvatar) {
                        const remoteReady = await waitForAvatarSessionReady();
                        if (!remoteReady) {
                            const message = 'Timed out waiting for avatar worker before first greeting.';
                            console.error('[Avatar Session] ' + message);
                            setVideoSessionError(message);
                            await cleanupRemoteSession('avatar wait before first greeting timed out');
                        }
                    }

                    activeSystemPromptRef.current = systemPrompt;
                    llm.configure({
                        chatConfig: {
                            systemPrompt,
                            initialMessageHistory: [],
                            contextWindowLength: DEFAULT_CONTEXT_WINDOW_LENGTH,
                        },
                    });
                    llmTurnRef.current = 0;
                    lastPromptTokenCountRef.current = 0;
                    maxPromptTokenCountRef.current = 0;
                    sessionRunnerPosStartRef.current = estimatedRunnerPosRef.current;
                    console.log(
                        `[LLM Diag] Session configured contextWindowLength=${DEFAULT_CONTEXT_WINDOW_LENGTH} systemPromptChars=${systemPrompt.length}`
                    );
                    console.log(
                        `[LLM Diag] Session baseline estRunnerPos=${sessionRunnerPosStartRef.current}`
                    );

                    setMessages([]);
                    messagesRef.current = [];
                    await handleLLMGenerate('Organically greet your partner, ask one friendly question.');
                    console.log('[Session] Prompt configured and greeting triggered.');
                } catch (e) {
                    console.error('[Session] Failed to configure/start session:', e);
                }
            })();
        } else if (pendingSystemPrompt) {
            console.log(
                "[Session] Waiting for models... TTS:",
                tts.isReady ? "Ready" : "Not Ready",
                "LLM:",
                llm.isReady ? "Ready" : "Not Ready",
                "ASR:",
                speechToText.isReady ? "Ready" : "Not Ready"
            );
        }
    }, [pendingSystemPrompt, tts.isReady, llm.isReady, speechToText.isReady, llm.configure]);


    // --- TTS Streaming Logic ---

    // 1. Process Queue
    const processQueue = async () => {
        if (isProcessingQueue.current) return;
        isProcessingQueue.current = true;

        while (ttsQueue.current.length > 0 && sessionActiveRef.current) {
            const text = ttsQueue.current.shift();
            if (text) {
                await playAudioChunk(text);
            }
        }

        isProcessingQueue.current = false;

        // If generation is done AND queue is empty, restart recording
        if (!llm.isGenerating && sessionActiveRef.current && !isRecordingRef.current && !isStartingRef.current) {
            console.log('[Auto-Listen] All chunks played. Restarting...');
            startRecordingSafe();
        }
    };

    const handleStop = () => {
        if (llm.isGenerating) llm.interrupt();
        playbackGenerationRef.current += 1;
        try {
            tts.streamStop();
        } catch { }
        ttsQueue.current = []; // Clear queue
        sentenceBuffer.current = '';
        streamedAudioPlayerRef.current?.stopAll();
        activeSourcesRef.current = 0;
        setIsPlaying(false);
        isPlayingRef.current = false;
        setIsRecording(false);
        isRecordingRef.current = false;
        isStartingRef.current = false;
        playbackSpeechMsRef.current = 0;
        bargingInRef.current = false;
        streamStartAtRef.current = 0;
        noSpeechStopIssuedRef.current = false;
        llmSendChainRef.current = Promise.resolve();
        setPendingSystemPrompt(null);
        pendingVoiceReloadRef.current = false;
        activeSystemPromptRef.current = '';
        llmTurnRef.current = 0;
        lastPromptTokenCountRef.current = 0;
        maxPromptTokenCountRef.current = 0;
        resetIntelligentVadState();
        silenceStartRef.current = null;
        isSpeakingRef.current = false;
        setVideoSessionError(null);
        void cleanupRemoteSession('handleStop');

        // Explicitly stop recorder cleanup (since we keep it running now)
        try {
            recorder.stop();
            recorder.clearOnAudioReady();
            console.log('[Recorder] Stopped and cleared.');
        } catch (e) { }
    };

    const stopPlaybackForBargeIn = async () => {
        if (bargingInRef.current) return;
        bargingInRef.current = true;
        playbackSpeechMsRef.current = 0;
        playbackGenerationRef.current += 1;

        try {
            if (llm.isGenerating) {
                llm.interrupt();
            }
            try {
                tts.streamStop();
            } catch { }
            ttsQueue.current = [];
            sentenceBuffer.current = '';
            streamedAudioPlayerRef.current?.stopAll();
            activeSourcesRef.current = 0;
            setIsPlaying(false);
            isPlayingRef.current = false;
            playbackSuppressUntilRef.current = Date.now() + BARGE_IN_COOLDOWN_MS;
        } finally {
            bargingInRef.current = false;
        }
    };

    const waitForLLMIdle = async (timeoutMs: number = 1500) => {
        const start = Date.now();
        while ((llm.isGenerating || isLLMGeneratingRef.current) && Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 25));
        }
    };

    const waitForAvatarSessionReady = async (timeoutMs: number = 15000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (avatarSessionClientRef.current?.isReady()) {
                return true;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        return false;
    };

    const handleStartSession = async () => {
        if (!selectedScenario || !llm.isReady || !tts.isReady || !speechToText.isReady) {
            console.log("Not ready to start:", {
                scenario: !!selectedScenario,
                llm: llm.isReady,
                tts: tts.isReady,
                asr: speechToText.isReady
            });
            return;
        }

        const p = getRandomPersona(selectedScenario);
        const scenarioDef = SCENARIOS.find(s => s.id === selectedScenario);
        const systemPrompt = buildSystemPrompt(
            scenarioDef?.promptBase || 'Have a short natural conversation.',
            p.description
        );

        if (isVideoExperience && controlPlaneUrl) {
            setVideoSessionError(null);
            setVideoSegments([]);
            setRemoteRtcConnected(false);
            try {
                console.log('[Avatar Session] controlPlaneUrl=', controlPlaneUrl);
                console.log('[Avatar Session] creating control-plane session...');
                const created = await createAvatarSession(controlPlaneUrl, {
                    avatarId: p.gender === 'female' ? 'default-female' : 'default-male',
                    gender: p.gender,
                });
                console.log('[Avatar Session] control-plane session created', created);

                const client = new AvatarSessionClient(created, {
                    onError: (message) => {
                        console.error('[Avatar Session] Worker error:', message);
                        setVideoSessionError(message);
                    },
                    onStopped: () => {
                        setRemoteRtcConnected(false);
                    },
                    onVideoSegment: (segment) => {
                        console.log(
                            `[Avatar Session] video segment ready index=${segment.segmentIndex} final=${String(segment.final)} url=${segment.url}`,
                        );
                        setRemoteRtcConnected(true);
                        setVideoSegments((existing) => {
                            if (
                                existing.some(
                                    (entry) =>
                                        entry.sessionId === segment.sessionId &&
                                        entry.segmentIndex === segment.segmentIndex,
                                )
                            ) {
                                return existing;
                            }
                            return [...existing, segment].sort((left, right) => left.segmentIndex - right.segmentIndex);
                        });
                    },
                });
                console.log('[Avatar Session] connecting worker websocket...', created.workerWsUrl);
                await client.connect();
                console.log('[Avatar Session] worker websocket connected');
                avatarSessionClientRef.current = client;
                setRemoteSession(created);
                console.log('[Avatar Session] remote session created', created);
            } catch (e) {
                const message = getFriendlyVideoSessionError(e);
                if (isNoCapacitySessionError(e)) {
                    console.warn('[Avatar Session] Remote avatar unavailable, falling back to local audio.', e);
                } else {
                    console.error('[Avatar Session] Failed to start remote session:', e);
                }
                setVideoSessionError(message);
                if (!isNoCapacitySessionError(e)) {
                    setLoadError(`Video session failed: ${message}`);
                    return;
                }
                await cleanupRemoteSession('remote start no capacity');
            }
        } else if (isVideoExperience && !controlPlaneUrl) {
            console.warn('[Avatar Session] EXPO_PUBLIC_CONTROL_PLANE_URL is not set; video tab will stay local-only.');
        }

        try {
            const primedVoice = await tts.primeVoice(p.gender);
            console.log(`[TTS] Primed voice '${primedVoice}' for persona gender='${p.gender}'`);
        } catch (e) {
            console.error('[TTS] Failed to prime selected voice:', e);
            setLoadError(`Voice priming failed: ${e instanceof Error ? e.message : String(e)}`);
            void cleanupRemoteSession('tts prime failure');
            return;
        }

        pendingVoiceReloadRef.current = false;
        activeSystemPromptRef.current = systemPrompt;
        setMessages([]);
        messagesRef.current = [];
        setSessionActive(true);
        setPendingSystemPrompt(systemPrompt); // Store prompt to send in useEffect
    };

    const handleEndSession = () => {
        setSessionActive(false);
        sessionActiveRef.current = false;
        handleStop();
        setSelectedScenario(null);
    };

    const handleRecordPress = async () => {
        if (!parakeetPaths || !tts.isReady) return;
        if (isStartingRef.current) return; // Prevent double-entry
        isStartingRef.current = true;

        // Check permissions first
        console.log('[Permissions] Requesting microphone access...');
        const perm = await AudioManager.requestRecordingPermissions();
        console.log('[Permissions] Result:', JSON.stringify(perm));

        // Normalize permission response shape across SDK versions.
        const permissionStatus =
            typeof perm === 'object' && perm !== null && 'status' in (perm as object)
                ? String((perm as { status?: unknown }).status ?? '')
                : String(perm);
        const normalizedPermissionStatus = permissionStatus.trim().toLowerCase();
        const hasGrantedFlag =
            typeof perm === 'object' &&
            perm !== null &&
            'granted' in (perm as object) &&
            Boolean((perm as { granted?: unknown }).granted);

        if (!hasGrantedFlag && normalizedPermissionStatus !== 'granted' && normalizedPermissionStatus !== 'authorized') {
            alert('Microphone permission denied');
            isStartingRef.current = false;
            return;
        }

        // Clean up any existing listeners to prevent duplicates
        recorder.clearOnAudioReady();

        // Allow recorder startup during playback for barge-in detection.
        // Stopping the session here mutes TTS before audio can be heard.

        if (isRecordingRef.current) {
            console.log('[Recorder] Stopping manually...');
            setIsRecording(false);
            isRecordingRef.current = false;
            recorder.stop();
            recorder.clearOnAudioReady();
            try {
                speechToText.streamStop();
            } catch (e) {
                console.warn('[Recorder] streamStop error:', e);
            }
            isStartingRef.current = false;
        } else {
            console.log('[Recorder] Starting...');
            setIsRecording(true);
            isRecordingRef.current = true; // Sync ref
            recorder.clearOnAudioReady(); // Clear listeners before adding new ones
            // Reset VAD state
            silenceStartRef.current = null;
            isSpeakingRef.current = false;
            noSpeechStopIssuedRef.current = false;
            streamStartAtRef.current = Date.now();
            resetIntelligentVadState();

            // Debug: Add Error Listener
            recorder.onError((e) => {
                console.error('[Recorder] onError event:', JSON.stringify(e));
            });

            // Activate Audio Session
            try {
                const active = await AudioManager.setAudioSessionActivity(true);
                console.log('[Recorder] Audio Session Active:', active);
            } catch (e) {
                console.error('[Recorder] Failed to activate audio session:', e);
            }

            const sampleRate = 16000; // Hardcoded to 16k for STT
            console.log('[Recorder] Using sample rate:', sampleRate);

            const readyResult = recorder.onAudioReady({
                sampleRate: sampleRate,
                bufferLength: 1600, // 0.1 * 16000
                channelCount: 1,
            }, ({ buffer }) => {
                const data = buffer.getChannelData(0);

                // --- VAD Logic First ---
                let sum = 0;
                for (let i = 0; i < data.length; i++) {
                    sum += data[i] * data[i];
                }
                const rms = Math.sqrt(sum / data.length);
                const chunkDurationMs = (data.length / sampleRate) * 1000;
                const now = Date.now();

                // Use Ref current value to avoid stale closure issues
                const isPlayback = activeSourcesRef.current > 0 || isPlayingRef.current;
                const isInBargeCooldown = now < playbackSuppressUntilRef.current;
                const noiseAlpha = 0.05;
                if (!isPlayback && !isSpeakingRef.current) {
                    noiseFloorRef.current = (1 - noiseAlpha) * noiseFloorRef.current + noiseAlpha * rms;
                }
                const adaptiveBaseThreshold = Math.max(MIN_BASE_THRESHOLD, noiseFloorRef.current * 2.2);
                const SPEECH_THRESHOLD = isPlayback ? PLAYBACK_THRESHOLD : adaptiveBaseThreshold;

                if (isPlayback) {
                    if (rms > SPEECH_THRESHOLD) {
                        playbackSpeechMsRef.current += chunkDurationMs;
                        if (playbackSpeechMsRef.current >= BARGE_IN_MIN_MS && !bargingInRef.current) {
                            console.log('[Barge-In] User speech detected over playback. Interrupting TTS/LLM.');
                            void stopPlaybackForBargeIn();
                        }
                    } else {
                        playbackSpeechMsRef.current = Math.max(0, playbackSpeechMsRef.current - chunkDurationMs * 0.5);
                    }
                    // During playback we do half-duplex input gating to avoid self-transcription.
                    return;
                } else {
                    playbackSpeechMsRef.current = 0;
                }

                if (isInBargeCooldown) {
                    // Short cooldown after interruption to avoid immediately re-consuming tail audio.
                    return;
                }

                const shouldApplyNoSpeechTimeout = vadReadyRef.current
                    ? !vadHasSpeechRef.current
                    : !isSpeakingRef.current;
                if (shouldApplyNoSpeechTimeout && !noSpeechStopIssuedRef.current && streamStartAtRef.current > 0) {
                    const noSpeechElapsed = now - streamStartAtRef.current;
                    if (noSpeechElapsed > NO_SPEECH_TIMEOUT_MS) {
                        noSpeechStopIssuedRef.current = true;
                        console.log('[VAD] No speech timeout. Restarting stream.');
                        try {
                            speechToText.streamStop();
                        } catch (e) {
                            console.error('[VAD] no-speech streamStop failed:', e);
                        }
                        return;
                    }
                }

                // Guard streamInsert
                try {
                    speechToText.streamInsert(data);
                } catch (e) {
                    // console.warn('[STT] streamInsert failed:', e);
                }
                if (vadReadyRef.current) {
                    pushVadAudioChunk(data);
                    maybeRunIntelligentVad(now);
                }

                // Sparse diagnostics for threshold tuning
                if (!isPlayback && now - lastVadLogRef.current > 1500) {
                    console.log(`[VAD] RMS=${rms.toFixed(4)} floor=${noiseFloorRef.current.toFixed(4)} threshold=${SPEECH_THRESHOLD.toFixed(4)}`);
                    lastVadLogRef.current = now;
                }

                if (rms > SPEECH_THRESHOLD) {
                    if (!isSpeakingRef.current) {
                        console.log('[VAD] Speech detected (RMS:', rms.toFixed(4), ')');
                    }
                    noSpeechStopIssuedRef.current = false;
                    isSpeakingRef.current = true;
                    silenceStartRef.current = null; // Reset silence timer
                } else {
                    // Fallback only: if FSMN VAD isn't ready, use RMS silence timer.
                    if (!vadReadyRef.current && isSpeakingRef.current) {
                        // We were speaking, now we are silent. Start counting?
                        if (silenceStartRef.current === null) {
                            silenceStartRef.current = Date.now();
                        } else {
                            const diff = Date.now() - silenceStartRef.current;
                            if (diff > SILENCE_DURATION_MS) {
                                console.log('[VAD] Silence detected for', diff, 'ms. Stopping.');

                                // FORCE STOP the STREAM only, NOT the recorder
                                // We keep the recorder running so the NEXT loop iteration catches data immediately!
                                isSpeakingRef.current = false; // Reset VAD state manually for next turn
                                silenceStartRef.current = null;

                                try {
                                    speechToText.streamStop(); // This resolves the main promise
                                    console.log('[VAD] Triggered streamStop()');
                                } catch (e) {
                                    console.error('[VAD] streamStop died:', e);
                                }
                            }
                        }
                    }
                }
            });
            console.log('[Recorder] onAudioReady setup result:', JSON.stringify(readyResult));

            const startResult = recorder.start();
            console.log('[Recorder] start result:', JSON.stringify(startResult));

            // Wait for stream
            try {
                // Loop to capture continuous utterances
                // We use isRecordingRef for the loop condition
                while (isRecordingRef.current && sessionActiveRef.current) {
                    if (!speechToText.isGenerating && !isPlayingRef.current && activeSourcesRef.current === 0) {
                        console.log('[STT Stream] Starting stream loop...');
                        resetIntelligentVadState();
                        streamStartAtRef.current = Date.now();
                        noSpeechStopIssuedRef.current = false;

                        const resultText = await speechToText.stream();
                        streamStartAtRef.current = 0;

                        if (resultText && resultText.trim()) {
                            const text = sanitizeTranscription(resultText);

                            if (!text || !isMeaningfulSpeech(text)) {
                                console.log('[STT] Ignoring blank/noise:', resultText);
                            } else {
                                console.log('[STT Stream] Result: ', text);
                                const userMessage = { role: 'user', content: text } as Message;
                                setMessages(prev => {
                                    const next = [...prev, userMessage];
                                    messagesRef.current = next;
                                    return next;
                                });

                                // DO NOT AWAIT! Fire and forget to keep listening (Barge-In)
                                handleLLMGenerate(text).catch(e => console.error(e));
                            }
                        }
                    } else {
                        // Wait a bit
                        await new Promise(r => setTimeout(r, 60));
                    }

                    // Break loop if not recording anymore (we need a way to check current state in loop)
                    // If startRecordingSafe called setIsRecording(true), we want to stay in loop.
                    // But we don't have a ref for isRecording!
                    // Let's rely on sessionActiveRef for now as a safeguard?
                    // And check if we should stop.
                }
            } catch (e) {
                console.warn('[Recorder] stream loop error:', JSON.stringify(e));
            } finally {
                isStartingRef.current = false;
            }
        }
    };

    const handleLLMGenerate = (userText: string) => {
        if (!userText || !userText.trim()) return Promise.resolve();

        llmSendChainRef.current = llmSendChainRef.current
            .catch(() => { })
            .then(async () => {
                if (!sessionActiveRef.current || !llm.isReady) return;

                if (llm.isGenerating || isLLMGeneratingRef.current || isPlayingRef.current || activeSourcesRef.current > 0) {
                    await stopPlaybackForBargeIn();
                    await new Promise(r => setTimeout(r, 40));
                }
                await waitForLLMIdle();

                isLLMGeneratingRef.current = true;
                try {
                    llmTurnRef.current += 1;
                    const turn = llmTurnRef.current;
                    const history = Array.isArray(llm.messageHistory) ? llm.messageHistory : [];
                    console.log(
                        `[LLM Diag] Turn=${turn} pre-send historyMsgs=${history.length} userChars=${userText.length}`
                    );

                    console.log('[LLM] Sending user message:', userText);
                    await llm.sendMessage(userText, {
                        onToken: (token) => {
                            if (!sessionActiveRef.current) return;
                            sentenceBuffer.current += token;
                        },
                    });
                    // Flush remaining buffer after generation ends
                    if (sentenceBuffer.current.trim().length > 0) {
                        console.log('[TTS Stream] Full response flush:', sentenceBuffer.current.trim());
                        ttsQueue.current.push(sentenceBuffer.current.trim());
                        sentenceBuffer.current = '';
                        processQueue();
                    }
                    console.log('[LLM] User message sent.');
                } catch (e: any) {
                    const message = e?.message ?? String(e);
                    console.error(`[LLM] Generate Error: ${message}`, e);
                } finally {
                    isLLMGeneratingRef.current = false;
                }
            });

        return llmSendChainRef.current;
    };

    const startRecordingSafe = () => {
        if (!isRecordingRef.current && !isStartingRef.current && sessionActiveRef.current) {
            handleRecordPress();
        }
    };

    const playAudioChunk = async (text: string) => {
        const normalizedText = ensureTerminalPunctuation(
            capitalizeSentenceStart(text.replace(/\s+/g, ' ').trim())
        );
        if (!normalizedText) return;
        // Skip punctuation-only chunks ("?", "...") that frequently produce empty TTS output.
        if (!/[a-zA-Z0-9]/.test(normalizedText)) {
            console.log('[TTS] Skipping non-lexical chunk:', normalizedText);
            return;
        }
        const shouldUseRemoteAvatar = isVideoExperience && Boolean(remoteSession || avatarSessionClientRef.current);
        if (shouldUseRemoteAvatar) {
            const remoteReady = await waitForAvatarSessionReady();
            if (!remoteReady) {
                const message = `Avatar worker was not ready to receive "${normalizedText.slice(0, 48)}".`;
                console.error('[Avatar Session] ' + message);
                setVideoSessionError(message);
                await cleanupRemoteSession('avatar session not ready for tts');
            }
        }
        if (!ttsReadyRef.current || !isMountedRef.current) {
            console.warn('[TTS] Model not ready or unmounted. Skipping chunk:', normalizedText);
            return;
        }
        const playbackGeneration = playbackGenerationRef.current;
        setIsPlaying(true);
        isPlayingRef.current = true;
        try {
            const audioContext = audioContextRef.current;
            if (!audioContext) return;
            const streamedAudioPlayer = streamedAudioPlayerRef.current;
            if (!streamedAudioPlayer) return;
            if (audioContext.state === 'suspended') await audioContext.resume();
            streamedAudioPlayer.startUtterance();

            // Ensure any stale STT stream is closed before speaking.
            if (speechToText.isGenerating) {
                try {
                    speechToText.streamStop();
                } catch { }
            }

            let ambientStarted = false;
            let receivedChunkCount = 0;
            const maybeStartAmbientListener = () => {
                if (ambientStarted) return;
                if (!sessionActiveRef.current) return;
                if (isRecordingRef.current || isStartingRef.current) return;
                ambientStarted = true;
                console.log('[Playback] Starting ambient listener...');
                // Schedule on next tick so first chunk scheduling is not impacted.
                setTimeout(() => startRecordingSafe(), 10);
            };

            const scheduleAudioVector = (audioVec: Float32Array) => {
                if (playbackGeneration !== playbackGenerationRef.current || !sessionActiveRef.current) return;
                if (!audioVec || audioVec.length === 0) return;
                streamedAudioPlayer.scheduleChunk(audioVec);
            };

            const onNext = async (audioVec: Float32Array) => {
                receivedChunkCount++;
                let playedRemotely = false;
                if (isVideoExperience && avatarSessionClientRef.current?.isReady()) {
                    try {
                        await avatarSessionClientRef.current.appendFloat32Chunk(audioVec, 24000, 1);
                        playedRemotely = true;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.error('[Avatar Session] Failed to forward TTS chunk:', error);
                        setVideoSessionError(message);
                        await cleanupRemoteSession('tts forward failure');
                    }
                }

                if (!playedRemotely) {
                    scheduleAudioVector(audioVec);
                }
                maybeStartAmbientListener();
            };

            let streamError: any = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const ready = await waitForTTSReady(6000);
                if (!ready) {
                    streamError = new Error('TTS model not ready in time.');
                    break;
                }

                try {
                    await tts.stream({
                        text: normalizedText,
                        onNext,
                        onEnd: async () => { }
                    });
                    streamError = null;
                    break;
                } catch (e: any) {
                    const code = e?.code;
                    const message = String(e?.message ?? e);
                    const isModelNotLoaded =
                        code === 102 || /model not loaded/i.test(message);
                    if (attempt === 0 && isModelNotLoaded) {
                        console.warn('[TTS] Model not loaded during stream. Waiting and retrying once.');
                        await sleep(180);
                        continue;
                    }
                    streamError = e;
                    break;
                }
            }

            // Some runs can finish without yielding any stream chunks. Fallback to one-shot synthesis.
            if (!streamError && receivedChunkCount === 0) {
                console.warn('[TTS] Stream produced no chunks. Falling back to forward().');
                let fallbackAudio: Float32Array | null = null;
                for (let fallbackAttempt = 0; fallbackAttempt < 2; fallbackAttempt++) {
                    const audioVec = await tts.forward({ text: normalizedText });
                    if (audioVec && audioVec.length > 0) {
                        fallbackAudio = audioVec;
                        break;
                    }
                    if (fallbackAttempt === 0) {
                        await sleep(120);
                    }
                }
                if (fallbackAudio && fallbackAudio.length > 0) {
                    let playedRemotely = false;
                    if (isVideoExperience && avatarSessionClientRef.current?.isReady()) {
                        try {
                            await avatarSessionClientRef.current.appendFloat32Chunk(fallbackAudio, 24000, 1);
                            playedRemotely = true;
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            console.error('[Avatar Session] Failed to forward fallback TTS chunk:', error);
                            setVideoSessionError(message);
                            await cleanupRemoteSession('fallback tts forward failure');
                        }
                    }
                    if (!playedRemotely) {
                        scheduleAudioVector(fallbackAudio);
                    }
                    maybeStartAmbientListener();
                } else {
                    // Treat as a soft drop instead of hard TTS failure to keep the session flowing.
                    console.warn('[TTS] Forward produced empty audio twice. Skipping chunk:', normalizedText);
                }
            }

            if (streamError) {
                throw streamError;
            }

            if (isVideoExperience && avatarSessionClientRef.current?.isReady()) {
                avatarSessionClientRef.current?.signalAudioEnd();
            }
        } catch (error) {
            console.error('TTS Error:', error);
            streamedAudioPlayerRef.current?.stopAll();
            setIsPlaying(false);
            isPlayingRef.current = false;
            activeSourcesRef.current = 0;
        }
    };

    // --- Render ---

    if (!isSetupReady) {
        const spin = setupSpinAnim.interpolate({
            inputRange: [0, 1],
            outputRange: ['0deg', '360deg'],
        });
        const coreScale = setupPulseAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.9, 1.08],
        });
        const coreOpacity = setupPulseAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.55, 0.95],
        });
        const progressPercent = Math.max(4, Math.min(100, Math.round(downloadProgress * 100)));

        return (
            <View style={styles.loaderContainer}>
                <View style={styles.loaderBackgroundGlow} />
                <Animated.View style={[styles.loaderRingOuter, { transform: [{ rotate: spin }] }]}>
                    <View style={styles.loaderRingInner} />
                </Animated.View>
                <Animated.View style={[styles.loaderCore, { transform: [{ scale: coreScale }], opacity: coreOpacity }]} />

                        <Text style={styles.loaderTitle}>
                            {isVideoExperience ? 'Launching Video Engine' : 'Launching Voice Engine'}
                        </Text>
                <Text style={styles.loaderSubtitle}>{downloadStatus}</Text>

                <View style={styles.loaderProgressTrack}>
                    <View style={[styles.loaderProgressFill, { width: `${progressPercent}%` }]} />
                </View>
                <Text style={styles.loaderPercent}>{progressPercent}%</Text>

                {loadError && (
                    <View style={styles.loaderErrorBlock}>
                        <Text style={styles.loaderErrorText}>{loadError}</Text>
                        <TouchableOpacity style={styles.loaderRetryButton} onPress={handleLoadModels}>
                            <Text style={styles.loaderRetryText}>Retry Setup</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.loaderResetButton} onPress={handleClearModels}>
                            <Text style={styles.loaderResetText}>Clear Cache</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        );
    }

    return (
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.container}>

                {/* Header */}
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>
                        {sessionActive
                            ? SCENARIOS.find(s => s.id === selectedScenario)?.label || (isVideoExperience ? 'Video Call' : 'Voice Chat')
                            : (isVideoExperience ? 'Video Practice' : 'Practice Mode')}
                    </Text>
                    {sessionActive && (
                        <TouchableOpacity onPress={handleEndSession}>
                            <Text style={styles.endButton}>End</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Content Logic */}
                {!sessionActive ? (
                    // 1. Scenario Selection
                    <View style={styles.selectionContainer}>
                        <Text style={styles.subHeader}>Choose a situation to practice:</Text>
                        <View style={styles.grid}>
                            {SCENARIOS.map((item) => (
                                <TouchableOpacity
                                    key={item.id}
                                    style={[
                                        styles.card,
                                        selectedScenario === item.id && styles.cardSelected
                                    ]}
                                    onPress={() => setSelectedScenario(item.id)}
                                >
                                    <Text style={styles.cardIcon}>{item.icon}</Text>
                                    <Text style={[
                                        styles.cardLabel,
                                        selectedScenario === item.id && styles.cardLabelSelected
                                    ]}>{item.label}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <View style={{ flex: 1 }} />

                        <TouchableOpacity
                            style={[styles.startButton, !selectedScenario && styles.startButtonDisabled]}
                            disabled={!selectedScenario}
                            onPress={handleStartSession}
                        >
                            <Text style={styles.startText}>
                                {isVideoExperience ? 'Start Video Call' : 'Start Conversation'}
                            </Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    isVideoExperience ? (
                        <View style={styles.videoSessionContainer}>
                            <View style={styles.videoStage}>
                                <View style={styles.videoStageHeader}>
                                    <Text style={styles.videoStageTitle}>Avatar Call</Text>
                                    <View style={styles.videoStageStatus}>
                                        <View style={styles.videoStageStatusDot} />
                                        <Text style={styles.videoStageStatusText}>
                                            {activeSourcesRef.current > 0 || isPlaying
                                                ? 'Speaking'
                                                : (isRecording
                                                    ? 'Listening'
                                                    : (llm.isGenerating ? 'Thinking' : 'Live'))}
                                        </Text>
                                    </View>
                                </View>

                                <View style={styles.videoStageCanvas}>
                                    <SoulxSegmentPlayer
                                        sessionId={remoteSession?.sessionId ?? null}
                                        segments={videoSegments}
                                        onConnectedChange={handleRemoteRtcConnected}
                                        onError={handleRemoteRtcError}
                                    />

                                    <View style={styles.videoStageOverlay}>
                                        <Text style={styles.videoStageOverlayLabel}>
                                            {selectedScenario ? SCENARIOS.find(s => s.id === selectedScenario)?.label || 'Video Call' : 'Video Call'}
                                        </Text>
                                        <Text style={styles.videoStageOverlaySubLabel}>
                                            {remoteSession
                                                ? (remoteRtcConnected
                                                    ? 'SoulX segment stream attached. Avatar audio/video is coming from worker-rendered MP4 chunks.'
                                                    : 'Worker session is live. Waiting for the first SoulX video segment...')
                                                : 'Voice agent loop active, video stream will attach when the backend session starts.'}
                                        </Text>
                                    </View>
                                </View>
                            </View>

                            <Text style={styles.statusText}>
                                {activeSourcesRef.current > 0 || isPlaying
                                    ? 'Speaking...'
                                    : (isRecording
                                        ? 'Listening...'
                                        : (llm.isGenerating ? 'Thinking...' : 'Waiting...'))}
                            </Text>
                            {videoSessionError && (
                                <Text style={styles.transcriptionPreview}>{videoSessionError}</Text>
                            )}
                            {isRecording && <Text style={styles.transcriptionPreview}>...</Text>}
                        </View>
                    ) : (
                        <View style={styles.orbContainer}>
                            <Animated.View style={[
                                styles.orb,
                                {
                                    transform: [{ scale: pulseAnim }],
                                    opacity: pulseAnim.interpolate({
                                        inputRange: [1, 1.2],
                                        outputRange: [0.8, 1]
                                    })
                                }
                            ]}>
                                <View style={styles.orbInner} />
                            </Animated.View>

                            <Text style={styles.statusText}>
                                {activeSourcesRef.current > 0 || isPlaying
                                    ? 'Speaking...'
                                    : (isRecording
                                        ? 'Listening...'
                                        : (llm.isGenerating ? 'Thinking...' : '...'))}
                            </Text>
                            {isRecording && <Text style={styles.transcriptionPreview}>...</Text>}
                        </View>
                    )
                )}

                {/* Bottom Controls (Only in Active Mode) */}
                {sessionActive && (
                    <View style={styles.controls}>
                        <TouchableOpacity
                            style={styles.endLimitButton}
                            onPress={handleEndSession}
                        >
                            <Text style={styles.endLimitText}>End Session</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </TouchableWithoutFeedback>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#FFF',
        paddingTop: Platform.OS === 'android' ? 40 : 60,
    },
    loaderContainer: {
        flex: 1,
        backgroundColor: '#09122a',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 28,
    },
    loaderBackgroundGlow: {
        position: 'absolute',
        width: 360,
        height: 360,
        borderRadius: 180,
        backgroundColor: 'rgba(31, 112, 255, 0.2)',
    },
    loaderRingOuter: {
        width: 172,
        height: 172,
        borderRadius: 86,
        borderWidth: 6,
        borderColor: 'rgba(129, 186, 255, 0.35)',
        borderTopColor: '#7fd2ff',
        borderRightColor: '#2eb6ff',
        justifyContent: 'center',
        alignItems: 'center',
    },
    loaderRingInner: {
        width: 132,
        height: 132,
        borderRadius: 66,
        borderWidth: 2,
        borderColor: 'rgba(126, 210, 255, 0.35)',
    },
    loaderCore: {
        position: 'absolute',
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: '#70d6ff',
        shadowColor: '#2eb6ff',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9,
        shadowRadius: 18,
        elevation: 12,
    },
    loaderTitle: {
        marginTop: 36,
        fontSize: 24,
        fontWeight: '700',
        color: '#f4fbff',
    },
    loaderSubtitle: {
        marginTop: 10,
        fontSize: 15,
        color: '#b7ccf3',
        textAlign: 'center',
    },
    loaderProgressTrack: {
        width: '92%',
        height: 10,
        borderRadius: 999,
        backgroundColor: 'rgba(170, 197, 243, 0.25)',
        marginTop: 24,
        overflow: 'hidden',
    },
    loaderProgressFill: {
        height: '100%',
        borderRadius: 999,
        backgroundColor: '#7fd2ff',
    },
    loaderPercent: {
        marginTop: 8,
        fontSize: 13,
        color: '#95bbe3',
        letterSpacing: 0.3,
    },
    loaderErrorBlock: {
        marginTop: 22,
        alignItems: 'center',
        width: '100%',
    },
    loaderErrorText: {
        color: '#ffd2d2',
        textAlign: 'center',
        marginBottom: 12,
    },
    loaderRetryButton: {
        backgroundColor: '#2a7bff',
        borderRadius: 999,
        paddingHorizontal: 24,
        paddingVertical: 10,
        marginBottom: 10,
    },
    loaderRetryText: {
        color: '#ffffff',
        fontWeight: '700',
        fontSize: 15,
    },
    loaderResetButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    loaderResetText: {
        color: '#ffb9b9',
        fontWeight: '600',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 24,
        alignItems: 'center',
        marginBottom: 20,
    },
    headerTitle: {
        fontSize: 22,
        fontWeight: 'bold',
        color: '#333',
    },
    endButton: {
        color: '#FF3B30',
        fontSize: 16,
        fontWeight: '600',
    },
    endButtonUI: {
        alignItems: 'center',
        justifyContent: 'center',
    },

    // Selection Styles
    selectionContainer: {
        flex: 1,
        paddingHorizontal: 24,
        paddingBottom: 40,
    },
    subHeader: {
        fontSize: 16,
        color: '#666',
        marginBottom: 20,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
    },
    card: {
        width: (width - 64) / 2,
        height: 120,
        backgroundColor: '#F5F5F5',
        borderRadius: 20,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    cardSelected: {
        borderColor: '#007AFF',
        backgroundColor: '#F0F8FF',
    },
    cardIcon: {
        fontSize: 40,
        marginBottom: 10,
    },
    cardLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
    },
    cardLabelSelected: {
        color: '#007AFF',
    },
    startButton: {
        backgroundColor: '#007AFF',
        height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
    },
    startButtonDisabled: {
        backgroundColor: '#CCC',
        elevation: 0,
    },
    startText: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
    },

    // Orb Styles
    orbContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 60,
    },
    videoSessionContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 20,
        marginBottom: 28,
    },
    videoStage: {
        width: '100%',
        maxWidth: 420,
        borderRadius: 28,
        backgroundColor: '#08111f',
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: '#16324f',
        shadowColor: '#04111d',
        shadowOffset: { width: 0, height: 16 },
        shadowOpacity: 0.24,
        shadowRadius: 24,
        elevation: 12,
    },
    videoStageHeader: {
        paddingHorizontal: 18,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(127, 210, 255, 0.12)',
    },
    videoStageTitle: {
        color: '#f3f8ff',
        fontSize: 16,
        fontWeight: '700',
    },
    videoStageStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    videoStageStatusDot: {
        width: 10,
        height: 10,
        borderRadius: 999,
        backgroundColor: '#57e389',
    },
    videoStageStatusText: {
        color: '#a9bfd8',
        fontSize: 13,
        fontWeight: '600',
    },
    videoStageCanvas: {
        minHeight: 440,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#0b1625',
    },
    videoStageOverlay: {
        position: 'absolute',
        left: 18,
        right: 18,
        bottom: 18,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 18,
        backgroundColor: 'rgba(4, 11, 18, 0.56)',
    },
    videoStageOverlayLabel: {
        color: '#f4fbff',
        fontSize: 16,
        fontWeight: '700',
    },
    videoStageOverlaySubLabel: {
        marginTop: 4,
        color: '#abc4de',
        fontSize: 13,
        lineHeight: 18,
    },
    videoOrb: {
        width: 240,
        height: 240,
        borderRadius: 120,
        backgroundColor: 'rgba(80, 156, 255, 0.24)',
    },
    orb: {
        width: 200,
        height: 200,
        borderRadius: 100,
        backgroundColor: 'rgba(52, 120, 246, 0.2)', // Translucent Light Blue
        justifyContent: 'center',
        alignItems: 'center',
    },
    orbInner: {
        width: 140,
        height: 140,
        borderRadius: 70,
        backgroundColor: 'rgba(52, 120, 246, 0.4)', // Slightly darker inner
    },
    statusText: {
        marginTop: 40,
        fontSize: 18,
        color: '#888',
        fontWeight: '500',
    },
    transcriptionPreview: {
        marginTop: 10,
        color: '#CCC',
        fontStyle: 'italic',
    },

    // Bottom Bar
    bottomBar: {
        height: 100,
        alignItems: 'center',
        justifyContent: 'center',
        borderTopWidth: 1,
        borderTopColor: '#EEE',
    },
    controls: {
        flexDirection: 'row',
        justifyContent: 'center',
        marginTop: 20,
    },
    endLimitButton: {
        backgroundColor: '#FF3B30',
        paddingVertical: 12,
        paddingHorizontal: 24,
        borderRadius: 24,
    },
    endLimitText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
});
