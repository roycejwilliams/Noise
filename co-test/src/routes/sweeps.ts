import { Router } from "express";
import { requireTeam, requireTesterLoginApi } from "../middleware/requireTesterLogin.js";

// The 9am daily sweep's rollup (api/src/services/dailySweep.ts dailySweepRollup): one row per member per day. Team only: it names
// every member, so it is never shown to a tester who isn't on the team (the 404 is the same as for anything else they can't reach).
const router = Router();
router.get("/", requireTesterLoginApi, requireTeam, async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days ?? 14) || 14));
    const { dailySweepRollup } = await import("../../../api/src/services/dailySweep.js");
    res.json({ success: true, rows: await dailySweepRollup(days) });
  } catch (err: any) {
    console.error("sweeps rollup failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "The rollup couldn't be read." });
  }
});
// Promises made vs kept, per goal (api/src/services/commitmentLog.ts commitmentRollup): read from the decision log, team only, the
// same as the rollup above. Never sent to anyone as a text or an email.
router.get("/promises", requireTesterLoginApi, requireTeam, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30) || 30));
    const { commitmentRollup } = await import("../../../api/src/services/commitmentLog.js");
    res.json({ success: true, rows: await commitmentRollup(days) });
  } catch (err: any) {
    console.error("promises rollup failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "The promises rollup couldn't be read." });
  }
});
// Asks the old morning job likely switched off (api/src/services/askSplit.ts legacyFlips): open help asks that read as Co's own work,
// classified well after they were made. Team only, read-only: listed to look at, never corrected from here.
router.get("/legacy-flips", requireTesterLoginApi, requireTeam, async (_req, res) => {
  try {
    const { legacyFlips } = await import("../../../api/src/services/askSplit.js");
    res.json({ success: true, rows: (await legacyFlips()).map((f) => ({ firstName: f.firstName, text: f.text, createdAt: f.createdAt, checkedAt: f.checkedAt })) });
  } catch (err: any) {
    console.error("legacy flips failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "The legacy flips couldn't be read." });
  }
});
// Own work nothing is carrying (api/src/services/askSplit.ts unclaimedWork): work with no task, a mixed request's work part with no
// task, or one left unclaimed when it was split. Searched meanwhile, never quietly skipped. Team only, read-only.
router.get("/own-work", requireTesterLoginApi, requireTeam, async (_req, res) => {
  try {
    const { unclaimedWork } = await import("../../../api/src/services/askSplit.js");
    res.json({ success: true, rows: await unclaimedWork(7) });
  } catch (err: any) {
    console.error("own work list failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "The own-work list couldn't be read." });
  }
});
// When members engage, measured only (api/src/services/engagementRhythm.ts): their local hours and weekdays of the conversations they
// opened, and how they answered Co's proactive texts. Team only, read-only; nothing reads it to time a send.
router.get("/rhythm", requireTesterLoginApi, requireTeam, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 28) || 28));
    const { engagementRhythm } = await import("../../../api/src/services/engagementRhythm.js");
    res.json({ success: true, rows: (await engagementRhythm(days)).map(({ userId: _u, ...r }) => r) });
  } catch (err: any) {
    console.error("rhythm view failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "The rhythm view couldn't be read." });
  }
});
// Cue's failures per day (api/src/harness/failureCount.ts): members, the team and test members apart. The alert text carries members'
// numbers only; the team's and test members' are here (Royce, 2026-10-17). Team only, read-only.
router.get("/failures", requireTesterLoginApi, requireTeam, async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days ?? 14) || 14));
    const { failureDays } = await import("../../../api/src/harness/failureCount.js");
    res.json({ success: true, rows: (await failureDays(days)).map((d) => ({ day: d.day, fallbacks: { member: d.fallbacks.member, team: d.fallbacks.team, test: d.fallbacks.test }, cuts: d.cuts, redrafted: d.redrafted, noHelp: { member: d.noHelp.member, team: d.noHelp.team, test: d.noHelp.test }, membersHit: d.membersHit, memberTexts: d.memberTexts })) });
  } catch (err: any) {
    console.error("failures view failed:", err?.message ?? err);
    res.status(500).json({ success: false, error: "The failures view couldn't be read." });
  }
});
// The rule check (api/src/harness/ruleCompliance.ts): sends that went against a member's own rule or a team hold, with the send path
// that caused it. Ids, paths and rule ids only, never anyone's words. Team only, read-only: it fixes nothing.
router.get("/rule-checks", requireTesterLoginApi, requireTeam, async (req, res) => {
  try {
    const days = Math.min(14, Math.max(1, Number(req.query.days ?? 7) || 7));
    const R = await import("../../../api/src/harness/ruleCompliance.js");
    const until = new Date();
    const breaks = await R.ruleBreaks(new Date(until.getTime() - days * 86_400_000), until);
    const { default: pool } = await import("../../../api/src/db/db.js");
    const ids = [...new Set(breaks.map((b) => b.userId))];
    const { rows } = ids.length ? await pool.query(`SELECT id, first_name FROM users WHERE id = ANY($1::uuid[])`, [ids]) : { rows: [] as any[] };
    const names = new Map<string, string>(rows.map((r: any) => [String(r.id), String(r.first_name ?? "")]));
    res.json({ success: true, rows: breaks.map(({ userId, ...b }) => ({ name: names.get(userId) ?? "?", ...b })) });
  } catch (err: any) {
    console.error("rule checks failed:", err?.name ?? "Error");
    res.status(500).json({ success: false, error: "The rule check couldn't be read." });
  }
});
// One trace's exact prompt and answer (api/src/services/llmTraceText.ts): Langfuse shows the trace id with no text, and this
// reads our own 14-day copy. Team only, read-only: it holds members' own words. An id that isn't a trace id answers 400.
router.get("/trace/:traceId", requireTesterLoginApi, requireTeam, async (req, res) => {
  try {
    const T = await import("../../../api/src/services/llmTraceText.js");
    const id = String(req.params.traceId ?? "").trim().toLowerCase();
    if (!T.validTraceId(id)) return res.status(400).json({ success: false, error: "A trace id is 32 hex characters (copy it from Langfuse)." });
    res.json({ success: true, retentionDays: T.TRACE_TEXT.retentionDays, rows: await T.traceTextFor(id) });
  } catch (err: any) {
    console.error("trace text lookup failed:", err?.name ?? "Error");
    res.status(500).json({ success: false, error: "The trace text couldn't be read." });
  }
});
export default router;
