// Auth mutations used across the sign-in, sign-up, and OTP screens.
// All network calls go through the shared api instance (never directly to Supabase —
// the backend owns Supabase and returns a signed JWT on successful OTP verification).
import api from "@/lib/api";
import { useUserStore } from "@/stores/useUserStore";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback } from "react";

// POST /auth/register — creates a new user, triggers OTP to their email/phone
export const useRegister = () =>
  useMutation({
    mutationFn: (data: {
      first_name: string;
      email: string;
      phone_number: string;
    }) => api.post("/auth/register", data),
  });

// POST /auth/login — triggers OTP for an existing user by email
export const useLogin = () =>
  useMutation({
    mutationFn: (data: { email: string }) => api.post("/auth/login", data),
  });

// POST /auth/verify-otp — validates the 6-digit code and returns a JWT.
// The JWT is persisted in SecureStore here so the api interceptor picks it up
// on every subsequent request without needing to re-authenticate.
// user_id is also stored so the voice screen can call /co/call/:userId on mount.
export const useVerifyOtp = () =>
  useMutation({
    mutationFn: (data: { user_id: string; otp_code: string }) =>
      api.post("/auth/verify-otp", data),
    onSuccess: async (res, variables) => {
      const token = res.data?.token;
      if (token) {
        await SecureStore.setItemAsync("jwt_token", token);
        await SecureStore.setItemAsync("user_id", variables.user_id);
      }
    },
  });

// Clears credentials and redirects to sign-in — use for logout and session expiry.
export const useLogout = () => {
  const router = useRouter();
  const { clearUser } = useUserStore();
  return useCallback(async () => {
    await Promise.all([
      SecureStore.deleteItemAsync("jwt_token"),
      SecureStore.deleteItemAsync("user_id"),
    ]);
    clearUser();
    router.replace("/(auth)/sign-in");
  }, [router, clearUser]);
};

// POST /auth/send-otp — re-sends the code; the OTP screen enforces a 30s cooldown
export const useResendOtp = () =>
  useMutation({
    mutationFn: (data: { user_id: string }) =>
      api.post("/auth/send-otp", data),
  });
