// import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
// import {
//     ActivityIndicator,
//     Alert,
//     Animated,
//     Dimensions,
//     Easing,
//     Keyboard,
//     Platform,
//     StyleSheet,
//     Text,
//     TouchableOpacity,
//     TouchableWithoutFeedback,
//     View
// } from 'react-native';
// // Mocks
// import { MicIcon } from '../../components/MockComponents';
// import { GeneratingContext } from '../../context/GeneratingContext';

// // Libraries
// import Daily, { DailyCall, DailyEventObject, DailyMediaView } from "@daily-co/react-native-daily-js";
// import { useIsFocused } from '@react-navigation/native';

// // Constants
// const { width } = Dimensions.get('window');

// // REPLACE THIS WITH YOUR TAVUS API KEY
// const TAVUS_API_KEY = "e39c0560a7494138bbe6c8ed492699cd";

// // --- Types & Constants ---

// type Scenario = 'small_talk' | 'making_friends' | 'job_interview' | 'dating';

// const SCENARIOS: { id: Scenario; label: string; icon: string; promptBase: string }[] = [
//     {
//         id: 'small_talk',
//         label: 'Small Talk',
//         icon: '☕',
//         promptBase: 'You are a stranger at a coffee shop. We are making casual small talk.'
//     },
//     {
//         id: 'making_friends',
//         label: 'Making Friends',
//         icon: '👋',
//         promptBase: 'You are a potential new friend I just met at a mixer. Be friendly and open.'
//     },
//     {
//         id: 'job_interview',
//         label: 'Job Interview',
//         icon: '💼',
//         promptBase: 'You are a hiring manager for a tech company. Conduct a professional job interview with me.'
//     },
//     {
//         id: 'dating',
//         label: 'Date',
//         icon: '❤️',
//         promptBase: 'You are my date for the evening. Be charming, engaging, and flirtatious if appropriate.'
//     },
// ];

// const NAMES = {
//     male: ['James', 'David', 'Michael', 'Chris', 'Robert'],
//     female: ['Sarah', 'Emily', 'Jessica', 'Jennifer', 'Ashley']
// };

// const STYLES = ['calm', 'energetic', 'thoughtful', 'witty', 'direct'];

// const getRandomPersona = (scenarioId: Scenario) => {
//     const gender = (Math.random() > 0.5 ? 'male' : 'female') as 'male' | 'female';
//     const name = NAMES[gender][Math.floor(Math.random() * NAMES[gender].length)];
//     const age = Math.floor(Math.random() * (40 - 22) + 22); // 22-40
//     const style = STYLES[Math.floor(Math.random() * STYLES.length)];

//     return {
//         name,
//         age,
//         gender,
//         style,
//         description: `Name: ${name}. Age: ${age}. Gender: ${gender}. Speaking Style: ${style}.`
//     };
// };

// // --- Main Components ---

// export default function VoiceChatScreenWrapper() {
//     const isFocused = useIsFocused();
//     return isFocused ? <VoiceChatScreen /> : null;
// }

// function VoiceChatScreen() {
//     const isFocused = useIsFocused();
//     const { setGlobalGenerating } = useContext(GeneratingContext);

//     // --- State ---
//     const [callObject, setCallObject] = useState<DailyCall | null>(null);
//     const [sessionActive, setSessionActive] = useState(false);
//     const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
//     const [loading, setLoading] = useState(false);
//     const [joined, setJoined] = useState(false);
//     const [remoteParticipantId, setRemoteParticipantId] = useState<string | null>(null);

//     // Animation
//     const pulseAnim = useRef(new Animated.Value(1)).current;

//     // --- Daily.co Call Management ---
//     useEffect(() => {
//         const newCallObject = Daily.createCallObject();
//         setCallObject(newCallObject);

//         return () => {
//             newCallObject.destroy();
//         };
//     }, []);

