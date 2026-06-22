import CircleMain from "@/components/circle/CircleMain";
import ConsensusPolling from "@/components/circle/ConsensusPolling";
import MomentPending from "@/components/circle/MomentPending";
import api from "@/lib/api";
import { socket } from "@/lib/socket";
import type { Circle, CoProfile, Moment, MomentResponse } from "@/types";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type CircleState = "loading" | "empty" | "main" | "polling" | "moment_pending";

export default function CircleScreen() {
  const [state, setState] = useState<CircleState>("loading");
  const [circle, setCircle] = useState<Circle | null>(null);
  const [profile, setProfile] = useState<CoProfile | null>(null);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [responses, setResponses] = useState<MomentResponse[]>([]);
  const [confirmedMoment, setConfirmedMoment] = useState<Moment | null>(null);
  const [pendingMoment, setPendingMoment] = useState<Moment | null>(null);
  const [leaving, setLeaving] = useState(false);
  const userIdRef = useRef<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    async function load() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) return;
      userIdRef.current = userId;

      const [circleRes, profileRes] = await Promise.allSettled([
        api.get(`/circles/${userId}/with-members`),
        api.get(`/co/profile/${userId}`),
      ]);

      if (!mounted) return;

      if (profileRes.status === "fulfilled") {
        setProfile(profileRes.value.data?.data ?? profileRes.value.data);
      }

      if (circleRes.status === "rejected") {
        setState("empty");
        return;
      }

      const circles: Circle[] = circleRes.value.data?.data ?? circleRes.value.data ?? [];
      const active = circles.find((c) => c.status === "active") ?? null;

      if (!active) {
        setState("empty");
        return;
      }

      setCircle(active);

      try {
        const momentsRes = await api.get(`/moments/circle/${active.id}`);
        const moments: Moment[] = momentsRes.data?.data ?? momentsRes.data ?? [];
        const polling = moments.find((m) => m.status === "polling");
        const confirmed = moments.find((m) => m.status === "confirmed");
        const pending = moments.find((m) => m.status === "pending");

        if (confirmed && pending) {
          setConfirmedMoment(confirmed);
          setPendingMoment(pending);
          setState("moment_pending");
        } else if (polling) {
          setMoment(polling);
          try {
            const respRes = await api.get(`/moments/${polling.id}/responses`);
            setResponses(respRes.data?.data ?? respRes.data ?? []);
          } catch {}
          setState("polling");
        } else {
          setState("main");
        }
      } catch {
        setState("main");
      }
    }

    load();

    socket.on("moment:confirmed", () => { if (mounted) load(); });
    socket.on("circle:approved", () => { if (mounted) load(); });
    socket.on("circle:placed", () => { if (mounted) load(); });
    socket.on("circle:member_left", ({ user_id }: { circle_id: string; user_id: string }) => {
      if (!mounted) return;
      if (user_id === userIdRef.current) {
        setCircle(null);
        setState("empty");
      } else {
        load();
      }
    });

    return () => {
      mounted = false;
      socket.off("moment:confirmed");
      socket.off("circle:approved");
      socket.off("circle:placed");
      socket.off("circle:member_left");
    };
  }, []);

  async function handleLeaveCircle() {
    if (!circle || leaving) return;
    Alert.alert(
      "Leave this circle?",
      "Co will keep looking for you.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: async () => {
            setLeaving(true);
            try {
              await api.post(`/co/circles/${circle.id}/leave`);
              setCircle(null);
              setState("empty");
            } catch (e) {
              console.error("Leave circle failed:", e);
            } finally {
              setLeaving(false);
            }
          },
        },
      ],
    );
  }

  if (state === "loading") {
    return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;
  }

  const isConnector = profile?.is_circle_connector ?? false;

  return (
    <SafeAreaView style={cs.root}>
      <Text style={cs.wordmark}>CoPatible</Text>

      {/* Empty state */}
      {state === "empty" && (
        <View style={cs.emptyWrap}>
          <Text style={cs.emptyHeadline}>Co is finding your circle.</Text>
          <Text style={cs.emptyMuted}>Your people are closer than you think.</Text>
        </View>
      )}

      {/* Active circle states */}
      {state === "polling" && moment && circle && (
        <ConsensusPolling
          circle={circle}
          moment={moment}
          responses={responses}
          isConnector={isConnector}
        />
      )}

      {state === "moment_pending" && confirmedMoment && pendingMoment && circle && (
        <MomentPending
          circle={circle}
          confirmedMoment={confirmedMoment}
          pendingMoment={pendingMoment}
          isConnector={isConnector}
        />
      )}

      {state === "main" && circle && (
        <>
          <CircleMain
            circle={circle}
            moment={moment ?? undefined}
            isConnector={isConnector}
            onViewMoment={(_: string) => router.navigate("/(main)/moment")}
          />
          <TouchableOpacity
            style={cs.leaveLink}
            onPress={handleLeaveCircle}
            disabled={leaving}
            activeOpacity={0.7}
          >
            {leaving ? (
              <ActivityIndicator color="rgba(255,255,255,0.3)" size="small" />
            ) : (
              <Text style={cs.leaveLinkText}>Leave circle</Text>
            )}
          </TouchableOpacity>
        </>
      )}
    </SafeAreaView>
  );
}

const cs = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#1a1a1a" },
  wordmark: {
    fontSize: 24,
    fontWeight: "200",
    color: "#fff",
    letterSpacing: 0.3,
    marginTop: 8,
    paddingHorizontal: 32,
  },
  emptyWrap: { flex: 1, paddingHorizontal: 32, paddingTop: 80, gap: 12 },
  emptyHeadline: { fontSize: 20, fontWeight: "300", color: "#fff", lineHeight: 28 },
  emptyMuted: { fontSize: 13, color: "rgba(255,255,255,0.3)", fontWeight: "300" },
  leaveLink: { alignItems: "center", paddingVertical: 20 },
  leaveLinkText: { fontSize: 13, fontWeight: "300", color: "rgba(255,255,255,0.3)" },
});
