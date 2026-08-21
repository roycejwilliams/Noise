import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function PaymentSuccess() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>Co</Text>

      <View style={styles.content}>
        <Text style={styles.title}>You are in.</Text>
        <Text style={styles.subtitle}>
          Co will reach out shortly to get started.
        </Text>

        <TouchableOpacity
          style={styles.cta}
          onPress={() => router.replace("/(auth)/pre-call")}
          activeOpacity={0.85}
        >
          <Text style={styles.ctaText}>Continue</Text>
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
  subtitle: { fontSize: 14, color: "#666666", lineHeight: 20 },
  cta: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 16,
  },
  ctaText: { fontSize: 15, fontWeight: "600", color: "#000000" },
});
