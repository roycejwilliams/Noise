// Auth container — one screen that toggles between sign-up ("New") and sign-in ("Login").
// This mirrors the CoPatible pattern: mode is component state, not a router param.
// The animated pill slides between the two options without any navigation event.
// Sub-forms (SignIn, SignUp) call onSuccess(userId) when the backend responds,
// and this container is the only thing that knows about the OTP route.
import SignIn from "@/components/auth/SignIn";
import SignUp from "@/components/auth/SignUp";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Mode = "sign-up" | "sign-in";

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>("sign-up");
  const pillX = useRef(new Animated.Value(0)).current;
  const [toggleWidth, setToggleWidth] = useState(0);
  const router = useRouter();

  const switchTo = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    Animated.timing(pillX, {
      //positioning
      toValue: next === "sign-up" ? 0 : 1,
      //time
      duration: 240,
      //starts fast then slow
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // left position cannot use the native driver
      //native driver only used for opacity and transform
    }).start();
  };

  // pillLeft maps the 0-1 value to a pixel offset spanning half the toggle width
  //creates actual pixel positions
  const pillLeft = pillX.interpolate({
    inputRange: [0, 1],
    outputRange: [3, toggleWidth / 2 - 3],
  });

  // Both sub-forms call this on success — the container owns the next route
  const handleSuccess = (userId: string) => {
    router.push({ pathname: "/(auth)/otp", params: { userId } });
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.inner}>
        {/* Logo mark — placeholder border box until final brand assets land */}
        <View style={styles.logoMark} />

        <Text style={styles.title}>
          {mode === "sign-up" ? "Sign Up" : "Login"}
        </Text>

        {/* Sliding pill toggle — compact and left-aligned per Figma */}
        <View
          style={styles.toggle}
          //measuring the actual rendered width
          onLayout={(e: LayoutChangeEvent) =>
            setToggleWidth(e.nativeEvent.layout.width)
          }
        >
          <Animated.View
            style={[
              styles.pill,
              { left: pillLeft, width: toggleWidth / 2 - 3 },
            ]}
          />
          {/* makes it respond properly to touches */}
          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => switchTo("sign-up")}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.toggleLabel,
                mode === "sign-up" && styles.toggleLabelActive,
              ]}
            >
              New
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => switchTo("sign-in")}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.toggleLabel,
                mode === "sign-in" && styles.toggleLabelActive,
              ]}
            >
              Login
            </Text>
          </TouchableOpacity>
        </View>

        {mode === "sign-up" ? (
          <SignUp onSuccess={handleSuccess} />
        ) : (
          <SignIn onSuccess={handleSuccess} />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  inner: {
    flex: 1,
    paddingHorizontal: 33,
    paddingTop: 40,
  },
  logoMark: {
    width: 60,
    height: 60,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ffffff",
    marginBottom: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: "300",
    color: "#ffffff",
    marginBottom: 20,
    letterSpacing: 0.2,
  },
  toggle: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderRadius: 100,
    padding: 3,
    alignSelf: "flex-start",
    width: 200,
    position: "relative",
    marginBottom: 36,
  },
  pill: {
    position: "absolute",
    top: 3,
    bottom: 3,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 100,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 6,
    alignItems: "center",
    zIndex: 1,
  },
  toggleLabel: {
    fontSize: 11,
    color: "rgba(255,255,255,0.35)",
  },
  toggleLabelActive: {
    color: "#ffffff",
  },
});
