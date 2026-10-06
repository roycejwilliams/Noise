// What Co knows about a person, kept current (Royce, 2026-09-15: "Keep what
// Co knows about each person accurate... newer facts beating older ones
// matters more than anything else").
//
// A short snapshot (what they do and at what stage, where they are, what
// they want right now, what's weighing on them, what matters to them in
// people and plans) rebuilt from what they've actually said recently,
// instead of profile lists that only grow and a recap that lags. Every layer
// that talks to or about them reads it first: the reply and the Hume call
// (via buildContextSummary), the sweep's search brief, and why-it-fits.
//
// Gate: the rebuild must be grounded in their own recent words; newer
// statements replace older ones; nothing about Co's own performance. The
// knowledge eval (evals/knowledge) checks a stale profile plus newer texts
// produce the newer facts.
import { goalEntries } from "./profileWrite.js";
import { notToTeammate } from "../services/teamLines.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { recordDecision } from "./core.js";

export type PersonSnapshot = {
  work: string | null; // what they do and at what stage
  place: string | null;
  wantsNow: string[];
  weighingOn: string[];
  valuesInPeople: string[]; // what "worth it" means to them
  worked: string[]; // suggestions that helped
  didntWork: string[]; // suggestions that didn't
  asOf: string; // newest statement it reflects
};

export type SnapshotInputs = {
  firstName: string;
  previous: PersonSnapshot | null;
  recentStatements: { at: string; text: string }[]; // their own words, oldest first
  openAsks: string[];
  // Where they say they are headed: goal-typed entries only, never an ask. Orientation, not a search.
  goals?: string[];
  outcomes: string[];
};

// Rebuilt at most this often while they're actively talking.
const REBUILD_MIN_INTERVAL_MS = 10 * 60 * 1000;

export function snapshotPrompt(input: SnapshotInputs): string {
  return `Keep Co's short, current picture of ${input.firstName}. Rebuild it from what they've actually said.

${input.previous ? `Your previous picture (may be out of date):\n${JSON.stringify(input.previous, null, 2)}` : "No previous picture."}

What ${input.firstName} has said recently, oldest first (their own words and call summaries):
${input.recentStatements.map((s) => `- [${s.at}] ${s.text}`).join("\n") || "(nothing recent)"}

What they're asking Co to look for right now (errands, not who they are):
${input.openAsks.map((a) => `- ${a}`).join("\n") || "(nothing open)"}

Where they say they are headed (direction):
${(input.goals ?? []).map((g) => `- ${g}`).join("\n") || "(nothing stated)"}

How past suggestions went:
${input.outcomes.map((o) => `- ${o}`).join("\n") || "(no results yet)"}

Rules:
- Newer statements replace older ones. If they said they're Series A, they're not pre-seed anymore, whatever the old picture says.
- Only what they actually said or what's listed above. No guesses about their feelings or circumstances.
- Only about them. Never about Co, Co's mistakes, or complaints about Co.
- Mo is an AI agent that works alongside Co, not a person in their life. Never list Mo as a cofounder, colleague or friend, even if an older picture did: drop it.
- Refer to them by name or as "they". Never "he" or "she" unless they told Co their pronouns (2026-09-22: a picture called a member "he" from their name alone).
- Keep every list short (at most 4 items), specific, and current. Drop anything resolved or contradicted.

Return ONLY JSON:
{"work": "what they do and at what stage, or null", "place": "where they are, or null", "wantsNow": [], "weighingOn": [], "valuesInPeople": [], "worked": [], "didntWork": [], "asOf": "the timestamp of the newest statement you used"}`;
}

