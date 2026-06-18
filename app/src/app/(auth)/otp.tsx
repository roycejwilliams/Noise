// OTP verification screen — input → pending → success | error
// Pending replaces the full screen while the network call is in-flight.
// Success shows check icon + Continue; Continue checks subscription then routes.
// Error shows X icon + Go Back, which resets to input phase.
import { useResendOtp, useVerifyOtp } from "@/hooks/useAuth";
import api from "@/lib/api";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Phase = "input" | "pending" | "success" | "error";

export default function Otp() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [phase, setPhase] = useState<Phase>("input");
  const [errorMsg, setErrorMsg] = useState("Incorrect code. Try again.");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [checking, setChecking] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);
  const { mutate: verifyOtp } = useVerifyOtp();
  const { mutate: resendOtp, isPending: isResending } = useResendOtp();
  const router = useRouter();

  useEffect(() => {
    if (phase === "input" && digits.every((d) => d !== "")) {
      submit(digits.join(""));
    }
  }, [digits]);

  const submit = (code: string) => {
    setPhase("pending");
    verifyOtp(
      { user_id: userId, otp_code: code },
      {
        onSuccess: () => setPhase("success"),
        onError: (err: unknown) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          setErrorMsg(
            status === 423 || status === 429
              ? "Account locked. Contact support."
              : "Incorrect code. Try again."
          );
          setPhase("error");
        },
      }
    );
  };

  const handleContinue = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await api.get(`/payments/status/${userId}`);
      const status = res.data?.status ?? res.data?.data?.subscription_status;
      if (status === "active") {
        router.replace("/(auth)/pre-call");
      } else {
        router.replace({ pathname: "/(auth)/paywall", params: { userId } });
      }
    } catch {
      router.replace({ pathname: "/(auth)/paywall", params: { userId } });
    } finally {
      setChecking(false);
    }
  };

  const handleGoBack = () => {
    setDigits(Array(6).fill(""));
    setPhase("input");
    setTimeout(() => inputRefs.current[0]?.focus(), 100);
  };

  const handleChange = (value: string, index: number) => {
    if (!/^[0-9]?$/.test(value)) return;
    const next = [...digits];
    next[index] = value;
    setDigits(next);
    if (value && index < 5) inputRefs.current[index + 1]?.focus();
  };

  const handleKeyPress = (key: string, index: number) => {
    if (key === "Backspace" && !digits[index] && index > 0)
      inputRefs.current[index - 1]?.focus();
  };

  const handleResend = () => {
    if (resendCooldown > 0 || isResending) return;
    resendOtp(
      { user_id: userId },
      {
        onSuccess: () => {
          setDigits(Array(6).fill(""));
          setPhase("input");
          setResendCooldown(30);
          const interval = setInterval(() => {
            setResendCooldown((prev) => {
              if (prev <= 1) { clearInterval(interval); return 0; }
              return prev - 1;
            });
          }, 1000);
          setTimeout(() => inputRefs.current[0]?.focus(), 100);
        },
      }
    );
  };

  // --- Pending ---
  if (phase === "pending") {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.stateInner}>
          <View style={styles.logoMark} />
          <Text style={styles.stateTitle}>Authenticating</Text>
          <Text style={styles.stateLabel}>One Moment</Text>
          <ActivityIndicator color="#ffffff" size="large" style={{ marginTop: 12 }} />
        </View>
      </SafeAreaView>
    );
  }

  // --- Success ---
  if (phase === "success") {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.stateInner}>
          <View style={styles.logoMark} />
          <Text style={styles.stateTitle}>Success!</Text>
          <Text style={styles.stateCopy}>You're verified. Let's keep going.</Text>
          <Text style={styles.checkIcon}>✓</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={[styles.pillBtn, checking && styles.pillBtnDim]}
            onPress={handleContinue}
            disabled={checking}
            activeOpacity={0.7}
          >
            {checking
              ? <ActivityIndicator color="#ffffff" size="small" />
              : <Text style={styles.pillBtnText}>Continue</Text>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // --- Error ---
  if (phase === "error") {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.stateInner}>
          <View style={styles.logoMark} />
          <Text style={styles.stateTitle}>Something went wrong</Text>
          <Text style={styles.stateCopy}>{errorMsg}</Text>
          <Text style={styles.xIcon}>✕</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={styles.pillBtn}
            onPress={handleGoBack}
            activeOpacity={0.7}
          >
            <Text style={styles.pillBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // --- Input (default) ---
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.inputInner}>
        <View style={styles.logoMark} />
        <Text style={styles.title}>Verification Code</Text>
        <Text style={styles.subtitle}>We've sent a 6-digit code to your email</Text>

        <View style={styles.digitRow}>
          {digits.map((digit, i) => (
            <TextInput
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              style={[styles.digit, digit && styles.digitFilled]}
              value={digit}
              onChangeText={(v) => handleChange(v, i)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, i)}
              keyboardType="number-pad"
              maxLength={1}
              selectTextOnFocus
              caretHidden
            />
          ))}
        </View>

        <View style={styles.footer}>
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
            <Text style={styles.footerLink}>Wrong email? Go back</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleResend}
            disabled={resendCooldown > 0 || isResending}
            activeOpacity={0.7}
          >
            <Text style={[styles.footerLink, (resendCooldown > 0 || isResending) && styles.dimmed]}>
              {isResending ? "Sending..." : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Code"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },

  // Shared pending / success / error layout
  stateInner: {
    flex: 1,
    paddingHorizontal: 40,
    paddingTop: 40,
    paddingBottom: 32,
  },
  logoMark: {
    width: 60,
    height: 60,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ffffff",
    marginBottom: 48,
  },
  stateTitle: {
    fontSize: 20,
    fontWeight: "200",
    color: "#ffffff",
    marginBottom: 8,
  },
  stateLabel: {
    fontSize: 12,
    fontWeight: "200",
    color: "#ffffff",
    marginBottom: 16,
  },
  stateCopy: {
    fontSize: 16,
    fontStyle: "italic",
    fontWeight: "300",
    color: "rgba(255,255,255,0.55)",
    marginBottom: 16,
  },
  checkIcon: {
    fontSize: 42,
    fontWeight: "200",
    color: "#ffffff",
    marginTop: 8,
  },
  xIcon: {
    fontSize: 36,
    fontWeight: "200",
    color: "#ffffff",
    marginTop: 8,
  },
  pillBtn: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
  pillBtnDim: { opacity: 0.4 },
  pillBtnText: { fontSize: 15, fontWeight: "200", color: "#ffffff" },

  // Input layout
  inputInner: {
    flex: 1,
    paddingHorizontal: 33,
    paddingTop: 40,
  },
  title: {
    fontSize: 20,
    fontWeight: "300",
    color: "#ffffff",
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 12,
    color: "rgba(255,255,255,0.5)",
    marginBottom: 28,
  },
  digitRow: { flexDirection: "row", gap: 10, marginBottom: 20 },
  digit: {
    flex: 1,
    height: 45,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 10,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "300",
    color: "#ffffff",
    backgroundColor: "transparent",
  },
  digitFilled: { borderColor: "rgba(255,255,255,0.8)" },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  footerLink: { fontSize: 11, color: "rgba(255,255,255,0.4)" },
  dimmed: { opacity: 0.3 },
});
