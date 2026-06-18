// Custom splash screen that renders on top of the Stack navigator.
// The native splash (expo-splash-screen) hands off to this component,
// which fades out once both conditions are true:
//   1. preparing is false (environment ready — driven by _layout's try/finally)
//   2. minimum display time has elapsed (so the splash never just flashes)
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  View,
} from "react-native";

interface Props {
  onDone: () => void;
  preparing: boolean;
}

export function SplashOverlay({ onDone, preparing }: Props) {
  const overlayOpacity = useRef(new Animated.Value(1)).current;
  const spinnerOpacity = useRef(new Animated.Value(0)).current;
  const [minTimeUp, setMinTimeUp] = useState(false);
  const hasFaded = useRef(false);

  const fadeOut = () => {
    if (hasFaded.current) return;
    hasFaded.current = true;
    Animated.timing(overlayOpacity, {
      toValue: 0,
      duration: 600,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onDone();
    });
  };

  // Minimum time the splash is visible regardless of how fast preparation finishes
  useEffect(() => {
    const t = setTimeout(() => setMinTimeUp(true), 1200);
    return () => clearTimeout(t);
  }, []);

  // Fade out only when both gates pass
  useEffect(() => {
    if (minTimeUp && !preparing) fadeOut();
  }, [minTimeUp, preparing]);

  // Spinner fades in/out based on whether there is active preparation work.
  // If the try block in _layout is empty, preparing flips true then false
  // before the animation even starts, so the spinner never appears.
  useEffect(() => {
    Animated.timing(spinnerOpacity, {
      toValue: preparing ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [preparing]);

  return (
    <Animated.View style={[styles.root, { opacity: overlayOpacity }]}>
      <View style={styles.center}>
        {/* Logo mark — placeholder until final brand assets land */}
        <View style={styles.logoMark} />
        <Text style={styles.wordmark}>CoPatible</Text>
        {/* <Text style={styles.tagline}>Your companion. Your circle.</Text> */}
        <Animated.View
          style={[styles.spinnerWrap, { opacity: spinnerOpacity }]}
        >
          <ActivityIndicator color="rgba(255,255,255,0.5)" size="small" />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
  },
  center: {
    alignItems: "center",
    gap: 14,
  },
  logoMark: {
    width: 60,
    height: 60,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ffffff",
    marginBottom: 4,
  },
  wordmark: {
    fontSize: 28,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.5,
  },
  tagline: {
    fontSize: 14,
    fontStyle: "italic",
    fontWeight: "300",
    color: "rgba(255,255,255,0.45)",
    letterSpacing: 0.2,
  },
  spinnerWrap: {
    marginTop: 24,
    height: 20,
    justifyContent: "center",
  },
});
