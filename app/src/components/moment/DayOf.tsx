import type { CircleMember, Moment } from "@/types";
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  moment: Moment;
  members: CircleMember[];
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  } catch {
    return "";
  }
}

export default function DayOf({ moment, members }: Props) {
  const venue = moment.venue ?? moment.location_name ?? "TBD";
  const time = formatTime(moment.moment_start);

  const handleDirections = () => {
    const query = encodeURIComponent(venue);
    Linking.openURL(`https://maps.apple.com/?q=${query}`);
  };

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>Co</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.headline}>Tonight's the night.</Text>
        <Text style={s.subtitle}>{`${venue} · ${time}`}</Text>

        <View style={s.qrPlaceholder}>
          <View style={s.qrInner}>
            <View style={s.qrCorner} />
            <View style={[s.qrCorner, { alignSelf: "flex-end" }]} />
          </View>
        </View>

        <View style={s.circleHeader}>
          <Text style={s.sectionLabel}>Your circle</Text>
          <Text style={s.memberCount}>{members.length + " people"}</Text>
        </View>

        {members.map((m) => (
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
      </ScrollView>

      <View style={s.bottom}>
        <TouchableOpacity style={s.cta} onPress={handleDirections} activeOpacity={0.8}>
          <Text style={s.ctaText}>Get Directions</Text>
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
  headline: {
    fontSize: 24,
    fontWeight: "300",
    color: "#fff",
    marginTop: 32,
  },
  subtitle: {
    fontSize: 13,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
    marginTop: 8,
  },
  qrPlaceholder: {
    width: 275,
    height: 275,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 4,
    alignSelf: "center",
    marginTop: 36,
    marginBottom: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  qrInner: {
    width: 220,
    height: 220,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    padding: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 0,
  },
  qrCorner: {
    width: 28,
    height: 28,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
  },
  circleHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 28,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  memberCount: {
    fontSize: 12,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
  },
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
