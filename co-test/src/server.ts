import "dotenv/config";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { Server } from "socket.io";
import pool from "../../api/src/db/db.js";
import { runMigrations } from "../../api/src/db/migrations.js";
import { runTestMigrations } from "./db/testMigrations.js";
import { configureCoTestSocket } from "./socket/index.js";
import apiRouter from "./routes/api.js";
import checklistRouter from "./routes/checklist.js";
import circlesTestRouter from "./routes/circlesTest.js";
import phoneRouter from "./routes/phone.js";
import { createWebhooksRouter } from "./routes/webhooks.js";

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

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false })); // Twilio status callbacks are form-encoded

  const publicDir = path.join(process.cwd(), "public");

  // Real-time push (live transcript/coverage-check events during a real
  // Twilio-bridged call) — same Socket.IO room pattern production uses
  // (api/src/socket/index.ts), minus the JWT auth co-test has never had.
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  configureCoTestSocket(io);

  app.get("/health", (_req, res) => res.status(200).send("ok"));

  // Serves Co's vCard so Sendblue can attach it to the real onboarding
  // "intro" text (see webhooks.ts's contact_verified branch, which calls
  // otpActions.ts's sendSMS — that function conditionally attaches media_url
  // only when CO_VCARD_URL is set, which needs to point here). Mirrors
  // production's identical route in api/src/server.ts.
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

  app.use("/api", apiRouter);
  app.use("/api/phone", phoneRouter);
  app.use("/api/checklist", checklistRouter);
  app.use("/api/circles-test", circlesTestRouter);
  // Mounted at root — these paths (/sendblue/webhook, /co/call-status,
  // /co/webhook) intentionally mirror production's exactly. See webhooks.ts.
  app.use(createWebhooksRouter(io));

  app.get(["/", "/call"], (_req, res) => res.sendFile(path.join(publicDir, "call.html")));
  app.get("/call/:sessionId/results", (_req, res) =>
    res.sendFile(path.join(publicDir, "results.html")),
  );
  app.get("/prompt", (_req, res) => res.sendFile(path.join(publicDir, "prompt.html")));
  app.get("/phone", (_req, res) => res.sendFile(path.join(publicDir, "phone.html")));
  app.get("/checklist", (_req, res) => res.sendFile(path.join(publicDir, "checklist.html")));

  app.use(express.static(publicDir));

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  httpServer.listen(port, () => console.log(`co-test listening on ${port}`));
}

main().catch((err) => {
  console.error("co-test failed to start:", err);
  process.exit(1);
});
