import type { CorsOptions } from "cors";

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed =
      process.env.NODE_ENV === "production"
        ? origin === "https://br3w.app" ||
          /^https:\/\/brew-.*\.vercel\.app$/.test(origin)
        : origin === "http://localhost:3000" ||
          /^https:\/\/.*\.ngrok-free\.dev$/.test(origin) ||
          /^https:\/\/.*\.ngrok\.io$/.test(origin);
    allowed
      ? callback(null, true)
      : callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
