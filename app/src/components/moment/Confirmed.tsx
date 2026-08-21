import type { Moment } from "@/types";
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  moment: Moment;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  } catch {
    return "";
  }
}

export default function Confirmed({ moment }: Props) {
  const date = formatDate(moment.moment_start);
  const time = formatTime(moment.moment_start);
  const venue = moment.venue ?? moment.location_name ?? "TBD";

  const handleCalendar = () => {
    const start = new Date(moment.moment_start).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    Linking.openURL(`https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(moment.moments_name)}&dates=${start}/${start}&location=${encodeURIComponent(venue)}`);
  };

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>Co</Text>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.main}>
          <View style={s.iconPlaceholder}>
            <View style={s.iconInner} />
          </View>
          <Text style={s.headline}>You're all set.</Text>
          <Text style={s.subtitle}>
            {`${venue} · ${date} · ${time}`}
          </Text>
        </View>

        <Text style={s.sectionLabel}>Details</Text>
        <View style={s.detailCard}>
          {[
            { label: "Venue", value: venue },
            { label: "Date", value: date },
            { label: "Time", value: time },
            { label: "Circle", value: "Your Co Circle" },
          ].map(({ label, value }) => (
            <View key={label} style={s.detailRow}>
              <Text style={s.detailLabel}>{label}</Text>
              <Text style={s.detailValue}>{value}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={s.bottom}>
        <TouchableOpacity style={s.cta} onPress={handleCalendar} activeOpacity={0.8}>
          <Text style={s.ctaText}>Add to Calendar</Text>
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
  main: { alignItems: "center", paddingTop: 60, paddingBottom: 8 },
  iconPlaceholder: {
    width: 84,
    height: 84,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 28,
  },
  iconInner: {
    width: 36,
    height: 36,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    borderRadius: 4,
  },
  headline: {
    fontSize: 20,
    fontWeight: "300",
    color: "#fff",
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: "300",
    color: "rgba(255,255,255,0.4)",
    textAlign: "center",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 36,
    marginBottom: 12,
  },
  detailCard: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  detailLabel: { fontSize: 13, color: "rgba(255,255,255,0.4)", fontWeight: "300" },
  detailValue: { fontSize: 13, color: "#fff", fontWeight: "300" },
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
