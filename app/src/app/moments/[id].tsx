import BookingPending from "@/components/moment/BookingPending";
import Confirmed from "@/components/moment/Confirmed";
import DayOf from "@/components/moment/DayOf";
import MomentEvent from "@/components/moment/MomentEvent";
import Recap from "@/components/moment/Recap";
import api from "@/lib/api";
import type { CircleMember, Moment } from "@/types";
import * as SecureStore from "expo-secure-store";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

type MomentState = "loading" | "event" | "booking_pending" | "confirmed" | "day_of" | "recap";

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
  if (moment.status === "booking_pending") return "booking_pending";
  return "event";
}

export default function MomentDeepLink() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [state, setState] = useState<MomentState>("loading");
  const [moment, setMoment] = useState<Moment | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const token = await SecureStore.getItemAsync("jwt_token");

      if (!token) {
        // Not logged in — send to sign-in, the normal auth flow will handle return
        router.replace("/(auth)/sign-in");
        return;
      }

      try {
        const res = await api.get(`/moments/moment/${id}`);
        const m: Moment = res.data?.data;
        if (!m || !mounted) return;

        // Load circle members if the moment has a circle
        if (m.circle_id) {
          const membersRes = await api.get(`/circles/${m.circle_id}/members`);
          const ms: CircleMember[] = membersRes.data?.data ?? [];
          if (mounted) setMembers(ms);
        }

        if (mounted) {
          setMoment(m);
          setState(deriveMomentState(m));
        }
      } catch {
        // Moment not accessible — fall back to main tab
        if (mounted) router.replace("/(main)/moment");
      }
    }

    load();
    return () => { mounted = false; };
  }, [id, router]);

  if (state === "loading" || !moment) {
    return <View style={{ flex: 1, backgroundColor: "#1a1a1a" }} />;
  }

  if (state === "booking_pending") return <BookingPending />;
  if (state === "confirmed") return <Confirmed moment={moment} />;
  if (state === "day_of") return <DayOf moment={moment} members={members} />;
  if (state === "recap") return <Recap moment={moment} />;

  return <MomentEvent moment={moment} members={members} />;
}
