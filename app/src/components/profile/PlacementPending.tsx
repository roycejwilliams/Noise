import type { CoProfile, User } from "@/types";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  profile: CoProfile;
  user: User;
}

function fmt(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function PlacementPending({ profile, user }: Props) {
  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>Co</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.sectionLabel}>Profile</Text>

        <View style={s.identityRow}>
          <View style={s.avatar} />
          <View style={s.identityText}>
            <Text style={s.name}>{user.first_name}</Text>
            <Text style={s.city}>{profile.city ?? ""}</Text>
          </View>
        </View>

        <View style={[s.card, { marginTop: 24 }]}>
          <Text style={s.cardHeadline}>Co is matching you now.</Text>
          <Text style={s.cardMuted}>This usually takes a few minutes.</Text>
        </View>

        <Text style={s.sectionLabel}>Life Chapters</Text>
        <View style={s.pillRow}>
          {(profile.life_chapters ?? []).map((c) => (
            <View key={c} style={[s.pill, s.pillMuted]}>
              <Text style={s.pillTextMuted}>{fmt(c)}</Text>
            </View>
          ))}
        </View>

        {(profile.goals ?? []).length > 0 && (
          <>
            <Text style={s.sectionLabel}>Goals</Text>
            {(profile.goals ?? []).map((g, i) => (
              <Text key={i} style={s.listItem}>{"· " + g}</Text>
            ))}
          </>
        )}

        {profile.emotional_state && (
          <>
            <Text style={s.sectionLabel}>Emotional State</Text>
            <View style={s.pillRow}>
              <View style={[s.pill, s.pillMuted]}>
                <Text style={s.pillTextMuted}>{fmt(profile.emotional_state)}</Text>
              </View>
            </View>
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
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: 16,
    gap: 6,
  },
  cardHeadline: { fontSize: 14, fontWeight: "400", color: "#fff" },
  cardMuted: { fontSize: 13, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillMuted: { backgroundColor: "rgba(255,255,255,0.04)" },
  pillTextMuted: { fontSize: 12, color: "rgba(255,255,255,0.35)", fontWeight: "300" },
  listItem: {
    fontSize: 14,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
    marginBottom: 6,
  },
});
