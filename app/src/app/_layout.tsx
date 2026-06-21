// Root layout — wraps the entire app in QueryClientProvider and manages
// the splash sequence. The native splash (expo-splash-screen) hands off to
// SplashOverlay, which fades out once preparation is done and a minimum
// display time has elapsed.
import { SplashOverlay } from "@/components/SplashOverlay";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

export default function RootLayout() {
  const [appReady, setAppReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  // preparing drives the spinner in SplashOverlay — true only while the
  // try block has async work in flight (font loading, prefetch, etc.)
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    async function prepare() {
      setPreparing(true);
      try {
        // add: await Font.loadAsync(...), await prefetchCriticalData(), etc.
      } finally {
        setPreparing(false);
        setAppReady(true);
      }
    }
    prepare();
  }, []);

  // Hide the native splash as soon as the app is ready to render
  useEffect(() => {
    if (appReady) SplashScreen.hideAsync();
  }, [appReady]);

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="voice" />
      </Stack>
      {/* SplashOverlay sits above the Stack and unmounts after its fade-out */}
      {!splashDone && (
        <SplashOverlay
          preparing={preparing}
          onDone={() => setSplashDone(true)}
        />
      )}
    </QueryClientProvider>
  );
}