export function parseSnapshot(text: string): PersonSnapshot | null {
  try {
    const p = parseModelJson<Partial<PersonSnapshot>>(text);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).slice(0, 160)).slice(0, 4) : []);
    return {
      work: typeof p.work === "string" && p.work.trim() ? p.work.slice(0, 200) : null,
      place: typeof p.place === "string" && p.place.trim() ? p.place.slice(0, 80) : null,
      wantsNow: list(p.wantsNow),
      weighingOn: list(p.weighingOn),
      valuesInPeople: list(p.valuesInPeople),
      worked: list(p.worked),
      didntWork: list(p.didntWork),
      asOf: typeof p.asOf === "string" ? p.asOf : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function renderSnapshot(s: PersonSnapshot | null): string {
  if (!s) return "";
  const lines = [
    s.work ? `Work: ${s.work}` : null,
    s.place ? `Where: ${s.place}` : null,
    s.wantsNow.length ? `Wants right now: ${s.wantsNow.join("; ")}` : null,
    s.weighingOn.length ? `Weighing on them: ${s.weighingOn.join("; ")}` : null,
    s.valuesInPeople.length ? `What matters to them in people and plans: ${s.valuesInPeople.join("; ")}` : null,
    s.worked.length ? `Suggestions that helped: ${s.worked.join("; ")}` : null,
    s.didntWork.length ? `Suggestions that didn't: ${s.didntWork.join("; ")}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

// Who this person is, for a search: what they do, what matters to them in
// people, and what has worked before. The search's topic comes only from the
// ask being searched. Their other asks ("wants right now") and what's on
// their mind are left out (2026-09-18: "Anyone hiring a design engineer?"
// searched pre-seed funding because the profile listed their funding asks;
// feelings reach the search separately, as a room preference). Also left
// out: what didn't work (a reason against, not a direction). Empty when Co
// knows nothing yet.
export function profileForSearch(s: PersonSnapshot | null): string {
  if (!s) return "";
  return [
    s.work ? `Works on: ${s.work}` : null,
    s.valuesInPeople.length ? `Cares about in people and plans: ${s.valuesInPeople.join("; ")}` : null,
    s.worked.length ? `Things that went well before: ${s.worked.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getPersonSnapshot(userId: string): Promise<PersonSnapshot | null> {
  const { rows } = await pool
    .query(`SELECT snapshot FROM person_snapshots WHERE user_id = $1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return (rows[0]?.snapshot as PersonSnapshot) ?? null;
}

async function gatherInputs(userId: string): Promise<SnapshotInputs | null> {
  const [user, statements, asks, outcomes, previous, intentRow] = await Promise.all([
    pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]),
    pool.query(
      `SELECT created_at, content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User said:%' OR content LIKE '[Call]%') AND ${notToTeammate()}
         AND created_at > NOW() - INTERVAL '21 days'
       ORDER BY created_at DESC LIMIT 60`,
      [userId],
    ),
    pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 5`, [userId]),
    loadOutcomeLines(userId),
    getPersonSnapshot(userId),
    pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] as any[] })),
  ]);
  if (!user.rows[0]) return null;
  return {
    firstName: user.rows[0].first_name || "them",
    previous,
    recentStatements: statements.rows
      .reverse()
      .map((r: any) => ({ at: new Date(r.created_at).toISOString().slice(0, 16), text: String(r.content).replace(/^User said: /, "").slice(0, 400) })),
    openAsks: asks.rows.map((r: any) => r.ask_text),
    goals: goalEntries(intentRow.rows[0]?.intent).map((g) => String(g.text)).slice(0, 6),
    outcomes,
  };
}

