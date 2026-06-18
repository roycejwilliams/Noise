// Pre-call screen — shown after Payment Success, before Co calls.
// Two paths:
//   "I'm ready"    → POST /co/call/:userId → voice screen (Co calls the user's phone)
//   "I'd rather type" → TextInput appears → POST /co/typed-intake/:userId → voice screen
import api from "@/lib/api";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Mode = "ready" | "typing";

export default function PreCall() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("ready");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleReady = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const userId = await SecureStore.getItemAsync("user_id");
      if (userId) await api.post(`/co/call/${userId}`);
    } catch {}
    router.replace("/(main)/voice");
  };

  const handleSend = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    try {
      const userId = await SecureStore.getItemAsync("user_id");
      if (userId) {
        await api.post(`/co/typed-intake/${userId}`, { transcript: text.trim() });
      }
    } catch {}
    router.replace("/(main)/voice");
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.inner}>
        <Text style={styles.heading}>Co is about to call you.</Text>
        <Text style={styles.subtext}>
          Pick up when your phone rings. Co will ask you a few questions about where you are in life.
        </Text>

        {mode === "typing" && (
          <TextInput
            style={styles.textInput}
            value={text}
            onChangeText={setText}
            placeholder="Tell Co what's on your mind."
            placeholderTextColor="rgba(255,255,255,0.25)"
            multiline
            textAlignVertical="top"
          />
        )}

        <TouchableOpacity
          style={[styles.cta, (loading || (mode === "typing" && !text.trim())) && styles.ctaDim]}
          onPress={mode === "ready" ? handleReady : handleSend}
          disabled={loading || (mode === "typing" && !text.trim())}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#000000" size="small" />
            : <Text style={styles.ctaText}>{mode === "ready" ? "I'm ready" : "Send to Co"}</Text>}
        </TouchableOpacity>

        {mode === "ready" && (
          <TouchableOpacity
            style={styles.typeLink}
            onPress={() => setMode("typing")}
            activeOpacity={0.7}
          >
            <Text style={styles.typeLinkText}>I'd rather type</Text>
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
    paddingTop: 80,
  },
  heading: {
    fontSize: 28,
    fontWeight: "300",
    color: "#ffffff",
    marginBottom: 16,
    letterSpacing: -0.2,
  },
  subtext: {
    fontSize: 14,
    fontWeight: "300",
    color: "#666666",
    lineHeight: 22,
    marginBottom: 48,
  },
  textInput: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 12,
    padding: 16,
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "300",
    minHeight: 120,
    marginBottom: 20,
  },
  cta: {
    backgroundColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  ctaDim: { opacity: 0.4 },
  ctaText: { fontSize: 15, fontWeight: "400", color: "#000000" },
  typeLink: { alignItems: "center" },
  typeLinkText: { fontSize: 13, color: "#666666" },
});
