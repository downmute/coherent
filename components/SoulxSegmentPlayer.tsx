import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ResizeMode, Video, type AVPlaybackStatus } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import type { AvatarVideoSegment } from '../services/avatarSession';

interface SoulxSegmentPlayerProps {
    sessionId: string | null;
    segments: AvatarVideoSegment[];
    onConnectedChange?: (connected: boolean) => void;
    onError?: (message: string) => void;
}

export function SoulxSegmentPlayer({
    sessionId,
    segments,
    onConnectedChange,
    onError,
}: SoulxSegmentPlayerProps) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [localUris, setLocalUris] = useState<Record<string, string>>({});

    useEffect(() => {
        setCurrentIndex(0);
        setLocalUris({});
    }, [sessionId]);

    useEffect(() => {
        onConnectedChange?.(segments.length > 0);
    }, [segments.length, onConnectedChange]);

    useEffect(() => {
        let cancelled = false;

        const prefetchSegments = async () => {
            if (!sessionId) {
                return;
            }

            const baseDir = FileSystem.cacheDirectory;
            if (!baseDir) {
                return;
            }

            const sessionDir = `${baseDir}soulx-segments/${sessionId}/`;
            await FileSystem.makeDirectoryAsync(sessionDir, { intermediates: true }).catch(() => undefined);

            const upcoming = segments.slice(currentIndex, currentIndex + 3);
            for (const segment of upcoming) {
                if (cancelled || localUris[segment.url]) {
                    continue;
                }

                const fileUri = `${sessionDir}${segment.segmentIndex}.mp4`;
                const info = await FileSystem.getInfoAsync(fileUri).catch(() => ({ exists: false }));
                if (info.exists) {
                    if (!cancelled) {
                        setLocalUris((existing) => ({ ...existing, [segment.url]: fileUri }));
                    }
                    continue;
                }

                try {
                    const result = await FileSystem.downloadAsync(segment.url, fileUri);
                    if (!cancelled) {
                        setLocalUris((existing) => ({ ...existing, [segment.url]: result.uri }));
                    }
                } catch (error) {
                    if (!cancelled) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn('[soulx-segment-player] prefetch failed:', message);
                    }
                }
            }
        };

        void prefetchSegments();

        return () => {
            cancelled = true;
        };
    }, [currentIndex, localUris, onError, segments, sessionId]);

    const currentSegment = useMemo(() => {
        if (currentIndex < 0 || currentIndex >= segments.length) {
            return null;
        }
        return segments[currentIndex] ?? null;
    }, [currentIndex, segments]);

    const handleStatusUpdate = (status: AVPlaybackStatus) => {
        if (!status.isLoaded) {
            if (status.error) {
                onError?.(status.error);
            }
            return;
        }

        if (status.didJustFinish) {
            setCurrentIndex((value) => value + 1);
        }
    };

    return (
        <View style={styles.container}>
            {currentSegment ? (
                <Video
                    key={localUris[currentSegment.url] ?? currentSegment.url}
                    style={styles.video}
                    source={{ uri: localUris[currentSegment.url] ?? currentSegment.url }}
                    resizeMode={ResizeMode.COVER}
                    shouldPlay
                    isLooping={false}
                    useNativeControls={false}
                    onError={(error) => {
                        const message = typeof error === 'string' ? error : JSON.stringify(error);
                        onError?.(message);
                    }}
                    onPlaybackStatusUpdate={handleStatusUpdate}
                />
            ) : (
                <View style={styles.placeholder}>
                    <ActivityIndicator size="small" color="#7cc7ff" />
                    <Text style={styles.placeholderText}>
                        {segments.length > 0
                            ? 'Waiting for next SoulX segment...'
                            : 'Waiting for first SoulX segment...'}
                    </Text>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: '100%',
        height: '100%',
        backgroundColor: '#08111f',
    },
    video: {
        flex: 1,
        width: '100%',
        height: '100%',
        backgroundColor: '#08111f',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        backgroundColor: '#08111f',
    },
    placeholderText: {
        color: '#cfe4ff',
        fontSize: 14,
    },
});
