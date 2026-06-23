import type { Circle, CoProfile, User } from "@/types";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  profile: CoProfile;
  user: User;
  circle: Circle;
  onViewCircle: () => void;
}

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function CircleReady({ profile, user, circle, onViewCircle }: Props) {
  const trust = Math.max(0, Math.min(100, profile.trust_score ?? 0));
  const memberCount = (circle.members ?? []).length;
  const primaryChapter = (profile.life_chapters ?? [])[0] ?? "";

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.sectionLabel}>Profile</Text>

        <View style={s.identityRow}>
          <View style={s.avatar} />
          <View style={s.identityText}>
            <Text style={s.name}>{user.first_name}</Text>
            <Text style={s.city}>{profile.city ?? "—"}</Text>
          </View>
        </View>

        <View style={[s.card, { marginTop: 24 }]}>
          <Text style={s.cardHeadline}>Your circle is ready.</Text>
          <Text style={s.cardMuted}>
            {`Co found ${memberCount} people in your chapter.`}
          </Text>
        </View>

        <Text style={s.sectionLabel}>Your Circle</Text>
        <View style={s.circleCard}>
          <View style={s.avatarRow}>
            {(circle.members ?? []).slice(0, 5).map((_, i) => (
              <View key={i} style={[s.avatarSm, { marginLeft: i === 0 ? 0 : -8 }]} />
            ))}
          </View>
          <Text style={s.circleSubtext}>
            {`${memberCount} people · ${fmt(primaryChapter)}`}
          </Text>
        </View>

        <Text style={s.sectionLabel}>Life Chapters</Text>
        <View style={s.pillRow}>
          {(profile.life_chapters ?? []).map((c) => (
            <View key={c} style={[s.pill, s.pillMuted]}>
              <Text style={s.pillTextMuted}>{fmt(c)}</Text>
            </View>
          ))}
        </View>

        <Text style={s.sectionLabel}>Goals</Text>
        {(profile.goals ?? []).map((g, i) => (
          <Text key={i} style={s.listItem}>{"· " + g}</Text>
        ))}

        <View style={s.trustHeader}>
          <Text style={s.sectionLabel}>Trust Score</Text>
          <Text style={s.trustScore}>{trust} / 100</Text>
        </View>
        <View style={s.trustBg}>
          <View style={[s.trustFill, { width: `${trust}%` }]} />
        </View>
      </ScrollView>

      <View style={s.bottom}>
        <TouchableOpacity style={s.cta} onPress={onViewCircle} activeOpacity={0.8}>
          <Text style={s.ctaText}>View Your Circle</Text>
        </TouchableOpacity>
      </View>
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
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 28,
    marginBottom: 12,
  },
  identityRow: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 24 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  identityText: { gap: 4 },
  name: { fontSize: 18, fontWeight: "300", color: "#fff" },
  city: { fontSize: 13, color: "rgba(255,255,255,0.4)" },
  card: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.03)",
    gap: 6,
  },
  cardHeadline: { fontSize: 14, fontWeight: "400", color: "#fff" },
  cardMuted: { fontSize: 13, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  circleCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.03)",
    gap: 12,
  },
  avatarRow: { flexDirection: "row" },
  avatarSm: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "#1a1a1a",
  },
  circleSubtext: { fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: "#fff",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillMuted: {
    borderColor: "rgba(255,255,255,0.2)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  pillTextMuted: { fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  listItem: {
    fontSize: 14,
    color: "rgba(255,255,255,0.8)",
    fontWeight: "300",
    marginBottom: 6,
  },
  trustHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  trustScore: {
    fontSize: 12,
    color: "rgba(255,255,255,0.5)",
    marginBottom: 12,
  },
  trustBg: { height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.08)" },
  trustFill: { height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.4)" },
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
