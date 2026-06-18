// Sign-up sub-form — rendered by the AuthScreen container when mode is "New".
// Collects name, email, and phone. Phone is used for OTP delivery and later
// for Co voice calls. Calls onSuccess(userId) on a successful POST /auth/register.
import { useRegister } from "@/hooks/useAuth";
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

export default function SignUp({ onSuccess }: Props) {
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const { mutate: register, isPending } = useRegister();

  const isValid = firstName.trim() && email.trim() && phone.trim();

  const handleContinue = () => {
    if (!isValid || isPending) return;
    register(
      {
        first_name: firstName.trim(),
        email: email.trim(),
        phone_number: phone.trim(),
      },
      { onSuccess: (res) => onSuccess(res.data?.data?.id) }
    );
  };

  return (
    <View style={styles.form}>
      <Text style={styles.label}>Full Name</Text>
      <TextInput
        style={styles.input}
        value={firstName}
        onChangeText={setFirstName}
        placeholder="Full Name"
        placeholderTextColor="rgba(255,255,255,0.25)"
        autoCapitalize="words"
        autoCorrect={false}
      />
      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="your@email.com"
        placeholderTextColor="rgba(255,255,255,0.25)"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.label}>Phone Number</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        placeholder="+1 (555) 000-0000"
        placeholderTextColor="rgba(255,255,255,0.25)"
        keyboardType="phone-pad"
      />
      {/* CTA is disabled until all three fields have content */}
      <TouchableOpacity
        style={[styles.cta, (!isValid || isPending) && styles.ctaDisabled]}
        onPress={handleContinue}
        disabled={!isValid || isPending}
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
  ctaText: { fontSize: 14, fontWeight: "300", color: "#ffffff", letterSpacing: 0.3 },
});
