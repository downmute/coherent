import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
    Dimensions,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';
import { AVOIDANCE_OPTIONS, FEAR_OPTIONS, getSeverityBand, LSAS_QUESTIONS } from '../constants/LSASConfig';
import { downloadAllModels } from '../services/ModelLoader';

const { width } = Dimensions.get('window');

const INITIAL_QUESTIONS = [
    {
        id: 'confidence',
        title: "What's your confidence level in social situations?",
        options: [
            'Extreme social anxiety',
            'Social anxiety',
            'Mild nervousness',
            'Normal',
            'Confident',
        ],
    },
    {
        id: 'useCase',
        title: "What's your preferred use case?",
        options: [
            'Job interview',
            'Day-to-day social interactions',
            'Making friends',
            'Dating',
        ],
    },
    {
        id: 'goal',
        title: "What's your biggest goal?",
        options: [
            'Be a better speaker',
            'Be more charismatic',
            'Be less awkward',
            'Sound friendlier',
        ],
    },
];

export default function OnboardingScreen() {
    const router = useRouter();
    const [step, setStep] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string>>({});

    // LSAS State
    const [lsasIndex, setLsasIndex] = useState(0); // 0 to 11
    const [lsasAnswers, setLsasAnswers] = useState<Record<string, { fear: number; avoidance: number }>>({});
    const [showResults, setShowResults] = useState(false);

    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStatus, setDownloadStatus] = useState('');
    // Use ref to prevent double-invocation in Strict Mode
    const downloadStarted = useRef(false);

    useEffect(() => {
        if (!downloadStarted.current) {
            downloadStarted.current = true;
            console.log("Initializing model downloads...");
            downloadAllModels(
                (progress) => setDownloadProgress(progress),
                (status) => setDownloadStatus(status)
            );
        }
    }, []);

    const handleSelectOption = (option: string) => {
        setAnswers((prev) => ({ ...prev, [INITIAL_QUESTIONS[step].id]: option }));
    };

    const handleLsasAnswer = (type: 'fear' | 'avoidance', value: number) => {
        const questionId = LSAS_QUESTIONS[lsasIndex].id;
        setLsasAnswers(prev => ({
            ...prev,
            [questionId]: {
                ...(prev[questionId] || { fear: -1, avoidance: -1 }), // Default -1 to indicate unset
                [type]: value
            }
        }));
    };

    const handleNext = async () => {
        // Phase 1: Initial Questions
        if (step < INITIAL_QUESTIONS.length - 1) {
            setStep((prev) => prev + 1);
            return;
        }

        // Phase 2: Start LSAS or Next LSAS Question
        if (step === INITIAL_QUESTIONS.length - 1 && !showResults) {
            // Must have answered current initial question to proceed to LSAS (checked by button disable)
            // But logic for "Next" button in Init phase transitions to LSAS #0?
            // Actually, let's say Step goes up to INITIAL_QUESTIONS.length (which is 3).
            // If Step == 3, we are in LSAS mode.
            if (step === INITIAL_QUESTIONS.length - 1) {
                setStep(INITIAL_QUESTIONS.length); // Entering LSAS
                return;
            }
        }

        if (step === INITIAL_QUESTIONS.length) {
            // In LSAS flow
            if (lsasIndex < LSAS_QUESTIONS.length - 1) {
                setLsasIndex(prev => prev + 1);
            } else {
                setShowResults(true);
            }
        }
    };

    const handleFinish = async () => {
        try {
            const finalProfile = {
                ...answers,
                lsas: lsasAnswers,
                lsasScore: calculateScore(),
                onboardedAt: Date.now()
            };
            await AsyncStorage.setItem('user_profile', JSON.stringify(finalProfile));
            await AsyncStorage.setItem('has_onboarded', 'true');
            router.replace('/(tabs)/voice');
        } catch (e) {
            console.error('Failed to save onboarding data', e);
        }
    };

    const calculateScore = () => {
        let total = 0;
        Object.values(lsasAnswers).forEach(ans => {
            if (ans.fear >= 0) total += ans.fear;
            if (ans.avoidance >= 0) total += ans.avoidance;
        });
        return total;
    };

    const getTopDomains = () => {
        const domainScores: Record<string, number> = {};
        LSAS_QUESTIONS.forEach(q => {
            const ans = lsasAnswers[q.id];
            if (ans) {
                const score = (ans.fear >= 0 ? ans.fear : 0) + (ans.avoidance >= 0 ? ans.avoidance : 0);
                domainScores[q.domain] = (domainScores[q.domain] || 0) + score;
            }
        });
        return Object.entries(domainScores).sort(([, a], [, b]) => b - a).slice(0, 2).map(([d]) => d);
    };


    const renderContent = () => {
        if (showResults) {
            const score = calculateScore();
            const band = getSeverityBand(score);
            const topDomains = getTopDomains();

            return (
                <View style={styles.resultContainer}>
                    <Text style={styles.resultTitle}>Your Starting Point</Text>

                    <View style={[styles.scoreCircle, { borderColor: band.color }]}>
                        <Text style={[styles.scoreText, { color: band.color }]}>{score}</Text>
                        <Text style={styles.bandText}>{band.label}</Text>
                    </View>

                    <Text style={styles.domainTitle}>Priority Areas:</Text>
                    {topDomains.map(d => (
                        <View key={d} style={styles.domainBadge}>
                            <Text style={styles.domainText}>{d}</Text>
                        </View>
                    ))}

                    <View style={{ flex: 1 }} />
                </View>
            );
        }

        if (step === INITIAL_QUESTIONS.length) {
            const q = LSAS_QUESTIONS[lsasIndex];
            const currentAns = lsasAnswers[q.id] || { fear: null, avoidance: null };

            return (
                <View style={styles.content}>
                    <Text style={styles.progressLabel}>Question {lsasIndex + 1} of {LSAS_QUESTIONS.length}</Text>
                    <Text style={styles.title}>{q.title}</Text>
                    <Text style={styles.subtitle}>{q.description}</Text>

                    <ScrollView contentContainerStyle={styles.lsasContainer}>
                        <Text style={styles.sliderLabel}>How anxious would you feel?</Text>
                        <View style={styles.sliderRow}>
                            {FEAR_OPTIONS.map((opt, idx) => (
                                <TouchableOpacity
                                    key={idx}
                                    style={[styles.sliderBtn, currentAns.fear === idx && styles.sliderBtnSelected]}
                                    onPress={() => handleLsasAnswer('fear', idx)}
                                >
                                    <Text style={[styles.sliderBtnText, currentAns.fear === idx && { color: 'white' }]}>{idx}</Text>
                                    <Text style={styles.sliderBtnSub}>{opt.split(' ')[0]}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <Text style={[styles.sliderLabel, { marginTop: 24 }]}>How often do you avoid this?</Text>
                        <View style={styles.sliderRow}>
                            {AVOIDANCE_OPTIONS.map((opt, idx) => (
                                <TouchableOpacity
                                    key={idx}
                                    style={[styles.sliderBtn, currentAns.avoidance === idx && styles.sliderBtnSelected]}
                                    onPress={() => handleLsasAnswer('avoidance', idx)}
                                >
                                    <Text style={[styles.sliderBtnText, currentAns.avoidance === idx && { color: 'white' }]}>{idx}</Text>
                                    <Text style={styles.sliderBtnSub}>{opt.split(' ')[0]}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </ScrollView>
                </View>
            );
        }

        // Initial Questions
        const currentQuestion = INITIAL_QUESTIONS[step];
        return (
            <View style={styles.content}>
                <Text style={styles.title}>{currentQuestion.title}</Text>
                <Text style={styles.subtitle}>Select the option that fits best</Text>

                <ScrollView contentContainerStyle={styles.optionsContainer}>
                    {currentQuestion.options.map((option) => {
                        const isSelected = answers[currentQuestion.id] === option;
                        return (
                            <TouchableOpacity
                                key={option}
                                style={[styles.optionButton, isSelected && styles.selectedOption]}
                                onPress={() => handleSelectOption(option)}
                                activeOpacity={0.8}
                            >
                                <Text style={styles.optionText}>{option}</Text>
                                {isSelected && (
                                    <View style={styles.checkmark}>
                                        <Text style={{ color: 'white', fontWeight: 'bold' }}>✓</Text>
                                    </View>
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>
        );
    };

    const isNextDisabled = () => {
        if (showResults) return downloadProgress < 0.99; // Finish blocked by download

        if (step < INITIAL_QUESTIONS.length) {
            return !answers[INITIAL_QUESTIONS[step].id];
        } else {
            // LSAS
            const q = LSAS_QUESTIONS[lsasIndex];
            const ans = lsasAnswers[q.id];
            return !ans || ans.fear === undefined || ans.avoidance === undefined || ans.fear === null || ans.avoidance === null;
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.headerImage}>
                <TouchableOpacity
                    style={styles.skipButton}
                    onPress={async () => {
                        await AsyncStorage.setItem('has_onboarded', 'true');
                        router.replace('/(tabs)/voice');
                    }}
                >
                    <Text style={styles.skipText}>Skip (Testing)</Text>
                </TouchableOpacity>
                <View style={styles.headerCircle}>
                    <Text style={{ fontSize: 50 }}>😊</Text>
                </View>
            </View>

            {renderContent()}

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[
                        styles.continueButton,
                        isNextDisabled() && styles.disabledButton
                    ]}
                    onPress={showResults ? handleFinish : handleNext}
                    disabled={isNextDisabled()}
                >
                    <Text style={styles.continueText}>
                        {showResults
                            ? (downloadProgress < 0.99 ? `Installing... ${(downloadProgress * 100).toFixed(0)}%` : 'Finish & Start')
                            : 'Continue'}
                    </Text>
                </TouchableOpacity>
                {downloadProgress < 1 && (
                    <Text style={styles.progressText}>
                        Setting up AI... {(downloadProgress * 100).toFixed(0)}%
                        {downloadStatus && `\n${downloadStatus}`}
                    </Text>
                )}
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#ffffff',
    },
    headerImage: {
        width: '100%',
        height: 120, // Reduced from 200
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: 10,
        position: 'relative', // For absolute positioning of skip
    },
    skipButton: {
        position: 'absolute',
        top: 0,
        right: 24,
        zIndex: 10,
        padding: 8,
    },
    skipText: {
        color: '#007AFF',
        fontWeight: '600',
    },
    headerCircle: {
        width: 80, // Reduced
        height: 80,
        borderRadius: 40,
        backgroundColor: '#FF6B00',
        justifyContent: 'center',
        alignItems: 'center',
    },
    content: {
        flex: 1,
        paddingHorizontal: 24,
        marginTop: 10,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        textAlign: 'center',
        marginBottom: 8,
        color: '#000',
    },
    subtitle: {
        fontSize: 16,
        textAlign: 'center',
        color: '#666',
        marginBottom: 20,
    },
    optionsContainer: {
        gap: 12,
        paddingBottom: 20,
    },
    optionButton: {
        paddingVertical: 16,
        paddingHorizontal: 20,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: '#EEE',
        backgroundColor: '#FFF',
        elevation: 2,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    selectedOption: {
        borderColor: '#007AFF',
        backgroundColor: '#F0F8FF',
    },
    optionText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
    },
    checkmark: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: '#007AFF',
        justifyContent: 'center',
        alignItems: 'center',
    },
    footer: {
        padding: 24,
        borderTopWidth: 1,
        borderTopColor: '#f0f0f0',
    },
    continueButton: {
        backgroundColor: '#007AFF',
        borderRadius: 30,
        paddingVertical: 16,
        alignItems: 'center',
        elevation: 5,
    },
    disabledButton: {
        backgroundColor: '#CCC',
        elevation: 0,
    },
    continueText: {
        color: 'white',
        fontSize: 18,
        fontWeight: 'bold',
    },
    progressText: {
        textAlign: 'center',
        marginTop: 10,
        color: '#888',
        fontSize: 12,
    },
    // LSAS Styles
    lsasContainer: {
        paddingBottom: 20,
    },
    progressLabel: {
        textAlign: 'center',
        color: '#888',
        fontSize: 12,
        marginBottom: 5,
        textTransform: 'uppercase',
        letterSpacing: 1,
    },
    sliderLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
        marginBottom: 10,
    },
    sliderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 8,
    },
    sliderBtn: {
        flex: 1,
        aspectRatio: 1,
        backgroundColor: '#F5F5F5',
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    sliderBtnSelected: {
        backgroundColor: '#007AFF',
    },
    sliderBtnText: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#333',
    },
    sliderBtnSub: {
        fontSize: 10,
        color: '#666',
        marginTop: 4,
    },
    // Results Styles
    resultContainer: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingTop: 20,
    },
    resultTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 30,
    },
    scoreCircle: {
        width: 180,
        height: 180,
        borderRadius: 90,
        borderWidth: 8,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 40,
    },
    scoreText: {
        fontSize: 60,
        fontWeight: 'bold',
    },
    bandText: {
        fontSize: 16,
        fontWeight: '600',
        marginTop: 5,
        textAlign: 'center',
        maxWidth: 140,
    },
    domainTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 16,
        alignSelf: 'flex-start',
    },
    domainBadge: {
        backgroundColor: '#F0F0F0',
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 20,
        marginBottom: 10,
        width: '100%',
    },
    domainText: {
        fontSize: 16,
        fontWeight: '500',
        color: '#333',
    }
});
