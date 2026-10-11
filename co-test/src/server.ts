import "dotenv/config";
import { initTelemetry } from "./telemetry.js";
initTelemetry();

import cookieParser from "cookie-parser";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { Server } from "socket.io";
import pool from "../../api/src/db/db.js";
import { runMigrations } from "../../api/src/db/migrations.js";
import { buildCoVCard } from "../../api/src/utils/vcard.js";
import { getAudioEntry } from "../../api/src/services/voiceNote.js";
import { servePlanFile } from "../../api/src/services/planFile.js";
import { runTestMigrations } from "./db/testMigrations.js";
import { configureCoTestSocket } from "./socket/index.js";
import apiRouter from "./routes/api.js";
import checklistRouter from "./routes/checklist.js";
import loginRouter from "./routes/login.js";
import phoneRouter from "./routes/phone.js";
import { requireTesterLoginApi, requireTesterLoginPage } from "./middleware/requireTesterLogin.js";
import { createCoRouter } from "../../api/src/routes/co.js";
import { createCallLlmRouter } from "../../api/src/routes/callLlm.js";
import { reportUnfinishedTurns, sendblueRouter } from "../../api/src/routes/sendblue.js";
import { serveInvitePage } from "../../api/src/routes/invitePage.js";
import { createLumaRouter } from "../../api/src/routes/luma.js";
import { createMoRouter } from "../../api/src/routes/mo.js";
import { createGoogleRouter } from "../../api/src/routes/google.js";
import { createReadoutRouter } from "../../api/src/routes/readout.js";
import { createCoPageRouter } from "../../api/src/routes/coPage.js";
import { registerJobs } from "../../api/src/jobs/index.js";
import { installGracefulShutdown, trackRequests } from "../../api/src/services/shutdown.js";
import { authLimiter, limiter } from "../../api/src/middleware/rateLimiter.js";

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
  // Awaited (2026-09-22) — the same fix api/src/server.ts got on 2026-09-17:
  // jobs and webhooks started before migrations finished, so a cron on a
  // fresh deploy could query a table or column that didn't exist yet.
  await runMigrations();
  runTestMigrations();

  const app = express();
  // Behind Railway's proxy: the client's address is the first hop, so the rate limits below count per visitor, not per proxy.
  app.set("trust proxy", 1);
  app.use(trackRequests); // a restart waits for requests mid-flight (services/shutdown.ts)
  // ElevenLabs signs the post-call webhook over the exact raw body
  // (api/src/services/elevenLabsCalls.ts): a parsed-then-stringified body isn't
  // byte-identical. Must run before express.json() below; mirrors api/src/server.ts.
  app.use("/co/el/post-call", express.raw({ type: "application/json", limit: "5mb" }));
  // The agent sends the whole conversation to its tools; the default 100kb JSON limit would reject a long call before the route runs.
  app.use("/co/el/tool", express.json({ limit: "2mb" }));
  // The call brain's endpoint (api/src/routes/callLlm.ts): a request per turn of every call. Mirrors api/src/server.ts.
  app.use("/co/el/llm", express.json({ limit: "4mb" }), createCallLlmRouter());
  // Luma's webhook signature is the same "HMAC over the raw body" shape as
  // ElevenLabs' above — see validateLumaWebhook in api/src/routes/luma.ts. This
  // route was never mounted at all in co-test (confirmed live, 2026-09-02:
  // LUMA_WEBHOOK_SECRET/LUMA_API_KEY/LUMA_WEBHOOKS are all already set here,
  // so this was meant to be live), meaning every real Luma delivery — guest
  // scoring, event updates/cancellations, calendar subscriber reach-outs —
  // has been 404ing silently since co-test became the only running server
  // for this environment.
  app.use("/luma/webhook", express.raw({ type: "application/json" }));
  // Resend signs the raw body of Mo's inbound email posts (routes/mo.ts).
  app.use("/mo/email/inbound", express.raw({ type: "application/json" }));
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


  app.get("/health", (_req, res) => res.status(200).send("ok"));

  // Rate limits (security review, 2026-10-11): co-test had none. The public pages anyone can open without signing in are limited
  // (100 per 15 minutes per address), and starting a sign-in to 10. The signed-in dashboard polls every few seconds and is behind
  // its login, and webhooks (Sendblue, Twilio, ElevenLabs, Luma, Resend) and the media Twilio and Sendblue fetch (/audio,
  // /plan-file, /co.vcf) are signed or unguessable and arrive in bursts from a few provider addresses: none of those are limited.
  app.use(["/i", "/readout", "/google", "/mo/unsubscribe", "/d"], limiter);
  app.use("/api/login/start", authLimiter);

  // Serves Co's vCard so Sendblue can attach it to the real onboarding
  // "intro" text (see api/src/routes/sendblue.ts's identity_captured/
  // intake_asked branch, which calls otpActions.ts's sendSMS — that function
  // conditionally attaches media_url only when CO_VCARD_URL is set, which
  // needs to point here). Mirrors production's identical route in
  // api/src/server.ts.
  app.get("/co.vcf", (_req, res) => {
    const phone = process.env.SENDBLUE_PHONE_NUMBER ?? "";
    const vcard = buildCoVCard(phone);
    res.setHeader("Content-Type", "text/vcard");
    res.setHeader("Content-Disposition", "attachment; filename=Co.vcf");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(vcard);
  });

  // A member's invite link: mirrors production's identical route in
  // api/src/server.ts (api/src/routes/invitePage.ts).
  app.get("/i/:code", serveInvitePage);

  // Serves generated voice-note audio (ElevenLabs) — mirrors
  // production's identical route in api/src/server.ts. Needed here since
  // Twilio's <Play> requires a fetchable URL, not inline audio data.
  app.get("/audio/:id", (req, res) => {
    const entry = getAudioEntry(req.params.id);
    if (!entry) return res.status(404).send("Not found.");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(entry.buffer);
  });

  // A plan's PDF for Sendblue to attach to a text (services/planFile.ts): the same route api/src/server.ts mounts.
  // co-test keeps its own copies of the media routes, so it has to be added here too.
  app.get("/plan-file/:id.pdf", servePlanFile);
  app.get("/plan-file/:id/:name", servePlanFile);

  // The actual product routes (ElevenLabs call webhooks, Twilio call-status,
  // inbound-call TwiML, and the Sendblue text-conversation webhook) —
  // these used to be co-test's own separate implementation
  // (routes/webhooks.ts, deleted); that logic now lives in api/src and this
  // is what actually serves it for this deployment, since no separate
  // process runs api/src/server.ts on this branch/environment. Same
  // factory functions, same io instance pattern api's own server uses.
  app.use("/co", createCoRouter(io));
  // Google connect pages (api/src/routes/google.ts): never mounted on co-test before, so the connect link 404ed here. Mirrors api/src/server.ts.
  app.use("/google", createGoogleRouter());
  // The host's read-only partner readout, by an approved link only. Mirrors api/src/server.ts.
  app.use("/readout", createReadoutRouter());
  // A Co page, by its unguessable link only; never listed (api/src/routes/coPage.ts). Mirrors api/src/server.ts.
  app.use("/d", createCoPageRouter());
  app.use("/sendblue", sendblueRouter(io));
  app.use("/luma", createLumaRouter());
  // Mo's email opt-out link and inbound email replies (2026-09-25: Mo runs
  // here, so these have to be served here too).
  app.use("/mo", createMoRouter());

  // Tool-access login (phone + OTP) — see services/testerAuth.ts. Public by
  // definition, it's the thing that grants access to everything below.
  app.use("/api/login", loginRouter);

  app.use("/api", apiRouter);
  app.use("/api/phone", phoneRouter);
  // Dashboard APIs — gated on the same tool-access login as the rest of the
  // sandbox (see requireTesterLogin.ts) now that there's a single sign-in
  // for the whole tool, not a separate team-only password.
  app.use("/api/checklist", requireTesterLoginApi, checklistRouter);

  // Root is the login form itself now — not the call page. A tester who's
  // already logged in gets redirected client-side (see login.ts checking
  // /api/login/status on load), so this never becomes an extra click for a
  // returning tester.
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));

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

  // Every cron (event surfacing sweep, ask check-ins, memory compaction,
  // proactive calls, etc.) lives in api/src/jobs/index.ts, but co-test never
  // called it — this service has been running with zero background jobs
  // since it stopped running its own separate webhook implementation, since
  // nothing here ever wired the shared jobs module in. Confirmed live,
  // 2026-09-01: 9 open asks sitting with last_surfaced_at still NULL days
  // after creation, and manually replaying the sweep's own logic against
  // the real DB worked instantly with no errors — so the job logic was
  // fine, it just never ran.
  // Texts that were mid-reply when this process last stopped: tell the
  // member instead of leaving them on "Read" (api/src/routes/sendblue.ts).
  reportUnfinishedTurns().catch((err: any) =>
    console.error("reportUnfinishedTurns failed on startup (non-fatal):", err?.message ?? err),
  );
  registerJobs(io);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  httpServer.listen(port, () => console.log(`co-test listening on ${port}`));
  installGracefulShutdown(httpServer);
}

main().catch((err) => {
  console.error("co-test failed to start:", err);
  process.exit(1);
});
