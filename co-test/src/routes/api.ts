import { isTestCase, TEST_CASES } from "../testCases.js";
import { getCoPersonaPrompt } from "../../../api/src/services/coPersona.js";
import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import pool from "../../../api/src/db/db.js";
import {
  assessConversationCoverage,
  captureIntent,
  extractPsychographicProfile,
  RAPPORT_TOPICS,
  storeProfile,
  storeTranscriptMemory,
} from "../../../api/src/services/profileExtraction.js";
import { buildContextSummary } from "../../../api/src/services/callContext.js";
import { mayReach, requireOwnOrTeam, requireTeam, requireTesterLoginApi } from "../middleware/requireTesterLogin.js";

const router = express.Router();

// Entirely the tester-facing tool — gated on the phone-verified tool-access
// login from routes/login.ts (see requireTesterLogin.ts).
router.use(requireTesterLoginApi);

// POST /api/session — creates a throwaway users row so co_profiles/co_memories
// (both FK'd to users.id) have somewhere to attach. This tool has no login;
// every page load is a new synthetic test user, isolated from real accounts
// because it's a different table row in a different (co-test) database.
router.post("/session", requireTeam, async (_req: Request, res: Response, next: NextFunction) => {
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

// POST /api/session/:sessionId/tag — tags a session with which of the two
// agreed test cases it belongs to (Part 2, item 5). Shared shape with
// phone.ts's /api/phone/:user_id/tag — same users.test_case column, works
// for both browser-EVI and real-phone sessions since both are just rows in
// the same users table.
router.post("/session/:sessionId/tag", requireOwnOrTeam("sessionId"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { test_case } = req.body as { test_case?: string };
    if (!isTestCase(test_case)) {
      return res.status(400).json({ success: false, error: `test_case must be one of: ${TEST_CASES.map((t) => t.value).join(", ")}.` });
    }
    await pool.query(`UPDATE users SET test_case = $2 WHERE id = $1`, [req.params.sessionId, test_case]);
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// GET /api/prompt: Co's call prompt, read from api/prompts/co-system-prompt.md
// (the source of truth for the ElevenLabs agent and the text persona).
router.get("/prompt", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const prompt = await getCoPersonaPrompt();
    if (!prompt) return res.status(200).json({ success: false, error: "prompts/co-system-prompt.md not found" });
    return res.status(200).json({ success: true, prompt, source: "prompts/co-system-prompt.md" });
  } catch (error) {
    next(error);
  }
});

// POST /api/assess-coverage — sandbox-only counterpart to the tool_call
// branch in api/src/routes/co.ts's Hume webhook. That branch exists for the
// Twilio-bridged phone path, where nobody holds the live EVI socket so Hume
// falls back to a webhook + Control Plane round trip. co-test's browser DOES
// hold the socket directly (see call.ts), so Hume delivers tool_call there
// instead — this route is just the server-side half (Anthropic call) that
// the browser can't make itself, called from call.ts's tool_call handler.
// Same assessConversationCoverage() function either way — this is proving
// out that function and the tool schema, not the Twilio-specific plumbing.
//
// `assessment` is the only part of this response that ever reaches Hume —
// call.ts sends exactly {missing_topics, ready_to_summarize} back as the
// tool result, unchanged. covered_topics and latency_ms are sandbox-only
// observability, for the side panel, never spoken by Co and never part of
// what EVI's model sees.
router.post("/assess-coverage", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { transcript, user_id } = req.body as { transcript?: string; user_id?: string };
    if (user_id && !(await mayReach((req as any).testerId, user_id))) return res.status(404).json({ success: false, error: "Session not found." });
    const priorContext = user_id ? await buildContextSummary(user_id).catch(() => "") : "";
    const start = Date.now();
    const assessment = await assessConversationCoverage(transcript ?? "", priorContext);
    const latency_ms = Date.now() - start;
    const covered_topics = RAPPORT_TOPICS.filter((t) => !assessment.missing_topics.includes(t));
    return res.status(200).json({ success: true, assessment, covered_topics, latency_ms });
  } catch (error) {
    next(error);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/extract — runs the same extraction pipeline the Hume webhook and
// typed-intake use (api/src/services/profileExtraction.ts), writes to
// co_profiles/co_memories on THIS service's DATABASE_URL, and stores the full
// combined result as a co_memories 'recap' row so the results page can reload
// it later by session ID instead of relying on in-memory state.
router.post("/extract", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, transcript, messages, coverage_history } = req.body as {
      user_id?: string;
      transcript?: string;
      messages?: unknown;
      coverage_history?: unknown;
    };
    if (!user_id || !transcript?.trim()) {
      return res.status(400).json({ success: false, error: "Missing user_id or transcript." });
    }
    if (!(await mayReach((req as any).testerId, user_id))) return res.status(404).json({ success: false, error: "Session not found." });

    await storeTranscriptMemory(user_id, transcript);
    const { raw, extracted } = await extractPsychographicProfile(transcript);
    await storeProfile(user_id, extracted, transcript);
    const intent = await captureIntent(user_id, transcript);

    const data = {
      profile: extracted,
      intent,
      raw_model_output: raw,
      transcript,
      messages: messages ?? [],
      // Sandbox-only tool-call observability captured live in call.ts — never
      // fed into extraction, just carried through so the results page can
      // show it after the call ends instead of only during the live panel.
      coverage_history: coverage_history ?? [],
      channel: "browser",
    };

    await pool.query(
      `INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'recap', $2)`,
      [user_id, JSON.stringify(data)],
    );

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// GET /api/session/:sessionId/results — the results page's reload path. Pulls
// the stored 'recap' row for this session from the DB rather than any
// in-memory state, so the URL is a real, revisitable link.
router.get("/session/:sessionId/results", requireOwnOrTeam("sessionId"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = String(req.params.sessionId);
    if (!UUID_RE.test(sessionId)) {
      return res.status(200).json({ success: true, status: "not_found" });
    }

    const userResult = await pool.query(
      `SELECT id, test_case FROM users WHERE id = $1`,
      [sessionId],
    );
    if (!userResult.rows[0]) {
      return res.status(200).json({ success: true, status: "not_found" });
    }

    const recapResult = await pool.query(
      `SELECT content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'recap'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    if (!recapResult.rows[0]) {
      return res.status(200).json({ success: true, status: "not_ready" });
    }

    // Full real iMessage thread (Part 3, item 7) — every text_exchange row
    // this session has, not just what happened to be in-memory when the
    // recap was written. Covers ongoing texting that continues after a call
    // ends, or happens with no call at all. Rows are stored as plain
    // "User said: X" / "Co replied: Y" strings (see webhooks.ts's
    // /sendblue/webhook) — parsed back into a clean role/content list here
    // rather than changing the storage format everywhere else that reads it.
    const threadResult = await pool.query(
      `SELECT content, created_at FROM co_memories
       WHERE user_id = $1 AND memory_type = 'text_exchange'
       ORDER BY created_at ASC`,
      [sessionId],
    );
    const imessage_thread = threadResult.rows.map((r: any) => {
      const isCo = r.content.startsWith("Co replied: ");
      const content = isCo ? r.content.slice("Co replied: ".length) : r.content.replace(/^User said: /, "");
      return { role: isCo ? "assistant" : "user", content, timestamp: r.created_at };
    });

    return res.status(200).json({
      success: true,
      status: "ready",
      data: {
        ...JSON.parse(recapResult.rows[0].content),
        test_case: userResult.rows[0].test_case,
        imessage_thread,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
