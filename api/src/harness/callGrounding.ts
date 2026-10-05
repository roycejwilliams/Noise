// Grounding for calls (Royce, 2026-09-15: "Calls themselves aren't grounded.
// On a Hume call, Co's words go straight to the person").
//
// Hume speaks as it generates, so a call can't be gated sentence by sentence
// the way a text is (that would need routing the call's language model
// through our server). What this does instead, right after every call:
//
//   audit    — a Sonnet read of everything Co said, against what Co actually
//              had going into the call (the context summary, its standing
//              capabilities, open asks) and what the person said on the call
//   act      — a promise Co can keep ("I'll look for designers after we hang
//              up") is kept: it becomes a saved ask so the search really
//              runs. A claim or promise Co can't back is recorded as a
//              correction, and the next text reply gets it as a fact so Co
//              corrects it plainly if it comes up
//   record   — call.grounding in the decision log; monitoring alerts on
//              spikes (harness/monitor.ts)
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { captureIntentForTurn } from "../services/profileExtraction.js";
import { writeMemory } from "../services/memory.js";
import { recordDecision, type GateCheck } from "./core.js";
import { callKey } from "../services/callKey.js";

export type CallClaim = {
  quote: string;
  type: "promise_keepable" | "promise_unkeepable" | "invented_fact" | "capability" | "ok";
  what: string; // for keepable promises: what to look for; otherwise a short note
};

// What Co can truthfully promise or claim on a call, mirrored from the text
// side's standing capabilities.
export const CALL_CAPABILITIES = `Co can: look for events, communities, opportunities, and people after a call and text them if something real fits (never a guaranteed result or time); call them back if they ask; text them.
Co can't: book, buy, register them for events, email or call other people for them, promise when something will be found, or know details (times, places, people's intentions) it wasn't given.`;

// impressions (2026-09-28, the facts-vs-hints rule on the text side,
// replyGrounding.ts addHint): summaries and read-outs Co's own models wrote
// going into the call. They help read the call, but they're never proof of a
// specific time, place, count, or what another person said, wants or did.
export function callAuditPrompt(transcript: string, knownBefore: string, impressions?: string): string {
  return `Audit what Co said on a phone call. Co can only claim things it actually knew and only promise things it can actually do.

What Co can and can't do:
${CALL_CAPABILITIES}

What Co knew going into the call (facts):
${knownBefore || "(nothing)"}
${impressions?.trim() ? `
Co's own impressions going in (summaries its models wrote). Use these to understand the call, never as proof: a specific time, place, count, link, or what another person said, wants or did that only an impression backs is "invented_fact". What the person themself said in these recent texts is fine to rely on.
${impressions.slice(0, 6000)}
` : ""}
Call transcript ("assistant" is Co):
${transcript.slice(-12000)}

List every statement by Co ("assistant" lines only) that is a promise of a future action, a specific fact about an event, a person, or a place, or a claim about what Co can do. For each:
- "promise_keepable": a promise to look for something after the call and text if something fits, with no guaranteed result or time. Put what to look for in "what".
- "promise_unkeepable": any other promise (a time, a guaranteed result, booking, contacting someone for them).
- "invented_fact": a specific fact not in what Co knew or what the person said on the call.
- "capability": a wrong claim about what Co can or can't do.
- "ok": supported by the facts Co knew, what the person said, or the capabilities.

Return ONLY JSON: {"claims": [{"quote": "Co's exact words", "type": "...", "what": "..."}]}`;
}

export function callAuditChecks(claims: CallClaim[]): GateCheck[] {
  return claims
    .filter((c) => c.type !== "ok")
    .map((c) => ({
      name: `call_${c.type}`,
      pass: c.type === "promise_keepable",
      reason: `"${c.quote.slice(0, 140)}"${c.what ? ` (${c.what.slice(0, 100)})` : ""}`,
    }));
}

// Fixed 2026-09-17: every keepable promise got saved as `user: ${what}` via
// captureIntentForTurn regardless of who actually raised it — a promise Co
// volunteered on its own ("I'll look into events for you while we're at it")
// became a saved ask the person never made. Only save it as their ask when
// their own words on the call actually asked for something like it.
const GROUNDING_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "on", "at",
  "their", "his", "her", "my", "more", "other", "if", "something", "real",
  "fits", "after", "we", "hang", "up", "you", "your", "it", "that", "this",
]);
function significantWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !GROUNDING_STOPWORDS.has(w));
}

// Exported for evals — whether the person's own lines on this call actually
// asked for something like `what`, by simple word overlap (same tool
// mergeProfileList's nearDuplicate uses elsewhere, just checked against the
// transcript instead of another list item).
export function personAskedForThis(transcript: string, what: string): boolean {
  const userLines = transcript
    .split("\n")
    .filter((l) => /^user:/i.test(l.trim()))
    .map((l) => l.replace(/^user:\s*/i, ""))
    .join(" ")
    .toLowerCase();
  if (!userLines.trim()) return false;
  const words = significantWords(what);
  if (!words.length) return false;
  const hits = words.filter((w) => userLines.includes(w)).length;
  return hits / words.length >= 0.34;
}

