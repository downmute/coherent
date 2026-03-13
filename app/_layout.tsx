import { Stack } from "expo-router";
import { useEffect } from "react";
import "react-native-get-random-values";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GeneratingProvider } from "../context/GeneratingContext";
import { preloadCoreModelsAtLaunch } from "../services/ModelLoader";
import "../global.css";

export default function RootLayout() {
  useEffect(() => {
    void preloadCoreModelsAtLaunch();
  }, []);

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
