// Sign-in sub-form — rendered by the AuthScreen container when mode is "Login".
// Only asks for email; the backend sends an OTP to that address.
// Calls onSuccess(userId) on a successful POST — the container handles routing.
import { useLogin } from "@/hooks/useAuth";
import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

interface Props {
  onSuccess: (userId: string) => void;
}

export default function SignIn({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const { mutate: login, isPending } = useLogin();

  const handleContinue = () => {
    if (!email.trim() || isPending) return;
    setError("");
    login(
      { email: email.trim() },
      {
        onSuccess: (res) => onSuccess(res.data?.data?.id),
        onError: (err: unknown) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          setError(
            status === 404
              ? "No account found with that email."
              : "Something went wrong. Please try again."
          );
        },
      }
    );
  };

  return (
    <View style={styles.form}>
      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        onSubmitEditing={handleContinue}
        placeholder="your@email.com"
        placeholderTextColor="rgba(255,255,255,0.25)"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {!!error && <Text style={styles.errorText}>{error}</Text>}
      <TouchableOpacity
        style={[styles.cta, (!email.trim() || isPending) && styles.ctaDisabled]}
        onPress={handleContinue}
        disabled={!email.trim() || isPending}
        activeOpacity={0.7}
      >
        {isPending ? (
          <ActivityIndicator color="#ffffff" size="small" />
        ) : (
          <Text style={styles.ctaText}>Continue</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  label: {
    fontSize: 11,
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 0.5,
    marginBottom: -4,
  },
  // Pill-shaped outlined inputs — matches the Figma wireframe design language
  input: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 100,
    paddingHorizontal: 20,
    paddingVertical: 14,
    fontSize: 14,
    color: "#ffffff",
    backgroundColor: "transparent",
  },
  cta: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 8,
  },
  ctaDisabled: { opacity: 0.3 },
  ctaText: {
    fontSize: 14,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.3,
  },
  errorText: {
    fontSize: 12,
    color: "rgba(255,100,100,0.9)",
    marginTop: -4,
  },
});
