// Paywall — three states driven by plan selection and Stripe checkout session creation.
//
// idle:       landing view — pricing row with empty radio, hollow "Check out" button
// selected:   plan tapped — checkmark fills radio, "Check out" button turns white/filled
// processing: checkout tapped — spinner shows while POST /payments/create-subscription runs
//             then Linking.openURL opens Stripe in Safari
//
// Return-from-Stripe detection: two paths (fastest wins)
//   1. socket "subscription:active" event — server pushes after Stripe webhook fires
//   2. AppState "active" listener — polls GET /payments/status when app foregrounds
import api from "@/lib/api";
import { connectSocket, socket } from "@/lib/socket";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type PaywallState = "idle" | "selected" | "processing";

const FEATURES = [
  "Daily voice sessions with Co",
  "Energy-matched conversations",
  "Circle — share moments with close friends",
  "Early access to all new features",
  "Founding member status",
];

export default function Paywall() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const [state, setState] = useState<PaywallState>("idle");
  const [checking, setChecking] = useState(false);
  const appState = useRef(AppState.currentState);
  const hasOpenedStripe = useRef(false);

  useEffect(() => {
    connectSocket();

    socket.on("subscription:active", () =>
      router.replace("/(auth)/payment-success")
    );

    const sub = AppState.addEventListener("change", async (next: AppStateStatus) => {
      // Only poll when returning from Safari (user was in Stripe checkout)
      if (
        hasOpenedStripe.current &&
        appState.current.match(/inactive|background/) &&
        next === "active"
      ) {
        checkStatus();
      }
      appState.current = next;
    });

    return () => {
      socket.off("subscription:active");
      socket.disconnect();
      sub.remove();
    };
  }, []);

  const checkStatus = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await api.get(`/payments/status/${userId}`);
      const status = res.data?.status ?? res.data?.data?.subscription_status;
      if (status === "active") {
        router.replace("/(auth)/payment-success");
      } else {
        router.replace({
          pathname: "/(auth)/payment-failure",
          params: { reason: "Payment did not complete." },
        });
      }
    } catch {
      router.replace({
        pathname: "/(auth)/payment-failure",
        params: { reason: "Something went wrong. Try again." },
      });
    } finally {
      setChecking(false);
    }
  };

  const handleCheckout = async () => {
    if (state !== "selected") return;
    setState("processing");
    try {
      const res = await api.post("/payments/create-subscription");
      const checkoutUrl: string = res.data?.checkoutUrl ?? res.data?.checkout_url;
      if (checkoutUrl) {
        hasOpenedStripe.current = true;
        await Linking.openURL(checkoutUrl);
      }
    } catch (err) {
      console.error("Stripe session creation failed:", err);
      setState("selected");
    }
  };

  const isSelected = state === "selected" || state === "processing";

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.inner}>

        <View style={styles.topRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Private Beta</Text>
          </View>
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>✕</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.headline}>
          Your AI companion for clarity, connection, and growth.
        </Text>

        <Text style={styles.sectionLabel}>WHAT'S INCLUDED?</Text>
        <View style={styles.featureList}>
          {FEATURES.map((f) => (
            <View key={f} style={styles.featureRow}>
              <Text style={styles.bullet}>·</Text>
              <Text style={styles.featureText}>{f}</Text>
            </View>
          ))}
        </View>

        {/* Pricing row — tapping selects the plan */}
        <TouchableOpacity
          style={styles.pricingRow}
          onPress={() => state === "idle" && setState("selected")}
          activeOpacity={0.8}
        >
          <View style={styles.pricingLeft}>
            <Text style={styles.pricingTitle}>One time fee</Text>
            <View style={styles.pricingAmountRow}>
              <Text style={styles.pricingAmount}>$20.00</Text>
              <Text style={styles.pricingExpiry}>Until August 3rd</Text>
            </View>
          </View>
          <View style={[styles.radio, isSelected && styles.radioSelected]}>
            {isSelected && <Text style={styles.radioCheck}>✓</Text>}
          </View>
        </TouchableOpacity>

        {/* CTA — hollow in idle, white-filled in selected, spinner in processing */}
        {state === "processing" ? (
          <View style={styles.ctaSpinner}>
            <ActivityIndicator color="#ffffff" size="small" />
          </View>
        ) : (
          <TouchableOpacity
            style={[
              styles.cta,
              state === "idle" && styles.ctaIdle,
              state === "selected" && styles.ctaSelected,
            ]}
            onPress={state === "selected" ? handleCheckout : () => setState("selected")}
            activeOpacity={0.8}
          >
            <Text style={[styles.ctaText, state === "selected" && styles.ctaTextDark]}>
              {checking ? "Checking..." : "Check out"}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  inner: {
    flex: 1,
    paddingHorizontal: 33,
    paddingTop: 20,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 28,
  },
  badge: {
    backgroundColor: "#ffffff",
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  badgeText: { fontSize: 14, fontWeight: "400", color: "#000000" },
  closeBtn: { fontSize: 16, color: "rgba(255,255,255,0.5)" },
  headline: {
    fontSize: 24,
    fontWeight: "600",
    color: "#ffffff",
    lineHeight: 32,
    marginBottom: 28,
    width: "65%",
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "400",
    color: "rgba(255,255,255,0.6)",
    letterSpacing: 1,
    marginBottom: 16,
  },
  featureList: { gap: 10, marginBottom: 32 },
  featureRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  bullet: { fontSize: 16, color: "rgba(255,255,255,0.5)", lineHeight: 18 },
  featureText: {
    fontSize: 12,
    color: "rgba(255,255,255,0.7)",
    lineHeight: 18,
    flex: 1,
  },
  pricingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
    borderRadius: 100,
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginBottom: 16,
  },
  pricingLeft: { gap: 2 },
  pricingTitle: { fontSize: 15, fontWeight: "300", color: "#ffffff" },
  pricingAmountRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  pricingAmount: { fontSize: 12, fontWeight: "300", color: "#ffffff" },
  pricingExpiry: { fontSize: 10, color: "rgba(255,255,255,0.4)" },
  radio: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: "#ffffff",
    backgroundColor: "transparent",
  },
  radioCheck: {
    fontSize: 9,
    color: "#ffffff",
    lineHeight: 11,
  },
  cta: {
    borderWidth: 1,
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaIdle: {
    borderColor: "#ffffff",
    backgroundColor: "transparent",
  },
  ctaSelected: {
    borderColor: "#ffffff",
    backgroundColor: "#ffffff",
  },
  ctaText: { fontSize: 15, fontWeight: "300", color: "#ffffff", letterSpacing: 0.3 },
  ctaTextDark: { color: "#000000" },
  ctaSpinner: {
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
});
