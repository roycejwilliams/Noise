import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import helmut from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import pool from "./db/db.js";
import { runMigrations } from "./db/migrations.js";
import { registerJobs } from "./jobs/index.js";
import { authenticateToken } from "./middleware/auth.js";
import { corsOptions } from "./middleware/cors.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { applicationLimiter, authLimiter, limiter } from "./middleware/rateLimiter.js";
import applicationsRouter from "./routes/applications.js";
import { createAiRouter } from "./routes/ai.js";
import { createAuthRouter } from "./routes/auth.js";
import { createCirclesRouter } from "./routes/circles.js";
import coRouter from "./routes/co.js";
import { createInvitesRouter } from "./routes/invites.js";
import { createMomentsRouter } from "./routes/moments.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createReferralsRouter } from "./routes/referrals.js";
import { sendblueRouter } from "./routes/sendblue.js";
import { stripeRouter } from "./routes/stripe.js";
import { createUsersRouter } from "./routes/users.js";
import { configureSocket } from "./socket/index.js";
import { getAudioEntry } from "./services/voiceNote.js";

const app = express();
app.set("trust proxy", 1);
const port = "8080";

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });

configureSocket(io);
runMigrations();
pool
  .query(`ALTER TABLE co_memories ADD COLUMN IF NOT EXISTS content_embedding vector(1536)`)
  .then(() =>
    pool.query(`CREATE INDEX IF NOT EXISTS co_memories_embedding_hnsw_idx
      ON co_memories USING hnsw (content_embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)`),
  )
  .catch((err) => console.error("Failed to set up co_memories embedding index:", err));

// Stripe webhook needs raw body for signature verification — must run before express.json()
app.use("/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio status callbacks send form-encoded bodies
app.use(helmut());
app.use(cors(corsOptions));
app.use(limiter);
app.use("/auth", authLimiter);
app.post("/applications", applicationLimiter);
app.use(cookieParser());

// Routes
app.use("/applications", applicationsRouter);
app.use("/auth", createAuthRouter());
app.use("/users", createUsersRouter(authenticateToken));
app.use("/circles", createCirclesRouter(io, authenticateToken));
app.use(createMomentsRouter(io, authenticateToken));
app.use("/invites", createInvitesRouter(io, authenticateToken));
app.use("/notifications", createNotificationsRouter(authenticateToken));
app.use("/ai", createAiRouter(io, authenticateToken));
app.use("/referrals", createReferralsRouter(authenticateToken));
app.use("/co", coRouter);
app.use("/payments", stripeRouter(io, authenticateToken));
app.use("/sendblue", sendblueRouter(io));

// Serve ElevenLabs-generated voice note audio files for Sendblue media messages
// Files are stored in memory with a 10-minute TTL — long enough for Sendblue to fetch
app.get("/audio/:id", (req, res) => {
  const entry = getAudioEntry(req.params.id);
  if (!entry) return res.status(404).send("Not found.");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  return res.send(entry.buffer);
});

app.use(errorHandler);

registerJobs();

httpServer.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
