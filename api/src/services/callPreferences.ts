// Rules said on a call apply to that same call (Royce, 2026-11-02). Before this, a rule said on a call was captured only after it
// (services/callLearning.ts), so "keep it short" didn't shape the rest of the call and nothing was on file until the call was processed.
//
//   read      each time GPT-Live hands a turn to the thinking (services/gptLiveBridge.ts), the caller's words since the last read go
//             through the existing small preference read (memberPreferences.ts capturePreferencesNow: one Haiku call, the same
//             resolve and store as a text's). It runs beside the thinking, never before it: the answer never waits on it.
//   apply     what that read stored is on file at once, so every send gate (harness/notifyGate.ts, the call gate for dials) reads it:
//             "don't call me again this week" holds the follow-up dials. And the thinking's next turns carry a note of what they set
//             on this call (callRuleNote), so "keep it short" shapes the remaining answers.
//   safety    a turn that touches their safety (callLlmProxy.ts safetyCall) is never read mid-call and never carries the note: the
//             crisis path is as it was, with nothing added to it. Those lines are read after the call instead.
//   fallback  after the call, the call's learning read (callLearning.ts) stores rules only from the caller's lines no mid-call read
//             covered (unreadCallerLines): a failed read, a safety turn, or words said after the last handover. Never twice.
// In memory, by the call's key ("gpt-live:<session>"), for the life of the call and its processing; a restart in between loses only
// the coverage, and the after-call read then reads every line (as before this).
import { safetyCall } from "./callLlmProxy.js";
import { describePreference, type Preference } from "./memberPreferences.js";
import type { LiveTurn } from "./gptLive.js";

type CallReads = { userId: string; read: string[]; pending: Set<Promise<void>>; setHere: Map<string, Preference>; liftedHere: Map<string, Preference>; at: number };
const calls = new Map<string, CallReads>();
const KEEP_MS = 3 * 3_600_000;

export type ReadDeps = {
  capture: (userId: string, words: string, o: { zone: string | null; source: Preference["source"]; via: "call" }) => Promise<{ added: string[]; retired: string[] }>;
  zone: (userId: string) => Promise<string | null>;
  load: (userId: string) => Promise<Preference[]>;
  loadRetired: (userId: string) => Promise<Preference[]>;
  record: (d: import("../harness/core.js").HarnessDecision) => void;
};
const realDeps = (): ReadDeps => ({
  capture: (u, w, o) => import("./memberPreferences.js").then((P) => P.capturePreferencesNow(u, w, o)),
  zone: (u) => import("./memberTime.js").then((M) => M.memberZone(u)),
  load: (u) => import("./memberPreferences.js").then((P) => P.activePreferences(u)),
  loadRetired: (u) => import("./memberPreferences.js").then((P) => P.loadPreferences(u, undefined, { withRetired: true })),
  record: (d) => void import("../harness/core.js").then((C) => C.recordDecision(d)).catch(() => {}),
});
let depsOverride: Partial<ReadDeps> | null = null;
export const setCallReadDeps = (d: Partial<ReadDeps> | null): void => void (depsOverride = d);
const deps = (): ReadDeps => ({ ...realDeps(), ...(depsOverride ?? {}) });

function entry(callKey: string, userId: string, now = Date.now()): CallReads {
  for (const [k, v] of calls) if (now - v.at > KEEP_MS) calls.delete(k);
  let e = calls.get(callKey);
  if (!e) calls.set(callKey, (e = { userId, read: [], pending: new Set(), setHere: new Map(), liftedHere: new Map(), at: now }));
  return e;
}

// Pure: the caller's lines not read yet: their turns as they stand, minus what an earlier read took (a turn that grew since keeps only
// what it gained). Listening sounds ("mm") aren't words.
export function unreadOf(lines: string[], read: string[]): string[] {
  const left = [...read];
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const i = left.findIndex((r) => line === r || line.startsWith(r));
    if (i < 0) out.push(line);
    else {
      const rest = line.slice(left[i].length).trim();
      left.splice(i, 1);
      if (rest) out.push(rest);
    }
  }
  return out;
}

