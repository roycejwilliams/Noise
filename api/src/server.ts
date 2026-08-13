import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import helmut from "helmet";
import { createServer } from "http";
import cron from "node-cron";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import pool from "./db/db.js";
import { runMigrations } from "./db/migrations.js";
import { registerJobs } from "./jobs/index.js";
import { bridgeTwilioMediaStream } from "./services/mediaStreamBridge.js";
import sendblue from "./services/sendblue.js";
import { authenticateToken } from "./middleware/auth.js";
import { corsOptions } from "./middleware/cors.js";
import { errorHandler } from "./middleware/errorHandler.js";
import {
  applicationLimiter,
  limiter,
} from "./middleware/rateLimiter.js";
import { createAiRouter } from "./routes/ai.js";
import applicationsRouter from "./routes/applications.js";
import { createAuthRouter } from "./routes/auth.js";
import { createCirclesRouter } from "./routes/circles.js";
import { createCoRouter } from "./routes/co.js";
import { createInvitesRouter } from "./routes/invites.js";
import { createMomentsRouter } from "./routes/moments.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createReferralsRouter } from "./routes/referrals.js";
import { sendblueRouter } from "./routes/sendblue.js";
import { stripeRouter } from "./routes/stripe.js";
import { createUsersRouter } from "./routes/users.js";
import { getAudioEntry } from "./services/voiceNote.js";
import { configureSocket } from "./socket/index.js";

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT ?? "8080";

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });

//Web socket config
configureSocket(io);

// Twilio's <Connect><Stream> (see co.ts/jobs/index.ts) connects here
// directly — a raw `ws` server, not socket.io, since Twilio Media Streams
// speaks its own plain WebSocket JSON protocol. noServer mode + a manual
// "upgrade" listener so this coexists with socket.io's own upgrade handling
// on the same httpServer without either intercepting the other's path.
// user_id is NOT available yet at upgrade time — Twilio strips query
// parameters from Stream URLs entirely (confirmed live against co-test, and
// via Twilio's own docs), so it travels as a <Parameter> instead and only
// arrives once the socket sends its own "start" event.
// bridgeTwilioMediaStream resolves it from there itself.
const mediaStreamWss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "", `http://${req.headers.host}`);
  if (pathname !== "/media-stream") return; // socket.io's own listener handles /socket.io/
  mediaStreamWss.handleUpgrade(req, socket, head, (ws) => {
    mediaStreamWss.emit("connection", ws, req);
  });
});
mediaStreamWss.on("connection", (ws) => {
  bridgeTwilioMediaStream(ws);
});

//Security check to make sure the right tables/columns
// are there when the server starts
runMigrations();
// Stripe webhook needs raw body for signature verification — must run before express.json()
app.use("/payments/webhook", express.raw({ type: "application/json" }));
// Hume's webhook signature is an HMAC over the exact raw body string, same
// reasoning as Stripe above — a re-serialized/parsed-then-stringified body
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
app.use("/circles", createCirclesRouter(io, authenticateToken));
app.use(createMomentsRouter(io, authenticateToken));
app.use("/invites", createInvitesRouter(io, authenticateToken));
app.use("/notifications", createNotificationsRouter(authenticateToken));
app.use("/ai", createAiRouter(io, authenticateToken));
app.use("/referrals", createReferralsRouter(authenticateToken));
app.use("/co", createCoRouter(io));
app.use("/payments", stripeRouter(io, authenticateToken));
app.use("/sendblue", sendblueRouter(io));