// Outcome lines (services/outcomes.ts writes them); kept here as a plain read
// so the snapshot doesn't depend on the outcome loop's internals.
async function loadOutcomeLines(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT item_name, kind, result, note FROM suggestion_outcomes WHERE user_id = $1 AND created_at > NOW() - INTERVAL '90 days' ORDER BY created_at DESC LIMIT 10`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => `${r.kind} "${r.item_name}": ${r.result}${r.note ? ` (${r.note})` : ""}`);
}

// The check after every rebuild (Royce, 2026-09-15: "What Co knows about a
// person has no check"): a read of the new snapshot against their own words
// from the last 48 hours. A problem means the snapshot kept something they've
// since changed, or dropped a new fact they stated.
export function snapshotCheckPrompt(snapshot: PersonSnapshot, recent: { at: string; text: string }[]): string {
  return `Here is Co's current picture of someone, and what they've said in the last 48 hours.

Picture:
${renderSnapshot(snapshot) || "(empty)"}

What they said, oldest first:
${recent.map((s) => `- [${s.at}] ${s.text}`).join("\n")}

The picture also draws on things they said before this window, so a line these messages don't mention is fine. Only list:
- a line their recent words contradict (they said something newer that changes it), or anything about Co itself rather than them ("contradicted");
- an important new fact about them they stated here that the picture is missing: their work or stage, where they are, or something they want ("missing").

Before calling anything missing, read the whole picture, not one line. If any
line already covers it, in any wording, it is not missing. Ignore wording
differences and small details. Most of the time there are no problems; return
an empty list then.

Return ONLY JSON: {"problems": [{"line": "the picture line, or null if missing", "kind": "contradicted" | "missing", "evidence": "their words that show it"}]}`;
}

export type SnapshotProblem = { line: string | null; kind: "contradicted" | "missing"; evidence: string };

// Returns the problems it found. Recording is the caller's job: a problem the
// rebuild then fixes isn't a problem (Royce, 2026-09-16: 89% of rebuilds were
// logging one, which would have paged us every 12 hours for nothing).
async function checkSnapshot(userId: string, snapshot: PersonSnapshot, recent: { at: string; text: string }[]): Promise<SnapshotProblem[]> {
  if (!recent.length) return [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "personSnapshot.check" },
      prompt: snapshotCheckPrompt(snapshot, recent),
    });
    return (parseModelJson<{ problems?: SnapshotProblem[] }>(text).problems ?? []).filter((p) => p && p.kind);
  } catch (err: any) {
    console.error("personSnapshot: check failed (non-fatal):", err?.message ?? err);
    return [];
  }
}

// The snapshot rebuild and the open-threads read used to be two calls on the
// same beat over the same words (2026-09-28, reply-path restructure phase 4).
// The first build now does both, with each prompt's own wording; the
// snapshot's check and one fix-up rebuild are unchanged, and the threads
// proposal goes through the same gates (harness/memberThreads.ts).
function promptBody(prompt: string): { body: string; shape: string } {
  const i = prompt.lastIndexOf("Return ONLY JSON:");
  return i < 0 ? { body: prompt, shape: "{}" } : { body: prompt.slice(0, i).trim(), shape: prompt.slice(i + "Return ONLY JSON:".length).trim() };
}

export function snapshotAndThreadsPrompt(snapshotPromptText: string, threadsPromptText: string): string {
  const a = promptBody(snapshotPromptText);
  const b = promptBody(threadsPromptText);
  return `Two tasks about the same person, from the same words. Do both.

TASK 1: THE PICTURE
${a.body}

TASK 2: OPEN THREADS
${b.body}

Return ONLY JSON: {"snapshot": ${a.shape}, "threads": ${b.shape}}`;
}

// Non-blocking callers: fire and forget. Returns whether it rebuilt.
export async function refreshPersonSnapshot(userId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  try {
    if (!opts.force) {
      const { rows } = await pool.query(
        `SELECT s.updated_at,
                (SELECT MAX(created_at) FROM co_memories m WHERE m.user_id = $1 AND m.memory_type = 'text_exchange' AND (m.content LIKE 'User said:%' OR m.content LIKE '[Call]%') AND ${notToTeammate('m')}) AS newest
         FROM (SELECT $1::uuid AS user_id) u LEFT JOIN person_snapshots s ON s.user_id = u.user_id`,
        [userId],
      );
      const updated = rows[0]?.updated_at ? new Date(rows[0].updated_at).getTime() : 0;
      const newest = rows[0]?.newest ? new Date(rows[0].newest).getTime() : 0;
      if (newest <= updated || Date.now() - updated < REBUILD_MIN_INTERVAL_MS) return false;
    }
    const input = await gatherInputs(userId);
    if (!input || (!input.recentStatements.length && !input.openAsks.length)) return false;
    // Loaded here so the many light importers of this file don't pull in the send path.
    const threads = await import("./memberThreads.js");
    const { lines, onFile } = await threads.threadInputs(userId);
    const build = async (feedback: string | null) => {
      const { text } = await generateText({
        model: anthropic(MODELS.sonnet),
        providerOptions: { anthropic: { effort: "low" } },
        experimental_telemetry: { isEnabled: true, functionId: "personSnapshot.rebuild" },
        prompt: snapshotPrompt(input) + (feedback ? `\n\nYour last picture had these problems; fix them:\n${feedback}` : ""),
      });
      return parseSnapshot(text);
    };
    // First build: the picture and the threads in one call.
    let threadProposal: { open?: any[]; close?: any[] } | null = null;
    let snapshot: PersonSnapshot | null;
    if (lines.length) {
      const { text } = await generateText({
        model: anthropic(MODELS.sonnet),
        providerOptions: { anthropic: { effort: "low" } },
        experimental_telemetry: { isEnabled: true, functionId: "personSnapshot.rebuildWithThreads" },
        prompt: snapshotAndThreadsPrompt(snapshotPrompt(input), threads.threadsPrompt(input.firstName, onFile, lines.slice(-80))),
      });
      let both: any = null;
      try {
        both = parseModelJson<any>(text);
      } catch {}
      snapshot = both?.snapshot ? parseSnapshot(JSON.stringify(both.snapshot)) : null;
      threadProposal = both?.threads && typeof both.threads === "object" ? both.threads : null;
    } else {
      snapshot = await build(null);
    }
    if (!snapshot) return false;
    // Check against the last 48 hours; one rebuild with the problems named.
    const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 16);
    const recent = input.recentStatements.filter((s) => s.at >= cutoff);
    const problems = await checkSnapshot(userId, snapshot, recent);
    let unresolved = problems;
    if (problems.length) {
      const retry = await build(problems.map((p) => `- ${p.kind}: ${p.line ?? "(missing)"} (they said: ${p.evidence})`).join("\n"));
      if (retry) {
        const remaining = await checkSnapshot(userId, retry, recent);
        if (remaining.length <= problems.length) {
          snapshot = retry;
          unresolved = remaining;
        }
      }
    }
    // Only what the rebuild couldn't fix counts as a problem worth watching.
    if (recent.length) {
      await recordDecision({
        layer: 4,
        decision: "profile.snapshotCheck",
        userId,
        outcome: unresolved.length ? "skip" : "act",
        action: unresolved.length ? "problems_found" : problems.length ? "fixed_on_rebuild" : "matches_recent",
        proposal: { snapshot, found: problems, unresolved },
        checks: unresolved.map((p) => ({ name: `snapshot_${p.kind}`, pass: false, reason: `${p.line ?? "(missing)"}: ${p.evidence}`.slice(0, 300) })),
        reason: problems.length && !unresolved.length ? `${problems.length} problem(s) fixed on the rebuild` : null,
      });
    }
    await pool.query(
      `INSERT INTO person_snapshots (user_id, snapshot, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()`,
      [userId, JSON.stringify(snapshot)],
    );
    await recordDecision({ layer: 4, decision: "profile.snapshot", userId, outcome: "act", action: "rebuilt", proposal: { previous: input.previous, snapshot } });
    // Their open threads move on the same beat: after they've said something
    // new (2026-09-22, harness/memberThreads.ts), from the same first call.
    if (lines.length) await threads.applyThreadProposal(userId, threadProposal, onFile, lines);
    return true;
  } catch (err: any) {
    console.error("refreshPersonSnapshot failed (non-fatal):", err?.message ?? err);
    return false;
  }
}
