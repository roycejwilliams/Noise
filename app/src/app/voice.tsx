import { useLogout } from "@/hooks/useAuth";
import api from "@/lib/api";
import { connectSocket, socket } from "@/lib/socket";
import TypingBubble from "@/components/voice/TypingBubble";
import VuiWave from "@/components/VuiWave";
import * as SecureStore from "expo-secure-store";
import { SymbolView } from "expo-symbols";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type VoiceState = "waiting" | "ringing" | "active" | "processing" | "ready";

const ICON_NAME: Partial<Record<VoiceState, string>> = {
  ringing:    "phone.fill",
  active:     "waveform",
  processing: "brain.head.profile",
  ready:      "checkmark",
};

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  const digits = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

// Context A = first-time caller (no co_profile yet, onboarding).
// Context B = returning caller (co_profile exists, ongoing relationship).
function getHeadline(state: VoiceState, isReturning: boolean, firstName: string): string {
  switch (state) {
    case "waiting":
      return isReturning
        ? `${firstName.trim() || "You're back"}. Co is ready.`
        : "Co is about to call you.";
    case "ringing":
      return isReturning ? "Co is calling." : "Co is ready to meet you.";
    case "active":
      return isReturning ? "Talk to Co." : "Co is listening.";
    case "processing":
      return isReturning ? "Co is taking notes." : "Co is getting to know you.";
    case "ready":
      return isReturning ? "Co heard you." : "Your profile is ready.";
  }
}

function getSubtitle(state: VoiceState, isReturning: boolean): string | null {
  switch (state) {
    case "waiting":
      return isReturning
        ? "Pick up when it rings."
        : "Pick up when your phone rings. Co will take it from there.";
    case "ringing":
      return isReturning ? "Pick up when it rings." : "Incoming call from Co";
    case "active":
      return isReturning ? "Co is paying attention." : "Just talk. Co will take it from here.";
    case "processing":
      return isReturning
        ? "Co heard you. Updating your memory."
        : "Building your profile. This takes a moment.";
    case "ready":
      return isReturning ? null : "Co is already looking for your people.";
  }
}

