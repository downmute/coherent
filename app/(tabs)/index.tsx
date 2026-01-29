import { Link } from "expo-router";
import { Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function HomeScreen() {
    return (
        <SafeAreaView className="flex-1 bg-slate-50 p-6">
            <View className="flex-1 items-center justify-center">
                <Text className="text-3xl font-bold text-slate-900 mb-4">Coherent</Text>
                <Text className="text-lg text-slate-600 text-center mb-8">
                    Master your social skills with real-time feedback.
                </Text>

                <Link href="/(tabs)/chat" asChild>
                    <TouchableOpacity className="bg-blue-600 px-8 py-4 rounded-full active:bg-blue-700">
                        <Text className="text-white font-bold text-lg">Start Practicing</Text>
                    </TouchableOpacity>
                </Link>
            </View>
        </SafeAreaView>
    );
}
