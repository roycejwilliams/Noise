import { useLogout } from "@/hooks/useAuth";
import api from "@/lib/api";
import { connectSocket, socket } from "@/lib/socket";
import * as SecureStore from "expo-secure-store";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type VoiceState = "waiting" | "ringing" | "active" | "processing" | "ready";

const A = {
  loadingDots: "https://www.figma.com/api/mcp/asset/218fdd6c-80cb-452d-8ff2-b620e4a6b3aa",
  phone:       "https://www.figma.com/api/mcp/asset/9b655edb-0517-45a7-9239-012e8dcc3c67",
  mic:         "https://www.figma.com/api/mcp/asset/efaa7969-0409-4a5c-a6f3-47e02969f8a1",
  brain:       "https://www.figma.com/api/mcp/asset/0368586f-a7c6-4fef-93f5-418c26e18f1b",
  check:       "https://www.figma.com/api/mcp/asset/cbc0f2c5-7d55-476c-9ef6-0786997db4c0",
  wave:        "https://www.figma.com/api/mcp/asset/40602fdd-98ba-44fc-9fdf-269bfeda0570",
};

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  const digits = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

const ICON_URI: Partial<Record<VoiceState, string>> = {
  ringing:    A.phone,
  active:     A.mic,
  processing: A.brain,
  ready:      A.check,
};

const HEADLINE: Partial<Record<VoiceState, string>> = {
  waiting:    "Co is ready to meet you.",
  ringing:    "Co is ready to meet you.",
  active:     "Co is listening",
  processing: "Co is getting to know you.",
  ready:      "Your profile is ready.",
};

const SUBTITLE: Partial<Record<VoiceState, string>> = {
  ringing:    "Incoming call from Co",
  active:     "Just talk. Co will take it from here.",
  processing: "Building your profile. This takes a moment.",
  ready:      "Co is already looking for your people.",
};

export default function VoiceScreen() {
  const { initialState } = useLocalSearchParams<{ initialState?: string }>();
  const [voiceState, setVoiceState] = useState<VoiceState>(
    (initialState as VoiceState) ?? "waiting"
  );
  const [phone, setPhone] = useState("");
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
        if (mounted) setPhone(res.data?.data?.phone_number ?? res.data?.phone_number ?? "");
      } catch {}
      // If a profile already exists, jump straight to ready
      try {
        await api.get(`/co/profile/${userId}`);
        if (mounted) setVoiceState("ready");
      } catch {}
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

  const iconUri = ICON_URI[voiceState];
  const hasIcon = !!iconUri;

  return (
    <View style={s.root}>
      <SafeAreaView style={s.safe}>
        {/* Wordmark */}
        <Text style={s.wordmark}>CoPatible</Text>

        {/* ── WAITING ── */}
        {voiceState === "waiting" && (
          <View style={s.waitingSection}>
            <Text style={s.waitingLabel}>Co will call you shortly at</Text>
            <Text style={s.headline}>{HEADLINE.waiting}</Text>
            <Text style={s.phoneNumber}>
              {phone ? formatPhone(phone) : "your registered number"}
            </Text>
            <View style={s.dotsWrap}>
              <Image
                source={{ uri: A.loadingDots }}
                style={s.loadingDots}
                resizeMode="contain"
              />
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
                <Image
                  source={{ uri: iconUri }}
                  style={s.iconImage}
                  resizeMode="contain"
                />
              </View>
            </View>

            <Text style={s.headline}>{HEADLINE[voiceState]}</Text>
            <Text style={s.subtitle}>{SUBTITLE[voiceState]}</Text>

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

        {/* View Profile CTA (ready) */}
        {voiceState === "ready" && (
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
      {voiceState === "active" && (
        <Image
          source={{ uri: A.wave }}
          style={s.wave}
          resizeMode="cover"
        />
      )}
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
  loadingDots: { width: 72, height: 20 },

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
  },
  iconImage: {
    width: 50,
    height: 50,
    position: "absolute",
    left: 17,
    top: 17,
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
  ctaWrap: { position: "absolute", left: 0, right: 0, bottom: 80 },
  cta: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: {
    fontSize: 15,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.3,
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
