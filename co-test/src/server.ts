import "dotenv/config";
import { initTelemetry } from "./telemetry.js";
initTelemetry();

import cookieParser from "cookie-parser";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { Server } from "socket.io";
import { WebSocketServer } from "ws";
import pool from "../../api/src/db/db.js";
import { runMigrations } from "../../api/src/db/migrations.js";
import { buildCoVCard } from "../../api/src/utils/vcard.js";
import { runTestMigrations } from "./db/testMigrations.js";
import { configureCoTestSocket } from "./socket/index.js";
import apiRouter from "./routes/api.js";
import checklistRouter from "./routes/checklist.js";
import circlesTestRouter from "./routes/circlesTest.js";
import dynamicPlacementTestRouter from "./routes/dynamicPlacementTest.js";
import loginRouter from "./routes/login.js";
import phoneRouter from "./routes/phone.js";
import { createWebhooksRouter } from "./routes/webhooks.js";
import { registerPostCallFollowUpJob } from "./jobs/postCallFollowUpJob.js";
import { registerScheduledCallJob } from "./jobs/scheduledCallJob.js";
import { requireTesterLoginApi, requireTesterLoginPage } from "./middleware/requireTesterLogin.js";
import { bridgeTwilioMediaStream } from "./services/mediaStreamBridge.js";

// A fresh Railway Postgres has none of brew_dev's tables yet — runMigrations()
// (imported unchanged from api/) only ever does ALTER TABLE / CREATE TABLE IF
// NOT EXISTS against tables it assumes already exist, so the base schema has
// to be laid down once first. init.sql is a schema-only pg_dump of brew_dev
// (no data), applied only when the `users` table isn't there yet.
async function ensureBaseSchema(): Promise<void> {
  const { rows } = await pool.query(`SELECT to_regclass('public.users') AS exists`);
  if (rows[0].exists) return;

  console.log("No base schema found — initializing from init.sql");
  const initSql = fs.readFileSync(path.join(process.cwd(), "src/db/init.sql"), "utf-8");
  await pool.query(initSql);
  console.log("Base schema initialized");
}

async function main() {
  await ensureBaseSchema();
  runMigrations();
  runTestMigrations();
  registerPostCallFollowUpJob();
  registerScheduledCallJob();

  const app = express();
  // Hume's webhook signature is an HMAC over the exact raw body string, so
  // this needs to run before the global express.json() below — a
  // re-serialized/parsed-then-stringified body isn't guaranteed
  // byte-identical to what Hume actually signed (same reasoning as
  // production's Stripe webhook, api/src/server.ts).
  app.use("/co/webhook", express.raw({ type: "application/json" }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false })); // Twilio status callbacks are form-encoded
  app.use(cookieParser());

  const publicDir = path.join(process.cwd(), "public");

  // Real-time push (live transcript/coverage-check events during a real
  // Twilio-bridged call) — same Socket.IO room pattern production uses
  // (api/src/socket/index.ts), minus the JWT auth co-test has never had.
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  configureCoTestSocket(io);

  // Twilio's <Connect><Stream> (see callTrigger.ts) connects here directly —
  // a raw `ws` server, not socket.io, since Twilio Media Streams speaks its
  // own plain WebSocket JSON protocol. noServer mode + a manual "upgrade"
  // listener so this coexists with socket.io's own upgrade handling on the
  // same httpServer without either intercepting the other's path.
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
  // only arrives once the socket sends its own "start" event. bridgeTwilioMediaStream
  // resolves it from there itself.
  mediaStreamWss.on("connection", (ws) => {
    bridgeTwilioMediaStream(ws);
  });

  app.get("/health", (_req, res) => res.status(200).send("ok"));

  // Serves Co's vCard so Sendblue can attach it to the real onboarding
  // "intro" text (see webhooks.ts's identity_captured/intake_asked branch,
  // which calls otpActions.ts's sendSMS — that function conditionally attaches media_url
  // only when CO_VCARD_URL is set, which needs to point here). Mirrors
  // production's identical route in api/src/server.ts.
  app.get("/co.vcf", (_req, res) => {
    const phone = process.env.SENDBLUE_PHONE_NUMBER ?? "";
    const vcard = buildCoVCard(phone);
    res.setHeader("Content-Type", "text/vcard");
    res.setHeader("Content-Disposition", "attachment; filename=Co.vcf");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(vcard);
  });

  // Tool-access login (phone + OTP) — see services/testerAuth.ts. Public by
  // definition, it's the thing that grants access to everything below.
  app.use("/api/login", loginRouter);

  app.use("/api", apiRouter);
  app.use("/api/phone", phoneRouter);
  // Dashboard APIs — gated on the same tool-access login as the rest of the
  // sandbox (see requireTesterLogin.ts) now that there's a single sign-in
  // for the whole tool, not a separate team-only password.
  app.use("/api/checklist", requireTesterLoginApi, checklistRouter);
  app.use("/api/circles-test", requireTesterLoginApi, circlesTestRouter);
  app.use("/api/dynamic-test", requireTesterLoginApi, dynamicPlacementTestRouter);
  // Mounted at root — these paths (/sendblue/webhook, /co/call-status,
  // /co/webhook) intentionally mirror production's exactly. See webhooks.ts.
  app.use(createWebhooksRouter(io));

  // Root is the login form itself now — not the call page. A tester who's
  // already logged in gets redirected client-side (see login.ts checking
  // /api/login/status on load), so this never becomes an extra click for a
  // returning tester.
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));

  app.get("/call", requireTesterLoginPage, (_req, res) => res.sendFile(path.join(publicDir, "call.html")));
  app.get("/call/:sessionId/results", requireTesterLoginPage, (_req, res) =>
    res.sendFile(path.join(publicDir, "results.html")),
  );
  app.get("/prompt", requireTesterLoginPage, (_req, res) => res.sendFile(path.join(publicDir, "prompt.html")));
  app.get("/phone", requireTesterLoginPage, (_req, res) => res.sendFile(path.join(publicDir, "phone.html")));
  app.get("/checklist", requireTesterLoginPage, (_req, res) => res.sendFile(path.join(publicDir, "checklist.html")));

  // Static assets (JS/CSS) still need to serve out of public/, but the HTML
  // pages above must only ever be reachable through the gated routes — a
  // bare static mount would also serve e.g. /call.html directly by literal
  // filename, walking straight around requireTesterLoginPage.
  app.use((req, res, next) => (req.path.endsWith(".html") ? res.status(404).end() : next()));
  app.use(express.static(publicDir));

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  httpServer.listen(port, () => console.log(`co-test listening on ${port}`));
}

main().catch((err) => {
  console.error("co-test failed to start:", err);
  process.exit(1);
});
