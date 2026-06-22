import type { Circle, CoProfile, User } from "@/types";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  profile: CoProfile;
  user: User;
  circle?: Circle | null;
}

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function trustMessage(score: number, checkInCount: number): string {
  const t = Math.max(0, Math.min(100, score));
  if (t <= 20) return "Co is just getting to know you.";
  if (t <= 40) return "You showed up once. Co noticed.";
  if (t <= 60) return `Co has seen you show up ${checkInCount} times.`;
  if (t <= 80) return "You show up. Co remembers that.";
  return "Co knows you show up every time.";
}

export default function ProfileMain({ profile, user, circle }: Props) {
  const vibes = [
    ...(profile.emotional_state ? [profile.emotional_state] : []),
    ...(profile.activity_preferences ?? []),
  ].slice(0, 6);

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.sectionLabel}>Profile</Text>

        <View style={s.identityRow}>
          <View style={s.avatar} />
          <View style={s.identityText}>
            <Text style={s.name}>{user.first_name}</Text>
            <Text style={s.city}>{profile.city ?? ""}</Text>
          </View>
        </View>

        {(profile.life_chapters ?? []).length > 0 && (
          <>
            <Text style={s.sectionLabel}>Life Chapters</Text>
            <View style={s.pillRow}>
              {(profile.life_chapters ?? []).map((c) => (
                <View key={c} style={s.pill}>
                  <Text style={s.pillText}>{fmt(c)}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {(profile.goals ?? []).length > 0 && (
          <>
            <Text style={s.sectionLabel}>Goals</Text>
            {(profile.goals ?? []).map((g, i) => (
              <Text key={i} style={s.listItem}>{"· " + g}</Text>
            ))}
          </>
        )}

        {vibes.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Vibe</Text>
            <View style={s.pillRow}>
              {vibes.map((v, i) => (
                <View key={i} style={s.pill}>
                  <Text style={s.pillText}>{fmt(v)}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        <Text style={s.sectionLabel}>Trust</Text>
        <Text style={s.trustMessage}>{trustMessage(profile.trust_score ?? 0, profile.check_in_count ?? 0)}</Text>

        <Text style={s.sectionLabel}>Circle Status</Text>
        {circle ? (
          <View style={s.card}>
            <Text style={s.cardHeadline}>{circle.circle_name}</Text>
            <Text style={s.cardMuted}>
              {`${(circle.members ?? []).length} people in your circle`}
            </Text>
          </View>
        ) : (
          <View style={s.card}>
            <Text style={s.cardHeadline}>Co is finding your people.</Text>
            <Text style={s.cardMuted}>You'll hear from Co soon.</Text>
          </View>
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
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillText: { fontSize: 12, color: "#fff", fontWeight: "300" },
  listItem: {
    fontSize: 14,
    color: "rgba(255,255,255,0.7)",
    fontWeight: "300",
    marginBottom: 6,
  },
  trustMessage: {
    fontSize: 13,
    fontWeight: "300",
    color: "rgba(255,255,255,0.5)",
    lineHeight: 20,
  },
  card: {
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: 16,
    gap: 6,
  },
  cardHeadline: { fontSize: 14, fontWeight: "400", color: "#fff" },
  cardMuted: { fontSize: 13, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
});
