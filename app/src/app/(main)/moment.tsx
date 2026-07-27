import Confirmed from "@/components/moment/Confirmed";
import DayOf from "@/components/moment/DayOf";
import MomentEvent from "@/components/moment/MomentEvent";
import Recap from "@/components/moment/Recap";
import api from "@/lib/api";
import { socket } from "@/lib/socket";
import type { Circle, CircleMember, Moment } from "@/types";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type MomentState = "loading" | "empty" | "event" | "confirmed" | "day_of" | "recap";

function deriveMomentState(moment: Moment): MomentState {
  if (moment.status === "recap") return "recap";
  if (moment.status === "confirmed") {
    const now = new Date();
    const start = new Date(moment.moment_start);
    const hoursDiff = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursDiff <= 0) return "recap";
    if (hoursDiff <= 24) return "day_of";
    return "confirmed";
  }
  // polling and pending_venue_approval both show the event page
  return "event";
}

export default function MomentScreen() {
  const [state, setState] = useState<MomentState>("loading");
  const [moment, setMoment] = useState<Moment | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const userId = await SecureStore.getItemAsync("user_id");
      if (!userId || !mounted) return;

      try {
        const circlesRes = await api.get(`/circles/${userId}/with-members`);
        const circles: Circle[] = circlesRes.data?.data ?? circlesRes.data ?? [];
        const active = circles.find((c) => c.status === "active");

        if (!active) {
          if (mounted) setState("empty");
          return;
        }

        if (mounted) setMembers(active.members ?? []);

        const momentsRes = await api.get(`/moments/circle/${active.id}`);
        const moments: Moment[] = momentsRes.data?.data ?? momentsRes.data ?? [];
        const current = moments.find((m) => m.status !== "recap") ?? moments[0];

        if (!current) {
          if (mounted) setState("empty");
          return;
        }

        if (mounted) {
          setMoment(current);
          setState(deriveMomentState(current));
        }
      } catch {
        if (mounted) setState("empty");
      }
    }

    load();

    socket.on("moment:confirmed", () => { if (mounted) load(); });

    return () => {
      mounted = false;
      socket.off("moment:confirmed");
    };
  }, []);

  if (state === "loading") {
    return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;
  }

  if (state === "empty") {
    return (
      <SafeAreaView style={s.root}>
        <Text style={s.wordmark}>CoPatible</Text>
        <View style={s.emptyWrap}>
          <Text style={s.emptyHeadline}>Co is arranging something.</Text>
          <Text style={s.emptyMuted}>Your first moment is coming.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!moment) return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;

  if (state === "confirmed") return <Confirmed moment={moment} />;
  if (state === "day_of") return <DayOf moment={moment} members={members} />;
  if (state === "recap") return <Recap moment={moment} />;

  return <MomentEvent moment={moment} members={members} />;
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
    fontSize: 13,
    color: "rgba(255,255,255,0.3)",
    fontWeight: "300",
  },
});
