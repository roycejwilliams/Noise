// Living asks (Royce, 2026-09-26: "How can I make Co more adaptable?" …
// "Do all."). Not every ask is something a search can find. "Find me a
// founder meetup" is; "plan out the event" and "what can we offer sponsors"
// are asks for Co's help, and searching them every morning took slots from
// the asks that matter and brought back noise. Each ask is marked once:
// "find" asks are searched, "help" asks aren't, and Co checks in on both.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { withMember } from "./llmUsage.js";
import { withTraceUser } from "./llmTraceText.js";

// "person": someone to meet or talk to ("a founder who's done a pre-seed raise to talk to"), which only an intro can meet, never a
// search of events and pages (Royce, 2026-10-09: that ask came back empty five mornings running). Routed to intros, not swept.
// "outside": remembered, never worked on (the purpose boundary, harness/scope.ts, Royce 2026-11-04): an errand, shopping, travel, a general
// research project, a job-board watch, a funding or investor search. The row stays so Cue still knows what they said (and shows it back);
// it is never swept, checked in on, turned into a task or a look-out. Decided in code, no model call.
export type AskKind = "find" | "help" | "person" | "outside";
import { classifyScope, connectionPart } from "../harness/scope.js";
export const outsideAsk = (text: string): boolean => classifyScope(text).scope === "out";
// What a sweep searches for an ask: a mixed ask ("founder dinners and a dentist") is searched for its connection part only.
export const searchPartOf = (text: string): string => connectionPart(text) ?? text;

