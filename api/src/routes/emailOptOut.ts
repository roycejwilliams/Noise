// The opt-out link in invitation emails sent before 2026-10-14 (the removed outreach agent, see services/extensions.ts).
// Those emails are still in people's inboxes, so the link keeps working: a valid link is acknowledged, the person's keys go on
// the suppression list the agent read before every send (mo_suppression, where its database still has it), and the click is
// recorded in the decision log by prospect id only (Royce, 2026-10-16: never their email, X id or LinkedIn). Nothing in the code emails these
// people any more; if outreach ever comes back (archive/mo-backup-2026-10-14), it must honor both.
import { Router } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

// The same signature the links were made with, so only a real link is recorded.
export function optOutTokenMatches(prospectId: string, token: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.MO_UNSUBSCRIBE_SECRET || env.JWT_SECRET;
  if (!secret || !/^[0-9a-f-]{36}$/i.test(prospectId)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`mo-unsub:${prospectId}`).digest("hex").slice(0, 32));
  const got = Buffer.from(String(token ?? ""));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// The keys the agent checked before any send (its mo/rules.ts suppressionKeys, kept here as it was).
export function optOutKeys(p: { x_user_id?: string | null; email?: string | null; linkedin_url?: string | null }): string[] {
  return [
    p.x_user_id ? `x:${p.x_user_id}` : null,
    p.email ? `email:${p.email.trim().toLowerCase()}` : null,
    p.linkedin_url ? `li:${p.linkedin_url.trim().toLowerCase().replace(/\/+$/, "")}` : null,
  ].filter((k): k is string => Boolean(k));
}

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };
export async function recordOptOut(prospectId: string, db: Db = pool): Promise<string[]> {
  const keys = await db
    .query(`SELECT x_user_id, email, linkedin_url FROM mo_prospects WHERE id = $1`, [prospectId])
    .then((r) => (r.rows[0] ? optOutKeys(r.rows[0]) : []))
    .catch(() => [] as string[]);
  for (const key of keys) await db.query(`INSERT INTO mo_suppression (key, reason) VALUES ($1, 'unsubscribed') ON CONFLICT (key) DO NOTHING`, [key]).catch(() => {});
  return keys;
}

export function createEmailOptOutRouter(): Router {
  const router = Router();
  router.get("/unsubscribe", async (req, res) => {
    const p = String(req.query.p ?? "");
    const ok = optOutTokenMatches(p, String(req.query.t ?? ""));
    if (ok) {
      const keys = await recordOptOut(p).catch(() => [] as string[]);
      await recordDecision({ layer: 5, decision: "email.optOut", userId: null, outcome: "act", action: "unsubscribed", proposal: { prospectId: p, suppressed: keys.length } }).catch(() => {});
    }
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        ok
          ? `<p style="font-family:system-ui;max-width:32rem;margin:4rem auto">Done. You won't be emailed again.</p>`
          : `<p style="font-family:system-ui;max-width:32rem;margin:4rem auto">That link didn't work. Email hello@copatible.com and we'll take you off the list.</p>`,
      );
  });
  return router;
}
