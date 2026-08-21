import type { Circle, Moment } from "@/types";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  circle: Circle;
  confirmedMoment: Moment;
  pendingMoment: Moment;
}

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function MomentPending({ circle, confirmedMoment, pendingMoment }: Props) {
  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>Co</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.circleHeader}>
          <View>
            <Text style={s.sectionLabel}>Circle</Text>
            <Text style={s.circleName}>{circle.circle_name}</Text>
          </View>
        </View>

        <Text style={s.sectionLabel}>Moments</Text>

        <View style={s.momentCard}>
          <View style={s.momentThumb} />
          <View style={s.momentInfo}>
            <Text style={s.momentName}>{confirmedMoment.moments_name}</Text>
            <Text style={s.momentVenue}>
              {[confirmedMoment.venue, confirmedMoment.location_name].filter(Boolean).join(" · ")}
            </Text>
            <View style={s.statusPill}>
              <Text style={s.statusText}>Confirmed</Text>
            </View>
          </View>
        </View>

        <View style={[s.momentCard, { marginTop: 12 }]}>
          <View style={[s.momentThumb, { backgroundColor: "rgba(255,255,255,0.04)" }]} />
          <View style={s.momentInfo}>
            <Text style={s.momentNameMuted}>Pending Moment</Text>
            <Text style={s.momentVenueMuted}>
              {pendingMoment.venue ? pendingMoment.venue : "Co is arranging your next experience."}
            </Text>
            <View style={[s.statusPill, s.statusPillMuted]}>
              <Text style={s.statusTextMuted}>Pending</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
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
  scroll: { flex: 1 },
  content: { paddingHorizontal: 32, paddingBottom: 48 },
  circleHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginTop: 24,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 28,
    marginBottom: 12,
  },
  circleName: { fontSize: 24, fontWeight: "300", color: "#fff", marginTop: 4 },
  momentCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    flexDirection: "row",
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  momentThumb: { width: 55, height: 80, backgroundColor: "rgba(255,255,255,0.08)" },
  momentInfo: { flex: 1, padding: 12, gap: 4 },
  momentName: { fontSize: 13, fontWeight: "400", color: "#fff" },
  momentNameMuted: { fontSize: 13, fontWeight: "400", color: "rgba(255,255,255,0.3)" },
  momentVenue: { fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  momentVenueMuted: { fontSize: 12, color: "rgba(255,255,255,0.2)", fontWeight: "300" },
  statusPill: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 4,
  },
  statusPillMuted: { borderColor: "rgba(255,255,255,0.1)" },
  statusText: { fontSize: 10, color: "rgba(255,255,255,0.6)" },
  statusTextMuted: { fontSize: 10, color: "rgba(255,255,255,0.25)" },
});
