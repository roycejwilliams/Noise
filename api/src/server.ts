import "dotenv/config";
import { initTelemetry } from "./telemetry.js";
initTelemetry();

import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmut from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import { runMigrations } from "./db/migrations.js";
import { registerJobs } from "./jobs/index.js";
import { installGracefulShutdown, trackRequests } from "./services/shutdown.js";
import { authenticateToken } from "./middleware/auth.js";
import { corsOptions } from "./middleware/cors.js";
import { errorHandler } from "./middleware/errorHandler.js";
import {
  applicationLimiter,
  limiter,
} from "./middleware/rateLimiter.js";
import applicationsRouter from "./routes/applications.js";
import { createAuthRouter } from "./routes/auth.js";
import { createCoRouter } from "./routes/co.js";
import { serveInvitePage } from "./routes/invitePage.js";
import { createLumaRouter } from "./routes/luma.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createReferralsRouter } from "./routes/referrals.js";
import { reportUnfinishedTurns, sendblueRouter } from "./routes/sendblue.js";
import { stripeRouter } from "./routes/stripe.js";
import { createUsersRouter } from "./routes/users.js";
import { getAudioEntry } from "./services/voiceNote.js";
import { configureSocket } from "./socket/index.js";
import { buildCoVCard } from "./utils/vcard.js";
import { createMoRouter } from "./routes/mo.js";
import { createGoogleRouter } from "./routes/google.js";

const app = express();
app.set("trust proxy", 1);
app.use(trackRequests); // a restart waits for requests mid-flight (services/shutdown.ts)
const port = process.env.PORT ?? "8080";

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });

//Web socket config
configureSocket(io);

//Security check to make sure the right tables/columns
// are there when the server starts. Fixed 2026-09-17: runMigrations()
// became async/awaitable (auth/payments) but this call was still fired
// unawaited — the server could start accepting requests (and cron jobs
// could start firing) before migrations actually finished. migrationsReady
// is awaited below, right before jobs are registered and the server starts
// listening, instead of being awaited here — route registration itself
// (app.use(...) below) doesn't touch the DB and doesn't need to wait.
const migrationsReady = runMigrations();
// Stripe webhook needs raw body for signature verification — must run before express.json()
app.use("/payments/webhook", express.raw({ type: "application/json" }));
// ElevenLabs signs the post-call webhook over the exact raw body (services/
// elevenLabsCalls.ts), same reasoning as Stripe's above.
app.use("/co/el/post-call", express.raw({ type: "application/json", limit: "5mb" }));
// Luma's webhook signature is the same "HMAC over the raw body" shape as the
// two above — see validateLumaWebhook in routes/luma.ts for the exact scheme.
app.use("/luma/webhook", express.raw({ type: "application/json" }));
// Resend signs the raw body of Mo's inbound email posts (routes/mo.ts).
app.use("/mo/email/inbound", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio status callbacks send form-encoded bodies
app.use(helmut());
app.use(cors(corsOptions));
app.use(limiter);
app.post("/applications", applicationLimiter);
app.use(cookieParser());

app.get("/health", (_req, res) => res.sendStatus(200));

// Routes
app.use("/applications", applicationsRouter);
app.use("/auth", createAuthRouter());
app.use("/users", createUsersRouter(authenticateToken));
app.use("/notifications", createNotificationsRouter(authenticateToken));
app.use("/referrals", createReferralsRouter(authenticateToken));
app.use("/co", createCoRouter(io));
app.use("/luma", createLumaRouter());
app.use("/payments", stripeRouter(io, authenticateToken));
app.use("/sendblue", sendblueRouter(io));
app.use("/mo", createMoRouter());
app.use("/google", createGoogleRouter());

// Serve Co's vCard so Sendblue can attach it to the circle_placement iMessage.
// Sendblue fetches media_url before sending — this endpoint must be publicly reachable
// (via ngrok in dev, or Railway in prod). CO_VCARD_URL points here.
app.get("/co.vcf", (_req, res) => {
  const phone = process.env.SENDBLUE_PHONE_NUMBER ?? "";
  const vcard = buildCoVCard(phone);
  res.setHeader("Content-Type", "text/vcard");
  res.setHeader("Content-Disposition", "attachment; filename=Co.vcf");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(vcard);
});

// A member's invite link (routes/invitePage.ts): opens a text to Co with the
// code and a greeting filled in. Public, like /co.vcf.
app.get("/i/:code", serveInvitePage);

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

migrationsReady
  .then(() => {
    // One-time startup check for inbound texts that were mid-turn when the
    // process last restarted or crashed (routes/sendblue.ts,
    // 2026-09-17) — after migrations so the columns it reads (payload,
    // finished_at) are guaranteed to exist. Report-only, non-fatal, must
    // never block the server from starting.
    reportUnfinishedTurns().catch((err: any) =>
      console.error("reportUnfinishedTurns failed on startup (non-fatal):", err?.message ?? err),
    );

    registerJobs(io);

    httpServer.listen(port, () => {
      console.log(`Listening on port: ${port}`);
    });
    installGracefulShutdown(httpServer);
  })
  .catch((err) => {
    console.error("Migrations failed — server not starting:", err);
    process.exit(1);
  });
