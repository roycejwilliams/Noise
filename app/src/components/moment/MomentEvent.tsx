import type { CircleMember, Moment } from "@/types";
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  moment: Moment;
  members: CircleMember[];
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

export default function MomentEvent({ moment, members }: Props) {
  const dateStr = moment.suggested_time ?? `${formatDate(moment.moment_start)} · ${formatTime(moment.moment_start)}`;

  const handleBook = () => {
    if (moment.venue_booking_url) {
      Linking.openURL(moment.venue_booking_url);
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.wordmark}>CoPatible</Text>
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.heroPlaceholder}>
          <View style={s.heroIcon} />
        </View>

        <View style={s.content}>
          <Text style={s.momentName}>{moment.moments_name}</Text>
          <Text style={s.venueText}>
            {[moment.venue, moment.location_name].filter(Boolean).join(" · ")}
          </Text>
          <Text style={s.dateText}>{dateStr}</Text>

          <View style={s.attendeesRow}>
            {members.slice(0, 5).map((_, i) => (
              <View
                key={i}
                style={[s.attendeeAvatar, { marginLeft: i === 0 ? 0 : -12 }]}
              />
            ))}
            <Text style={s.attendeeCount}>
              {"  " + members.length + " people · Curated by Co"}
            </Text>
          </View>

          {moment.description && (
            <>
              <Text style={s.sectionLabel}>Co's Notes</Text>
              <Text style={s.notes}>{moment.description}</Text>
            </>
          )}
        </View>
      </ScrollView>

      <View style={s.bottom}>
        <TouchableOpacity
          style={[s.cta, !moment.venue_booking_url && s.ctaDim]}
          onPress={handleBook}
          activeOpacity={0.8}
          disabled={!moment.venue_booking_url}
        >
          <Text style={s.ctaText}>Book Your Spot</Text>
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
  heroPlaceholder: {
    aspectRatio: 1,
    marginHorizontal: 32,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 4,
  },
  content: { paddingHorizontal: 32, paddingBottom: 16 },
  momentName: {
    fontSize: 24,
    fontWeight: "300",
    color: "#fff",
    marginTop: 20,
  },
  venueText: {
    fontSize: 13,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
    marginTop: 6,
  },
  dateText: {
    fontSize: 13,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
    marginTop: 4,
  },
  attendeesRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 20,
    marginBottom: 8,
  },
  attendeeAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "#1a1a1a",
  },
  attendeeCount: {
    fontSize: 12,
    color: "rgba(255,255,255,0.4)",
    fontWeight: "300",
    marginLeft: 8,
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
  notes: {
    fontSize: 14,
    color: "rgba(255,255,255,0.7)",
    fontWeight: "300",
    lineHeight: 22,
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
  ctaDim: { opacity: 0.35 },
  ctaText: { fontSize: 14, fontWeight: "300", color: "#fff", letterSpacing: 0.3 },
});
