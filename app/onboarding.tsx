
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
    Dimensions,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { downloadAllModels } from '../services/ModelLoader';

const { width } = Dimensions.get('window');

const QUESTIONS = [
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
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadStarted, setDownloadStarted] = useState(false);

    useEffect(() => {
        if (!downloadStarted) {
            setDownloadStarted(true);
            downloadAllModels((progress) => {
                setDownloadProgress(progress);
            });
        }
    }, [downloadStarted]);

    const handleSelectOption = (option: string) => {
        setAnswers((prev) => ({ ...prev, [QUESTIONS[step].id]: option }));
    };

    const handleNext = async () => {
        if (step < QUESTIONS.length - 1) {
            setStep((prev) => prev + 1);
        } else {
            // Save and Finish
            try {
                await AsyncStorage.setItem('user_profile', JSON.stringify(answers));
                await AsyncStorage.setItem('has_onboarded', 'true');
                router.replace('/(tabs)/voice');
            } catch (e) {
                console.error('Failed to save onboarding data', e);
            }
        }
    };

    const currentQuestion = QUESTIONS[step];
    const styles = StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: '#ffffff',
        },
        headerImage: {
            width: '100%',
            height: 200,
            justifyContent: 'center',
            alignItems: 'center',
            marginTop: 40,
        },
        headerCircle: {
            width: 120,
            height: 120,
            borderRadius: 60,
            backgroundColor: '#FF6B00', // Orange similar to screenshot
            justifyContent: 'center',
            alignItems: 'center',
        },
        faceIcon: {
            fontSize: 40,
            color: 'white' // Placeholder for face logic
        },
        content: {
            flex: 1,
            paddingHorizontal: 24,
            marginTop: 20,
        },
        title: {
            fontSize: 28,
            fontWeight: 'bold',
            textAlign: 'center',
            marginBottom: 8,
            color: '#000',
        },
        subtitle: {
            fontSize: 16,
            textAlign: 'center',
            color: '#666',
            marginBottom: 32,
        },
        optionsContainer: {
            gap: 12,
        },
        optionButton: {
            paddingVertical: 16,
            paddingHorizontal: 20,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: '#EEE',
            backgroundColor: '#FFF',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.05,
            shadowRadius: 4,
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
            fontSize: 18,
            fontWeight: '600',
            color: '#333',
        },
        checkmark: {
            width: 24,
            height: 24,
            borderRadius: 12,
            backgroundColor: '#007AFF', // Blue check
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
            shadowColor: '#007AFF',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 8,
            elevation: 5,
        },
        disabledButton: {
            backgroundColor: '#CCC',
            shadowOpacity: 0,
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
        }
    });

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.headerImage}>
                {/* Placeholder for the aesthetic face circle */}
                <View style={styles.headerCircle}>
                    {/* Can replace with Image component later */}
                    <Text style={{ fontSize: 50 }}>😊</Text>
                </View>
            </View>

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

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.continueButton, !answers[currentQuestion.id] && styles.disabledButton]}
                    onPress={handleNext}
                    disabled={!answers[currentQuestion.id]}
                >
                    <Text style={styles.continueText}>Continue</Text>
                </TouchableOpacity>
                {downloadProgress < 1 && (
                    <Text style={styles.progressText}>
                        Setting up AI... {(downloadProgress * 100).toFixed(0)}%
                    </Text>
                )}
            </View>
        </SafeAreaView>
    );
}
