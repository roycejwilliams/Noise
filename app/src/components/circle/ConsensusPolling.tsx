import type { Circle, Moment, MomentResponse } from "@/types";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  circle: Circle;
  moment: Moment;
  responses: MomentResponse[];
  isConnector: boolean;
  onUpdate?: () => void;
}

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getDateOptions(suggestedTime: string | null | undefined): string[] {
  const base = suggestedTime ? new Date(suggestedTime) : new Date();
  return [0, 1, 2].map((offset) => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  });
}

function getTimeOptions(suggestedTime: string | null | undefined): string[] {
  const base = suggestedTime ? new Date(suggestedTime) : null;
  const startHour = base ? base.getHours() : 18;
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const totalMins = startHour * 60 + i * 30;
    const h = Math.floor(totalMins / 60) % 24;
    const m = totalMins % 60;
    const period = h >= 12 ? "PM" : "AM";
    const displayH = h > 12 ? h - 12 : h === 0 ? 12 : h;
    return `${displayH}:${m.toString().padStart(2, "0")} ${period}`;
  });
}

export default function ConsensusPolling({ circle, moment, responses, isConnector, onUpdate }: Props) {
  const yesCount = responses.filter((r) => r.response === "yes").length;
  const dateOptions = getDateOptions(moment.suggested_time);
  const timeOptions = getTimeOptions(moment.suggested_time);

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.circleHeader}>
          <View>
            <Text style={s.sectionLabel}>Circle</Text>
            <Text style={s.circleName}>{circle.circle_name}</Text>
          </View>
          {isConnector && (
            <View style={s.connectorBadge}>
              <Text style={s.connectorText}>Circle Connector</Text>
            </View>
          )}
        </View>

        <View style={s.momentCard}>
          <Text style={s.momentName}>{moment.moments_name}</Text>
          <Text style={s.momentVenue}>
            {[moment.venue, moment.location_name].filter(Boolean).join(" · ")}
          </Text>
          {moment.suggested_time && (
            <Text style={s.momentTime}>{moment.suggested_time}</Text>
          )}
        </View>

        {isConnector ? (
          <>
            <Text style={s.sectionLabel}>Request Date</Text>
            <View style={s.pillRow}>
              {dateOptions.map((d) => (
                <View key={d} style={s.pill}>
                  <Text style={s.pillText}>{d}</Text>
                </View>
              ))}
            </View>

            <Text style={s.sectionLabel}>Request Time</Text>
            <View style={s.pillRow}>
              {timeOptions.map((t) => (
                <View key={t} style={s.pill}>
                  <Text style={s.pillText}>{t}</Text>
                </View>
              ))}
            </View>
          </>
        ) : (
          <>
            <Text style={s.sectionLabel}>Proposed Time</Text>
            <View style={s.card}>
              <Text style={s.cardText}>{moment.suggested_time ?? "TBD"}</Text>
              <Text style={s.cardMuted}>Reply YES or suggest another time via iMessage.</Text>
            </View>
          </>
        )}

        <View style={s.responsesHeader}>
          <Text style={s.sectionLabel}>Responses</Text>
          <Text style={s.responseCount}>{yesCount} of {responses.length} confirmed</Text>
        </View>
        {responses.map((r) => (
          <View key={r.user_id} style={s.responseRow}>
            <View style={s.memberAvatar} />
            <Text style={s.memberName}>{r.first_name}</Text>
            <Text style={[s.responseText, r.response === "yes" && s.responseYes]}>
              {r.response ? fmt(r.response) : "No reply"}
            </Text>
          </View>
        ))}
      </ScrollView>

      {isConnector && onUpdate && (
        <View style={s.bottom}>
          <TouchableOpacity style={s.cta} onPress={onUpdate} activeOpacity={0.8}>
            <Text style={s.ctaText}>Update Moment</Text>
          </TouchableOpacity>
        </View>
      )}
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
  content: { paddingHorizontal: 32, paddingBottom: 16 },
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
  connectorBadge: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginBottom: 4,
  },
  connectorText: { fontSize: 10, color: "rgba(255,255,255,0.6)", fontWeight: "400" },
  momentCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.03)",
    gap: 6,
    marginTop: 4,
  },
  momentName: { fontSize: 14, fontWeight: "400", color: "#fff" },
  momentVenue: { fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  momentTime: { fontSize: 12, color: "rgba(255,255,255,0.5)", fontWeight: "300" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillText: { fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: "300" },
  card: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.03)",
    gap: 6,
  },
  cardText: { fontSize: 14, color: "#fff", fontWeight: "300" },
  cardMuted: { fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  responsesHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  responseCount: {
    fontSize: 11,
    color: "rgba(255,255,255,0.4)",
    marginBottom: 12,
  },
  responseRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
    gap: 12,
  },
  memberAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  memberName: { flex: 1, fontSize: 14, color: "#fff", fontWeight: "300" },
  responseText: { fontSize: 12, color: "rgba(255,255,255,0.3)", fontWeight: "300" },
  responseYes: { color: "rgba(255,255,255,0.7)" },
  bottom: { paddingHorizontal: 32, paddingBottom: 16 },
  cta: {
    borderWidth: 1,
    borderColor: "#fff",
    borderRadius: 100,
    height: 57,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: { fontSize: 14, fontWeight: "300", color: "#fff", letterSpacing: 0.3 },
});
