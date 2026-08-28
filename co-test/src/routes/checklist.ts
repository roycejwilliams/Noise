import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";

const router = express.Router();

// Fixed catalog — split exactly as agreed (see task notes): auto-verifiable
// items the system checks off itself from real data, and manual items that
// only ever track whether a human has filled them in. Not a DB table: this
// list doesn't change at runtime, so a table would just be an extra place
// for the two to drift out of sync.
type ChecklistItem = {
  key: string;
  label: string;
  category: "auto" | "manual";
  test_case: "intent_layer";
};

const CATALOG: ChecklistItem[] = [
  // Manual — human input only, never inferred or fabricated by the system.
  {
    key: "recognition_check",
    label: "Recognition check — does the extracted profile sound like the person",
    category: "manual",
    test_case: "intent_layer",
  },
  {
    key: "specificity_check",
    label: "Specificity of seeking/offering output",
    category: "manual",
    test_case: "intent_layer",
  },
];

// GET /api/checklist — full catalog. Every current item is manual (read from
// checklist_responses); nothing in CATALOG is category: "auto" right now,
// but the shape stays here so a future auto-computed item doesn't need a
// structural change to slot in.
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const manualResult = await pool.query(`SELECT item_key, value, filled_in, updated_at FROM checklist_responses`);
    const manualByKey = new Map(manualResult.rows.map((r: any) => [r.item_key, r]));

    const items = CATALOG.map((item) => {
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
router.post("/:item_key", async (req: Request, res: Response, next: NextFunction) => {
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
