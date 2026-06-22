import api from "@/lib/api";
import type { Moment } from "@/types";
import { useEffect, useState } from "react";
import { Image, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface Props {
  moment: Moment;
}

interface MomentPhoto {
  id: string;
  image_url: string;
}

export default function Recap({ moment }: Props) {
  const [photos, setPhotos] = useState<MomentPhoto[]>([]);

  useEffect(() => {
    let mounted = true;
    api.get(`/moments/${moment.id}/photos`)
      .then((res) => {
        if (mounted) setPhotos(res.data?.data ?? []);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [moment.id]);

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Just had an amazing time at ${moment.moments_name} with my Co circle.\n\nhttps://copatible.app/moments/${moment.id}`,
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

        <Text style={s.sectionLabel}>Relive the Night</Text>

        {photos.length > 0 ? (
          <View style={s.photoGrid}>
            {photos.map((photo) => (
              <View key={photo.id} style={s.photoCell}>
                <Image source={{ uri: photo.image_url }} style={s.photo} resizeMode="cover" />
              </View>
            ))}
          </View>
        ) : (
          <Text style={s.emptyPhotos}>Photos will appear here.</Text>
        )}
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
  photo: { flex: 1 },
  emptyPhotos: {
    fontSize: 13,
    fontWeight: "300",
    color: "rgba(255,255,255,0.3)",
    marginTop: 4,
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
