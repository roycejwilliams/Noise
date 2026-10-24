// Their yes, before anything that needs it (review of the lane moves branch, 2026-10-13). Co decides, code guards facts:
//   1. the fact, in code: the words Co quotes as their yes are in THIS message, as whole words (a raw substring took "ok" from
//      "booking" and "no" from "I know"). Not there: Co quotes again, only their words that say yes; nobody is asked twice.
//   2. the intent, a short Haiku read of the recent exchange: did Co offer THIS action, and is their latest message a yes to it? The
//      exchange, not Co's last line: a clarifying question can sit between offer and yes, a link can be the last thing Co sent, and an
//      offer can span beats (re-review, 2026-10-13). Only when a tool that needs their yes is called, never on the plain reply path. An
//      error or an answer that can't be read is not a yes, and is logged.
// Words never decide intent here: "Yes! Can't wait", "no problem, go ahead" and "why not" are yeses that a negation regex refused.
// One check for every tool that needs their yes (agent/toolGuard.ts), lane moves included (services/laneMoves.ts).
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { recordAnthropicUsage } from "./llmUsage.js";

const words = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);

// Pure, the fact: the quoted words are in their message, as whole words, in order.
export function yesIsTheirs(theirYes: unknown, message: string): boolean {
  const y = words(theirYes);
  const m = words(message);
  if (!y.length || y.join(" ").length < 2) return false;
  for (let i = 0; i + y.length <= m.length; i++) if (y.every((w, j) => m[i + j] === w)) return true;
  return false;
}
export const QUOTE_RETRY = "Quote only the words in their message that say yes (e.g. 'Yes'), copied exactly, and call it again.";

// ---------------------------------------------------------------- the recent exchange the read sees

