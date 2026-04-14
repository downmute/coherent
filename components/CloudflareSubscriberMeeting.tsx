import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { AvatarRtcCredentials } from '../services/avatarSession';

type RealtimeCoreModule = {
    useRealtimeKitClient: () => [any, (options: Record<string, unknown>) => Promise<void>];
    RealtimeKitProvider: React.ComponentType<{ value: any; children: React.ReactNode }>;
    useRealtimeKitSelector: <T>(selector: (meeting: any) => T) => T;
};

type RealtimeUiModule = {
    RtkMeeting?: React.ComponentType<Record<string, unknown>>;
    RtkUIProvider?: React.ComponentType<{ children: React.ReactNode }>;
    PeerView?: React.ComponentType<Record<string, unknown>>;
};

function shouldSuppressDyteLog(args: unknown[]): boolean {
    const message = args
        .map((value) => {
            if (typeof value === 'string') {
                return value;
            }

            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        })
        .join(' ');

    return message.includes('DyteInternalLogs::');
}

function isManualSubscriptionModeWarning(message: string): boolean {
    return (
        message.includes('Manual Subscription Mode was not ACTIVATED') ||
        message.includes('MANUAL subscription mode was not activated')
    );
}

function getRealtimeCore(): RealtimeCoreModule | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('@cloudflare/realtimekit-react-native') as RealtimeCoreModule;
    } catch {
        return null;
    }
}

function getRealtimeUi(): RealtimeUiModule | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const rootModule = require('@cloudflare/realtimekit-react-native-ui') as RealtimeUiModule;
        if (rootModule.PeerView) {
            return rootModule;
        }

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const peerViewModule = require('@cloudflare/realtimekit-react-native-ui/lib/module/PeerView') as {
                default?: React.ComponentType<Record<string, unknown>>;
            };
            return {
                ...rootModule,
                PeerView: peerViewModule.default,
            };
        } catch {
            return rootModule;
        }
    } catch {
        return null;
    }
}

function SubscriberMeetingInner({
    authToken,
    onConnectedChange,
    onError,
    core,
    ui,
}: {
    authToken: string;
    onConnectedChange?: (value: boolean) => void;
    onError?: (message: string) => void;
    core: RealtimeCoreModule;
    ui: RealtimeUiModule | null;
}) {
    const [meeting, initMeeting] = core.useRealtimeKitClient();
    const connectedChangeRef = React.useRef(onConnectedChange);
    const errorRef = React.useRef(onError);
    const initMeetingRef = React.useRef(initMeeting);
    const initializedAuthTokenRef = React.useRef<string | null>(null);
    const joinedMeetingRef = React.useRef<any>(null);
    const activeMeetingRef = React.useRef<any>(null);

    React.useEffect(() => {
        const originalDebug = console.debug;
        const originalInfo = console.info;
        const originalLog = console.log;

        console.debug = (...args: unknown[]) => {
            if (shouldSuppressDyteLog(args)) {
                return;
            }
            originalDebug(...args);
        };
        console.info = (...args: unknown[]) => {
            if (shouldSuppressDyteLog(args)) {
                return;
            }
            originalInfo(...args);
        };
        console.log = (...args: unknown[]) => {
            if (shouldSuppressDyteLog(args)) {
                return;
            }
            originalLog(...args);
        };

        return () => {
            console.debug = originalDebug;
            console.info = originalInfo;
            console.log = originalLog;
        };
    }, []);

    React.useEffect(() => {
        connectedChangeRef.current = onConnectedChange;
    }, [onConnectedChange]);

    React.useEffect(() => {
        errorRef.current = onError;
    }, [onError]);

    React.useEffect(() => {
        initMeetingRef.current = initMeeting;
    }, [initMeeting]);

    React.useEffect(() => {
        let cancelled = false;

        if (initializedAuthTokenRef.current === authToken) {
            return () => {
                cancelled = true;
            };
        }
        initializedAuthTokenRef.current = authToken;

        const init = async () => {
            try {
                console.log('[rtc-subscriber] initializing RealtimeKit client');
                await initMeetingRef.current({
                    authToken,
                    defaults: {
                        audio: false,
                        video: false,
                    },
                    modules: {
                        devTools: {
                            logs: false,
                        },
                    },
                    onError: (error: unknown) => {
                        const message = error instanceof Error ? error.message : String(error);
                        if (isManualSubscriptionModeWarning(message)) {
                            console.log('[rtc-subscriber] auto-subscription mode active');
                            return;
                        }
                        console.error('[rtc-subscriber] sdk error:', message);
                        errorRef.current?.(message);
                    },
                });
                console.log('[rtc-subscriber] RealtimeKit client initialized');
            } catch (error) {
                if (!cancelled) {
                    errorRef.current?.(error instanceof Error ? error.message : String(error));
                }
            }
        };

        void init();
        return () => {
            cancelled = true;
        };
    }, [authToken]);

    React.useEffect(() => {
        let cancelled = false;

        const join = async () => {
            if (!meeting) {
                return;
            }
            if (joinedMeetingRef.current === meeting) {
                return;
            }
            joinedMeetingRef.current = meeting;
            activeMeetingRef.current = meeting;

            try {
                console.log('[rtc-subscriber] joining room');
                if (typeof meeting.joinRoom === 'function') {
                    await meeting.joinRoom();
                } else if (typeof meeting.join === 'function') {
                    await meeting.join();
                }
                console.log('[rtc-subscriber] room join completed');

                if (typeof meeting?.self?.disableAudio === 'function') {
                    await meeting.self.disableAudio();
                }
                if (typeof meeting?.self?.disableVideo === 'function') {
                    await meeting.self.disableVideo();
                }
                console.log('[rtc-subscriber] local audio/video disabled for subscriber mode');
            } catch (error) {
                if (!cancelled) {
                    connectedChangeRef.current?.(false);
                    errorRef.current?.(error instanceof Error ? error.message : String(error));
                }
            }
        };

        void join();

        return () => {
            cancelled = true;
            connectedChangeRef.current?.(false);
        };
    }, [meeting]);

    React.useEffect(() => {
        return () => {
            connectedChangeRef.current?.(false);
            const activeMeeting = activeMeetingRef.current;
            activeMeetingRef.current = null;
            joinedMeetingRef.current = null;
            initializedAuthTokenRef.current = null;
            if (activeMeeting && typeof activeMeeting.leave === 'function') {
                console.log('[rtc-subscriber] leaving room');
                void activeMeeting.leave().catch(() => undefined);
            }
        };
    }, [authToken]);

    if (!meeting) {
        return (
            <View style={styles.placeholder}>
                <Text style={styles.placeholderTitle}>Connecting To Avatar Stream</Text>
                <Text style={styles.placeholderText}>Joining subscriber-only Cloudflare meeting…</Text>
            </View>
        );
    }

    const Provider = core.RealtimeKitProvider;
    const UiProvider = ui?.RtkUIProvider ?? React.Fragment;

    if (Provider) {
        return (
            <Provider value={meeting}>
                <UiProvider>
                    <SubscriberMedia
                        meeting={meeting}
                        core={core}
                        ui={ui}
                        onConnectedChange={onConnectedChange}
                        onError={onError}
                    />
                </UiProvider>
            </Provider>
        );
    }

    return (
        <View style={styles.placeholder}>
            <Text style={styles.placeholderTitle}>Subscriber Session Active</Text>
            <Text style={styles.placeholderText}>
                Cloudflare RealtimeKit is connected in subscriber-only mode. Install the native UI package to render remote media here.
            </Text>
        </View>
    );
}