// Serve Co's vCard so Sendblue can attach it to the circle_placement iMessage.
// Sendblue fetches media_url before sending — this endpoint must be publicly reachable
// (via ngrok in dev, or Railway in prod). CO_VCARD_URL points here.
app.get("/co.vcf", (_req, res) => {
  const phone = process.env.SENDBLUE_PHONE_NUMBER ?? "";
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Co",
    "ORG:CoPatible",
    `TEL:${phone}`,
    "URL:https://app.copatible.com",
    "NOTE:Your life concierge.",
    "END:VCARD",
  ].join("\r\n");
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

registerJobs();

// Every 30 minutes — auto-approve circles Keana hasn't responded to within 4 hours
cron.schedule("*/30 * * * *", async () => {
  try {
    const staleCircles = await pool.query(
      `SELECT c.id, c.circle_name, c.owner_id
       FROM circles c
       WHERE c.status = 'pending_approval'
         AND c.keana_notified_at IS NOT NULL
         AND c.keana_notified_at < NOW() - INTERVAL '4 hours'`,
    );

    for (const circle of staleCircles.rows) {
      await pool.query(
        `UPDATE circles SET status = 'active' WHERE id = $1`,
        [circle.id],
      );

      const membersResult = await pool.query(
        `SELECT u.id, u.first_name, u.phone_number, cp.city, cp.life_chapters
         FROM circle_members cm
         JOIN users u ON cm.member_id = u.id
         LEFT JOIN co_profiles cp ON cp.user_id = cm.member_id
         WHERE cm.circle_id = $1`,
        [circle.id],
      );
      const members = membersResult.rows;
      const memberCount = members.length;
      const city = members.find((m: any) => m.city)?.city ?? "your city";
      const chapter = (members.find((m: any) => m.life_chapters?.length)?.life_chapters?.[0] ?? "").replace(/_/g, " ");

      const momentResult = await pool.query(
        `SELECT id FROM moments WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [circle.id],
      );
      const momentId = momentResult.rows[0]?.id ?? null;

      for (const member of members) {
        if (process.env.CO_VCARD_URL) {
          const vcardCheck = await pool.query(
            `SELECT id FROM co_memories WHERE user_id = $1 AND content = 'Co vCard sent to user — contact saved' LIMIT 1`,
            [member.id],
          );
          if (!vcardCheck.rows[0]) {
            try {
              const { text: vcardMsg } = await generateText({
                model: anthropic("claude-haiku-4-5-20251001"),
                prompt: `You are Co, texting ${member.first_name} for the first time. Ask them to save your contact, briefly, in your own words. No exclamation points, no em dashes. 1 sentence.`,
              });
              await sendblue.messages.send({
                number: member.phone_number,
                content: vcardMsg,
                media_url: process.env.CO_VCARD_URL,
                from_number: process.env.SENDBLUE_PHONE_NUMBER!,
              });
              await pool.query(
                `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', 'Co vCard sent to user — contact saved')`,
                [member.id],
              );
              await new Promise((resolve) => setTimeout(resolve, 3000));
            } catch (vcardErr: any) {
              console.error("Auto-approval vCard send failed (non-fatal):", vcardErr?.message ?? vcardErr);
            }
          }
        }

        // Individual thread, same as the manual-approval path in
        // sendblue.ts — never mention headcount, this isn't a group blast.
        let placementMsg = `I placed you in a circle. Same chapter, same city.${momentId ? `\n\nhttps://app.copatible.com/moments/${momentId}` : ""}`;
        try {
          const { text } = await generateText({
            model: anthropic("claude-sonnet-4-6"),
            prompt: `You are Co. You just placed ${member.first_name} in a circle with people in the same ${chapter || "chapter of life"}, based in ${city}. Text them the news like it means something, not like a system notification. Never mention how many people are in it — this is their own thread, not a group announcement. No exclamation points, no em dashes. 1-2 sentences.`,
          });
          placementMsg = momentId ? `${text}\n\nhttps://app.copatible.com/moments/${momentId}` : text;
        } catch (genErr: any) {
          console.error("Auto-approval placement message generation failed, using fallback (non-fatal):", genErr?.message ?? genErr);
        }

        try {
          await sendblue.messages.send({
            number: member.phone_number,
            content: placementMsg,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error(`Auto-approval placement message failed for ${member.id}:`, smsErr?.message ?? smsErr);
        }

        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'placement', $2)`,
          [member.id, `Co placed user in circle ${circle.id} — auto-approved after 4 hours`],
        );

        io.to(`user:${member.id}`).emit("circle:placed", {
          circle_id: circle.id,
          circle_name: circle.circle_name,
          member_count: memberCount,
          city,
          chapter,
        });
      }

      try {
        await sendblue.messages.send({
          number: process.env.KEANA_PHONE_NUMBER!,
          content: `Circle ${circle.id} auto-approved after 4 hours. ${memberCount} members placed. No action needed.`,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (keanaErr: any) {
        console.error("Auto-approval Keana notify failed (non-fatal):", keanaErr?.message ?? keanaErr);
      }
    }
  } catch (err) {
    console.error("Auto-approval cron error:", err);
  }
});

httpServer.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
