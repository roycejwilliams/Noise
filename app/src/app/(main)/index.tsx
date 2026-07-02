import api from "@/lib/api";
import { socket } from "@/lib/socket";
import type { CoNotification, CoProfile } from "@/types";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const GREETINGS = [
  "{name}. Your people are out there.",
  "{name}. Co has been thinking about you.",
  "{name}. You belong somewhere.",
  "{name}. The right circle changes everything.",
  "{name}. Connection is closer than you think.",
  "{name}. Co is ready when you are.",
  "{name}. You don't have to figure it out alone.",
  "{name}. Good things take the right people.",
  "{name}. Co is paying attention.",
  "{name}. Your chapter is just getting started.",
];

const SUBHEADINGS: Record<string, string[]> = {
  new_to_city: [
    "A new city is easier with the right people.",
    "Co is finding your people in this city.",
    "You just got here. Co is already working.",
  ],
  building_solo: [
    "Building alone is hard. Co is changing that.",
    "You don't have to do this by yourself.",
    "The right circle makes the work lighter.",
  ],
  career_pivot: [
    "Big transitions call for real community.",
    "Co finds people who get what you're going through.",
    "A pivot is easier with people in your corner.",
  ],
  starting_over: [
    "Starting over takes courage. Co sees that.",
    "New chapters need new people. Co is on it.",
    "You're not starting from scratch. You're starting with Co.",
  ],
};