function SubscriberMedia({
    meeting,
    core,
    ui,
    onConnectedChange,
    onError,
}: {
    meeting: any;
    core: RealtimeCoreModule;
    ui: RealtimeUiModule | null;
    onConnectedChange?: (value: boolean) => void;
    onError?: (message: string) => void;
}) {
    const { width } = useWindowDimensions();
    const state = core.useRealtimeKitSelector((client) => {
        const selfId = client.self.id;
        const remoteJoined = client.participants.joined
            .toArray()
            .filter((participant: any) => participant.id !== selfId);
        const videoSubscribed = client.participants.videoSubscribed
            .toArray()
            .filter((participant: any) => participant.id !== selfId);
        const audioSubscribed = client.participants.audioSubscribed
            .toArray()
            .filter((participant: any) => participant.id !== selfId);

        return {
            roomJoined: Boolean(client.self.roomJoined),
            roomState: String(client.self.roomState ?? 'unknown'),
            remoteJoined,
            videoSubscribed,
            audioSubscribed,
        };
    });

    const remotePeerIdsKey = state.remoteJoined
        .map((participant: any) => String(participant.id))
        .sort()
        .join(',');
    const hasRemoteMedia = state.videoSubscribed.length > 0 || state.audioSubscribed.length > 0;

    React.useEffect(() => {
        onConnectedChange?.(hasRemoteMedia || state.remoteJoined.length > 0);
    }, [hasRemoteMedia, onConnectedChange, state.remoteJoined.length]);

    React.useEffect(() => {
        console.log(
            `[rtc-subscriber] roomState=${state.roomState} roomJoined=${state.roomJoined} joined=${state.remoteJoined.length} videoSubscribed=${state.videoSubscribed.length} audioSubscribed=${state.audioSubscribed.length}`,
        );
    }, [
        state.audioSubscribed.length,
        state.remoteJoined.length,
        state.roomJoined,
        state.roomState,
        state.videoSubscribed.length,
    ]);

    React.useEffect(() => {
        if (state.remoteJoined.length === 0) {
            return;
        }

        const details = state.remoteJoined.map((participant: any) => ({
            id: String(participant.id),
            name: String(participant.name ?? ''),
            videoEnabled: Boolean(participant.videoEnabled),
            audioEnabled: Boolean(participant.audioEnabled),
            screenShareEnabled: Boolean(participant.screenShareEnabled),
            presetName: String(participant.presetName ?? ''),
        }));
        console.log('[rtc-subscriber] remote participant details', details);
    }, [remotePeerIdsKey, state.remoteJoined]);

    const PeerView = ui?.PeerView;
    const primaryParticipant = state.videoSubscribed[0] ?? state.remoteJoined[0] ?? null;
    const participantWidth = Math.max(280, width - 48);

    React.useEffect(() => {
        console.log(
            `[rtc-subscriber] renderer PeerView=${Boolean(PeerView)} primaryParticipant=${primaryParticipant ? String(primaryParticipant.id) : 'none'}`,
        );
    }, [PeerView, primaryParticipant]);

    if (PeerView && primaryParticipant) {
        return (
            <View style={styles.peerStage}>
                {React.createElement(PeerView, {
                    participant: primaryParticipant,
                    width: participantWidth,
                    height: Math.round(participantWidth * 1.1),
                    mirrorVideo: false,
                })}
                <View style={styles.debugPill}>
                    <Text style={styles.debugPillText}>
                        {`joined ${state.remoteJoined.length} | video ${state.videoSubscribed.length} | audio ${state.audioSubscribed.length}`}
                    </Text>
                </View>
            </View>
        );
    }

    const waitingMessage = !state.roomJoined
        ? 'Joining the Cloudflare subscriber room...'
        : state.remoteJoined.length === 0
            ? 'Subscriber joined. Waiting for the avatar publisher to appear...'
            : 'Publisher joined. Waiting for remote media tracks to subscribe...';

    return (
        <View style={styles.placeholder}>
            <Text style={styles.placeholderTitle}>Connecting To Avatar Stream</Text>
            <Text style={styles.placeholderText}>{waitingMessage}</Text>
            <Text style={styles.debugText}>
                {`room=${state.roomState} joined=${state.remoteJoined.length} video=${state.videoSubscribed.length} audio=${state.audioSubscribed.length}`}
            </Text>
        </View>
    );
}

