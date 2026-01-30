
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

export default function Index() {
    const [isMounted, setIsMounted] = useState(false);
    const [onboarded, setOnboarded] = useState<boolean | null>(null);
    const router = useRouter();

    useEffect(() => {
        setIsMounted(true);
        checkOnboarding();
    }, []);

    const checkOnboarding = async () => {
        try {
            // RESET FOR DEBUGGING
            await AsyncStorage.removeItem('has_onboarded');

            const value = await AsyncStorage.getItem('has_onboarded');
            setOnboarded(value === 'true');
        } catch (e) {
            setOnboarded(false);
        }
    };

    if (!isMounted || onboarded === null) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    if (onboarded) {
        return <Redirect href="/(tabs)/voice" />;
    } else {
        return <Redirect href="/onboarding" />;
    }
}
