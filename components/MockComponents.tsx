import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

export const Spinner = ({ visible, textContent }: { visible: boolean; textContent: string }) => {
    if (!visible) return null;
    return (
        <View style={styles.spinnerContainer}>
            <ActivityIndicator size="large" color="#0000ff" />
            <Text style={styles.spinnerText}>{textContent}</Text>
        </View>
    );
};

export const Messages = ({ chatHistory, llmResponse, isGenerating, deleteMessage }: any) => {
    return (
        <View style={styles.messagesContainer}>
            <Text>Messages Placeholder</Text>
            {chatHistory.map((msg: any, index: number) => (
                <Text key={index} style={msg.role === 'user' ? styles.userMsg : styles.aiMsg}>
                    {msg.role}: {msg.content}
                </Text>
            ))}
            <Text>{llmResponse}</Text>
        </View>
    );
};

// Icons adapted as text for simplicity or SVG wrappers if installed
export const SWMIcon = (props: any) => <Text>🤖</Text>;
export const PauseIcon = (props: any) => <Text>⏸️</Text>;
export const MicIcon = (props: any) => <Text>🎤</Text>;
export const StopIcon = (props: any) => <Text>⏹️</Text>;

const styles = StyleSheet.create({
    spinnerContainer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.8)',
        zIndex: 1000,
    },
    spinnerText: {
        marginTop: 10,
        textAlign: 'center',
    },
    messagesContainer: {
        padding: 10,
    },
    userMsg: {
        color: 'blue',
        alignSelf: 'flex-end',
        marginVertical: 2,
    },
    aiMsg: {
        color: 'green',
        alignSelf: 'flex-start',
        marginVertical: 2,
    },
});