//     const handleParticipantJoined = useCallback((event: DailyEventObject) => {
//         if (!event.participant.local) {
//             setRemoteParticipantId(event.participant.session_id);
//             setGlobalGenerating(false); // Agent joined, stop "loading" state if any
//         }
//     }, [setGlobalGenerating]);

//     const handleParticipantLeft = useCallback((event: DailyEventObject) => {
//         if (!event.participant.local) {
//             setRemoteParticipantId(null);
//         }
//     }, []);

//     const handleError = useCallback((event: DailyEventObject) => {
//         console.error("Daily Error:", event);
//         Alert.alert("Error", "An error occurred with the call.");
//         setJoined(false);
//         setLoading(false);
//         setSessionActive(false);
//         setGlobalGenerating(false);
//     }, [setGlobalGenerating]);

//     useEffect(() => {
//         if (!callObject) return;

//         callObject.on("participant-joined", handleParticipantJoined);
//         callObject.on("participant-left", handleParticipantLeft);
//         callObject.on("error", handleError);

//         return () => {
//             callObject.off("participant-joined", handleParticipantJoined);
//             callObject.off("participant-left", handleParticipantLeft);
//             callObject.off("error", handleError);
//         };
//     }, [callObject, handleParticipantJoined, handleParticipantLeft, handleError]);


//     // --- Session Logic ---

//     const handleStartSession = async () => {
//         if (!selectedScenario) return;

//         // if (TAVUS_API_KEY === "REPLACE_WITH_YOUR_TAVUS_API_KEY") {
//         //     Alert.alert("Configuration Error", "Please set your Tavus API Key in the code.");
//         //     return;
//         // }

//         const p = getRandomPersona(selectedScenario);


//         if (p.gender == "female") {
//             const REPLICA_ID = "rf4e9d9790f0"; // Anna
//             const PERSONA_ID = "pcb7a34da5fe"; // Sales Development Rep
//         } else {
//             const REPLICA_ID = "rf4e9d9790f0"; // Anna
//             const PERSONA_ID = "pcb7a34da5fe"; // Sales Development Rep
//         }
//         // Note: We are currently using fixed persona IDs for Tavus demo as per request,
//         // but we could theoretically create new personas via API if Tavus supports it dynamically
//         // or select from a pre-made list. For now, we use the user-provided Example IDs.

//         setLoading(true);
//         setSessionActive(true);
//         setGlobalGenerating(true);

//         try {
//             // Create Tavus Conversation
//             const response = await fetch("https://tavusapi.com/v2/conversations", {
//                 method: "POST",
//                 headers: {
//                     "Content-Type": "application/json",
//                     "x-api-key": TAVUS_API_KEY,
//                 },
//                 body: JSON.stringify({
//                     replica_id: REPLICA_ID,
//                     persona_id: PERSONA_ID,
//                     // We could potentially pass the scenario context if Tavus API supports context/propmpt overrides
//                     // conversation_name: `Scenario: ${selectedScenario}`,
//                 }),
//             });

//             if (!response.ok) {
//                 const errorData = await response.text();
//                 throw new Error(`Failed to create conversation: ${errorData}`);
//             }

//             const data = await response.json();
//             const conversationUrl = data.conversation_url;

//             if (!conversationUrl) {
//                 throw new Error("No conversation URL returned");
//             }

//             // Join Daily Call
//             if (callObject) {
//                 await callObject.join({ url: conversationUrl });
//                 setJoined(true);
//             }

//         } catch (e: any) {
//             console.error(e);
//             Alert.alert("Error", e.message);
//             setSessionActive(false);
//         } finally {
//             setLoading(false);
//             // keep global generating true until participant joins? or just false here
//             // setGlobalGenerating(false); 
//         }
//     };

//     const handleEndSession = async () => {
//         if (callObject) {
//             await callObject.leave();
//         }
//         setJoined(false);
//         setSessionActive(false);
//         setRemoteParticipantId(null);
//         setGlobalGenerating(false);
//     };