export function CloudflareSubscriberMeeting({
    credentials,
    onConnectedChange,
    onError,
}: {
    credentials: AvatarRtcCredentials | null;
    onConnectedChange?: (value: boolean) => void;
    onError?: (message: string) => void;
}) {
    const shouldLoadRealtimeKit = Boolean(credentials && credentials.provider === 'cloudflare');
    const core = React.useMemo(
        () => (shouldLoadRealtimeKit ? getRealtimeCore() : null),
        [shouldLoadRealtimeKit],
    );
    const ui = React.useMemo(
        () => (shouldLoadRealtimeKit ? getRealtimeUi() : null),
        [shouldLoadRealtimeKit],
    );

    if (!credentials || credentials.provider !== 'cloudflare') {
        return (
            <View style={styles.placeholder}>
                <Text style={styles.placeholderTitle}>Waiting For Subscriber Session</Text>
                <Text style={styles.placeholderText}>
                    Start a video call to request a Cloudflare subscriber token.
                </Text>
            </View>
        );
    }

    if (!core) {
        return (
            <View style={styles.placeholder}>
                <Text style={styles.placeholderTitle}>Cloudflare RealtimeKit Not Installed</Text>
                <Text style={styles.placeholderText}>
                    Install the React Native RealtimeKit packages to render the remote avatar stream in-app.
                </Text>
            </View>
        );
    }

    return (
        <SubscriberMeetingInner
            authToken={credentials.token}
            onConnectedChange={onConnectedChange}
            onError={onError}
            core={core}
            ui={ui}
        />
    );
}

const styles = StyleSheet.create({
    placeholder: {
        flex: 1,
        width: '100%',
        minHeight: 320,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        backgroundColor: '#0b1625',
    },
    placeholderTitle: {
        color: '#f4fbff',
        fontSize: 18,
        fontWeight: '700',
        textAlign: 'center',
    },
    placeholderText: {
        marginTop: 10,
        color: '#a9bfd8',
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
    },
    peerStage: {
        flex: 1,
        width: '100%',
        minHeight: 320,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0b1625',
        paddingVertical: 16,
    },
    debugPill: {
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: 'rgba(8, 17, 31, 0.82)',
    },
    debugPillText: {
        color: '#d6e8ff',
        fontSize: 12,
    },
    debugText: {
        marginTop: 12,
        color: '#7f97b2',
        fontSize: 12,
        textAlign: 'center',
    },
});
