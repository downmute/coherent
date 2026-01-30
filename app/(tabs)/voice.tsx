import React, { useContext, useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
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
import { ensureModelExists, KOKORO_MODEL, QWEN_MODEL } from '../../services/ModelLoader';

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

    // Animation
    const pulseAnim = useRef(new Animated.Value(1)).current;

    // --- Effects ---

    // 1. Load Models
    useEffect(() => {
        const loadModels = async () => {
            try {
                setDownloadStatus('Downloading Qwen3-4B...');
                const qPaths = await ensureModelExists(QWEN_MODEL, (p) => setDownloadProgress(p));
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
        loadModels();
    }, []);

    // 2. Setup Audio Session
    useEffect(() => {
        AudioManager.setAudioSessionOptions({
            iosCategory: 'playAndRecord',
            iosMode: 'spokenAudio',
            iosOptions: ['allowBluetooth', 'defaultToSpeaker'],
        });
        AudioManager.requestRecordingPermissions();

        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
        audioContextRef.current.suspend();

        return () => {
            audioContextRef.current?.close();
            audioContextRef.current = null;
        };
    }, []);

    // 3. Animation Loop
    useEffect(() => {
        if (isPlaying || (sessionActive && llm.isGenerating)) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 1.2,
                        duration: 1000,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.stopAnimation();
            Animated.spring(pulseAnim, {
                toValue: 1,
                useNativeDriver: true,
            }).start();
        }
    }, [isPlaying, sessionActive]); // Check deps

    // --- Hooks Configuration ---

    const llmConfig = React.useMemo(() => qwenPaths ? {
        modelSource: qwenPaths['Qwen3-4B-instruct-8bit.pte'],
        tokenizerSource: qwenPaths['qwen-tokenizer.json'],
        tokenizerConfigSource: qwenPaths['qwen-tokenizer_config.json'],
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
        type: 'kokoro',
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

    // Deferred session start: Send system prompt after TTS reconfigures
    useEffect(() => {
        if (pendingSystemPrompt && tts.isReady && llm.isReady) {
            console.log("[Session] Sending system prompt...");
            llm.sendMessage(pendingSystemPrompt).catch((e: any) => console.error("Failed to start session:", e));
            setPendingSystemPrompt(null); // Clear once sent
        }
    }, [pendingSystemPrompt, tts.isReady, llm.isReady]);

    // Auto-TTS Trigger
    useEffect(() => {
        // Only speak if session is active
        if (!sessionActive) return;

        const generatedText = llm.response;
        if (!llm.isGenerating && generatedText && generatedText !== lastSpokenResponse.current && tts.isReady) {
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
        const systemPrompt = `SYSTEM DIRECTIVE: ${scenarioDef?.promptBase} Your Persona: ${p.description} Keep responses concise and conversational.`;

        setPersona(p.description);
        setActiveVoiceFile(p.voiceFile);
        setSessionActive(true);
        setPendingSystemPrompt(systemPrompt); // Store prompt to send in useEffect
    };

    const handleRecordPress = async () => {
        if (!qwenPaths || !kokoroPaths) return;

        if (isPlaying) {
            handleStop();
            return;
        }

        if (isRecording) {
            setIsRecording(false);
            recorder.stop();
            recorder.clearOnAudioReady();
            speechToText.streamStop();
        } else {
            setIsRecording(true);
            recorder.onAudioReady({
                sampleRate: 16000,
                bufferLength: 1600,
                channelCount: 1,
            }, ({ buffer }) => {
                speechToText.streamInsert(buffer.getChannelData(0));
            });
            recorder.start();
            try {
                const transcription = await speechToText.stream();
                // Send to LLM
                await llm.sendMessage(transcription);
            } catch (e) {
                console.error(e);
            }
        }
    };

    // --- Render ---

    if (!qwenPaths || !kokoroPaths || !llm.isReady || !speechToText.isReady || !tts.isReady) {
        return (
            <Spinner
                visible={true}
                textContent={
                    (!qwenPaths || !kokoroPaths)
                        ? `${downloadStatus} ${(downloadProgress * 100).toFixed(0)}%`
                        : `Loading...\nLLM: ${llm.isReady ? 'Ready' : 'Init'}\nSTT: ${speechToText.isReady ? 'Ready' : 'Init'}\nTTS: ${tts.isReady ? 'Ready' : 'Init'}`
                }
            />
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
