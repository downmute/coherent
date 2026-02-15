import Daily, { DailyCall, DailyEventObject, DailyMediaView } from "@daily-co/react-native-daily-js";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// REPLACE THIS WITH YOUR TAVUS API KEY
const TAVUS_API_KEY = "REPLACE_WITH_YOUR_TAVUS_API_KEY";
const REPLICA_ID = "rf4e9d9790f0"; // Anna
const PERSONA_ID = "pcb7a34da5fe"; // Sales Development Rep

export default function ChatScreen() {
    const [callObject, setCallObject] = useState<DailyCall | null>(null);
    const [joined, setJoined] = useState(false);
    const [loading, setLoading] = useState(false);
    const [remoteParticipantId, setRemoteParticipantId] = useState<string | null>(null);

    useEffect(() => {
        const newCallObject = Daily.createCallObject();
        setCallObject(newCallObject);

        return () => {
            newCallObject.destroy();
        };
    }, []);

    const handleParticipantJoined = useCallback((event: DailyEventObject) => {
        if (!event.participant.local) {
            setRemoteParticipantId(event.participant.session_id);
        }
    }, []);

    const handleParticipantLeft = useCallback((event: DailyEventObject) => {
        if (!event.participant.local) {
            setRemoteParticipantId(null);
        }
    }, []);

    const handleError = useCallback((event: DailyEventObject) => {
        console.error("Daily Error:", event);
        Alert.alert("Error", "An error occurred with the call.");
        setJoined(false);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (!callObject) return;

        callObject.on("participant-joined", handleParticipantJoined);
        callObject.on("participant-left", handleParticipantLeft);
        callObject.on("error", handleError);

        return () => {
            callObject.off("participant-joined", handleParticipantJoined);
            callObject.off("participant-left", handleParticipantLeft);
            callObject.off("error", handleError);
        };
    }, [callObject, handleParticipantJoined, handleParticipantLeft, handleError]);

    const startConversation = async () => {
        if (TAVUS_API_KEY === "REPLACE_WITH_YOUR_TAVUS_API_KEY") {
            Alert.alert("Configuration Error", "Please set your Tavus API Key in the code.");
            return;
        }

        setLoading(true);
        try {
            const response = await fetch("https://tavusapi.com/v2/conversations", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": TAVUS_API_KEY,
                },
                body: JSON.stringify({
                    replica_id: REPLICA_ID,
                    persona_id: PERSONA_ID,
                }),
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`Failed to create conversation: ${errorData}`);
            }

            const data = await response.json();
            const conversationUrl = data.conversation_url; // Adjust based on actual API response structure if strictly 'url' or 'conversation_url'

            if (!conversationUrl) {
                throw new Error("No conversation URL returned");
            }

            if (callObject) {
                await callObject.join({ url: conversationUrl });
                setJoined(true);
            }
        } catch (error: any) {
            Alert.alert("Error", error.message);
        } finally {
            setLoading(false);
        }
    };

    const leaveConversation = async () => {
        if (callObject) {
            await callObject.leave();
            setJoined(false);
            setRemoteParticipantId(null);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            {!joined ? (
                <View style={styles.startContainer}>
                    <Text style={styles.title}>Tavus Voice Agent</Text>
                    <Text style={styles.subtitle}>Native Daily.co Integration</Text>
                    <TouchableOpacity
                        style={styles.button}
                        onPress={startConversation}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.buttonText}>Start Conversation</Text>
                        )}
                    </TouchableOpacity>
                </View>
            ) : (
                <View style={styles.callContainer}>
                    {remoteParticipantId ? (
                        <DailyMediaView
                            videoTrack={null} // Or track from participant if video enabled
                            audioTrack={null} // Daily handles audio automatically usually, but MediaView is for video.
                            mirror={false}
                            objectFit="cover"
                            style={styles.videoView}
                        />
                    ) : (
                        <View style={styles.placeholderView}>
                            <Text style={styles.placeholderText}>Waiting for agent...</Text>
                        </View>
                    )}

                    {/*
                       Note: DailyMediaView is primarily for video.
                       If this is voice-only, we might not need it, or we use it for the agent's video.
                       The API response/doc implies video is possible.
                       If remoteParticipantId exists, we can try to show their video.
                       However, getting the track requires accessing callObject.participants()
                    */}
                    {remoteParticipantId && (
                        <View style={styles.videoContainer}>
                            <DailyMediaView
                                videoTrack={callObject?.participants()[remoteParticipantId]?.videoTrack || null}
                                audioTrack={callObject?.participants()[remoteParticipantId]?.audioTrack || null}
                                mirror={false}
                                objectFit="cover"
                                style={styles.videoView}
                            />
                        </View>
                    )}

                    <TouchableOpacity style={styles.leaveButton} onPress={leaveConversation}>
                        <Text style={styles.buttonText}>End Call</Text>
                    </TouchableOpacity>
                </View>
            )}
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#000",
    },
    startContainer: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
    },
    title: {
        fontSize: 24,
        fontWeight: "bold",
        color: "#fff",
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 16,
        color: "#ccc",
        marginBottom: 32,
    },
    button: {
        backgroundColor: "#2563eb",
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    leaveButton: {
        backgroundColor: "#ef4444",
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
        position: 'absolute',
        bottom: 40,
        alignSelf: 'center',
    },
    buttonText: {
        color: "#fff",
        fontWeight: "600",
        fontSize: 16,
    },
    callContainer: {
        flex: 1,
        position: 'relative',
    },
    videoContainer: {
        flex: 1,
        width: '100%',
        height: '100%',
    },
    videoView: {
        flex: 1,
        width: '100%',
        height: '100%',
    },
    placeholderView: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    placeholderText: {
        color: '#fff'
    }
});