export default function VoiceScreen() {
  const { initialState } = useLocalSearchParams<{ initialState?: string }>();
  const [voiceState, setVoiceState] = useState<VoiceState>(
    (initialState as VoiceState) ?? "waiting"
  );
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  // Context A (first-time) vs Context B (returning) — defaults to Context A,
  // the safer default if the profile fetch fails, times out, or never resolves.
  const [isReturning, setIsReturning] = useState(false);
  const logout = useLogout();
  const router = useRouter();

  // Pulse rings (ringing state)
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  // Bouncing ball (processing state)
  const ballY = useRef(new Animated.Value(0)).current;

  // Socket + phone fetch
  useEffect(() => {
    let mounted = true;

    async function init() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) return;
      try {
        const res = await api.get(`/users/${userId}`);
        if (mounted) {
          setPhone(res.data?.data?.phone_number ?? res.data?.phone_number ?? "");
          setFirstName(res.data?.data?.first_name ?? res.data?.first_name ?? "");
        }
      } catch {}
      // Determine context once on mount: a populated co_profile means this is
      // a returning caller (Context B). A 404 or any failure defaults to
      // Context A (first-time) — the safer assumption for an unknown state.
      try {
        const profileRes = await api.get(`/co/profile/${userId}`);
        const coProfile = profileRes.data?.data ?? profileRes.data;
        if (mounted) setIsReturning(!!coProfile);
      } catch {
        if (mounted) setIsReturning(false);
      }
    }

    connectSocket().then(() => { if (mounted) init(); });

    const advance = (state: VoiceState) => () => { if (mounted) setVoiceState(state); };

    socket.on("co:call_started",  advance("ringing"));
    socket.on("co:call_ringing",  advance("ringing"));
    socket.on("co:call_active",   advance("active"));
    socket.on("co:call_answered", advance("active"));
    socket.on("co:call_ended",    advance("processing"));
    socket.on("co:processing",    advance("processing"));
    socket.on("co:profile_ready", advance("ready"));

    return () => {
      mounted = false;
      socket.off("co:call_started");
      socket.off("co:call_ringing");
      socket.off("co:call_active");
      socket.off("co:call_answered");
      socket.off("co:call_ended");
      socket.off("co:processing");
      socket.off("co:profile_ready");
    };
  }, []);

  // Pulse ring animations
  useEffect(() => {
    if (voiceState !== "ringing") {
      ring1.setValue(0);
      ring2.setValue(0);
      ring3.setValue(0);
      return;
    }
    const loops: Animated.CompositeAnimation[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];

    const startLoop = (anim: Animated.Value) => {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
      loop.start();
      loops.push(loop);
    };

    startLoop(ring1);
    timers.push(setTimeout(() => startLoop(ring2), 660));
    timers.push(setTimeout(() => startLoop(ring3), 1320));

    return () => {
      loops.forEach((l) => l.stop());
      timers.forEach((t) => clearTimeout(t));
    };
  }, [voiceState]);

  // Bouncing ball animation
  useEffect(() => {
    if (voiceState !== "processing") {
      ballY.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ballY, { toValue: -20, duration: 420, useNativeDriver: true }),
        Animated.timing(ballY, { toValue: 0, duration: 420, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [voiceState]);

  // Context B (returning) ready state has no CTA — quietly return home instead
  useEffect(() => {
    if (voiceState !== "ready" || !isReturning) return;
    const timeout = setTimeout(() => {
      router.replace("/(main)");
    }, 3000);
    return () => clearTimeout(timeout);
  }, [voiceState, isReturning, router]);

  const iconName = ICON_NAME[voiceState];
  const hasIcon = !!iconName;

  return (
    <View style={s.root}>
      <SafeAreaView style={s.safe}>
        {/* Wordmark */}
        <Text style={s.wordmark}>CoPatible</Text>

        {/* ── WAITING ── */}
        {voiceState === "waiting" && (
          <View style={s.waitingSection}>
            <Text style={s.headline}>{getHeadline("waiting", isReturning, firstName)}</Text>
            <Text style={s.waitingLabel}>{getSubtitle("waiting", isReturning)}</Text>
            <Text style={s.phoneNumber}>
              {phone ? formatPhone(phone) : "your registered number"}
            </Text>
            <View style={s.dotsWrap}>
              <TypingBubble />
            </View>
          </View>
        )}

        {/* ── ICON STATES (ringing / active / processing / ready) ── */}
        {hasIcon && (
          <View style={s.iconSection}>
            {/* Pulse rings centered on icon circle */}
            <View style={s.iconWrap}>
              {voiceState === "ringing" && (
                <View style={s.ringsContainer} pointerEvents="none">
                  {[ring1, ring2, ring3].map((anim, i) => (
                    <Animated.View
                      key={i}
                      style={[
                        s.ring,
                        {
                          transform: [{
                            scale: anim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [1, 3.6],
                            }),
                          }],
                          opacity: anim.interpolate({
                            inputRange: [0, 0.25, 1],
                            outputRange: [0.5, 0.35, 0],
                          }),
                        },
                      ]}
                    />
                  ))}
                </View>
              )}
              <View style={s.iconCircle}>
                <SymbolView
                  name={iconName as any}
                  size={34}
                  tintColor="#ffffff"
                  type="monochrome"
                />
              </View>
            </View>

            <Text style={s.headline}>{getHeadline(voiceState, isReturning, firstName)}</Text>
            {getSubtitle(voiceState, isReturning) && (
              <Text style={s.subtitle}>{getSubtitle(voiceState, isReturning)}</Text>
            )}

            {/* Bouncing ball (processing) */}
            {voiceState === "processing" && (
              <View style={s.ballWrap}>
                <Animated.View
                  style={[s.ball, { transform: [{ translateY: ballY }] }]}
                />
              </View>
            )}
          </View>
        )}

        {/* View Profile CTA — Context A (first-time) only. Context B quietly
            returns home on its own via the auto-return effect above. */}
        {voiceState === "ready" && !isReturning && (
          <View style={s.ctaWrap}>
            <TouchableOpacity
              style={s.cta}
              onPress={() => router.navigate("/(main)/profile")}
              activeOpacity={0.8}
            >
              <Text style={s.ctaText}>View Profile</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Sign out */}
        <View style={s.signOutRow}>
          <TouchableOpacity onPress={logout} activeOpacity={0.5}>
            <Text style={s.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* VUI wave — absolute at screen bottom, behind safe area */}
      <View style={s.wave}>
        <VuiWave />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1a1a1a" },
  safe: { flex: 1, paddingHorizontal: 32 },

  wordmark: {
    fontSize: 24,
    fontWeight: "200",
    color: "#ffffff",
    letterSpacing: 0.3,
    marginTop: 8,
  },

  // Waiting
  waitingSection: { marginTop: 90 },
  waitingLabel: {
    fontSize: 15,
    fontWeight: "300",
    color: "rgba(255,255,255,0.5)",
    marginBottom: 6,
  },
  headline: {
    fontSize: 20,
    fontWeight: "400",
    color: "#ffffff",
  },
  phoneNumber: {
    fontSize: 32,
    fontWeight: "400",
    color: "#ffffff",
    marginTop: 24,
  },
  dotsWrap: { alignItems: "center", marginTop: 104 },
  // Icon states
  iconSection: { marginTop: 60 },
  iconWrap: {
    width: 84,
    height: 84,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 47,
  },
  ringsContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  iconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: "rgba(255,255,255,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  subtitle: {
    fontSize: 15,
    fontWeight: "300",
    color: "rgba(255,255,255,0.5)",
    marginTop: 12,
  },
  ballWrap: { alignItems: "center", marginTop: 100 },
  ball: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ffffff",
  },

  // CTA + sign out pushed to bottom
  ctaWrap: { position: "absolute", left: 32, right: 32, bottom: 80 },
  cta: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: {
    fontSize: 16,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.2,
  },
  signOutRow: {
    position: "absolute",
    bottom: 16,
    right: 0,
  },
  signOutText: {
    fontSize: 11,
    color: "rgba(255,255,255,0.25)",
  },

  // VUI wave (active state, root-level absolute)
  wave: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: 227,
  },
});
