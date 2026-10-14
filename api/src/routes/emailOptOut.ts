// The opt-out link in invitation emails sent before 2026-10-14 (the removed outreach agent, see services/extensions.ts).
// Those emails are still in people's inboxes, so the link keeps working: a valid link is acknowledged and the click is
// recorded in the decision log (no other table is written). Nothing in the code emails these people any more.
import { Router } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { recordDecision } from "../harness/core.js";

// The same signature the links were made with, so only a real link is recorded.
export function optOutTokenMatches(prospectId: string, token: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.MO_UNSUBSCRIBE_SECRET || env.JWT_SECRET;
  if (!secret || !/^[0-9a-f-]{36}$/i.test(prospectId)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`mo-unsub:${prospectId}`).digest("hex").slice(0, 32));
  const got = Buffer.from(String(token ?? ""));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function createEmailOptOutRouter(): Router {
  const router = Router();
  router.get("/unsubscribe", async (req, res) => {
    const p = String(req.query.p ?? "");
    const ok = optOutTokenMatches(p, String(req.query.t ?? ""));
    if (ok) await recordDecision({ layer: 5, decision: "email.optOut", userId: null, outcome: "act", action: "unsubscribed", proposal: { prospectId: p } }).catch(() => {});
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        ok
          ? `<p style="font-family:system-ui;max-width:32rem;margin:4rem auto">Done. You won't be emailed again.</p>`
          : `<p style="font-family:system-ui;max-width:32rem;margin:4rem auto">That link didn't work. Reply to the email with "stop" and we'll take care of it.</p>`,
      );
  });
  return router;
}
