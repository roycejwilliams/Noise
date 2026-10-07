// The host's read-only partner readout (services/partnerReadoutSend.ts). /readout/:token is the link the team gives the host once
// they've approved it; /readout/:token.json is the same readout as data, for a host who wants it in their own tools. Nothing here
// writes, and nothing here is reachable without a live link: an unknown, withdrawn or expired link is a plain 404.
import { Router } from "express";
import { readoutByToken } from "../services/partnerReadoutSend.js";

const gone = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available</title></head><body style="font-family:-apple-system,system-ui,sans-serif;padding:24px">This readout isn't available.</body></html>`;

export function createReadoutRouter(): Router {
  const router = Router();
  router.get("/:token", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
    const raw = String(req.params.token);
    const json = raw.endsWith(".json");
    const r = await readoutByToken(json ? raw.slice(0, -5) : raw).catch(() => null);
    if (!r) return json ? res.status(404).json({ error: "not available" }) : res.status(404).send(gone);
    if (json) return res.json({ headline: r.headline, lines: r.lines, note: r.note });
    res.type("html").send(r.html);
  });
  return router;
}
