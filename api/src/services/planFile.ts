// A plan's PDF, held in memory for a few minutes so Sendblue can fetch it to attach to a text
// (the same way voice notes are served, services/voiceNote.ts). The address is a long random
// id nobody can guess; nothing here is listed, and it is gone after the TTL.
import { randomBytes } from "crypto";
import type { Request, Response } from "express";

// A file name that is safe in an address and a header: letters, digits, dots and hyphens, ending .pdf.
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,120}\.pdf$/;
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
// With a name, the address ends in it (/plan-file/<id>/<Name>.pdf), so the attachment arrives under its real name, not a hash.
export function cachePlanFile(buffer: Buffer, name?: string): string {
  if (files.size >= MAX_FILES) {
    const oldest = files.keys().next().value;
    if (oldest) files.delete(oldest);
  }
  const id = randomBytes(24).toString("hex");
  files.set(id, { buffer, expiresAt: Date.now() + PLAN_FILE_TTL_MS });
  const base = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : process.env.API_URL!;
  return name && SAFE_NAME.test(name) ? `${base}/plan-file/${id}/${encodeURIComponent(name)}` : `${base}/plan-file/${id}.pdf`;
}

// The route both servers mount, at /plan-file/:id.pdf and /plan-file/:id/:name (api/src/server.ts and co-test/src/server.ts:
// co-test has its own copies of the media routes, so a route added to only one of them 404s on the other). Only a 48-hex id answers.
export function servePlanFile(req: Request, res: Response): unknown {
  const id = String(req.params.id ?? "");
  const file = /^[a-f0-9]{48}$/.test(id) ? getPlanFile(id) : null;
  if (!file) return res.status(404).send("Not found.");
  res.setHeader("Content-Type", "application/pdf");
  const name = String(req.params.name ?? "");
  res.setHeader("Content-Disposition", `inline; filename="${SAFE_NAME.test(name) ? name : "plan.pdf"}"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(file);
}
