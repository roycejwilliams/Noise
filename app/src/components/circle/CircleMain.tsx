import type { Circle, Moment } from "@/types";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  circle: Circle;
  moment?: Moment;
  onViewMoment: (momentId: string) => void;
}

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractChapters(circleName: string): string[] {
  const parts = circleName.split(" — ");
  if (parts.length > 1) return [parts.slice(1).join(" — ")];
  return [];
}

export default function CircleMain({
  circle,
  moment,
  onViewMoment,
}: Props) {
  const chapters = extractChapters(circle.circle_name ?? "");

  return (
    <SafeAreaView style={s.root}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.circleHeader}>
          <View>
            <Text style={s.sectionLabel}>Circle</Text>
            <Text style={s.circleName}>{circle.circle_name}</Text>
          </View>
        </View>

        <Text style={s.sectionLabel}>Members</Text>
        {(circle.members ?? []).map((m) => (
          <View key={m.id} style={s.memberRow}>
            <View style={s.memberAvatar} />
            <Text style={s.memberName}>{m.first_name}</Text>
            <View style={s.socialIcons}>
              <View style={s.socialIcon} />
              <View style={s.socialIcon} />
              <View style={s.socialIcon} />
            </View>
          </View>
        ))}

        {chapters.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Shared Life Chapters</Text>
            <View style={s.pillRow}>
              {chapters.map((c) => (
                <View key={c} style={s.pill}>
                  <Text style={s.pillText}>{fmt(c)}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {moment && (
          <>
            <Text style={s.sectionLabel}>Moments</Text>
            <TouchableOpacity
              style={s.momentCard}
              onPress={() => onViewMoment(moment.id)}
              activeOpacity={0.8}
            >
              <View style={s.momentThumb} />
              <View style={s.momentInfo}>
                <Text style={s.momentName}>{moment.moments_name}</Text>
                <Text style={s.momentVenue}>
                  {[moment.venue, moment.location_name]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                <View style={s.momentStatusPill}>
                  <Text style={s.momentStatusText}>
                    {fmt(moment.status ?? "polling")}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          </>
        )}
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
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
    gap: 12,
  },
  memberAvatar: {
    width: 31,
    height: 31,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  memberName: { flex: 1, fontSize: 14, color: "#fff", fontWeight: "300" },
  socialIcons: { flexDirection: "row", gap: 10 },
  socialIcon: {
    width: 16,
    height: 16,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillText: { fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: "300" },
  momentCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    flexDirection: "row",
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  momentThumb: {
    width: 55,
    height: 62,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  momentInfo: { flex: 1, padding: 12, gap: 4 },
  momentName: { fontSize: 13, fontWeight: "400", color: "#fff" },
  momentVenue: {
    fontSize: 12,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
  },
  momentStatusPill: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 4,
  },
  momentStatusText: { fontSize: 10, color: "rgba(255,255,255,0.5)" },
});
