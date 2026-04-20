import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { ResizeMode, Video, type AVPlaybackStatus, type VideoProps } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import type { AvatarVideoSegment } from '../services/avatarSession';

interface SoulxSegmentPlayerProps {
    sessionId: string | null;
    segments: AvatarVideoSegment[];
    onConnectedChange?: (connected: boolean) => void;
    onPlaybackFinished?: () => void;
    onError?: (message: string) => void;
}

type Slot = 'a' | 'b';

export function SoulxSegmentPlayer({
    sessionId,
    segments,
    onConnectedChange,
    onPlaybackFinished,
    onError,
}: SoulxSegmentPlayerProps) {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [localUris, setLocalUris] = useState<Record<string, string>>({});
    // Double-buffer: one slot plays while the other pre-loads the next segment.
    const [activeSlot, setActiveSlot] = useState<Slot>('a');
    const [slotUri, setSlotUri] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
    const videoA = useRef<Video>(null);
    const videoB = useRef<Video>(null);

    useEffect(() => {
        setCurrentIndex(0);
        setLocalUris({});
        setActiveSlot('a');
        setSlotUri({ a: null, b: null });
    }, [sessionId]);

    useEffect(() => {
        onConnectedChange?.(segments.length > 0);
    }, [segments.length, onConnectedChange]);

    // Parallel prefetch: download upcoming segments concurrently.
    useEffect(() => {
        let cancelled = false;

        const prefetchSegments = async () => {
            if (!sessionId) return;

            const baseDir = FileSystem.cacheDirectory;
            if (!baseDir) return;

            const sessionDir = `${baseDir}soulx-segments/${sessionId}/`;
            await FileSystem.makeDirectoryAsync(sessionDir, { intermediates: true }).catch(() => undefined);

            const upcoming = segments.slice(currentIndex, currentIndex + 3);

            await Promise.all(
                upcoming.map(async (segment) => {
                    if (cancelled || localUris[segment.url]) return;

                    const fileUri = `${sessionDir}${segment.segmentIndex}.mp4`;
                    const info = await FileSystem.getInfoAsync(fileUri).catch(() => ({ exists: false }));
                    if (info.exists) {
                        if (!cancelled) setLocalUris((prev) => ({ ...prev, [segment.url]: fileUri }));
                        return;
                    }

                    try {
                        const result = await FileSystem.downloadAsync(segment.url, fileUri);
                        if (!cancelled) setLocalUris((prev) => ({ ...prev, [segment.url]: result.uri }));
                    } catch (error) {
                        if (!cancelled) {
                            console.warn('[soulx-segment-player] prefetch failed:', error instanceof Error ? error.message : String(error));
                        }
                    }
                }),
            );
        };

        void prefetchSegments();
        return () => { cancelled = true; };
    }, [currentIndex, localUris, segments, sessionId]);

    // When a new local URI becomes available, push it into the inactive slot so it's
    // pre-loaded before we need it.
    const currentSegment = useMemo(() => segments[currentIndex] ?? null, [currentIndex, segments]);
    const nextSegment = useMemo(() => segments[currentIndex + 1] ?? null, [currentIndex, segments]);

    // Load current segment into the active slot.
    useEffect(() => {
        if (!currentSegment) return;
        const uri = localUris[currentSegment.url] ?? currentSegment.url;
        setSlotUri((prev) => ({ ...prev, [activeSlot]: uri }));
    }, [currentSegment, localUris, activeSlot]);

    // Pre-load next segment into the inactive slot.
    const inactiveSlot: Slot = activeSlot === 'a' ? 'b' : 'a';
    useEffect(() => {
        if (!nextSegment) return;
        const uri = localUris[nextSegment.url];
        if (!uri) return; // Not downloaded yet; will re-run once localUris updates.
        setSlotUri((prev) => ({ ...prev, [inactiveSlot]: uri }));
    }, [nextSegment, localUris, inactiveSlot]);

    const handleStatusUpdate = (status: AVPlaybackStatus) => {
        if (!status.isLoaded) {
            if (status.error) onError?.(status.error);
            return;
        }

        if (status.didJustFinish) {
            const finishedSegment = currentSegment;
            const nextIndex = currentIndex + 1;

            if (nextIndex < segments.length) {
                // Swap to the pre-loaded inactive slot.
                setActiveSlot(inactiveSlot);
            }

            setCurrentIndex(nextIndex);

            if (finishedSegment?.final) {
                onPlaybackFinished?.();
            }
        }
    };

    const sharedVideoProps: Partial<VideoProps> = {
        style: styles.video,
        resizeMode: ResizeMode.CONTAIN,
        isLooping: false,
        useNativeControls: false,
        isMuted: true, // TTS drives audio; suppress embedded segment audio.
    };

    return (
        <View style={styles.container}>
            {slotUri.a || slotUri.b ? (
                <>
                    {slotUri.a ? (
                        <Video
                            ref={videoA}
                            {...sharedVideoProps}
                            source={{ uri: slotUri.a }}
                            shouldPlay={activeSlot === 'a'}
                            style={[styles.video, activeSlot !== 'a' && styles.hidden]}
                            onError={(error) => {
                                const message = typeof error === 'string' ? error : JSON.stringify(error);
                                onError?.(message);
                            }}
                            onPlaybackStatusUpdate={activeSlot === 'a' ? handleStatusUpdate : undefined}
                        />
                    ) : null}
                    {slotUri.b ? (
                        <Video
                            ref={videoB}
                            {...sharedVideoProps}
                            source={{ uri: slotUri.b }}
                            shouldPlay={activeSlot === 'b'}
                            style={[styles.video, activeSlot !== 'b' && styles.hidden]}
                            onError={(error) => {
                                const message = typeof error === 'string' ? error : JSON.stringify(error);
                                onError?.(message);
                            }}
                            onPlaybackStatusUpdate={activeSlot === 'b' ? handleStatusUpdate : undefined}
                        />
                    ) : null}
                </>
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
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#08111f',
    },
    hidden: {
        opacity: 0,
        pointerEvents: 'none',
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
