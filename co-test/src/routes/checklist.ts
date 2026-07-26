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
  test_case: "intent_layer" | "circles" | "both";
};

const CATALOG: ChecklistItem[] = [
  // Auto-verifiable — computed live from real data, never guessed.
  {
    key: "confidence_floor_rate",
    label: "% of placements clearing the 0.55 confidence floor autonomously vs. routing to Moderator",
    category: "auto",
    test_case: "circles",
  },
  {
    key: "retry_4hr",
    label: "Whether the 4hr-retry fires, and whether it resolves without a human decision",
    category: "auto",
    test_case: "circles",
  },
  {
    key: "venue_approval_rate",
    label: "Venue/time approval pass vs. reject rate on first attempt",
    category: "auto",
    test_case: "circles",
  },
  {
    key: "human_decision_fraction",
    label: "Aggregate: what fraction of the total flow required an actual human decision",
    category: "auto",
    test_case: "both",
  },
  {
    key: "sample_size_parity",
    label: "Same-sample-size check: equal number of real test participants across both test cases",
    category: "auto",
    test_case: "both",
  },
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
  {
    key: "recommendation_relevance",
    label: "Whether a recommendation/event felt genuinely relevant",
    category: "manual",
    test_case: "circles",
  },
  {
    key: "circle_undeniable",
    label: "Whether a circle felt undeniable",
    category: "manual",
    test_case: "circles",
  },
  {
    key: "moment_attendance",
    label: "Whether people actually showed up to the Moment",
    category: "manual",
    test_case: "circles",
  },
  {
    key: "repeat_desire",
    label: "Whether they'd want to repeat it",
    category: "manual",
    test_case: "both",
  },
  {
    key: "less_explanation",
    label: "Which test case required less explanation to understand its value",
    category: "manual",
    test_case: "both",
  },
];

const CIRCLES_PENDING_NOTE =
  "Pending a data source — this metric describes the Circles matching/booking pipeline (confidence gate, Keana approval, availability poll), which only runs in production today. co-test doesn't run that pipeline yet, and production isn't read from (even read-only) per policy. See the Circles-in-co-test scoping note for what porting it would take.";

// The one auto item computable purely from co-test's own DB today — real
// (phone-channel, OTP-verified) participants tagged per test case.
async function computeSampleSizeParity(): Promise<{ computed: true; value: string; detail: any }> {
  const result = await pool.query(
    `SELECT test_case, COUNT(*)::int AS n
     FROM users
     WHERE test_channel = 'phone' AND otp_verified = true AND test_case IS NOT NULL
     GROUP BY test_case`,
  );
  const counts: Record<string, number> = { intent_layer: 0, circles: 0 };
  for (const row of result.rows) counts[row.test_case] = row.n;

  const equal = counts.intent_layer === counts.circles;
  return {
    computed: true,
    value: equal
      ? `Equal — ${counts.intent_layer} real participants each`
      : `Not equal — Intent Layer: ${counts.intent_layer}, Circles: ${counts.circles}`,
    detail: counts,
  };
}

async function computeAutoValue(key: string): Promise<{ computed: boolean; value: string; detail?: any }> {
  switch (key) {
    case "sample_size_parity":
      return computeSampleSizeParity();
    case "confidence_floor_rate":
    case "retry_4hr":
    case "venue_approval_rate":
    case "human_decision_fraction":
      return { computed: false, value: CIRCLES_PENDING_NOTE };
    default:
      return { computed: false, value: "Unknown item." };
  }
}

// GET /api/checklist — full catalog, auto items computed live on every
// request (no stored/stale status), manual items read from checklist_responses.
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const manualResult = await pool.query(`SELECT item_key, value, filled_in, updated_at FROM checklist_responses`);
    const manualByKey = new Map(manualResult.rows.map((r: any) => [r.item_key, r]));

    const items = await Promise.all(
      CATALOG.map(async (item) => {
        if (item.category === "auto") {
          const auto = await computeAutoValue(item.key);
          return { ...item, computed: auto.computed, value: auto.value, detail: auto.detail ?? null };
        }
        const manual = manualByKey.get(item.key);
        return {
          ...item,
          filled_in: !!manual?.filled_in,
          value: manual?.value ?? null,
          updated_at: manual?.updated_at ?? null,
        };
      }),
    );

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
