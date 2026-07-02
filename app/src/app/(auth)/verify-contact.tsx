// Shown after registration (and after a login attempt for an account that
// never completed this step). Our Sendblue plan can only reply to contacts
// who've texted in first, so the user has to text the Sendblue number once
// before Co can send an OTP. Polls the backend until that text arrives, then
// moves on to the OTP screen automatically.
import api from "@/lib/api";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  const digits = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

export default function VerifyContact() {
  const { userId, verifyNumber } = useLocalSearchParams<{
    userId: string;
    verifyNumber: string;
  }>();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!userId) return;

    const poll = async () => {
      try {
        const res = await api.get(`/auth/verify-status/${userId}`);
        if (res.data?.contact_verified) {
          if (pollRef.current) clearInterval(pollRef.current);
          router.replace({ pathname: "/(auth)/otp", params: { userId } });
        }
      } catch {
        // Non-fatal — just try again on the next tick
      }
    };

    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [userId]);

  const handleTextUs = async () => {
    if (!verifyNumber || checking) return;
    setChecking(true);
    try {
      await Linking.openURL(`sms:${verifyNumber}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.inner}>
        <View style={s.logoMark} />
        <Text style={s.title}>One more step</Text>
        <Text style={s.subtitle}>
          Text us once to verify your number. Co will send your code right after.
        </Text>

        <View style={s.numberCard}>
          <Text style={s.numberLabel}>Text this number</Text>
          <Text style={s.number}>
            {verifyNumber ? formatPhone(verifyNumber) : "..."}
          </Text>
        </View>

        <TouchableOpacity
          style={[s.cta, checking && s.ctaDim]}
          onPress={handleTextUs}
          disabled={!verifyNumber || checking}
          activeOpacity={0.8}
        >
          <Text style={s.ctaText}>Text Us</Text>
        </TouchableOpacity>

        <Text style={s.waitingLabel}>Waiting for your text...</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  inner: { flex: 1, paddingHorizontal: 33, paddingTop: 40 },
  logoMark: {
    width: 60,
    height: 60,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ffffff",
    marginBottom: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: "300",
    color: "#ffffff",
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: "300",
    color: "rgba(255,255,255,0.5)",
    lineHeight: 20,
    marginBottom: 32,
  },
  numberCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 20,
    alignItems: "center",
    marginBottom: 24,
  },
  numberLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  number: {
    fontSize: 24,
    fontWeight: "400",
    color: "#ffffff",
  },
  cta: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  ctaDim: { opacity: 0.5 },
  ctaText: {
    fontSize: 16,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.2,
  },
  waitingLabel: {
    fontSize: 13,
    fontWeight: "300",
    color: "rgba(255,255,255,0.35)",
    textAlign: "center",
  },
});
