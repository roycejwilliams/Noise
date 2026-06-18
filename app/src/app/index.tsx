// Entry point — checks SecureStore for a saved JWT and redirects immediately.
// No UI is rendered here (black fallback only while the async check resolves).
// If a token exists the user goes straight to the main app; otherwise to auth.
import { Redirect } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { View } from "react-native";

export default function Index() {
  const [destination, setDestination] = useState<
    "/(auth)/sign-in" | "/(main)/voice" | null
  >(null);

  useEffect(() => {
    // jwt_token is written to SecureStore by useVerifyOtp on successful OTP verification
    SecureStore.getItemAsync("jwt_token").then((token) => {
      setDestination(token ? "/(main)/voice" : "/(auth)/sign-in");
    });
  }, []);

  // Hold on a black screen until the SecureStore read resolves — usually instant
  if (!destination)
    return <View style={{ flex: 1, backgroundColor: "#000000" }} />;

  return <Redirect href={destination} />;
}
