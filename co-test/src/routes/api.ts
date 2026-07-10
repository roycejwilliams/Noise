import crypto from "node:crypto";
import { fetchAccessToken } from "hume";
import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";
import {
  captureIntent,
  extractPsychographicProfile,
  storeProfile,
  storeTranscriptMemory,
} from "../../../api/src/services/profileExtraction.js";

const router = express.Router();

// POST /api/session — creates a throwaway users row so co_profiles/co_memories
// (both FK'd to users.id) have somewhere to attach. This tool has no login;
// every page load is a new synthetic test user, isolated from real accounts
// because it's a different table row in a different (co-test) database.
router.post("/session", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const suffix = crypto.randomUUID().slice(0, 8);
    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone_number, username)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name`,
      [
        "Test",
        "Caller",
        `co-test-${suffix}@copatible.test`,
        `+1000${suffix}`,
        `co_test_${suffix}`,
      ],
    );
    return res.status(200).json({ success: true, user_id: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

// POST /api/hume-token — mints a short-lived EVI access token server-side so
// HUME_API_KEY/HUME_SECRET_KEY never reach the browser. Same HUME_CONFIG_ID
// production calls use, just connected to directly instead of via Twilio.
router.post("/hume-token", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accessToken = await fetchAccessToken({
      apiKey: process.env.HUME_API_KEY!,
      secretKey: process.env.HUME_SECRET_KEY!,
    });
    return res.status(200).json({
      success: true,
      accessToken,
      configId: process.env.HUME_CONFIG_ID,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/extract — runs the same extraction pipeline the Hume webhook and
// typed-intake use (api/src/services/profileExtraction.ts), writes to
// co_profiles/co_memories on THIS service's DATABASE_URL, and returns the
// full raw result for the UI's cards + JSON panel + download.
router.post("/extract", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, transcript } = req.body as { user_id?: string; transcript?: string };
    if (!user_id || !transcript?.trim()) {
      return res.status(400).json({ success: false, error: "Missing user_id or transcript." });
    }

    await storeTranscriptMemory(user_id, transcript);
    const { raw, extracted } = await extractPsychographicProfile(transcript);
    await storeProfile(user_id, extracted);
    const intent = await captureIntent(user_id, transcript);

    return res.status(200).json({
      success: true,
      data: { profile: extracted, intent, raw_model_output: raw },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
