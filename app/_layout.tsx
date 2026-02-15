import { Stack } from "expo-router";
import "react-native-get-random-values";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GeneratingProvider } from "../context/GeneratingContext";
import "../global.css";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <GeneratingProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
      </GeneratingProvider>
    </SafeAreaProvider>
  );
}
