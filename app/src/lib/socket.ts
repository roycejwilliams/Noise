// Socket.io client — autoConnect: false so screens open it only when needed.
// Mobile clients authenticate via handshake auth token (not cookies).
// Call configureSocketAuth(token) before socket.connect() on any screen that uses it.
import * as SecureStore from "expo-secure-store";
import { io } from "socket.io-client";

export const socket = io(process.env.EXPO_PUBLIC_API_URL!, {
  autoConnect: false,
});

export async function connectSocket() {
  const token = await SecureStore.getItemAsync("jwt_token");
  if (!token) return;
  socket.auth = { token };
  if (!socket.connected) socket.connect();
}
