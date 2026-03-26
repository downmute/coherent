import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

export default function TabLayout() {
    return (
        <Tabs
            screenOptions={{
                tabBarActiveTintColor: "#2563eb", // blue-600
                tabBarInactiveTintColor: "#64748b", // slate-500
                tabBarStyle: {
                    backgroundColor: "#ffffff",
                    borderTopWidth: 1,
                    borderTopColor: "#e2e8f0",
                },
                headerShown: false,
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: "Home",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons name="home-outline" size={size} color={color} />
                    ),
                }}
            />

            <Tabs.Screen
                name="voice"
                options={{
                    title: "Practice",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons name="mic-outline" size={size} color={color} />
                    ),
                }}
            />

            <Tabs.Screen
                name="video"
                options={{
                    title: "Video",
                    tabBarIcon: ({ color, size }) => (
                        <Ionicons name="videocam-outline" size={size} color={color} />
                    ),
                }}
            />
        </Tabs>
    );
}
