import type { Server } from "socket.io";
import { verifySocketToken } from "../services/liveCallState.js";

// co-test has no login system, but joining a live-call room still needs to
// be restricted to the browser that actually owns that session — the room
// carries a real tester's live call transcript. The per-session token
// (issued by /api/phone/session, verified here) is the credential; a bare
// user_id is not, since it's visible in the results-page URL and elsewhere.
export function configureCoTestSocket(io: Server) {
  io.on("connection", (socket) => {
    const auth = socket.handshake.auth as { user_id?: string; token?: string } | undefined;
    if (auth?.user_id && verifySocketToken(auth.user_id, auth.token)) {
      socket.join(`user:${auth.user_id}`);
    }

    socket.on("join", (payload: { user_id?: string; token?: string }) => {
      if (payload?.user_id && verifySocketToken(payload.user_id, payload.token)) {
        socket.join(`user:${payload.user_id}`);
      }
    });
  });
}
