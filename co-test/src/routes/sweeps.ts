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
export default router;
