// Shared Axios instance for all API calls to the CoPatible backend.
// The request interceptor reads the JWT from SecureStore on every call so
// we never have to pass the token manually — it just works after login.
import axios from "axios";
import * as SecureStore from "expo-secure-store";

const api = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL || "http://localhost:8080",
});

// Attach the stored JWT as a Bearer token on every outgoing request.
// SecureStore is async and native — this is why the interceptor is async.
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync("jwt_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;
