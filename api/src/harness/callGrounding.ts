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

export type CallClaim = {
  quote: string;
  type: "promise_keepable" | "promise_unkeepable" | "invented_fact" | "capability" | "ok";
  what: string; // for keepable promises: what to look for; otherwise a short note
};

// What Co can truthfully promise or claim on a call, mirrored from the text
// side's standing capabilities.
export const CALL_CAPABILITIES = `Co can: look for events, communities, opportunities, and people after a call and text them if something real fits (never a guaranteed result or time); call them back if they ask; text them.
Co can't: book, buy, register them for events, email or call other people for them, promise when something will be found, or know details (times, places, people's intentions) it wasn't given.`;

export function callAuditPrompt(transcript: string, knownBefore: string): string {
  return `Audit what Co said on a phone call. Co can only claim things it actually knew and only promise things it can actually do.

What Co can and can't do:
${CALL_CAPABILITIES}

What Co knew going into the call:
${knownBefore || "(nothing)"}

Call transcript ("assistant" is Co):
${transcript.slice(-12000)}

List every statement by Co ("assistant" lines only) that is a promise of a future action, a specific fact about an event, a person, or a place, or a claim about what Co can do. For each:
- "promise_keepable": a promise to look for something after the call and text if something fits, with no guaranteed result or time. Put what to look for in "what".
- "promise_unkeepable": any other promise (a time, a guaranteed result, booking, contacting someone for them).
- "invented_fact": a specific fact not in what Co knew or what the person said on the call.
- "capability": a wrong claim about what Co can or can't do.
- "ok": supported by what Co knew, what the person said, or the capabilities.

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

export async function auditCall(userId: string, transcript: string, knownBefore: string): Promise<void> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "call.grounding.audit" },
      prompt: callAuditPrompt(transcript, knownBefore),
    });
    const claims = (parseModelJson<{ claims?: CallClaim[] }>(text).claims ?? []).filter((c) => c && typeof c.quote === "string");
    const checks = callAuditChecks(claims);

    // Keep the promises Co can keep.
    for (const c of claims.filter((x) => x.type === "promise_keepable" && x.what)) {
      await captureIntentForTurn(userId, `user: ${c.what}`, { timeoutMs: 6000 }).catch(() => null);
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
