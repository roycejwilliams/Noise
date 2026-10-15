// Google connect pages (services/googleAuth.ts). /google/connect/:state is the
// one-time link Co texts; it opens Google's consent screen. /google/callback
// is where Google sends them back. Nothing here shows anyone's data.
import { Router } from "express";
import { consentUrlFor, finishConnect, googleConfigured } from "../services/googleAuth.js";
import { calendarConsentUrlFor, disconnectByToken, finishCalendarConnect, grantKindOf } from "../services/calendarGrant.js";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0b;color:#f2f2f2;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px}h1{font-size:22px;margin:0 0 12px}p{color:#bdbdbd;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

// The calendar grant's pages (services/calendarGrant.ts; Royce, 2026-10-15: "Grant screen: bare-minimum design, functionality first").
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
  done: "Free and busy only. Cue will only hold time for you when your calendar shows you're free.",
  disconnect: "Disconnect",
  sureTitle: "Disconnect your calendar?",
  sure: "Cue will stop seeing when you're busy, and what it had is deleted.",
  goneTitle: "Disconnected",
  gone: "Cue no longer sees your calendar, and what it had is deleted.",
} as const;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createGoogleRouter(): Router {
  const router = Router();

  router.get("/connect/:state", async (req, res) => {
    if (!googleConfigured()) return res.status(404).send(page("Not available yet", "Connecting Google isn't turned on yet."));
    // A calendar link shows the grant screen first; Google's screen only after they choose to go on.
    if ((await grantKindOf(String(req.params.state)).catch(() => null)) === "calendar") {
      const C = CALENDAR_GRANT_COPY;
      return res.send(calPage(C.title, `<p>${esc(C.sees)}</p><ul>${C.never.map((n) => `<li>${esc(n)}</li>`).join("")}</ul><p class="small">${esc(C.undo)}</p><a class="btn go" href="/google/connect/${encodeURIComponent(String(req.params.state))}/go">${esc(C.go)}</a>`));
    }
    const url = await consentUrlFor(String(req.params.state)).catch(() => null);
    if (!url) return res.status(410).send(page("This link has expired", "Text Co and ask for a new one."));
    res.redirect(302, url);
  });

  router.get("/connect/:state/go", async (req, res) => {
    if (!googleConfigured()) return res.status(404).send(page("Not available yet", "Connecting Google isn't turned on yet."));
    const url = await calendarConsentUrlFor(String(req.params.state)).catch(() => null);
    if (!url) return res.status(410).send(calPage("This link has expired", "<p>Text Cue and ask for a new one.</p>"));
    res.redirect(302, url);
  });

  // The one-tap disconnect: a page with one button; the POST does it.
  router.get("/calendar/disconnect/:token", (req, res) => {
    const C = CALENDAR_GRANT_COPY;
    res.send(calPage(C.sureTitle, `<p>${esc(C.sure)}</p><form method="post"><button class="btn go" type="submit">${esc(C.disconnect)}</button></form>`));
  });
  router.post("/calendar/disconnect/:token", async (req, res) => {
    const C = CALENDAR_GRANT_COPY;
    const done = await disconnectByToken(String(req.params.token)).catch(() => false);
    res.send(calPage(done ? C.goneTitle : "Already disconnected", `<p>${esc(done ? C.gone : "There's no calendar connected on this link anymore.")}</p>`));
  });

  router.get("/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code || req.query.error) {
      return res.status(400).send(page("Not connected", "Nothing was connected. You can close this and text Co if you want to try again."));
    }
    // A calendar grant goes its own way (services/calendarGrant.ts): its own scope and token, and its page has the one-tap disconnect.
    if ((await grantKindOf(state).catch(() => null)) === "calendar") {
      const c = await finishCalendarConnect(state, code).catch(() => ({ ok: false }) as { ok: boolean; revoke?: string });
      if (!c.ok || !c.revoke) return res.status(400).send(calPage("Not connected", "<p>That didn't work, so nothing was connected. Text Cue for a new link.</p>"));
      const C = CALENDAR_GRANT_COPY;
      return res.send(calPage(C.doneTitle, `<p>${esc(C.done)}</p><p class="small">${esc(C.undo.replace(", or tap Disconnect on the next page", ""))}</p><a class="btn quiet" href="/google/calendar/disconnect/${encodeURIComponent(c.revoke)}">${esc(C.disconnect)}</a>`));
    }
    const r = await finishConnect(state, code).catch(() => ({ ok: false }));
    if (!r.ok) return res.status(400).send(page("Not connected", "That didn't work, so nothing was connected. Text Co for a new link."));
    res.send(page("Connected", "Co can now see when you're busy (not what the events are) and which emails you sent are still waiting on a reply, and, if you allowed it, save a document you ask for as a Google Doc in your Drive (Co sees only the files it creates). It never sends email or changes your calendar. Text Co \"disconnect Google\" any time."));
  });

  return router;
}
