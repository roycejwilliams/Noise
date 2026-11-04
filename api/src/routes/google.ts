// Google connect pages (services/googleAuth.ts). /google/connect/:state is the
// one-time link Co texts; it opens Google's consent screen. /google/callback
// is where Google sends them back. Nothing here shows anyone's data.
import { Router } from "express";
import { consentUrlFor, finishConnect, googleConfigured } from "../services/googleAuth.js";
import { cueGrantsConfigured, disconnectByToken, finishGrantConnect, grantConsentUrlFor, grantKindOf, type GrantKind } from "../services/cueGrants.js";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0b;color:#f2f2f2;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px}h1{font-size:22px;margin:0 0 12px}p{color:#bdbdbd;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

// The calendar and Docs grants' pages (services/cueGrants.ts; Royce, 2026-10-15: "Grant screen: bare-minimum design, functionality first").
// Plain and readable: what Cue sees, what it never sees, that it's never shared, and how to undo it. COPY: every line here is in the
// PR's Copy section for Royce. Disconnect is a button (a POST), never a bare link: a link preview can't disconnect anyone.
const CAL_STYLE = `body{font-family:-apple-system,system-ui,sans-serif;background:#f6f1e8;color:#1a1414;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px;width:100%}h1{font-size:24px;margin:0 0 14px;font-weight:600}p,li{line-height:1.5;color:#3a3030;font-size:16px}ul{padding-left:20px;margin:0 0 18px}.btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:14px 16px;border-radius:10px;font-size:16px;font-weight:600;border:0;cursor:pointer;text-decoration:none}.go{background:#6b1d2a;color:#fff}.quiet{background:transparent;color:#6b1d2a;border:1px solid #6b1d2a}.small{font-size:14px;color:#6a5f5f}`;
const calPage = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CAL_STYLE}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
export const CALENDAR_GRANT_COPY = {
  title: "Connect your calendar",
  sees: "Cue will see when you're busy and when you're free. That's all.",
  never: ["Never what an event is, where it is, or who it's with.", "Never shared with anyone, including other members.", "Cue never adds, moves or changes anything on your calendar."],
  undo: "You can undo it any time: text Cue \"disconnect my calendar\", or tap Disconnect on the next page.",
  go: "Continue to Google",
  doneTitle: "Calendar connected",
  done: "Free and busy only. Cue will only suggest a plan when your calendar shows you're free.",
  disconnect: "Disconnect",
  sureTitle: "Disconnect your calendar?",
  sure: "Cue will stop seeing when you're busy, and what it had is deleted.",
  goneTitle: "Disconnected",
  gone: "Cue no longer sees your calendar, and what it had is deleted.",
  notConnected: "There's no calendar connected on this link anymore.",
  off: "Connecting your calendar isn't turned on yet.",
} as const;
const GRANT_COPY: Record<GrantKind, typeof CALENDAR_GRANT_COPY> = { calendar: CALENDAR_GRANT_COPY };
const GRANT_KINDS = Object.keys(GRANT_COPY) as GrantKind[];
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createGoogleRouter(): Router {
  const router = Router();

  router.get("/connect/:state", async (req, res) => {
    // A calendar or Docs link shows its grant screen first; Google's screen only after they choose to go on.
    const kind = await grantKindOf(String(req.params.state)).catch(() => null);
    if (kind && kind !== "google") {
      const C = GRANT_COPY[kind];
      if (!cueGrantsConfigured()) return res.status(404).send(calPage("Not available yet", `<p>${esc(C.off)}</p>`));
      return res.send(calPage(C.title, `<p>${esc(C.sees)}</p><ul>${C.never.map((n) => `<li>${esc(n)}</li>`).join("")}</ul><p class="small">${esc(C.undo)}</p><a class="btn go" href="/google/connect/${encodeURIComponent(String(req.params.state))}/go">${esc(C.go)}</a>`));
    }
    // An expired or used link reads as nothing: Cue's own page, never the old one (review of the grants work: it said "Text Co").
    if (!kind) return res.status(410).send(calPage("This link has expired", "<p>Text Cue and ask for a new one.</p>"));
    if (!googleConfigured()) return res.status(404).send(page("Not available yet", "Connecting Google isn't turned on yet."));
    const url = await consentUrlFor(String(req.params.state)).catch(() => null);
    if (!url) return res.status(410).send(page("This link has expired", "Text Cue and ask for a new one."));
    res.redirect(302, url);
  });

  router.get("/connect/:state/go", async (req, res) => {
    const kind = await grantKindOf(String(req.params.state)).catch(() => null);
    if (!kind || kind === "google") return res.status(410).send(calPage("This link has expired", "<p>Text Cue and ask for a new one.</p>"));
    if (!cueGrantsConfigured()) return res.status(404).send(calPage("Not available yet", `<p>${esc(GRANT_COPY[kind].off)}</p>`));
    const url = await grantConsentUrlFor(kind, String(req.params.state)).catch(() => null);
    if (!url) return res.status(410).send(calPage("This link has expired", "<p>Text Cue and ask for a new one.</p>"));
    res.redirect(302, url);
  });

  // The one-tap disconnect, one path per grant: a page with one button; the POST does it, and only for that grant.
  for (const kind of GRANT_KINDS) {
    const C = GRANT_COPY[kind];
    router.get(`/${kind}/disconnect/:token`, (req, res) => {
      res.send(calPage(C.sureTitle, `<p>${esc(C.sure)}</p><form method="post"><button class="btn go" type="submit">${esc(C.disconnect)}</button></form>`));
    });
    router.post(`/${kind}/disconnect/:token`, async (req, res) => {
      const done = await disconnectByToken(String(req.params.token), fetch, kind).catch(() => null);
      res.send(calPage(done ? C.goneTitle : "Already disconnected", `<p>${esc(done ? C.gone : C.notConnected)}</p>`));
    });
  }

  router.get("/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code || req.query.error) {
      return res.status(400).send(page("Not connected", "Nothing was connected. You can close this and text Cue if you want to try again."));
    }
    // A calendar or Docs grant goes its own way (services/cueGrants.ts): its own scope and token, and its page has the one-tap disconnect.
    const kind = await grantKindOf(state).catch(() => null);
    if (kind && kind !== "google") {
      const c = await finishGrantConnect(kind, state, code).catch(() => ({ ok: false }) as { ok: boolean; revoke?: string });
      if (!c.ok || !c.revoke) return res.status(400).send(calPage("Not connected", "<p>That didn't work, so nothing was connected. Text Cue for a new link.</p>"));
      const C = GRANT_COPY[kind];
      return res.send(calPage(C.doneTitle, `<p>${esc(C.done)}</p><p class="small">${esc(C.undo.replace(", or tap Disconnect on the next page", ""))}</p><a class="btn quiet" href="/google/${kind}/disconnect/${encodeURIComponent(c.revoke)}">${esc(C.disconnect)}</a>`));
    }
    const r = await finishConnect(state, code).catch(() => ({ ok: false }));
    if (!r.ok) return res.status(400).send(page("Not connected", "That didn't work, so nothing was connected. Text Cue for a new link."));
    res.send(page("Connected", "Cue can now see which emails you sent are still waiting on a reply (who, subject and date, never the message). It never sends email. Text Cue \"disconnect Google\" any time."));
  });

  return router;
}