export type Turn = { side: "co" | "member"; text: string };
export const EXCHANGE_LIMITS = { groups: 7, chars: 1500 } as const;
const URL_ONLY = /^https?:\/\/\S+$/;
// Pure: the exchange before their latest message, as the read sees it: one line per side's turn (a turn's beats joined), a link as
// "[link: url]", the last few exchanges (Co's lines since their previous message plus about three exchanges before), capped.
export function exchangeText(turns: Turn[]): string {
  const g: Turn[] = [];
  for (const t of turns) {
    const raw = String(t.text ?? "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const text = URL_ONLY.test(raw) ? `[link: ${raw}]` : raw;
    const last = g[g.length - 1];
    if (last && last.side === t.side) last.text = `${last.text} / ${text}`;
    else g.push({ side: t.side, text });
  }
  const out = g.slice(-EXCHANGE_LIMITS.groups).map((t) => `${t.side === "co" ? "Cue" : "Member"}: ${t.text}`).join("\n");
  return out.length > EXCHANGE_LIMITS.chars ? `…${out.slice(-EXCHANGE_LIMITS.chars)}` : out;
}
// Pure: the turns in a text thread's log ("User said:", "Co replied:", Mo's lines; a line with no prefix continues the one before;
// bracketed notes are left out). The same log lastCoLine reads (services/conversationClose.ts).
export function turnsFromLog(log: string): Turn[] {
  const out: Turn[] = [];
  for (const line of String(log ?? "").split("\n")) {
    const m = line.match(/^(User said|User sent[^:]*|Co replied|Co said|Cue replied|Cue said|Mo said|Mo replied):\s*(.*)$/);
    if (m) out.push({ side: /^User/.test(m[1]) ? "member" : "co", text: m[2] });
    else if (/^\s*\[/.test(line)) continue;
    else if (out.length && line.trim()) out[out.length - 1].text += ` ${line.trim()}`;
  }
  return out;
}
export const exchangeFromLog = (log: string): string => exchangeText(turnsFromLog(log));
// An agent line in an exchange: "Cue: ...", or "Co: ..." from before the rename (2026-10-14).
const AGENT_LINE = /^(?:Co|Cue): /;
// Pure: Co's lines a yes can answer: Co's turn since their previous message, and Co's turn before that.
export function offerLines(recent: string | null | undefined): string[] {
  const all = String(recent ?? "").split("\n").filter((l) => /^(Co|Cue|Member): /.test(l));
  // In production the thread already ends with their current message (routes/sendblue.ts saves it before the reply reads the thread):
  // that one is the answer, not "their previous message", so it's left off before looking for the offer (fourth review of the lanes).
  const groups = all.length && all[all.length - 1].startsWith("Member: ") ? all.slice(0, -1) : all;
  const co = groups.filter((l) => AGENT_LINE.test(l)).map((l) => l.replace(AGENT_LINE, ""));
  const lastMember = groups.map((l) => l.startsWith("Member: ")).lastIndexOf(true);
  const since = groups.slice(lastMember + 1).filter((l) => AGENT_LINE.test(l)).map((l) => l.replace(AGENT_LINE, ""));
  return since.length ? co.slice(-(since.length + 1)) : co.slice(-1);
}

// The intent: their answer, read by a model against the recent exchange. Injected so tests stub it.
export type YesRead = { recent: string; message: string; ability: string };
export type YesVerdict = { yes: boolean; why: string; read: boolean };
export type YesJudge = (r: YesRead) => Promise<YesVerdict>;
export const YES_LIMITS = { timeoutMs: 6000, maxTokens: 300 } as const;

export function yesPrompt(r: YesRead): string {
  return `Cue is a texting companion. This is the recent exchange between Cue and a member, oldest first, then the member's latest message.

${r.recent.trim() || "(nothing before it)"}

Member's latest message: "${r.message.slice(0, 600)}"

The action Cue is about to take on their yes: ${r.ability.slice(0, 300)}

In this recent exchange, did Cue offer THIS action (not a different one: an offer to draft an email is not an offer to move an item, book something or send an intro), and is the member's latest message a yes to it? A yes to a different offer, a maybe, a not-now, a question back, or a plain acknowledgment that doesn't accept ("I know", "got it", "noted") is no. If no offer of this action appears in the exchange, no. Casual or enthusiastic yeses count ("why not", "no problem, go ahead", "Yes! Can't wait"), and a word about timing doesn't make a yes a maybe ("Sure, no rush", "yes, whenever"). Match the action by what it does in plain terms, not by its wording here ("an intro to Maya" is the introduction action; "keep it as a lookout" is the move). Judge only whether it was offered and whether they said yes: whether they qualify for it, or the details of the action, are checked elsewhere.

Return ONLY JSON: {"yes": true or false, "why": "under 15 words"}`;
}

// Pure: the model's answer, strictly. Anything else is unread, which is not a yes.
export function parseYes(text: string): YesVerdict {
  try {
    const p = parseModelJson<{ yes?: unknown; why?: unknown }>(text);
    if (typeof p?.yes !== "boolean") return { yes: false, why: "the read came back without a yes or no", read: false };
    return { yes: p.yes, why: String(p.why ?? "").slice(0, 200), read: true };
  } catch {
    return { yes: false, why: "the read couldn't be parsed", read: false };
  }
}

// Haiku 5.5 thinks by default and the ai-sdk drops "thinking disabled" (goalEdges.ts), so the SDK is called directly.
const haikuJudge: YesJudge = async (r) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), YES_LIMITS.timeoutMs);
  try {
    const out: any = await new Anthropic().messages.create({ model: MODELS.haiku, max_tokens: YES_LIMITS.maxTokens, thinking: { type: "disabled" }, messages: [{ role: "user", content: yesPrompt(r) }] } as any, { signal: ctl.signal });
    recordAnthropicUsage("theirYes.read", out.model ?? MODELS.haiku, out.usage);
    return parseYes((out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
  } catch (err: any) {
    return { yes: false, why: `the read failed: ${String(err?.message ?? err).slice(0, 120)}`, read: false };
  } finally {
    clearTimeout(t);
  }
};
let judge: YesJudge = haikuJudge;
export function setYesJudgeForTests(j: YesJudge | null): void {
  judge = j ?? haikuJudge;
}
// Never throws: a judge that throws is a judge that didn't read, so not a yes.
export async function judgeYes(r: YesRead): Promise<YesVerdict> {
  try {
    return await judge(r);
  } catch (err: any) {
    return { yes: false, why: `the read failed: ${String(err?.message ?? err).slice(0, 120)}`, read: false };
  }
}

// Both checks, in order: the fact first (no model call for a quote that isn't theirs), then the read.
export type YesCheck = { ok: true; why: string } | { ok: false; kind: "quote" | "not_yes" | "unread"; why: string };
export async function confirmYes(o: { theirYes: unknown; message: string; recent: string | null | undefined; ability: string }): Promise<YesCheck> {
  if (!yesIsTheirs(o.theirYes, o.message)) return { ok: false, kind: "quote", why: "the quoted yes isn't in their message" };
  const v = await judgeYes({ recent: o.recent ?? "", message: o.message, ability: o.ability });
  if (!v.read) return { ok: false, kind: "unread", why: v.why };
  return v.yes ? { ok: true, why: v.why } : { ok: false, kind: "not_yes", why: v.why };
}
