// A plan's PDF, held in memory for a few minutes so Sendblue can fetch it to attach to a text
// (the same way voice notes are served, services/voiceNote.ts). The address is a long random
// id nobody can guess; nothing here is listed, and it is gone after the TTL.
import { randomBytes } from "crypto";
import type { Request, Response } from "express";

export const PLAN_FILE_TTL_MS = 10 * 60 * 1000;
const MAX_FILES = 40;
const files = new Map<string, { buffer: Buffer; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [id, f] of files) if (f.expiresAt < now) files.delete(id);
}, PLAN_FILE_TTL_MS).unref?.();

export function getPlanFile(id: string): Buffer | null {
  const f = files.get(id);
  if (!f || f.expiresAt < Date.now()) return null;
  return f.buffer;
}

// The public address Sendblue fetches, e.g. https://test.copatible.com/plan-file/<id>.pdf
export function cachePlanFile(buffer: Buffer): string {
  if (files.size >= MAX_FILES) {
    const oldest = files.keys().next().value;
    if (oldest) files.delete(oldest);
  }
  const id = randomBytes(24).toString("hex");
  files.set(id, { buffer, expiresAt: Date.now() + PLAN_FILE_TTL_MS });
  const base = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : process.env.API_URL!;
  return `${base}/plan-file/${id}.pdf`;
}

// The route both servers mount (api/src/server.ts and co-test/src/server.ts: co-test has its own copies of the
// media routes, so a route added to only one of them 404s on the other). Only a 48-hex id answers.
export function servePlanFile(req: Request, res: Response): unknown {
  const id = String(req.params.id ?? "");
  const file = /^[a-f0-9]{48}$/.test(id) ? getPlanFile(id) : null;
  if (!file) return res.status(404).send("Not found.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=plan.pdf");
  res.setHeader("Cache-Control", "no-store");
  return res.send(file);
}