const DEFAULT_SUBHEADING = "Co is here when you're ready.";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function HomeScreen() {
  const router = useRouter();
  const [greeting, setGreeting] = useState("");
  const [subheading, setSubheading] = useState(DEFAULT_SUBHEADING);
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState("");
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [placementNotification, setPlacementNotification] = useState<CoNotification | null>(null);
  const userIdRef = useRef<string | null>(null);

  // Load greeting + subheading + placement notification
  useEffect(() => {
    let mounted = true;

    async function load() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) return;
      userIdRef.current = userId;

      let firstName = "";
      let lifeChapter = "";

      try {
        const userRes = await api.get(`/users/${userId}`);
        firstName = userRes.data?.data?.first_name ?? userRes.data?.first_name ?? "";
      } catch {}

      try {
        const profileRes = await api.get(`/co/profile/${userId}`);
        const profile: CoProfile = profileRes.data?.data ?? profileRes.data;
        lifeChapter = (profile.life_chapters ?? [])[0] ?? "";
      } catch {}

      try {
        const notifRes = await api.get(`/co/notifications/${userId}`);
        const notifications: CoNotification[] = notifRes.data?.data ?? [];
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recent = notifications.find(
          (n) => n.memory_type === "placement" && new Date(n.created_at).getTime() > cutoff,
        );
        if (mounted) setPlacementNotification(recent ?? null);
      } catch {}

      if (!mounted) return;

      const template = pick(GREETINGS);
      const pool = SUBHEADINGS[lifeChapter] ?? null;

      setGreeting(template.replace("{name}", firstName || "Hey"));
      setSubheading(pool ? pick(pool) : DEFAULT_SUBHEADING);
    }

    load();

    socket.on("circle:placed", () => {
      if (mounted) {
        const userId = userIdRef.current;
        if (!userId) return;
        api.get(`/co/notifications/${userId}`)
          .then((res) => {
            const notifs: CoNotification[] = res.data?.data ?? [];
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const recent = notifs.find(
              (n) => n.memory_type === "placement" && new Date(n.created_at).getTime() > cutoff,
            );
            if (mounted) setPlacementNotification(recent ?? null);
          })
          .catch(() => {});
      }
    });

    return () => {
      mounted = false;
      socket.off("circle:placed");
    };
  }, []);

  const toggleTextMode = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setTextMode((v) => !v);
  };

  const handleCallCo = async () => {
    if (calling) return;
    setCalling(true);
    setCallError(null);
    try {
      const userId = userIdRef.current ?? await SecureStore.getItemAsync("user_id");
      if (!userId) throw new Error("Not signed in.");
      await api.post(`/co/call/${userId}`);
      router.push("/voice");
    } catch (err: any) {
      const message =
        typeof err?.response?.data === "string" && err.response.data
          ? err.response.data
          : "Co couldn't reach you. Try again in a moment.";
      setCallError(message);
      setCalling(false);
    }
  };

  const handleTextSubmit = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      const userId = userIdRef.current ?? await SecureStore.getItemAsync("user_id");
      if (userId) {
        await api.post(`/co/typed-intake/${userId}`, { transcript: text.trim() });
      }
    } catch {}
    router.push({ pathname: "/voice", params: { initialState: "processing" } });
  };

  return (
    <View style={s.root}>
      <SafeAreaView style={s.safe}>
        {/* Greeting */}
        <View style={s.header}>
          <Text style={s.greeting}>{greeting || " "}</Text>
          <Text style={s.subheading}>{subheading}</Text>
        </View>

        {/* Spacer pushes actions to bottom */}
        <View style={s.spacer} />

        {/* Circle placement notification */}
        {placementNotification && !textMode && (
          <View style={s.placementCard}>
            <TouchableOpacity
              style={s.dismissBtn}
              onPress={() => setPlacementNotification(null)}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            >
              <Text style={s.dismissX}>×</Text>
            </TouchableOpacity>
            <Text style={s.placementHeadline}>Co placed you in a circle.</Text>
            <Text style={s.placementSubtitle}>Your people are waiting.</Text>
            <TouchableOpacity
              style={s.viewCircleBtn}
              onPress={() => router.push("/(main)/circle")}
              activeOpacity={0.8}
            >
              <Text style={s.viewCircleText}>View Circle</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Text input (expanded via LayoutAnimation) */}
        {textMode && (
          <View style={s.textWrap}>
            <TextInput
              style={s.textInput}
              value={text}
              onChangeText={setText}
              placeholder="Tell Co what's on your mind."
              placeholderTextColor="rgba(255,255,255,0.25)"
              multiline
              textAlignVertical="top"
              autoFocus
            />
            <TouchableOpacity
              style={[s.sendBtn, (!text.trim() || submitting) && s.sendDim]}
              onPress={handleTextSubmit}
              disabled={!text.trim() || submitting}
              activeOpacity={0.8}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={s.sendText}>Send to Co</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {callError && !textMode && (
          <Text style={s.callErrorText}>{callError}</Text>
        )}

        {/* Primary: Call Co */}
        <TouchableOpacity
          style={[s.callBtn, calling && s.callBtnDim]}
          onPress={handleCallCo}
          disabled={calling || textMode}
          activeOpacity={0.8}
        >
          {calling ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={s.callText}>Call Co</Text>
          )}
        </TouchableOpacity>

        {/* Secondary: I'd rather type */}
        {!textMode ? (
          <TouchableOpacity onPress={toggleTextMode} activeOpacity={0.7} style={s.typeLink}>
            <Text style={s.typeLinkText}>I'd rather type</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={toggleTextMode} activeOpacity={0.7} style={s.typeLink}>
            <Text style={s.typeLinkText}>Never mind</Text>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  safe: { flex: 1, paddingHorizontal: 32, paddingBottom: 8 },

  // Header
  header: { marginTop: 48 },
  greeting: {
    fontSize: 28,
    fontWeight: "200",
    color: "#ffffff",
    lineHeight: 36,
    marginBottom: 10,
  },
  subheading: {
    fontSize: 16,
    fontWeight: "300",
    color: "rgba(255,255,255,0.5)",
    lineHeight: 24,
  },

  spacer: { flex: 1 },

  // Text input section
  textWrap: { gap: 12, marginBottom: 16 },
  textInput: {
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.05)",
    padding: 16,
    minHeight: 120,
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "300",
  },
  sendBtn: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDim: { opacity: 0.35 },
  sendText: {
    fontSize: 16,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.2,
  },

  callErrorText: {
    fontSize: 13,
    fontWeight: "300",
    color: "rgba(255,120,120,0.9)",
    textAlign: "center",
    marginBottom: 12,
  },

  // Call Co button
  callBtn: {
    borderWidth: 1,
    borderColor: "#ffffff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  callBtnDim: { opacity: 0.5 },
  callText: {
    fontSize: 16,
    fontWeight: "300",
    color: "#ffffff",
    letterSpacing: 0.2,
  },

  // Type link
  typeLink: { alignItems: "center", paddingBottom: 8 },
  typeLinkText: {
    fontSize: 14,
    fontWeight: "300",
    color: "rgba(255,255,255,0.4)",
  },

  // Placement notification card
  placementCard: {
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    gap: 6,
  },
  dismissBtn: { position: "absolute", top: 12, right: 14 },
  dismissX: { fontSize: 20, color: "rgba(255,255,255,0.4)", lineHeight: 24 },
  placementHeadline: { fontSize: 16, fontWeight: "400", color: "#fff" },
  placementSubtitle: { fontSize: 13, fontWeight: "300", color: "rgba(255,255,255,0.5)" },
  viewCircleBtn: {
    borderWidth: 1,
    borderColor: "#fff",
    borderRadius: 100,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  viewCircleText: { color: "#fff", fontSize: 14, fontWeight: "400" },
});
