import type { Server } from "socket.io";

// co-test has no auth system (no JWT, no login) — every session is just a
// UUID, matching the rest of this tool's sandbox nature (e.g. GET
// /api/phone/:user_id/status has no auth check either). So unlike
// production's socket config (api/src/socket/index.ts), there's no token to
// verify — the client just tells us which user_id room it wants on connect.
export function configureCoTestSocket(io: Server) {
  io.on("connection", (socket) => {
    const userId = (socket.handshake.auth as any)?.user_id as string | undefined;
    if (userId) socket.join(`user:${userId}`);

    socket.on("join", (uid: string) => {
      if (typeof uid === "string" && uid) socket.join(`user:${uid}`);
    });
  });
}
