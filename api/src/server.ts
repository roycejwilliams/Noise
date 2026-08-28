import "dotenv/config";
import { initTelemetry } from "./telemetry.js";
initTelemetry();

import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmut from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import { runMigrations } from "./db/migrations.js";
import { registerJobs } from "./jobs/index.js";
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
import { createNotificationsRouter } from "./routes/notifications.js";
import { createReferralsRouter } from "./routes/referrals.js";
import { sendblueRouter } from "./routes/sendblue.js";
import { stripeRouter } from "./routes/stripe.js";
import { createUsersRouter } from "./routes/users.js";
import { bridgeTwilioMediaStream } from "./services/mediaStreamBridge.js";
import { getAudioEntry } from "./services/voiceNote.js";
import { configureSocket } from "./socket/index.js";
import { buildCoVCard } from "./utils/vcard.js";

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT ?? "8080";

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });

//Web socket config
configureSocket(io);

// Twilio's <Connect><Stream> (see services/callTrigger.ts) connects here
// directly — a raw `ws` server, not socket.io, since Twilio Media Streams
// speaks its own plain WebSocket JSON protocol. noServer mode + a manual
// "upgrade" listener so this coexists with socket.io's own upgrade handling
// on the same httpServer without either intercepting the other's path.
const mediaStreamWss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "", `http://${req.headers.host}`);
  if (pathname !== "/media-stream") return; // socket.io's own listener handles /socket.io/
  mediaStreamWss.handleUpgrade(req, socket, head, (ws) => {
    mediaStreamWss.emit("connection", ws, req);
  });
});
// user_id is NOT available yet at upgrade time — Twilio strips query
// parameters from Stream URLs entirely (confirmed live and via Twilio's
// docs), so it travels as a <Parameter> instead (see callTrigger.ts) and
// only arrives once the socket sends its own "start" event.
// bridgeTwilioMediaStream resolves it from there itself.
mediaStreamWss.on("connection", (ws) => {
  bridgeTwilioMediaStream(ws);
});
//Security check to make sure the right tables/columns
// are there when the server starts
runMigrations();
// Stripe webhook needs raw body for signature verification — must run before express.json()
app.use("/payments/webhook", express.raw({ type: "application/json" }));
// Hume's webhook signature is an HMAC over the exact raw body string, same
// reasoning as Stripe's above — a re-serialized/parsed-then-stringified body
// isn't guaranteed byte-identical to what Hume actually signed.
app.use("/co/webhook", express.raw({ type: "application/json" }));

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
app.use("/payments", stripeRouter(io, authenticateToken));
app.use("/sendblue", sendblueRouter(io));

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

registerJobs(io);

httpServer.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
