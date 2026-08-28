import jwt from "jsonwebtoken";
import type { Server } from "socket.io";

export function configureSocket(io: Server) {
  io.use((socket, next) => {
    // Mobile clients (React Native/Expo) pass the JWT via handshake auth.
    // Web clients fall back to the cookie set on OTP verification.
    let token: string | undefined = (socket.handshake.auth as any)?.token;

    if (!token) {
      const cookieHeader = socket.handshake.headers.cookie ?? "";
      //turns the token into a json object
      //this basically assigns the value to Token
      token = Object.fromEntries(
        cookieHeader
          .split(";")
          .map((c) => c.trim().split("=").map(decodeURIComponent)),
      )["token"];
    }

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
  });
}
