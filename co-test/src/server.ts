import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import pool from "../../api/src/db/db.js";
import { runMigrations } from "../../api/src/db/migrations.js";
import { runTestMigrations } from "./db/testMigrations.js";
import apiRouter from "./routes/api.js";
import checklistRouter from "./routes/checklist.js";
import phoneRouter from "./routes/phone.js";
import webhooksRouter from "./routes/webhooks.js";

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

  app.get("/health", (_req, res) => res.status(200).send("ok"));
  app.use("/api", apiRouter);
  app.use("/api/phone", phoneRouter);
  app.use("/api/checklist", checklistRouter);
  // Mounted at root — these paths (/sendblue/webhook, /co/call-status,
  // /co/webhook) intentionally mirror production's exactly. See webhooks.ts.
  app.use(webhooksRouter);

  app.get(["/", "/call"], (_req, res) => res.sendFile(path.join(publicDir, "call.html")));
  app.get("/call/:sessionId/results", (_req, res) =>
    res.sendFile(path.join(publicDir, "results.html")),
  );
  app.get("/prompt", (_req, res) => res.sendFile(path.join(publicDir, "prompt.html")));
  app.get("/phone", (_req, res) => res.sendFile(path.join(publicDir, "phone.html")));
  app.get("/checklist", (_req, res) => res.sendFile(path.join(publicDir, "checklist.html")));

  app.use(express.static(publicDir));

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => console.log(`co-test listening on ${port}`));
}

main().catch((err) => {
  console.error("co-test failed to start:", err);
  process.exit(1);
});