//     // --- Animation Loop (Visuals) ---
//     useEffect(() => {
//         if (sessionActive && joined) {
//             Animated.loop(
//                 Animated.sequence([
//                     Animated.timing(pulseAnim, {
//                         toValue: 1.05,
//                         duration: 1500,
//                         easing: Easing.inOut(Easing.ease),
//                         useNativeDriver: true,
//                     }),
//                     Animated.timing(pulseAnim, {
//                         toValue: 1,
//                         duration: 1500,
//                         easing: Easing.inOut(Easing.ease),
//                         useNativeDriver: true,
//                     }),
//                 ])
//             ).start();
//         } else {
//             pulseAnim.setValue(1);
//         }
//     }, [sessionActive, joined]);


//     // --- Render ---

//     return (
//         <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
//             <View style={styles.container}>

//                 {/* Header */}
//                 <View style={styles.header}>
//                     <Text style={styles.headerTitle}>
//                         {sessionActive
//                             ? SCENARIOS.find(s => s.id === selectedScenario)?.label || 'Voice Chat'
//                             : 'Practice Mode'}
//                     </Text>
//                     {sessionActive && (
//                         <TouchableOpacity onPress={handleEndSession}>
//                             <Text style={styles.endButton}>End</Text>
//                         </TouchableOpacity>
//                     )}
//                 </View>

//                 {/* Content Logic */}
//                 {!sessionActive ? (
//                     // 1. Scenario Selection
//                     <View style={styles.selectionContainer}>
//                         <Text style={styles.subHeader}>Choose a situation to practice:</Text>
//                         <View style={styles.grid}>
//                             {SCENARIOS.map((item) => (
//                                 <TouchableOpacity
//                                     key={item.id}
//                                     style={[
//                                         styles.card,
//                                         selectedScenario === item.id && styles.cardSelected
//                                     ]}
//                                     onPress={() => setSelectedScenario(item.id)}
//                                 >
//                                     <Text style={styles.cardIcon}>{item.icon}</Text>
//                                     <Text style={[
//                                         styles.cardLabel,
//                                         selectedScenario === item.id && styles.cardLabelSelected
//                                     ]}>{item.label}</Text>
//                                 </TouchableOpacity>
//                             ))}
//                         </View>

//                         <View style={{ flex: 1 }} />

//                         <TouchableOpacity
//                             style={[styles.startButton, !selectedScenario && styles.startButtonDisabled]}
//                             disabled={!selectedScenario}
//                             onPress={handleStartSession}
//                         >
//                             <Text style={styles.startText}>Start Conversation</Text>
//                         </TouchableOpacity>
//                     </View>
//                 ) : (
//                     // 2. Active Voice Session (Tavus/Daily)
//                     <View style={styles.callContainer}>
//                         {loading ? (
//                             <ActivityIndicator size="large" color="#007AFF" />
//                         ) : (
//                             <View style={styles.videoWrapper}>
//                                 {remoteParticipantId ? (
//                                     <DailyMediaView
//                                         videoTrack={callObject?.participants()[remoteParticipantId]?.videoTrack || null}
//                                         audioTrack={callObject?.participants()[remoteParticipantId]?.audioTrack || null}
//                                         mirror={false}
//                                         objectFit="cover"
//                                         style={styles.fullScreenVideo}
//                                     />
//                                 ) : (
//                                     <View style={styles.waitingContainer}>
//                                         <Text style={styles.waitingText}>Connecting to Agent...</Text>
//                                         <ActivityIndicator color="#fff" style={{ marginTop: 10 }} />
//                                     </View>
//                                 )}

//                                 {/* Self View (Optional, usually hidden for this type of app but good for debugging) */}
//                                 {/* 
//                                 <View style={styles.selfView}>
//                                     <DailyMediaView
//                                         videoTrack={callObject?.participants().local?.videoTrack || null}
//                                         audioTrack={null}
//                                         mirror={true}
//                                         objectFit="cover"
//                                         style={{flex: 1}}
//                                     />
//                                 </View> 
//                                 */}
//                             </View>
//                         )}

