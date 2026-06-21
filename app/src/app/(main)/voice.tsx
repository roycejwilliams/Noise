// Co voice screen — shown after successful payment (and on re-open for subscribers).
// On mount: fetches phone number, checks for existing co_profile, initiates a call
// if the user is new, then listens on socket for state transitions from the backend.
//
// State machine:
//   loading → waiting (call initiated, Co dialing)
//           → ringing (Twilio started ringing the user's phone)
//           → active  (user answered, call live)
//           → processing (call ended, Hume + Anthropic building profile)
//           → ready   (co_profile exists, profile is built)
//
// Backend socket events: co:ringing | co:answered | co:processing | co:ready

import { useLogout } from "@/hooks/useAuth";
import api from "@/lib/api";
import { connectSocket, socket } from "@/lib/socket";
import TypingBubble from "@/components/voice/TypingBubble";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type CoState = "loading" | "waiting" | "ringing" | "active" | "processing" | "ready";

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  const digits = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

export default function VoiceScreen() {
  const [coState, setCoState] = useState<CoState>("loading");
  const [phone, setPhone] = useState("");
  const logout = useLogout();
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    async function init() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) {
        if (mounted) setCoState("waiting");
        return;
      }

      try {
        const res = await api.get(`/users/${userId}`);
        if (mounted) setPhone(res.data?.data?.phone_number ?? "");
      } catch {}

      // Returning users with an existing profile go straight to ready
      try {
        await api.get(`/co/profile/${userId}`);
        if (mounted) { setCoState("ready"); return; }
      } catch {}

      if (mounted) setCoState("waiting");
    }

    // connectSocket sets JWT auth before opening the connection (required for mobile)
    connectSocket().then(() => { if (mounted) init(); });

    socket.on("co:call_ringing",  () => mounted && setCoState("ringing"));
    socket.on("co:call_answered", () => mounted && setCoState("active"));
    socket.on("co:processing",    () => mounted && setCoState("processing"));
    socket.on("co:profile_ready", () => mounted && setCoState("ready"));

    return () => {
      mounted = false;
      socket.off("co:call_ringing");
      socket.off("co:call_answered");
      socket.off("co:processing");
      socket.off("co:profile_ready");
      socket.disconnect();
    };
  }, []);

  if (coState === "loading") {
    return (
      <View style={styles.root} />
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.wordmark}>CoPatible</Text>

      <View style={styles.main}>

        {coState === "waiting" && (
          <>
            <Text style={styles.callLabel}>Co will call you shortly at</Text>
            <Text style={styles.headline}>Co is ready to meet you.</Text>
            <Text style={styles.phoneNumber}>{phone ? formatPhone(phone) : "your registered number"}</Text>
            <TypingBubble />
          </>
        )}

        {coState === "ringing" && (
          <>
            <View style={styles.iconCircle}>
              <Text style={styles.iconGlyph}>✆</Text>
            </View>
            <Text style={styles.headline}>Co is ready to meet you.</Text>
            <Text style={styles.subtitle}>Incoming call from Co</Text>
          </>
        )}

        {coState === "active" && (
          <>
            <View style={styles.iconCircle}>
              <Text style={styles.iconGlyph}>♬</Text>
            </View>
            <Text style={styles.headline}>Co is listening</Text>
            <Text style={styles.subtitle}>Just talk. Co will take it from here.</Text>
          </>
        )}

        {coState === "processing" && (
          <>
            <View style={styles.iconCircle}>
              <Text style={styles.iconGlyph}>◎</Text>
            </View>
            <Text style={styles.headline}>Co is getting to know you.</Text>
            <Text style={styles.subtitle}>Building your profile. This takes a moment.</Text>
            <TypingBubble />
          </>
        )}

        {coState === "ready" && (
          <>
            <View style={styles.iconCircle}>
              <Text style={styles.iconGlyph}>✓</Text>
            </View>
            <Text style={styles.headline}>Your profile is ready.</Text>
            <Text style={styles.subtitle}>Co is already looking for your people.</Text>
          </>
        )}

      </View>

      <View style={styles.bottomActions}>
        {coState === "ready" && (
          <TouchableOpacity
            style={styles.viewProfileCta}
            activeOpacity={0.7}
            onPress={() => router.navigate("/(main)/profile")}
          >
            <Text style={styles.viewProfileText}>View Profile</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={logout} style={styles.signOutRow} activeOpacity={0.5}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
    paddingHorizontal: 31,
  },
  wordmark: {
    fontSize: 24,
    fontWeight: "200",
    color: "#ffffff",
    letterSpacing: 0.3,
    marginTop: 8,
  },
  main: {
    flex: 1,
    paddingTop: 80,
  },
  // Waiting state
  callLabel: {
    fontSize: 15,
    fontWeight: "200",
    color: "#ffffff",
    marginBottom: 2,
  },
  headline: {
    fontSize: 20,
    fontWeight: "400",
    color: "#ffffff",
    marginBottom: 8,
  },
  phoneNumber: {
    fontSize: 32,
    fontWeight: "400",
    color: "#ffffff",
    marginTop: 20,
    marginBottom: 60,
  },
  // Icon circle states (ringing / active / processing / ready)
  iconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: "rgba(255,255,255,0.5)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 80,
  },
  iconGlyph: {
    fontSize: 34,
    color: "#ffffff",
  },
  subtitle: {
    fontSize: 15,
    fontWeight: "300",
    color: "#ffffff",
  },
  // Bottom actions
  bottomActions: {
    paddingBottom: 8,
    gap: 14,
  },
  viewProfileCta: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    paddingVertical: 15,
    alignItems: "center",
  },
  viewProfileText: {
    fontSize: 15,
    fontWeight: "200",
    color: "#ffffff",
    letterSpacing: 0.3,
  },
  signOutRow: {
    alignItems: "flex-end",
    paddingBottom: 4,
  },
  signOutText: {
    fontSize: 11,
    color: "rgba(255,255,255,0.25)",
  },
});
