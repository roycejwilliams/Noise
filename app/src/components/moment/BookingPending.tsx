import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const DOT_COUNT = 3;
const DOT_DURATION = 400;
const TIMEOUT_MS = 30 * 60 * 1000;

export default function BookingPending() {
  const dots = useRef(Array.from({ length: DOT_COUNT }, () => new Animated.Value(0.3))).current;
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const sequence = Animated.loop(
      Animated.sequence(
        dots.flatMap((dot, i) => [
          Animated.delay(i * DOT_DURATION),
          Animated.timing(dot, { toValue: 1, duration: DOT_DURATION, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: DOT_DURATION, useNativeDriver: true }),
        ]),
      ),
    );
    sequence.start();
    return () => sequence.stop();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <View style={s.main}>
        {/* Coordination icon */}
        <View style={s.icon}>
          <View style={s.iconRing}>
            <View style={s.iconDot} />
          </View>
        </View>

        <Text style={s.headline}>We're coordinating your experience.</Text>
        <Text style={s.subtitle}>
          {timedOut
            ? "Still coordinating. Co is following up with your Circle Connector."
            : "Your Circle Connector is booking the venue. Hang tight."}
        </Text>

        {/* Pulsing dots */}
        <View style={s.dotsRow}>
          {dots.map((opacity, i) => (
            <Animated.View key={i} style={[s.dot, { opacity }]} />
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1a1a1a" },
  wordmark: {
    fontSize: 24,
    fontWeight: "200",
    color: "#fff",
    letterSpacing: 0.3,
    marginTop: 8,
    paddingHorizontal: 32,
  },
  main: {
    flex: 1,
    paddingHorizontal: 32,
    paddingTop: 80,
    alignItems: "center",
  },
  icon: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
  },
  iconRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  headline: {
    fontSize: 20,
    fontWeight: "300",
    color: "#fff",
    textAlign: "center",
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: "300",
    color: "rgba(255,255,255,0.4)",
    textAlign: "center",
    lineHeight: 22,
  },
  dotsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 40,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.6)",
  },
});
