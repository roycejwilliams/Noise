import { requireTeam } from "../middleware/requireTesterLogin.js";
import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";

const router = express.Router();

// Fixed catalog, updated 2026-09-19 to what's being tested now (onboarding,
// the first call, texted searches, reactions, follow-ups, feedback). Auto
// items are checked from the signed-in tester's own data; manual items only
// ever track what a human wrote. Not a DB table: this list doesn't change at
// runtime.
type ChecklistItem = {
  key: string;
  label: string;
  category: "auto" | "manual";
};

const CATALOG: ChecklistItem[] = [
  { key: "invite", label: "Got in with an invite code", category: "auto" },
  { key: "onboarding", label: "Finished onboarding (name and email saved)", category: "auto" },
  { key: "call_offer", label: "Co offered the first call", category: "auto" },
  { key: "call", label: "Had a call with Co", category: "auto" },
  { key: "search_result", label: "Asked Co for something and got a real result", category: "auto" },
  { key: "reaction", label: "Reacted to something Co sent (interested, not interested, or already did it)", category: "auto" },
  { key: "followup", label: "Co reached out on its own", category: "auto" },
  { key: "issue", label: "Told Co about a problem, and it was saved for the team", category: "auto" },
  { key: "onboarding_on_brand", label: "Onboarding felt on brand: a private social club, never salesy", category: "manual" },
  { key: "call_worth_it", label: "The first call felt worth five minutes", category: "manual" },
  { key: "results_matched", label: "What Co sent matched what I asked for", category: "manual" },
  { key: "no_false_claims", label: "Nothing Co said about itself was untrue", category: "manual" },
];

const when = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

// Each auto item for one tester: done or not, and a short detail.
async function computeAuto(userId: string): Promise<Record<string, { computed: boolean; value: string | null }>> {
  const one = async (sql: string) => (await pool.query(sql, [userId]).catch(() => ({ rows: [] as any[] }))).rows[0] ?? null;
  const [u, offer, call, search, reaction, followup, issue] = await Promise.all([
    one(`SELECT invite_verified, identity_captured, first_name FROM users WHERE id = $1`),
    one(`SELECT created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'call_offer_pending' ORDER BY created_at LIMIT 1`),
    one(`SELECT created_at FROM co_memories WHERE user_id = $1 AND memory_type = 'recap' ORDER BY created_at DESC LIMIT 1`),
    one(`SELECT count(*)::int AS n, max(created_at) AS at FROM harness_decisions WHERE user_id = $1 AND decision = 'recommendation.search' AND action = 'sent_matches'`),
    one(`SELECT count(*)::int AS n, max(reacted_at) AS at FROM revealed_offers WHERE user_id = $1 AND reaction IS NOT NULL`),
    one(`SELECT count(*)::int AS n, max(sent_at) AS at FROM proactive_sends WHERE user_id = $1`),
    one(`SELECT count(*)::int AS n, max(created_at) AS at FROM user_reported_issues WHERE user_id = $1`),
  ]);
  const count = (r: any, noun: string) => (r?.n ? { computed: true, value: `${r.n} ${noun}${r.n === 1 ? "" : "s"}, last ${when(r.at)}` } : { computed: false, value: null });
  return {
    invite: { computed: !!u?.invite_verified, value: u?.invite_verified ? "Yes" : null },
    onboarding: { computed: !!u?.identity_captured, value: u?.identity_captured ? `Saved as ${u.first_name}` : null },
    call_offer: { computed: !!offer, value: offer ? `Offered ${when(offer.created_at)}` : null },
    call: { computed: !!call, value: call ? `Last call ${when(call.created_at)}` : null },
    search_result: count(search, "result"),
    reaction: count(reaction, "reaction"),
    followup: count(followup, "text"),
    issue: count(issue, "report"),
  };
}

// GET /api/checklist — the catalog, with auto items computed for whoever is
// signed in and manual items from checklist_responses.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const testerId = (req as any).testerId as string;
    const [manualResult, auto] = await Promise.all([
      pool.query(`SELECT item_key, value, filled_in, updated_at FROM checklist_responses`),
      computeAuto(testerId),
    ]);
    const manualByKey = new Map(manualResult.rows.map((r: any) => [r.item_key, r]));

    const items = CATALOG.map((item) => {
      if (item.category === "auto") return { ...item, ...auto[item.key] };
      const manual = manualByKey.get(item.key);
      return {
        ...item,
        filled_in: !!manual?.filled_in,
        value: manual?.value ?? null,
        updated_at: manual?.updated_at ?? null,
      };
    });

    return res.status(200).json({ success: true, items });
  } catch (error) {
    next(error);
  }
});

// POST /api/checklist/:item_key — the tester's own manual-input form.
// Rejects writes to auto items outright — this endpoint can never be used
// to fabricate or override a computed value.
router.post("/:item_key", requireTeam, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = CATALOG.find((i) => i.key === req.params.item_key);
    if (!item) return res.status(404).json({ success: false, error: "Unknown checklist item." });
    if (item.category !== "manual") {
      return res.status(400).json({ success: false, error: "This item is auto-verified and cannot be edited." });
    }

    const { value } = req.body as { value?: string };
    if (!value?.trim()) {
      return res.status(400).json({ success: false, error: "value is required." });
    }

    await pool.query(
      `INSERT INTO checklist_responses (item_key, value, filled_in, updated_at)
       VALUES ($1, $2, true, NOW())
       ON CONFLICT (item_key) DO UPDATE SET value = EXCLUDED.value, filled_in = true, updated_at = NOW()`,
      [req.params.item_key, value.trim()],
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