// Co's own deliverables and promises are not asks (2026-10-08): "plan will be
// delivered once ready" and "I'll send the outline tonight" were saved as
// "find" asks and spent the sweep's one X search on them. A narrow guard for
// sentences where Co (or the thing Co owes) is the subject; everything else
// is the model's call below.
const CO_COMMITMENT: RegExp[] = [
  // Co, or Co speaking as "I"/"we", saying what it will do or hand over.
  /\b(?:co|cue|i|we)(?:'ll| will| is going to| am going to| are going to)\s+(?:(?:draft|write|send|text|share|deliver|email|put together|pull together|get back|follow up|circle back|prepare|outline|check back)\b)/i,
  // The deliverable as the subject: "the plan will be delivered", "draft to be sent".
  /\b(?:will|to) be (?:delivered|sent|shared|texted|emailed|drafted|written)\b|\bwill be ready\b/i,
  // "once it's ready", "when ready": a status, not something to find.
  /\b(?:once|when) (?:it(?:'s| is) |they(?:'re| are) )?ready\b/i,
  // A request for Co to produce a written thing is help, never a search.
  /^\s*(?:draft|outline|put together)\b/i,
  /^\s*write (?:up |out )?(?:a|an|the|my|our) (?:plan|draft|outline|proposal|note|message|email|deck|brief|doc|document|post|bio|pitch)\b/i,
];
export function isCoCommitment(text: string): boolean {
  const t = (text ?? "").trim();
  return !!t && CO_COMMITMENT.some((re) => re.test(t));
}

export function askKindPrompt(text: string): string {
  return `Someone asked Cue for this: "${text.slice(0, 300)}"

Answer "find" if Cue could meet it by finding something out in the world: an event, a group or community (including researching which ones exist), people to meet or befriend (even when it's worded as wanting to connect with a kind of person), a program or an opportunity.

Answer "help" only if it's asking Cue to work something out with them: advice, deciding, planning, writing, organizing, figuring out what to offer. Finding sponsors or investors by name is "help": Cue's search can't find those.

Answer "help" as well when it isn't something to find at all: something Cue said it would do or deliver (a plan, a draft, a text, an intro), a status ("will be delivered once ready"), or a statement of what they're doing themselves (offering to partner with a company, launching, hosting, a deal in progress) with nothing in it to go and find.

Answer "help" too when it asks Cue to take an action for them (email, call, text, book, reserve, contact someone or somewhere): that's something to do, not something to find.

Answer "person" if it's asking for one particular kind of person to meet or talk to one on one (an advisor, a founder who has done something, a mentor, someone to introduce them to). People in general (a community, friends, a crowd to be around) are "find".

Answer with one word: find, help or person.`;
}

export async function classifyAsk(text: string): Promise<AskKind> {
  // Outside the purpose boundary: remembered, never searched or checked in on. First, so nothing else spends on it.
  if (outsideAsk(text)) return "outside";
  // Co's own promise or deliverable: never searched, no model call needed.
  if (isCoCommitment(text)) return "help";
  try {
    const { text: out } = await Promise.race([
      generateText({
        model: anthropic(MODELS.haiku),
        maxOutputTokens: 10,
        experimental_telemetry: { isEnabled: true, functionId: "askKind.classify" },
        prompt: askKindPrompt(text),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    const w = out.trim().toLowerCase();
    return w.startsWith("help") ? "help" : w.startsWith("person") ? "person" : "find";
  } catch {
    // When unsure, keep searching it, as before.
    return "find";
  }
}

// Marks open asks that haven't been classified yet (older asks, or one whose
// check timed out). Run before each morning sweep.
// ASK_KIND_VERSION: open find asks classified under an older prompt are read again once (2026-10-09: person asks and action requests
// were saved as find asks and searched every morning).
// A lookout's kind is never changed here (Royce, 2026-10-13, lane moves): every kind write goes through laneMoves.ts setAskKind.
export const ASK_KIND_VERSION = 3;
type KindDb = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export async function classifyOpenAsks(limit = 25, deps: { db?: KindDb; classify?: (text: string) => Promise<AskKind> } = {}): Promise<number> {
  const db = deps.db ?? pool;
  const classify = deps.classify ?? classifyAsk;
  const { setAskKind } = await import("./laneMoves.js");
  const { rows } = await db.query(
    `SELECT id, user_id, ask_text, kind, intent, kind_checked_at FROM ask_checkins WHERE resolved_at IS NULL AND (kind_checked_at IS NULL OR (kind = 'find' AND COALESCE(kind_version, 1) < $2)) LIMIT $1`,
    [limit, ASK_KIND_VERSION],
  );
  for (const r of rows) {
    // A lookout keeps its kind; it's only marked checked (or given find, if it never had one), so it isn't read again every run.
    // Version 3 (the purpose boundary): an open find ask read under an older version is checked once in code, with no model call; only
    // an ask that is outside moves (to "outside"), the rest keep the kind they were given.
    const kind: AskKind = outsideAsk(r.ask_text)
      ? "outside"
      : r.kind_checked_at && r.kind === "find" && r.intent !== "lookout"
        ? "find"
        : r.intent === "lookout"
          ? ((r.kind as AskKind | null) ?? "find")
          : await withTraceUser(r.user_id, () => withMember(r.user_id, () => classify(r.ask_text))); // under the ask's member, its cost theirs
    await setAskKind(db, { id: r.id, read: { kind: r.kind ?? null, intent: r.intent ?? null }, kind, version: ASK_KIND_VERSION }).catch(() => {});
  }
  // Open "find" asks that read as Co's own promise or deliverable are NOT switched off here any more (Royce, 2026-10-13: a member
  // restating something Co is already doing is a status check, and "the search keeps running"; a silent stop is what the rules
  // forbid). They stay as they are: asking about one gets "already on it, here's where it stands" (services/statusCheck.ts), and
  // retirement leaves them in the status-check lane (services/askRetire.ts). A new ask is still classified at birth (classifyAsk).
  return rows.length;
}

// One way to close an ask, in both places it lives (2026-09-26: closing only
// touched ask_checkins, so co_profiles.intent still listed expired asks as
// active; "what are you looking out for me" and live searches kept using
// them). Closes the check-in row, marks the intent entry resolved, and
// retires any open matches for it.
export async function closeAsk(userId: string, askId: string, reason: string, evidence: string | null = null): Promise<boolean> {
  // Why it closed, and the proof (services/askLifecycle.ts): member | answered | delivered | moved_on | co | archived. The first reason stays.
  const { rowCount } = await pool.query(
    `UPDATE ask_checkins SET resolved_at = COALESCE(resolved_at, NOW()), closed_reason = COALESCE(closed_reason, $3), closed_evidence = COALESCE(closed_evidence, $4) WHERE user_id = $1 AND ask_id = $2`,
    [userId, askId, reason.slice(0, 40), evidence],
  );
  await markIntentResolved(userId, [askId]);
  await pool
    .query(
      `UPDATE relevance_edges SET status = 'retired', retired_at = NOW(), retired_reason = $3 WHERE person_id = $1 AND ask_id = $2 AND status = 'open'`,
      [userId, askId, reason.slice(0, 200)],
    )
    .catch(() => {});
  return (rowCount ?? 0) > 0;
}

export async function markIntentResolved(userId: string, askIds: string[]): Promise<number> {
  if (!askIds.length) return 0;
  const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
  const intent = Array.isArray(rows[0]?.intent) ? rows[0].intent : null;
  if (!intent) return 0;
  let changed = 0;
  const next = intent.map((e: any) => {
    if (e && askIds.includes(e.id) && e.status === "active") {
      changed++;
      return { ...e, status: "resolved", resolved_at: new Date().toISOString() };
    }
    return e;
  });
  if (changed) await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
  return changed;
}

// Brings profiles back in step with asks already closed (expired, resolved,
// or closed by hand before closeAsk existed). Run before each sweep.
export async function syncClosedAsks(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT ac.user_id, array_agg(ac.ask_id) AS ids
     FROM ask_checkins ac JOIN co_profiles cp ON cp.user_id = ac.user_id
     WHERE ac.resolved_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(cp.intent, '[]'::jsonb)) e WHERE e->>'id' = ac.ask_id AND e->>'status' = 'active')
     GROUP BY ac.user_id`,
  );
  let n = 0;
  for (const r of rows) n += await markIntentResolved(r.user_id, r.ids);
  return n;
}
