// Google connect pages (services/googleAuth.ts). /google/connect/:state is the
// one-time link Co texts; it opens Google's consent screen. /google/callback
// is where Google sends them back. Nothing here shows anyone's data.
import { Router } from "express";
import { consentUrlFor, finishConnect, googleConfigured } from "../services/googleAuth.js";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0b;color:#f2f2f2;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px}h1{font-size:22px;margin:0 0 12px}p{color:#bdbdbd;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

export function createGoogleRouter(): Router {
  const router = Router();

  router.get("/connect/:state", async (req, res) => {
    if (!googleConfigured()) return res.status(404).send(page("Not available yet", "Connecting Google isn't turned on yet."));
    const url = await consentUrlFor(String(req.params.state)).catch(() => null);
    if (!url) return res.status(410).send(page("This link has expired", "Text Co and ask for a new one."));
    res.redirect(302, url);
  });

  router.get("/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code || req.query.error) {
      return res.status(400).send(page("Not connected", "Nothing was connected. You can close this and text Co if you want to try again."));
    }
    const r = await finishConnect(state, code).catch(() => ({ ok: false }));
    if (!r.ok) return res.status(400).send(page("Not connected", "That didn't work, so nothing was connected. Text Co for a new link."));
    res.send(page("Connected", "Co can now see when you're busy (not what the events are) and which emails you sent are still waiting on a reply, and, if you allowed it, save a document you ask for as a Google Doc in your Drive (Co sees only the files it creates). It never sends email or changes your calendar. Text Co \"disconnect Google\" any time."));
  });

  return router;
}
