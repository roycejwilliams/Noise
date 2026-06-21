import type { Moment } from "@/types";
import { ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  moment: Moment;
}

const PHOTO_SLOTS = [0, 1, 2, 3];

export default function Recap({ moment }: Props) {
  const handleShare = async () => {
    try {
      await Share.share({
        message: `Just had an amazing time at ${moment.moments_name} with my Co circle.`,
      });
    } catch {}
  };

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.headline}>{moment.moments_name}</Text>
        <Text style={s.subline}>
          {[moment.venue, moment.location_name].filter(Boolean).join(" · ")}
        </Text>

        {moment.description && (
          <Text style={s.recapText}>{moment.description}</Text>
        )}

        <View style={s.heroPlaceholder}>
          <View style={s.heroIcon} />
        </View>

        <Text style={s.sectionLabel}>Relive the Night</Text>
        <View style={s.photoGrid}>
          {PHOTO_SLOTS.map((i) => (
            <View key={i} style={s.photoCell}>
              <View style={s.photoInner} />
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={s.bottom}>
        <TouchableOpacity style={s.cta} onPress={handleShare} activeOpacity={0.8}>
          <Text style={s.ctaText}>Share</Text>
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
    marginTop: 28,
  },
  subline: {
    fontSize: 13,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
    marginTop: 6,
    marginBottom: 20,
  },
  recapText: {
    fontSize: 14,
    fontWeight: "300",
    color: "rgba(255,255,255,0.7)",
    lineHeight: 22,
    marginBottom: 24,
  },
  heroPlaceholder: {
    width: "100%",
    height: 362,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 4,
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
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  photoCell: {
    width: "48%",
    aspectRatio: 1,
    borderRadius: 4,
    overflow: "hidden",
  },
  photoInner: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
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
