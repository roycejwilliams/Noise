import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function BookingPending() {
  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <View style={s.main}>
        <View style={s.iconPlaceholder}>
          <View style={s.iconInner} />
        </View>
        <Text style={s.headline}>We're coordinating your experience.</Text>
        <Text style={s.subtitle}>
          Your Circle Connector is booking the venue. Hang tight.
        </Text>
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
  iconPlaceholder: {
    width: 84,
    height: 84,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
  },
  iconInner: {
    width: 36,
    height: 36,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    borderRadius: 4,
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
});
