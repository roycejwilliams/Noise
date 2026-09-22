import jwt from "jsonwebtoken";
import type { Server } from "socket.io";
import pool from "../db/db.js";
import { tokenVersionValid } from "../routes/accountRules.js";

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
      async (err: Error | null, user: any) => {
        if (err) return next(new Error("Invalid token"));
        // Same revocation check as middleware/auth.ts (2026-09-22): logout
        // and an OTP lock bump users.token_version, and a token signed with
        // an older version could still open a socket until now.
        try {
          const { rows } = await pool.query(`SELECT token_version FROM users WHERE id = $1`, [user?.id]);
          if (!rows[0] || !tokenVersionValid(user?.tv, rows[0].token_version)) return next(new Error("Invalid token"));
        } catch {
          return next(new Error("Unauthorized"));
        }
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