// Runs the same search a member's own ask gets, keyed as Co's promise so the
// offer never says they asked for it (fromProfile). Records what came of it,
// so the post-call text can say plainly when nothing turned up.
export async function keepCallPromise(userId: string, what: string, transcript?: string): Promise<"queued" | "nothing"> {
  const { rows } = await pool.query(
    `SELECT u.first_name, u.phone_number, cp.city, cp.goals, cp.activity_preferences
     FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const p = rows[0];
  if (!p?.phone_number) return "nothing";
  const { attemptEventSurfacing, PROMISE_ASK_PREFIX } = await import("../services/eventSurfacingSweep.js");
  const key = what.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  const { queued } = await attemptEventSurfacing({
    askId: `${PROMISE_ASK_PREFIX}${key}`,
    userId,
    firstName: p.first_name,
    phoneNumber: p.phone_number,
    askText: what,
    fromProfile: true,
    city: p.city ?? null,
    goals: p.goals ?? null,
    activityPreferences: p.activity_preferences ?? null,
    cooldownCleared: true,
  });
  const result = queued
    ? `Looked into "${what}" after the call, as Co said it would, and found something; it's queued to send.`
    : `Looked into "${what}" after the call, as Co said it would, and found nothing good enough to send yet.`;
  await writeMemory(userId, "promise_result", result).catch(() => null);
  // Tied to this call, so this call's after-call text is the one that
  // reports it (services/callKey.ts).
  if (transcript) {
    await pool
      .query(`INSERT INTO call_promise_results (user_id, call_key, content) VALUES ($1, $2, $3)`, [userId, callKey(transcript), result])
      .catch((err: any) => console.error("callGrounding: promise result write failed (non-fatal):", err?.message ?? err));
  }
  return queued ? "queued" : "nothing";
}

export async function auditCall(userId: string, transcript: string, knownBefore: string | { facts: string; impressions: string }): Promise<void> {
  const facts = typeof knownBefore === "string" ? knownBefore : knownBefore.facts;
  const impressions = typeof knownBefore === "string" ? undefined : knownBefore.impressions;
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "call.grounding.audit" },
      prompt: callAuditPrompt(transcript, facts, impressions),
    });
    const claims = (parseModelJson<{ claims?: CallClaim[] }>(text).claims ?? []).filter((c) => c && typeof c.quote === "string");
    const checks = callAuditChecks(claims);

    // Keep the promises Co can keep — but only file it as the PERSON's ask
    // when their own words on the call actually asked for it. A promise Co
    // volunteered on its own is still real for Co to keep, but gets
    // recorded as Co's own note, not a saved ask attributed to them.
    for (const c of claims.filter((x) => x.type === "promise_keepable" && x.what)) {
      if (personAskedForThis(transcript, c.what)) {
        await captureIntentForTurn(userId, `user: ${c.what}`, { timeoutMs: 6000 }).catch(() => null);
      } else {
        await writeMemory(
          userId,
          "system",
          `Co promised on a call to look into: "${c.what}" — Co's own initiative, not something the person actually asked for.`,
        ).catch(() => null);
        // And actually look (2026-09-23: "I'll dig into those communities
        // and text you" was only ever written down, so nothing searched).
        await keepCallPromise(userId, c.what, transcript).catch((err: any) =>
          console.error("callGrounding: keepCallPromise failed (non-fatal):", err?.message ?? err),
        );
      }
    }
    // Remember what needs correcting, for the next text reply.
    const corrections = claims.filter((x) => x.type === "promise_unkeepable" || x.type === "invented_fact" || x.type === "capability");
    for (const c of corrections) {
      await writeMemory(userId, "call_correction", JSON.stringify({ quote: c.quote.slice(0, 200), type: c.type, note: c.what?.slice(0, 200) ?? null }));
    }

    await recordDecision({
      layer: 8,
      decision: "call.grounding",
      userId,
      outcome: corrections.length ? "skip" : "act",
      action: corrections.length ? "corrections_recorded" : "grounded",
      proposal: { claims },
      checks,
      reason: corrections.length ? `${corrections.length} unsupported statement(s) on the call` : null,
    });
  } catch (err: any) {
    console.error("auditCall failed (non-fatal):", err?.message ?? err);
  }
}

// Corrections from calls in the last week that a text reply hasn't used yet.
export async function recentCallCorrections(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'call_correction' AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 3`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows
    .map((r: any) => {
      try {
        const c = JSON.parse(r.content);
        return `On a recent call Co said "${c.quote}", which ${c.type === "invented_fact" ? "wasn't based on anything Co actually knew" : c.type === "capability" ? "isn't true about what Co can do" : "is a promise Co can't keep"}${c.note ? ` (${c.note})` : ""}. If it comes up, correct it plainly.`;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => !!x);
}
