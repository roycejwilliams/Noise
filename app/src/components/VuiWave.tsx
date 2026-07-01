import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

const BAR_COUNT = 32;

// Animated equalizer-style waveform — each bar loops a height bounce on its
// own randomized duration/delay so the row ripples rather than pulsing in unison.
export default function VuiWave() {
  const values = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.25))
  ).current;

  useEffect(() => {
    const loops = values.map((v, i) => {
      const duration = 550 + Math.random() * 500;
      const delay = (i / BAR_COUNT) * 400;
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, {
            toValue: 0.35 + Math.random() * 0.65,
            duration,
            useNativeDriver: false,
          }),
          Animated.timing(v, {
            toValue: 0.12 + Math.random() * 0.2,
            duration,
            useNativeDriver: false,
          }),
        ])
      );
      loop.start();
      return loop;
    });
    return () => loops.forEach((l) => l.stop());
  }, [values]);

  return (
    <View style={s.row} pointerEvents="none">
      {values.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            s.bar,
            {
              height: v.interpolate({
                inputRange: [0, 1],
                outputRange: ["0%", "100%"],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  bar: {
    flex: 1,
    marginHorizontal: 2,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
});
