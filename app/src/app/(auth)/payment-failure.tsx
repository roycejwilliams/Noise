import { useLocalSearchParams } from "expo-router";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const STRIPE_URL = process.env.EXPO_PUBLIC_STRIPE_CHECKOUT_URL ?? "";

export default function PaymentFailure() {
  const { reason } = useLocalSearchParams<{ reason: string }>();

  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>Co</Text>

      <View style={styles.content}>
        <Text style={styles.title}>Payment failed.</Text>
        <Text style={styles.reason}>{reason ?? "Payment did not complete."}</Text>

        <TouchableOpacity
          style={styles.cta}
          onPress={() => Linking.openURL(STRIPE_URL)}
          activeOpacity={0.85}
        >
          <Text style={styles.ctaText}>Try again</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondary}
          onPress={() => Linking.openURL(STRIPE_URL)}
          activeOpacity={0.7}
        >
          <Text style={styles.secondaryText}>Use a different card</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  wordmark: {
    fontSize: 26,
    fontWeight: "600",
    color: "#ffffff",
    letterSpacing: 0.5,
    marginBottom: 48,
  },
  content: { gap: 16 },
  title: { fontSize: 22, fontWeight: "600", color: "#ffffff", letterSpacing: -0.3 },
  reason: { fontSize: 14, color: "#666666", lineHeight: 20 },
  cta: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 8,
  },
  ctaText: { fontSize: 15, fontWeight: "600", color: "#000000" },
  secondary: { paddingVertical: 12, alignItems: "center" },
  secondaryText: { fontSize: 14, color: "#666666" },
});
