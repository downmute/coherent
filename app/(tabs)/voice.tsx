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
// Mocks
import { MicIcon, PauseIcon, Spinner, StopIcon } from '../../components/MockComponents';
import { GeneratingContext } from '../../context/GeneratingContext';

// Libraries
import { useIsFocused } from '@react-navigation/native';
import { AudioBuffer, AudioBufferSourceNode, AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';
import {
    KOKORO_MEDIUM,
    KOKORO_VOICE_AF_HEART,
    useLLM,
    useSpeechToText,
    useTextToSpeech,
    WHISPER_TINY_EN,
} from 'react-native-executorch';
import {
    clearAllModels,
    ensureModelExists,
    KOKORO_MODEL,
    LLAMA_1B_MODEL
} from '../../services/ModelLoader';

const { width } = Dimensions.get('window');

// --- Types & Constants ---

type Scenario = 'small_talk' | 'making_friends' | 'job_interview' | 'dating';

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

const VOICES = {
    male: ['kokoro-voice-am_adam.bin', 'kokoro-voice-am_michael.bin', 'kokoro-voice-am_santa.bin'],
    female: ['kokoro-voice-af_heart.bin', 'kokoro-voice-af_river.bin', 'kokoro-voice-af_sarah.bin']
};

const STYLES = ['calm', 'energetic', 'thoughtful', 'witty', 'direct'];

const getRandomPersona = (scenarioId: Scenario) => {
    const gender = (Math.random() > 0.5 ? 'male' : 'female') as 'male' | 'female';
    const name = NAMES[gender][Math.floor(Math.random() * NAMES[gender].length)];
    const age = Math.floor(Math.random() * (40 - 22) + 22); // 22-40
    const style = STYLES[Math.floor(Math.random() * STYLES.length)];
    const voiceFile = VOICES[gender][Math.floor(Math.random() * VOICES[gender].length)];

    return {
        name,
        age,
        gender,
        style,
        voiceFile,
        description: `Name: ${name}. Age: ${age}. Gender: ${gender}. Speaking Style: ${style}.`
    };
};

// --- Helper Functions ---

const createAudioBufferFromVector = (
    audioVector: Float32Array,
    audioContext: AudioContext | null = null,
    sampleRate: number = 24000
): AudioBuffer => {
    if (audioContext == null) audioContext = new AudioContext({ sampleRate });

    const audioBuffer = audioContext.createBuffer(
        1,
        audioVector.length,
        sampleRate
    );
    const channelData = audioBuffer.getChannelData(0);
    channelData.set(audioVector);

    return audioBuffer;
};

// --- Main Components ---

export default function VoiceChatScreenWrapper() {
    const isFocused = useIsFocused();
    return isFocused ? <VoiceChatScreen /> : null;
}

function VoiceChatScreen() {
    const isFocused = useIsFocused();
    const { setGlobalGenerating } = useContext(GeneratingContext);

    // --- State ---
    const [isRecording, setIsRecording] = useState(false);
    const [recorder] = useState(() => new AudioRecorder());
    const [isPlaying, setIsPlaying] = useState(false);

    // Session State
    const [sessionActive, setSessionActive] = useState(false);
    // Ref to track session state for async callbacks (like onended)
    const sessionActiveRef = useRef(sessionActive);
    const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
    const [persona, setPersona] = useState<string>('');
    const [activeVoiceFile, setActiveVoiceFile] = useState<string>('kokoro-voice-af_heart.bin');
    const [pendingSystemPrompt, setPendingSystemPrompt] = useState<string | null>(null);

    // Download State
    const [qwenPaths, setQwenPaths] = useState<Record<string, string> | null>(null);
    const [kokoroPaths, setKokoroPaths] = useState<Record<string, string> | null>(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStatus, setDownloadStatus] = useState<string>('Checking models...');

    // Audio Context
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const lastSpokenResponse = useRef<string>('');

    // VAD State
    const silenceStartRef = useRef<number | null>(null);
    const isSpeakingRef = useRef<boolean>(false);

    // Animation
    const pulseAnim = useRef(new Animated.Value(1)).current;

    // --- Effects ---

    // Sync sessionActive to ref
    useEffect(() => {
        sessionActiveRef.current = sessionActive;
    }, [sessionActive]);

    // 1. Load Models (Manual Trigger now)

    // 1. Load Models (Manual Trigger now)
    const handleLoadModels = async () => {
        try {
            setDownloadStatus('Downloading Llama 3.2 1B SpinQuant...');
            // Using LLAMA_1B_MODEL instead of PHI_MODEL
            const qPaths = await ensureModelExists(LLAMA_1B_MODEL, (p) => setDownloadProgress(p));
            // Inject chat_template if missing (Llama usually has one, but safe to check/inject if we have a template logic)
            // But Llama 3.2 likely works out of box or we rely on tokenizer_config.
            // await injectChatTemplate(qPaths['llama-tokenizer_config.json']); 
            setQwenPaths(qPaths);

            setDownloadStatus('Downloading Kokoro...');
            const kPaths = await ensureModelExists(KOKORO_MODEL, (p) => setDownloadProgress(p));
            setKokoroPaths(kPaths);

            setDownloadStatus('Ready');
        } catch (e) {
            console.error(e);
            setDownloadStatus('Error downloading models: ' + e);
        }
    };

    const handleClearModels = async () => {
        try {
            await clearAllModels();
            // Reset paths to null to trigger "Download" UI
            setQwenPaths(null);
            setKokoroPaths(null);
            setDownloadStatus('Models cleared. Ready to download.');
            setDownloadProgress(0);
        } catch (e) {
            console.error(e);
            setDownloadStatus('Error clearing models: ' + e);
        }
    };

    // ...

    const llmConfig = React.useMemo(() => qwenPaths ? {
        modelSource: qwenPaths['llama-3.2-1b-spinquant.pte'], // Updated filename
        tokenizerSource: qwenPaths['tokenizer.json'],
        tokenizerConfigSource: qwenPaths['tokenizer_config.json'],
    } : {
        modelSource: '',
        tokenizerSource: '',
        tokenizerConfigSource: '',
    }, [qwenPaths]);

    const llm = useLLM({
        model: llmConfig,
        preventLoad: !qwenPaths,
    });

    const sttConfig = React.useMemo(() => qwenPaths ? {
        ...WHISPER_TINY_EN,
        encoderSource: qwenPaths['whisper_tiny_encoder.pte'],
        decoderSource: qwenPaths['whisper_tiny_decoder.pte'],
        tokenizerSource: qwenPaths['whisper-tokenizer.json']
    } : WHISPER_TINY_EN, [qwenPaths]);

    const speechToText = useSpeechToText({
        model: sttConfig,
        preventLoad: !qwenPaths
    });

    const ttsConfig = React.useMemo(() => kokoroPaths ? {
        type: 'kokoro' as const,
        durationPredictorSource: kokoroPaths['kokoro-duration-predictor.pte'],
        synthesizerSource: kokoroPaths['kokoro-synthesizer.pte'],
    } : KOKORO_MEDIUM, [kokoroPaths]);

    const ttsVoice = React.useMemo(() => kokoroPaths ? {
        ...KOKORO_VOICE_AF_HEART,
        voiceSource: kokoroPaths[activeVoiceFile] || kokoroPaths['kokoro-voice-af_heart.bin'],
        extra: {
            taggerSource: kokoroPaths['kokoro-phonemizer-tags.json'],
            lexiconSource: kokoroPaths['kokoro-phonemizer-us_merged.json']
        }
    } : KOKORO_VOICE_AF_HEART, [kokoroPaths, activeVoiceFile]);

    const tts = useTextToSpeech({
        model: ttsConfig,
        voice: ttsVoice,
        preventLoad: !kokoroPaths
    });

    // --- Logic ---

    // Sync global status
    useEffect(() => {
        setGlobalGenerating(llm.isGenerating || speechToText.isGenerating || tts.isGenerating);
    }, [llm.isGenerating, speechToText.isGenerating, tts.isGenerating, setGlobalGenerating]);

    // Audio Setup (Mount only)
    useEffect(() => {
        // Configure Audio Session for Play and Record
        AudioManager.setAudioSessionOptions({
            iosCategory: 'playAndRecord',
            iosMode: 'spokenAudio',
            iosOptions: ['allowBluetooth', 'defaultToSpeaker'],
        });

        // Initialize Audio Context for TTS (Kokoro uses 24000Hz)
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
        console.log('[Audio] Context initialized');

        return () => {
            audioContextRef.current?.close();
            audioContextRef.current = null;
        };
    }, []);

    // Deferred session start: Send system prompt after TTS reconfigures
    useEffect(() => {

        if (pendingSystemPrompt && tts.isReady && llm.isReady) {
            console.log("[Session] Sending system prompt...", pendingSystemPrompt.substring(0, 50) + "...");
            // Don't await this, let it run in background to avoid blocking UI
            llm.sendMessage(pendingSystemPrompt)
                .then(async (res) => {
                    console.log("[Session] System prompt sent. Response:", res);
                    // Kickstart the conversation with a hidden user message to force a greeting
                    console.log("[Session] Sending trigger message...");
                    try {
                        await llm.sendMessage("Hello, I am ready to practice. Please introduce yourself.");
                        console.log("[Session] Trigger message sent.");
                    } catch (err) {
                        console.error("[Session] Trigger message failed:", err);
                    }
                })
                .catch((e: any) => console.error("[Session] Failed to start session:", e));

            setPendingSystemPrompt(null); // Clear once sent
        } else if (pendingSystemPrompt) {
            console.log("[Session] Waiting for models... TTS:", tts.isReady ? "Ready" : "Not Ready", "LLM:", llm.isReady ? "Ready" : "Not Ready");
        }
    }, [pendingSystemPrompt, tts.isReady, llm.isReady]);

    // Auto-TTS Trigger
    useEffect(() => {
        // Only speak if session is active
        if (!sessionActive) return;

        const generatedText = llm.response;
        // Debug Log
        // console.log(`[TTS Check] isGenerating: ${llm.isGenerating}, ready: ${tts.isReady}, textLen: ${generatedText?.length}, last: ${lastSpokenResponse.current?.length}`);

        if (!llm.isGenerating && generatedText && generatedText !== lastSpokenResponse.current && tts.isReady) {
            console.log('[TTS] Triggering speech for:', generatedText.substring(0, 50) + '...');
            lastSpokenResponse.current = generatedText;
            handlePlayAudio(generatedText);
        }
    }, [llm.isGenerating, llm.response, tts.isReady, sessionActive]);

    const handlePlayAudio = async (text: string) => {
        if (!text.trim()) return;
        setIsPlaying(true);
        try {
            const audioContext = audioContextRef.current;
            if (!audioContext) return;
            if (audioContext.state === 'suspended') await audioContext.resume();

            const onNext = async (audioVec: Float32Array) => {
                return new Promise<void>((resolve) => {
                    const audioBuffer = createAudioBufferFromVector(audioVec, audioContext, 24000);
                    const source = audioContext.createBufferSource();
                    sourceRef.current = source;
                    source.buffer = audioBuffer;
                    source.connect(audioContext.destination);
                    source.onEnded = () => {
                        if (sourceRef.current === source) {
                            sourceRef.current = null;
                        }
                        resolve();
                    };
                    source.start();
                });
            };

            await tts.stream({
                text,
                onNext,
                onEnd: async () => {
                    setIsPlaying(false);
                }
            });
        } catch (error) {
            console.error('TTS Error:', error);
            setIsPlaying(false);
        }
    };

    const handleStop = () => {
        if (llm.isGenerating) llm.interrupt();
        if (tts.isGenerating || isPlaying) {
            try {
                sourceRef.current?.stop();
            } catch (e) { }
            sourceRef.current = null;
        }
        setIsPlaying(false);
    };

    const handleStartSession = async () => {
        if (!selectedScenario || !llm.isReady || !tts.isReady) {
            console.log("Not ready to start:", { scenario: !!selectedScenario, llm: llm.isReady, tts: tts.isReady });
            return;
        }

        const p = getRandomPersona(selectedScenario);
        const scenarioDef = SCENARIOS.find(s => s.id === selectedScenario);
        const systemPrompt = `SYSTEM DIRECTIVE: ${scenarioDef?.promptBase} Your Persona: ${p.description} Keep responses concise and conversational. Start with a short greeting.`;

        setPersona(p.description);
        setActiveVoiceFile(p.voiceFile);
        setSessionActive(true);
        setPendingSystemPrompt(systemPrompt); // Store prompt to send in useEffect
    };

    const handleRecordPress = async () => {
        if (!qwenPaths || !kokoroPaths) return;

        // Check permissions first
        console.log('[Permissions] Requesting microphone access...');
        const perm = await AudioManager.requestRecordingPermissions();
        console.log('[Permissions] Result:', JSON.stringify(perm));

        // Check if granted (it might return 'granted' string or an object depending on version/platform)
        if (perm !== 'granted' && (typeof perm === 'object' && perm['status'] !== 'granted')) {
            alert('Microphone permission denied');
            // console.log('Permission object:', perm);
            return;
        }

        if (isPlaying) {
            handleStop();
            return;
        }

        if (isRecording) {
            console.log('[Recorder] Stopping manually...');
            setIsRecording(false);
            recorder.stop();
            recorder.clearOnAudioReady();
            speechToText.streamStop();
        } else {
            console.log('[Recorder] Starting...');
            setIsRecording(true);
            // Reset VAD state
            silenceStartRef.current = null;
            isSpeakingRef.current = false;

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
                // console.log('[Recorder] Data received, length:', data.length); // Super verbose, uncomment if needed
                speechToText.streamInsert(data);

                // --- VAD Logic ---
                // Calculate RMS
                let sum = 0;
                for (let i = 0; i < data.length; i++) {
                    sum += data[i] * data[i];
                }
                const rms = Math.sqrt(sum / data.length);

                // Thresholds
                const SPEECH_THRESHOLD = 0.01; // Lowered threshold for better sensitivity
                const SILENCE_DURATION_MS = 750; // 0.75 seconds of silence

                // Throttle logging - REMOVED FOR DEBUGGING
                // if (Math.random() < 0.05) {
                console.log('[VAD] Current RMS:', rms.toFixed(4));
                // }

                if (rms > SPEECH_THRESHOLD) {
                    if (!isSpeakingRef.current) {
                        console.log('[VAD] Speech detected (RMS:', rms.toFixed(4), ')');
                    }
                    isSpeakingRef.current = true;
                    silenceStartRef.current = null; // Reset silence timer
                } else {
                    // It's quiet
                    if (isSpeakingRef.current) {
                        // We were speaking, now we are silent. Start counting?
                        if (silenceStartRef.current === null) {
                            silenceStartRef.current = Date.now();
                        } else {
                            const diff = Date.now() - silenceStartRef.current;
                            if (diff > SILENCE_DURATION_MS) {
                                console.log('[VAD] Silence detected for', diff, 'ms. Stopping.');

                                // FORCE STOP
                                recorder.stop(); // Stop recording immediately
                                recorder.clearOnAudioReady();
                                setIsRecording(false);
                                speechToText.streamStop(); // This resolves the main promise
                                console.log('[VAD] Triggered streamStop()');
                            }
                        }
                    }
                }
            });
            console.log('[Recorder] onAudioReady setup result:', JSON.stringify(readyResult));

            const startResult = recorder.start();
            console.log('[Recorder] start result:', JSON.stringify(startResult));
            // We removed the original "await speechToText.stream()" here because VAD handles the stop -> process flow.
            // But if the user manually stops, we still need to process.
            // We need to support BOTH manual stop and VAD stop.
            // The logic above in "isRecording" block handles manual stop.
            // But checking "await speechToText.stream()" in the start block blocks the UI thread if not careful,
            // or rather, it waits for streamStop() to be called.
            // So we can keep it for manual stop case? 
            // Actually, if we use VAD, the VAD block calls standard logic.
            // Let's refactor manual stop to invoke the same processing logic to avoid duplication?
            // For now, let's just let the VAD block handle the "Auto Stop" case.
            // And for Manual Stop, we need to ensure we capture the result.

            // To support Manual Stop (clicking the button), we need to capture the promise there too?
            // The previous code had:
            // try { const transcription = await speechToText.stream(); ... }
            // This waits until streamStop() is called.
            // So we can keep that here!
            try {
                if (!speechToText.isGenerating) {
                    console.log('[STT Stream] Starting stream loop...');
                    const transcription = await speechToText.stream();
                    console.log('[STT Stream] Result:', transcription);

                    if (transcription.trim().length > 0) {
                        console.log('[LLM] Sending user message:', transcription);
                        await llm.sendMessage(transcription);
                        console.log('[LLM] User message sent.');
                    } else {
                        console.log('[STT Stream] Empty transcription.');
                    }
                } else {
                    console.warn('[STT Stream] Already generating, skipping start.');
                }
            } catch (e) {
                console.error('[STT Stream] Error:', e);
            }
        }
    };

    // --- Render ---

    if (!qwenPaths || !kokoroPaths || !llm.isReady || !speechToText.isReady || !tts.isReady) {
        return (
            <View style={styles.container}>
                <View style={styles.orbContainer}>
                    <Text style={[styles.headerTitle, { marginBottom: 20 }]}>AI Setup</Text>

                    <Text style={{ textAlign: 'center', marginBottom: 20, paddingHorizontal: 40, color: '#666' }}>
                        {downloadStatus}
                    </Text>

                    {downloadStatus.includes('Downloading') ? (
                        <Spinner visible={true} textContent={`${(downloadProgress * 100).toFixed(0)}%`} />
                    ) : (
                        <>
                            <TouchableOpacity
                                style={[styles.startButton, { width: 200, marginBottom: 16 }]}
                                onPress={handleLoadModels}
                            >
                                <Text style={styles.startText}>Load AI Models</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.endButtonUI, { padding: 10 }]}
                                onPress={handleClearModels}
                            >
                                <Text style={{ color: 'red', fontWeight: '600', fontSize: 16 }}>Reset / Clear Cache</Text>
                            </TouchableOpacity>
                        </>
                    )}
                </View>
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
                            ? SCENARIOS.find(s => s.id === selectedScenario)?.label || 'Voice Chat'
                            : 'Practice Mode'}
                    </Text>
                    {sessionActive && (
                        <TouchableOpacity onPress={() => {
                            setSessionActive(false);
                            handleStop();
                            setSelectedScenario(null);
                        }}>
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
                            <Text style={styles.startText}>Start Conversation</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    // 2. Active Voice Session (The Orb)
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
                            {isPlaying ? 'Listening...' : (llm.isGenerating ? 'Thinking...' : (isRecording ? 'Listening...' : 'Tap mic to speak'))}
                        </Text>
                        {/* We can hide the raw transcription or show it simply */}
                        {isRecording && <Text style={styles.transcriptionPreview}>...</Text>}
                    </View>
                )}

                {/* Bottom Controls (Only in Active Mode) */}
                {sessionActive && (
                    <View style={styles.bottomBar}>
                        {llm.isGenerating || isPlaying ? (
                            <TouchableOpacity onPress={handleStop}>
                                <PauseIcon height={60} width={60} />
                            </TouchableOpacity>
                        ) : (
                            <TouchableOpacity onPress={handleRecordPress}>
                                {isRecording ? (
                                    <StopIcon height={60} width={60} />
                                ) : (
                                    <MicIcon height={60} width={60} />
                                )}
                            </TouchableOpacity>
                        )}
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
});