import type { Request, Response } from "express";
import { buildVersionedVCard, liveVersion, phonesFromEnv, renderCard } from "../utils/vcard.js";
import { noteVersionServed } from "../services/cardReissue.js";

// Cue's contact card, served by api/src/server.ts and co-test/src/server.ts alike. Sendblue fetches media_url before sending, so these
// are public; CO_VCARD_URL points at /co.vcf.

// /co.vcf: the live card (the newest version Royce approved), for onboarding and "send me your card".
export function serveCoVCard(_req: Request, res: Response) {
  const live = liveVersion();
  const vcard = renderCard(live, phonesFromEnv());
  noteVersionServed(live.version);
  res.setHeader("Content-Type", "text/vcard");
  res.setHeader("Content-Disposition", "attachment; filename=Cue.vcf");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(vcard);
}

// /cards/v<n>/Cue.vcf: one version exactly, for a push (services/cardReissue.ts). 404 for a version that isn't approved.
export function serveVersionedVCard(req: Request, res: Response) {
  const n = Number(/^v(\d{1,4})$/.exec(String(req.params.version ?? ""))?.[1] ?? NaN);
  const vcard = Number.isFinite(n) ? buildVersionedVCard(n) : null;
  if (!vcard) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "text/vcard");
  res.setHeader("Content-Disposition", "attachment; filename=Cue.vcf");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(vcard);
}
