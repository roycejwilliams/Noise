import CircleMain from "@/components/circle/CircleMain";
import ConsensusPolling from "@/components/circle/ConsensusPolling";
import MomentPending from "@/components/circle/MomentPending";
import api from "@/lib/api";
import { socket } from "@/lib/socket";
import type { Circle, CoProfile, Moment, MomentResponse } from "@/types";
import * as SecureStore from "expo-secure-store";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
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
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    async function load() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) return;

      try {
        const [circleRes, profileRes] = await Promise.all([
          api.get(`/circles/${userId}/with-members`),
          api.get(`/co/profile/${userId}`),
        ]);
        if (!mounted) return;

        const circles: Circle[] = circleRes.data?.data ?? circleRes.data ?? [];
        const active = circles.find((c) => c.status === "active") ?? circles[0];
        if (!active) { setState("empty"); return; }

        setCircle(active);
        setProfile(profileRes.data?.data ?? profileRes.data);

        // Load moments for the circle
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
            // Load responses
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
      } catch {
        if (mounted) setState("main");
      }
    }

    load();

    socket.on("moment:confirmed", () => {
      if (mounted) load();
    });

    return () => {
      mounted = false;
      socket.off("moment:confirmed");
    };
  }, []);

  if (state === "loading") {
    return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;
  }

  if (state === "empty" || !circle) {
    return (
      <SafeAreaView style={cs.root}>
        <Text style={cs.wordmark}>CoPatible</Text>
        <View style={cs.emptyWrap}>
          <Text style={cs.emptyHeadline}>Co is finding your circle.</Text>
          <Text style={cs.emptyMuted}>Your people are closer than you think.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isConnector = profile?.is_circle_connector ?? false;

  if (state === "polling" && moment) {
    return (
      <ConsensusPolling
        circle={circle}
        moment={moment}
        responses={responses}
        isConnector={isConnector}
      />
    );
  }

  if (state === "moment_pending" && confirmedMoment && pendingMoment) {
    return (
      <MomentPending
        circle={circle}
        confirmedMoment={confirmedMoment}
        pendingMoment={pendingMoment}
        isConnector={isConnector}
      />
    );
  }

  return (
    <CircleMain
      circle={circle}
      moment={moment ?? undefined}
      isConnector={isConnector}
      onViewMoment={(_: string) => router.navigate("/(main)/moment")}
    />
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
    fontSize: 13,
    color: "rgba(255,255,255,0.3)",
    fontWeight: "300",
  },
});
