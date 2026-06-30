import CircleReady from "@/components/profile/CircleReady";
import PlacementPending from "@/components/profile/PlacementPending";
import ProfileMain from "@/components/profile/ProfileMain";
import api from "@/lib/api";
import { connectSocket, socket } from "@/lib/socket";
import type { Circle, CoProfile, User } from "@/types";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type ProfileState = "loading" | "no_profile" | "pending" | "ready" | "main";

export default function ProfileScreen() {
  const [state, setState] = useState<ProfileState>("loading");
  const [profile, setProfile] = useState<CoProfile | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [circle, setCircle] = useState<Circle | null>(null);
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    async function load() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) return;

      // Fetch user
      try {
        const userRes = await api.get(`/users/${userId}`);
        if (!mounted) return;
        setUser(userRes.data?.data ?? userRes.data);
      } catch {
        if (mounted) setState("no_profile");
        return;
      }

      // Fetch co_profile — 404 means they haven't talked to Co yet
      try {
        const profileRes = await api.get(`/co/profile/${userId}`);
        if (!mounted) return;
        setProfile(profileRes.data?.data ?? profileRes.data);
      } catch {
        if (mounted) setState("no_profile");
        return;
      }

      // Fetch circles to determine placement state
      try {
        const circlesRes = await api.get(`/circles/${userId}/with-members`);
        if (!mounted) return;
        const circles: Circle[] = circlesRes.data?.data ?? circlesRes.data ?? [];
        const active = circles.find((c) => c.status === "active");
        if (active) {
          setCircle(active);
          setState("main");
        } else {
          setState("pending");
        }
      } catch {
        if (mounted) setState("pending");
      }
    }

    connectSocket().then(() => { if (mounted) load(); });

    // Silently capture GPS in background — updates co_profiles.location for proximity matching
    (async () => {
      try {
        const userId = await SecureStore.getItemAsync("user_id");
        if (!userId || !mounted) return;
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        await api.post(`/co/location/${userId}`, {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });
      } catch {
        // Non-fatal — matching falls back to city string if no GPS
      }
    })();

    socket.on("circle:approved", async ({ circle_id }: { circle_id: string }) => {
      if (!mounted) return;
      try {
        const userId = await SecureStore.getItemAsync("user_id");
        if (!userId) return;
        const res = await api.get(`/circles/${userId}/with-members`);
        const circles: Circle[] = res.data?.data ?? res.data ?? [];
        const approved = circles.find((c) => c.id === circle_id);
        if (approved && mounted) {
          setCircle(approved);
          setState("ready");
        }
      } catch {}
    });

    socket.on("co:profile_ready", () => {
      if (mounted) load();
    });

    return () => {
      mounted = false;
      socket.off("circle:approved");
      socket.off("co:profile_ready");
    };
  }, []);

  if (state === "loading") {
    return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;
  }

  if (state === "no_profile" || !user) {
    return (
      <SafeAreaView style={s.root}>
        <Text style={s.wordmark}>CoPatible</Text>
        <View style={s.emptyWrap}>
          <Text style={s.emptyHeadline}>Co hasn't called yet.</Text>
          <Text style={s.emptyMuted}>
            Your profile will appear here after your first call with Co.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state === "ready" && circle && profile) {
    return (
      <CircleReady
        profile={profile}
        user={user}
        circle={circle}
        onViewCircle={() => router.navigate("/(main)/circle")}
      />
    );
  }

  if (state === "pending" && profile) {
    return <PlacementPending profile={profile} user={user} />;
  }

  if (profile) {
    return <ProfileMain profile={profile} user={user} circle={circle} />;
  }

  return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1a1a1a" },
  wordmark: {
    fontSize: 24,
    fontWeight: "200",
    color: "#fff",
    letterSpacing: 0.3,
    marginTop: 8,
    paddingHorizontal: 32,
  },
  emptyWrap: {
    flex: 1,
    paddingHorizontal: 32,
    paddingTop: 80,
    gap: 12,
  },
  emptyHeadline: {
    fontSize: 20,
    fontWeight: "300",
    color: "#fff",
    lineHeight: 28,
  },
  emptyMuted: {
    fontSize: 14,
    fontWeight: "300",
    color: "rgba(255,255,255,0.4)",
    lineHeight: 22,
  },
});