// A delegated turn: read the caller's new words for rules, beside the thinking. Never awaited by the turn. safety: the turn's request
// touches their safety (the bridge passes callLlmProxy.ts safetyCall over it); then nothing is read now.
export function readCallTurn(o: { callKey: string; userId: string; turns: LiveTurn[]; safety: boolean }): Promise<void> | null {
  if (o.safety) return null;
  const e = entry(o.callKey, o.userId);
  const mine = o.turns.filter((t) => t.who === "member").map((t) => t.text.trim()).filter(Boolean);
  const fresh = unreadOf(mine, e.read);
  const words = fresh.join("\n").trim();
  if (words.length < 4) return null;
  // Claimed before the read: two delegations close together never read the same words twice. A failed read gives them back.
  const claimed = [...fresh];
  e.read.push(...claimed);
  const d = deps();
  const p = (async () => {
    try {
      const zone = await d.zone(o.userId).catch(() => null);
      const r = await d.capture(o.userId, words, { zone, source: { via: "call", ref: o.callKey }, via: "call" });
      if (r.added.length) for (const pref of (await d.load(o.userId)).filter((x) => r.added.includes(x.id))) e.setHere.set(pref.id, pref);
      if (r.retired.length) {
        const gone = (await d.loadRetired(o.userId)).filter((x) => r.retired.includes(x.id));
        for (const x of gone) {
          if (e.setHere.has(x.id)) e.setHere.delete(x.id);
          // A superseded rule is replaced by the one just added; only a withdrawal is a lift.
          if (x.state === "withdrawn") e.liftedHere.set(x.id, x);
        }
      }
      d.record({ layer: 4, decision: "member.preference", userId: o.userId, outcome: r.added.length || r.retired.length ? "act" : "skip", action: "call_turn_read", proposal: { callKey: o.callKey, added: r.added, retired: r.retired } });
    } catch (err: any) {
      // Not read: these words go to the after-call read instead.
      for (const c of claimed) {
        const i = e.read.indexOf(c);
        if (i >= 0) e.read.splice(i, 1);
      }
      d.record({ layer: 4, decision: "member.preference", userId: o.userId, outcome: "skip", action: "call_turn_read_failed", proposal: { callKey: o.callKey }, reason: String(err?.name ?? "Error") });
    }
  })();
  e.pending.add(p);
  void p.finally(() => e.pending.delete(p));
  return p;
}

// What they set or lifted on this call, for the thinking's next turns (internal prompt lines, not member copy). Null when nothing
// changed, and always on a turn that touches their safety: the crisis path gets nothing added.
export function callRuleNote(callKey: string, messages: { role: string; content?: unknown }[]): string | null {
  const e = calls.get(callKey);
  if (!e || (!e.setHere.size && !e.liftedHere.size)) return null;
  if (safetyCall({ messages: messages as any })) return null;
  const lines: string[] = [];
  for (const p of e.setHere.values()) {
    const what = describePreference({ ...p, basis: "explicit" }).replace(/ \(noted, not applied yet\)$/, "");
    lines.push(p.area === "reply_style" ? `- How to answer them: ${what}. Follow it in every answer for the rest of this call.` : `- ${what}. It's on file now: Cue's texts and calls after this follow it. Don't offer or promise anything it rules out.`);
  }
  for (const p of e.liftedHere.values()) lines.push(`- They lifted this rule on this call: ${describePreference({ ...p, basis: "explicit" }).replace(/ \(noted, not applied yet\)$/, "")}. It no longer applies.`);
  return `# What they asked on this call about how Cue works with them\n${lines.join("\n")}`;
}

// The thinking's messages with the note in its system prompt (the bridge's guard step).
export function withCallRuleNote<M extends { role: string; content?: unknown }>(callKey: string, messages: M[]): M[] {
  const note = callRuleNote(callKey, messages);
  if (!note) return messages;
  const i = messages.findIndex((m) => m.role === "system");
  if (i < 0 || typeof messages[i].content !== "string") return messages;
  return messages.map((m, j) => (j === i ? { ...m, content: `${m.content}\n\n${note}` } : m));
}

// After the call: wait (bounded) for reads still running, then the caller's lines no mid-call read covered, as one string for the
// after-call read's quote check (callLearning.ts). null: no mid-call reads on record for this call (every line is read, as before).
export async function unreadCallerLines(callKey: string | null | undefined, theirLines: string, waitMs = 10_000): Promise<string | null> {
  const e = callKey ? calls.get(callKey) : undefined;
  if (!e) return null;
  if (e.pending.size) await Promise.race([Promise.allSettled([...e.pending]), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  return unreadOf(theirLines.split("\n"), e.read).join("\n");
}

// Tests only.
export const resetCallReads = (): void => calls.clear();