//                         {/* Status / Controls Overlay */}
//                         <View style={styles.controlsOverlay}>
//                             <TouchableOpacity style={styles.micButton} onPress={() => {
//                                 const local = callObject?.participants().local;
//                                 callObject?.setLocalAudio(!local?.audio);
//                             }}>
//                                 <MicIcon width={30} height={30} color="#FFF" />
//                             </TouchableOpacity>
//                         </View>
//                     </View>
//                 )}
//             </View>
//         </TouchableWithoutFeedback>
//     );
// }

// const styles = StyleSheet.create({
//     container: {
//         flex: 1,
//         backgroundColor: '#FFF',
//         paddingTop: Platform.OS === 'android' ? 40 : 60,
//     },
//     header: {
//         flexDirection: 'row',
//         justifyContent: 'space-between',
//         paddingHorizontal: 24,
//         alignItems: 'center',
//         marginBottom: 20,
//     },
//     headerTitle: {
//         fontSize: 22,
//         fontWeight: 'bold',
//         color: '#333',
//     },
//     endButton: {
//         color: '#FF3B30',
//         fontSize: 16,
//         fontWeight: '600',
//     },

//     // Selection Styles
//     selectionContainer: {
//         flex: 1,
//         paddingHorizontal: 24,
//         paddingBottom: 40,
//     },
//     subHeader: {
//         fontSize: 16,
//         color: '#666',
//         marginBottom: 20,
//     },
//     grid: {
//         flexDirection: 'row',
//         flexWrap: 'wrap',
//         gap: 16,
//     },
//     card: {
//         width: (width - 64) / 2,
//         height: 120,
//         backgroundColor: '#F5F5F5',
//         borderRadius: 20,
//         justifyContent: 'center',
//         alignItems: 'center',
//         borderWidth: 2,
//         borderColor: 'transparent',
//     },
//     cardSelected: {
//         borderColor: '#007AFF',
//         backgroundColor: '#F0F8FF',
//     },
//     cardIcon: {
//         fontSize: 40,
//         marginBottom: 10,
//     },
//     cardLabel: {
//         fontSize: 16,
//         fontWeight: '600',
//         color: '#333',
//     },
//     cardLabelSelected: {
//         color: '#007AFF',
//     },
//     startButton: {
//         backgroundColor: '#007AFF',
//         height: 56,
//         borderRadius: 28,
//         justifyContent: 'center',
//         alignItems: 'center',
//         elevation: 4,
//         shadowColor: '#000',
//         shadowOffset: { width: 0, height: 2 },
//         shadowOpacity: 0.2,
//         shadowRadius: 4,
//     },
//     startButtonDisabled: {
//         backgroundColor: '#CCC',
//         elevation: 0,
//     },
//     startText: {
//         color: '#FFF',
//         fontSize: 18,
//         fontWeight: 'bold',
//     },

//     // Call Styles
//     callContainer: {
//         flex: 1,
//         backgroundColor: '#000',
//         justifyContent: 'center',
//         alignItems: 'center',
//     },
//     videoWrapper: {
//         width: '100%',
//         height: '100%',
//     },
//     fullScreenVideo: {
//         flex: 1,
//         backgroundColor: '#222',
//     },
//     waitingContainer: {
//         flex: 1,
//         justifyContent: 'center',
//         alignItems: 'center',
//         backgroundColor: '#111',
//     },
//     waitingText: {
//         color: '#FFF',
//         fontSize: 18,
//         fontWeight: '600',
//     },
//     controlsOverlay: {
//         position: 'absolute',
//         bottom: 40,
//         width: '100%',
//         alignItems: 'center',
//         justifyContent: 'center',
//     },
//     micButton: {
//         width: 60,
//         height: 60,
//         borderRadius: 30,
//         backgroundColor: 'rgba(255,255,255,0.2)',
//         justifyContent: 'center',
//         alignItems: 'center',
//     },
// });
