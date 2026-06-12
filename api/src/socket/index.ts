import jwt from "jsonwebtoken";
import type { Server } from "socket.io";

export function configureSocket(io: Server) {
  io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie ?? "";
    const token = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((c) => c.trim().split("=").map(decodeURIComponent)),
    )["token"];
    if (!token) return next(new Error("Unauthorized"));
    jwt.verify(
      token,
      process.env.JWT_SECRET_KEY!,
      (err: Error | null, user: any) => {
        if (err) return next(new Error("Invalid token"));
        (socket as any).user = user;
        next();
      },
    );
  });

  io.on("connection", (socket) => {
    const userId = (socket as any).user?.id as string;
    if (userId) socket.join(`user:${userId}`);

    socket.on("join:moment", (momentId: string) => {
      socket.join(`moment:${momentId}`);
    });

    socket.on("leave:moment", (momentId: string) => {
      socket.leave(`moment:${momentId}`);
    });
  });
}
