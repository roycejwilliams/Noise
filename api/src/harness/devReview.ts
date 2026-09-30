// Dev-only "what broke" review (Royce, 2026-09-18: "so each morning I know
// what to fix"). Reads the test users' conversations with Co on co-test and
// Co's decision log, and flags bad responses and failures. Flags only: it
// never changes anything Co does.
//
// Extends harness/monitor.ts (which watches rates of the same decision rows
// for spikes) with per-turn flags that quote the exact messages:
//   log            from harness_decisions, no model: slow replies, searches
//                  that sent nothing or had everything turned away, stretch
//                  sends, "came up empty" texts, rewritten replies, unsure
//                  router reads, search queries off the member's topic
//   conversation   from the texts, no model: Co restating or pointing back at
//                  its own message, and "only one" claims when more were found
//   model          Sonnet reads each day's conversation: repeated questions,
//                  answers that miss the question, contradictions or claims
//                  about Co's own actions the log doesn't back, off-voice
//                  replies, promises with no saved ask behind them. Every flag
//                  must quote messages that are really in the conversation.
//   reaction       the member's own signals: frustration with Co (the emotion
//                  read's withCo target), reports in user_reported_issues, and
//                  texts calling out a miss
//
// Each flag carries the related decision-log rows for its turn and a
// one-line suspected cause, marked a guess unless the log confirms it.
//
// DEV ONLY, same guard as services/issueReports.ts: co-test in Railway's dev
// environment, with DEV_REVIEW=true. Anywhere else it stores and sends
// nothing. The morning digest is texted to Royce from Co's number without
// being logged as a Co message, so Co never treats it as part of their
// conversation and the next review never reads it.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { createHash } from "crypto";
import pool from "../db/db.js";
import { capabilitySheet } from "../services/capabilities.js";
import { MODELS } from "../models.js";
import { CO_VOICE } from "../services/coVoice.js";
import { parseModelJson } from "../services/modelJson.js";
import { recordDecision } from "./core.js";
import { signalTarget } from "./emotion.js";

export function reviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RAILWAY_ENVIRONMENT_NAME !== "dev" || env.RAILWAY_SERVICE_NAME !== "co-test") return false;
  return env.DEV_REVIEW === "true";
}

// Who gets reviewed: every account on co-test (it only holds testers), or
// DEV_REVIEW_USER_IDS (comma-separated). Account ids change when testers
// start over (all were reset 2026-09-18), so none are fixed here.
export async function reviewUserIds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const ids = (env.DEV_REVIEW_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) return ids;
  const { rows } = await pool.query(`SELECT id FROM users ORDER BY created_at`);
  return rows.map((r: { id: string }) => r.id);
}

// Who the digest is texted to: the account with this first name
// (DEV_REVIEW_DIGEST_NAME, default Royce), the way scripts/notifyTesters.ts
// finds testers. Null when that account doesn't exist yet.
export async function digestRecipient(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const name = (env.DEV_REVIEW_DIGEST_NAME ?? "Royce").trim();
  const { rows } = await pool.query(`SELECT id FROM users WHERE lower(first_name) = lower($1) AND phone_number IS NOT NULL AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [name]);
  return rows[0]?.id ?? null;
}

export type FlagType =
  | "slow_reply"
  | "search_sent_nothing"
  | "found_but_turned_away"
  | "stretch_send"
  | "came_up_empty_text"
  | "reply_rewritten"
  | "router_unsure"
  | "off_topic_search"
  | "restated_own_message"
  | "only_one_claim"
  | "repeat_question"
  | "answer_missed_question"
  | "contradiction_or_unbacked_claim"
  | "off_voice"
  | "promise_without_ask"
  | "member_frustrated_with_co"
  | "member_reported_issue"
  | "member_called_out_miss"
  | "questionable_tool_choice";

export const FLAG_LABELS: Record<FlagType, string> = {
  slow_reply: "Slow reply (over the latency budget)",
  search_sent_nothing: "Search sent nothing",
  found_but_turned_away: "Search found real ones but turned all away",
  stretch_send: "Sent a near-miss with a caveat",
  came_up_empty_text: "\"Came up empty\" text",
  reply_rewritten: "Reply rewritten by the grounding check",
  router_unsure: "Router unsure what they meant",
  off_topic_search: "Search query off the member's topic",
  restated_own_message: "Restated or pointed back at its own message",
  only_one_claim: "Said it found only one when it found more",
  repeat_question: "Asked something it already asked or knows",
  answer_missed_question: "Answer didn't match the question",
  contradiction_or_unbacked_claim: "Contradiction or unbacked claim about itself",
  off_voice: "Robotic or off-voice reply",
  promise_without_ask: "Promise with no saved ask behind it",
  member_frustrated_with_co: "Member frustrated with Co",
  member_reported_issue: "Member reported an issue",
  member_called_out_miss: "Member called out a miss",
  questionable_tool_choice: "Questionable tool choice (Jev's read of Co's judgment)",
};

export type Severity = "low" | "medium" | "high";
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export type ReviewFlag = {
  userId: string;
  at: string;
  type: FlagType;
  severity: Severity;
  snippet: string;
  decisionIds: number[];
  cause: string;
  causeConfirmed: boolean;
  source: "log" | "conversation" | "model" | "reaction";
};

export type ReviewMessage = { id: string; at: string; from: "member" | "co" | "call"; text: string };
export type ReviewDecision = { id: number; at: string; decision: string; outcome: string; action: string | null; reason: string | null; proposal: any; checks: any };
export type ReviewEmotion = { at: string; source: "call" | "text"; emotion: string; intensity: string; about: string | null; quote: string | null; target: string | null };
export type ReviewIssue = { at: string; message: string; summary: string; category: string; severity: string };
// openAsks: asks still open, whenever they were saved. A promise to keep
// looking is backed by any of them, not only asks saved that day (2026-09-18:
// "Still watching though." was flagged though the ask was days old).
export type ReviewAsk = { text: string; savedAt: string };
// The week before the window (2026-09-26): what Co sent them and what they
// told Co. Co's texts can rightly refer back to it ("the rooftop mixer
// yesterday", "you're weighing accelerators vs VCs"); with only the day's
// log, the review flagged both as invented when Co had sent the one and
// Royce had said the other the day before.
export type ReviewEarlier = { sent: string[]; theySaid: string[]; coSaid?: string[] };
export type ReviewData = { userId: string; firstName: string; messages: ReviewMessage[]; decisions: ReviewDecision[]; emotions: ReviewEmotion[]; issues: ReviewIssue[]; openAsks?: ReviewAsk[]; earlier?: ReviewEarlier };

const ms = (iso: string) => new Date(iso).getTime();
const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The turn a moment belongs to: from the member's message that started it to
// just before their next one. A fixed time window pulled the previous turn's
// rows into a flag (2026-09-18: "12 passed the gate" when 6 did). Without a
// member message nearby (a proactive send), a short window around it.
export function turnBounds(messages: ReviewMessage[], at: string): { start: number; end: number } {
  const t = ms(at);
  const before = [...messages].reverse().find((m) => m.from === "member" && ms(m.at) <= t && t - ms(m.at) < 10 * 60_000);
  const after = messages.find((m) => m.from === "member" && ms(m.at) > t);
  const start = before ? ms(before.at) - 1000 : t - 90_000;
  const end = after ? Math.min(ms(after.at) - 1, t + 5 * 60_000) : t + 45_000;
  return { start, end };
}

export function turnRowIds(decisions: ReviewDecision[], at: string, messages: ReviewMessage[] = []): number[] {
  const { start, end } = turnBounds(messages, at);
  return decisions.filter((d) => ms(d.at) >= start && ms(d.at) <= end).map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Topic words, for "does the search query share a topic with their message".

const STOP = new Set(
  "a an the and or but if of to in on at for from with about into over by as is are was were be been am do does did done have has had can could would should will shall may might must i me my we our you your they them their he she it its this that these those there here what whats which who whom whose when where why how any anything anyone anybody something someone some all see seen saw look looking looks like likes know get got go going went come coming happen happening happens on up out just really please thanks thank hey hi yo ok okay yeah yes no not now new good best cool find found search show tell give let lets want wanted need needed also too very much more most so than then there's what's that's i'm im it's you're co".split(
    " ",
  ),
);
const TIME = /^(today|tonight|tomorrow|yesterday|weekend|week|weeks|month|months|day|days|morning|afternoon|evening|night|next|this|last|soon|later|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|\d+(st|nd|rd|th)?|\d+)$/;

export function stem(w: string): string {
  return w.replace(/(ings|ing|ers|er|ed|es|s)$/, "") || w;
}

export function topicWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^a-z0-9']+/)
      .map((w) => w.replace(/'s$/, ""))
      .filter((w) => w.length > 1 && !STOP.has(w) && !TIME.test(w))
      .map(stem),
  );
}

// ---------------------------------------------------------------------------
// Log checks (no model)

export function logFlags(data: ReviewData): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const add = (d: ReviewDecision, type: FlagType, severity: Severity, snippet: string, cause: string, causeConfirmed: boolean) =>
    flags.push({ userId: data.userId, at: d.at, type, severity, snippet: clip(snippet), decisionIds: turnRowIds(data.decisions, d.at, data.messages), cause, causeConfirmed, source: "log" });
  const messageBefore = (at: string) =>
    [...data.messages].reverse().find((m) => m.from === "member" && ms(m.at) <= ms(at) && ms(at) - ms(m.at) < 5 * 60_000)?.text ?? null;

  for (const d of data.decisions) {
    const p = d.proposal ?? {};
    if (d.decision === "turn.latency" && Array.isArray(d.checks) && d.checks.some((c: any) => c.pass === false)) {
      const secs = Math.round((p.ms ?? 0) / 1000);
      const slowest = Object.entries({ router: p.routerMs, search: p.searchMs, prep: p.prepMs, reply: p.replyMs, grounding: p.groundingMs })
        .filter(([, v]) => typeof v === "number")
        .sort((a, b) => (b[1] as number) - (a[1] as number))[0];
      add(d, "slow_reply", secs >= 60 ? "high" : "medium", `${secs}s to reply to "${messageBefore(d.at) ?? "?"}"`, slowest ? `${slowest[0]} took ${Math.round((slowest[1] as number) / 1000)}s` : "no timing breakdown", !!slowest);
    }
    if (d.decision === "recommendation.search") {
      const msg = p.message ?? p.scope?.rewrite?.original ?? messageBefore(d.at) ?? "?";
      const gatedOut: any[] = p.scope?.gatedOut ?? [];
      if (d.outcome === "skip" && gatedOut.length) {
        add(d, "found_but_turned_away", "medium", `"${msg}": found ${gatedOut.map((g) => g.name).slice(0, 3).join(", ")}, all turned away`, `gate: ${gatedOut.map((g) => (g.reasons ?? []).join(", ")).slice(0, 2).join("; ")}`, true);
      } else if (d.outcome === "skip") {
        add(d, "search_sent_nothing", "medium", `"${msg}": sent nothing (${d.action ?? "skip"})`, d.action === "nothing_fit" ? "every result failed the fit check" : d.reason ?? d.action ?? "no reason logged", !!(d.action || d.reason));
      }
      const matches: any[] = Array.isArray(p.matches) ? p.matches : [];
      if (d.action === "sent_matches" && matches.length && matches.every((m) => m.fits === false)) {
        add(d, "stretch_send", "medium", `"${msg}": sent "${matches[0]?.name}" though nothing fit`, `fit check: ${matches[0]?.why ?? "not a fit"}`, true);
      }
      const queries = [p.scope?.xQuery, p.scope?.webQuery].filter((q): q is string => typeof q === "string" && q.trim().length > 0);
      const asked = topicWords(msg);
      if (queries.length && asked.size) {
        const shared = queries.some((q) => [...topicWords(q)].some((w) => asked.has(w)));
        if (!shared) add(d, "off_topic_search", "high", `"${msg}" searched: ${queries.join(" | ")}`, "the query was built from something other than their message (guess: their other asks or profile)", false);
      }
    }
    if (d.decision === "recommendation.lateResult" && typeof d.action === "string" && d.action.endsWith("_told_them")) {
      add(d, "came_up_empty_text", "medium", `texted "came up empty" for "${p.askText ?? "?"}"`, d.action.startsWith("none_fit") ? `results found but none fit: ${(p.found ?? []).slice(0, 3).join(", ")}` : "the search found nothing", true);
    }
    if (d.decision === "reply.grounding" && (["cut", "redrafted", "stripped"].includes(d.action ?? "") || (p.draft && p.final && p.draft !== p.final))) {
      add(d, "reply_rewritten", d.action === "stripped" ? "high" : "low", `draft: "${clip(p.draft ?? "", 120)}" → sent: "${clip(p.final ?? "", 120)}"`, d.reason ?? `grounding ${d.action ?? "changed it"}`, !!d.reason);
    }
    if (d.decision === "router.decideActions" && p.confidence === "low") {
      add(d, "router_unsure", "low", `"${messageBefore(d.at) ?? "?"}": ${p.reason ?? ""}`, "router confidence low", true);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Conversation checks (no model)

const POINT_BACK = /\b(already sent (you|that|it)|just sent (you|that|it)|check (it|that|them|those) (out )?above|(sent|see) (it|that|one) above|the one above)\b/i;
const ONLY_ONE = /\b(just (that|this) one|only (one|thing)|the one (from that \w+ )?that (actually )?fits|that'?s (all|the only one)|nothing else (fits|came up|turned up))\b/i;
const isLinkOnly = (t: string) => /^\s*https?:\/\/\S+\s*$/.test(t);

export function conversationFlags(data: ReviewData): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const msgs = data.messages;
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.from !== "co" || isLinkOnly(m.text)) continue;
    // Co's messages since the member last texted, within a few minutes.
    const earlier: ReviewMessage[] = [];
    for (let j = i - 1; j >= 0 && msgs[j].from === "co" && ms(m.at) - ms(msgs[j].at) < 3 * 60_000; j--) earlier.push(msgs[j]);
    const prior = earlier.filter((e) => !isLinkOnly(e.text));
    if (earlier.length) {
      const words = topicWords(m.text);
      const overlap = prior.map((e) => {
        const ew = topicWords(e.text);
        return words.size ? [...words].filter((w) => ew.has(w)).length / words.size : 0;
      });
      const repeats = words.size >= 4 && overlap.some((o) => o >= 0.6);
      if (POINT_BACK.test(m.text) || repeats) {
        flags.push({
          userId: data.userId,
          at: m.at,
          type: "restated_own_message",
          severity: "medium",
          snippet: clip(`"${prior[0]?.text ?? earlier[0].text}" then "${m.text}"`, 300),
          decisionIds: turnRowIds(data.decisions, m.at, data.messages),
          cause: POINT_BACK.test(m.text) ? "the reply after sent results pointed back at them" : "the reply repeated what was just sent",
          causeConfirmed: true,
          source: "conversation",
        });
      }
    }
    if (ONLY_ONE.test(m.text)) {
      const { start } = turnBounds(msgs, m.at);
      const offered = data.decisions.filter((d) => d.decision === "match.gate" && d.outcome === "act" && ms(d.at) >= start && ms(d.at) <= ms(m.at));
      if (offered.length > 1) {
        flags.push({
          userId: data.userId,
          at: m.at,
          type: "only_one_claim",
          severity: "high",
          snippet: clip(`"${m.text}" (${offered.length} passed the gate: ${offered.map((d) => d.proposal?.name).filter(Boolean).slice(0, 5).join(", ")})`, 300),
          decisionIds: offered.map((d) => d.id),
          cause: `${offered.length} results passed every check; fewer were sent`,
          causeConfirmed: true,
          source: "conversation",
        });
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The member's own reactions

const CALLED_OUT = /\b(not what i (asked|said|meant)|you already (said|sent|asked|told)|that'?s not (it|right|what)|wrong (one|link|event|date|time)|i (just|already) (said|told you)|you('re| are) not (listening|getting it)|why (did|are) you|stop sending|didn'?t ask (for|about)|made (that|it) up)\b/i;

export function reactionFlags(data: ReviewData): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const e of data.emotions) {
    if (signalTarget({ source: e.source, about: e.about, target: e.target as any }) !== "co" || e.intensity === "low") continue;
    flags.push({
      userId: data.userId,
      at: e.at,
      type: "member_frustrated_with_co",
      severity: e.intensity === "high" ? "high" : "medium",
      snippet: clip(`${e.emotion} (${e.intensity})${e.about ? ` about ${e.about}` : ""}${e.quote ? `: "${e.quote}"` : ""}`),
      decisionIds: turnRowIds(data.decisions, e.at, data.messages),
      cause: "emotion read targeted at Co",
      causeConfirmed: true,
      source: "reaction",
    });
  }
  for (const r of data.issues) {
    flags.push({
      userId: data.userId,
      at: r.at,
      type: "member_reported_issue",
      severity: (["low", "medium", "high"].includes(r.severity) ? r.severity : "medium") as Severity,
      snippet: clip(`"${r.message}" (${r.category}: ${r.summary})`),
      decisionIds: turnRowIds(data.decisions, r.at, data.messages),
      cause: r.summary,
      causeConfirmed: false,
      source: "reaction",
    });
  }
  for (const m of data.messages) {
    if (m.from !== "member" || !CALLED_OUT.test(m.text)) continue;
    // Already in user_reported_issues: counted once.
    if (data.issues.some((r) => Math.abs(ms(r.at) - ms(m.at)) < 2 * 60_000)) continue;
    const lastCo = [...data.messages].reverse().find((x) => x.from === "co" && ms(x.at) < ms(m.at));
    flags.push({
      userId: data.userId,
      at: m.at,
      type: "member_called_out_miss",
      severity: "high",
      snippet: clip(`${lastCo ? `Co: "${clip(lastCo.text, 120)}" → ` : ""}member: "${m.text}"`, 300),
      decisionIds: turnRowIds(data.decisions, lastCo?.at ?? m.at, data.messages),
      cause: "their reply calls out the message before it",
      causeConfirmed: false,
      source: "reaction",
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Model review of the day's conversation

const MODEL_TYPES = ["repeat_question", "answer_missed_question", "contradiction_or_unbacked_claim", "off_voice", "promise_without_ask"] as const;

function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

// A quote counts only if it's really in one message of the conversation.
export function findQuoted(quote: string, messages: ReviewMessage[]): ReviewMessage | null {
  const q = normalizeQuote(quote).replace(/^["']|["']$/g, "");
  if (q.length < 6) return null;
  return messages.find((m) => normalizeQuote(m.text).includes(q)) ?? null;
}

export function transcriptFor(data: ReviewData): string {
  return data.messages
    .map((m) => `[${new Date(m.at).toISOString().slice(11, 16)}] ${m.from === "member" ? data.firstName : m.from === "call" ? "Call" : "Co"}: ${m.text}`)
    .join("\n");
}

// What Co's log says it did, so claims about its own actions can be checked.
export function loggedActions(data: ReviewData): string {
  const lines: string[] = (data.openAsks ?? []).map((a) => `[saved ${a.savedAt.slice(0, 10)}] open ask the daily search keeps looking for: "${a.text}"`);
  for (const d of data.decisions) {
    const t = new Date(d.at).toISOString().slice(11, 16);
    const p = d.proposal ?? {};
    if (d.decision === "reply.saveAsk" && p.saved) lines.push(`[${t}] saved an ask for the daily search: "${p.saved}"`);
    else if (d.decision === "profile.write" && p.ask?.text) lines.push(`[${t}] ${d.action === "open_new_ask" ? "saved a new ask" : "updated an ask"}: "${p.ask.text}"`);
    else if (d.decision === "recommendation.search") lines.push(`[${t}] searched for "${p.message ?? "?"}": ${d.action}${Array.isArray(p.matches) ? ` (${p.matches.map((m: any) => m.name).slice(0, 5).join(", ")})` : ""}`);
    else if (d.decision === "proactive.dailyPick" && d.outcome === "act") lines.push(`[${t}] sent a proactive ${String(d.action ?? "").replace("send:", "")}`);
    else if (d.decision === "recommendation.lateResult") lines.push(`[${t}] late search result: ${d.action}`);
  }
  return lines.join("\n") || "(nothing logged)";
}

export const EARLIER_DAYS = 7;

export function earlierRecord(data: ReviewData): string {
  const e = data.earlier;
  if (!e || (!e.sent.length && !e.theySaid.length)) return "(nothing earlier)";
  return [
    e.sent.length ? `What Co sent them:\n${e.sent.join("\n")}` : null,
    e.theySaid.length ? `What ${data.firstName} told Co:\n${e.theySaid.join("\n")}` : null,
    e.coSaid?.length ? `What Co texted them (how it described what it sent):\n${e.coSaid.join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
}

export function modelReviewPrompt(data: ReviewData): string {
  return `${CO_VOICE}

You're reviewing a day of texts between Co (above) and ${data.firstName}, a test user, to find Co's bad responses so a developer can fix them. Flag only what the conversation itself shows. Never infer a problem you can't point to.

What Co can do and its standing rules (true; Co may state these):
${capabilitySheet().map((c) => `- ${c}`).join("\n")}

What Co's decision log says it did today:
${loggedActions(data)}

The ${EARLIER_DAYS} days before today (also real, from the record; Co can rightly refer back to any of it):
${earlierRecord(data)}

The conversation (times UTC):
${transcriptFor(data)}

Flag these, and only these:
- repeat_question: Co asks something it already asked today, or something the conversation already answered.
- answer_missed_question: Co's reply doesn't answer what ${data.firstName} just asked (answers a different question, or ignores part of it).
- contradiction_or_unbacked_claim: Co contradicts itself; or claims something about its own actions ("I sent you", "I found", "I checked", "I saved") that neither today's decision log nor the earlier record backs up; or says something about ${data.firstName} that they never said, today or in the earlier record, and that isn't one of their open asks. Co naming or describing something it sent in its own words (as it did in the earlier record) is backed; a loose "yesterday" for something sent in the last few days is not worth flagging.
- off_voice: a reply that's robotic, templated, or breaks Co's voice described at the top (reads like a system, points at its own messages, lists, hype, filler).
- promise_without_ask: Co promises to keep looking or text later, but nothing in the log above (an open ask, whenever it was saved, or an ask saved that day before the promise) covers that topic.

Every flag must quote the exact words from the conversation that show it, copied character for character from the messages (one or two short quotes). If you can't quote it, don't flag it. Empty is a fine answer.

Return ONLY JSON: {"flags": [{"type": "...", "severity": "low" | "medium" | "high", "quotes": ["..."], "why": "one plain sentence"}]}`;
}

export async function modelFlags(data: ReviewData): Promise<ReviewFlag[]> {
  if (!data.messages.some((m) => m.from === "co")) return [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      // Room to think and still answer: at the default 4,096 the model spent
      // all of it thinking on a busy day and the review silently came back
      // empty (2026-09-26).
      maxOutputTokens: 16_000,
      experimental_telemetry: { isEnabled: true, functionId: "devReview.modelFlags" },
      prompt: modelReviewPrompt(data),
    });
    const parsed = parseModelJson<{ flags?: { type?: string; severity?: string; quotes?: string[]; why?: string }[] }>(text);
    const out: ReviewFlag[] = [];
    for (const f of parsed?.flags ?? []) {
      if (!MODEL_TYPES.includes(f.type as any) || !Array.isArray(f.quotes) || !f.quotes.length) continue;
      const found = f.quotes.map((q) => findQuoted(q, data.messages));
      // No inferred problems: every quote has to be really there.
      if (found.some((m) => !m)) continue;
      const at = found.map((m) => m!.at).sort().pop()!;
      out.push({
        userId: data.userId,
        at,
        type: f.type as FlagType,
        severity: (["low", "medium", "high"].includes(f.severity ?? "") ? f.severity : "medium") as Severity,
        snippet: clip(f.quotes.map((q) => `"${q}"`).join(" … "), 300),
        decisionIds: turnRowIds(data.decisions, at, data.messages),
        cause: `${f.why ?? "flagged in review"} (guess)`,
        causeConfirmed: false,
        source: "model",
      });
    }
    return out;
  } catch (err: any) {
    console.error("devReview: model review failed (non-fatal):", err?.message ?? err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Loading, storing, digest

export async function loadReviewData(userId: string, since: Date, until: Date): Promise<ReviewData> {
  const range = [userId, since.toISOString(), until.toISOString()];
  const [user, msgs, decisions, emotions, issues, asks] = await Promise.all([
    pool.query(`SELECT first_name FROM users WHERE id = $1`, [userId]),
    pool.query(
      `SELECT id, created_at, content FROM co_memories
       WHERE user_id = $1 AND memory_type = 'text_exchange' AND created_at >= $2 AND created_at < $3 ORDER BY created_at`,
      range,
    ),
    pool.query(
      `SELECT id, created_at, decision, outcome, action, reason, proposal, checks FROM harness_decisions
       WHERE user_id = $1 AND created_at >= $2::timestamptz - INTERVAL '5 minutes' AND created_at < $3::timestamptz + INTERVAL '5 minutes' ORDER BY created_at`,
      range,
    ),
    pool
      .query(`SELECT created_at, source, emotion, intensity, about, quote, target FROM emotion_signals WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`, range)
      .catch(() => ({ rows: [] as any[] })),
    pool
      .query(`SELECT created_at, message, summary, category, severity FROM user_reported_issues WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`, range)
      .catch(() => ({ rows: [] as any[] })),
    pool
      .query(`SELECT ask_text, created_at FROM ask_checkins WHERE user_id = $1 AND created_at < $2 AND (resolved_at IS NULL OR resolved_at >= $2) ORDER BY created_at`, [userId, until.toISOString()])
      .catch(() => ({ rows: [] as any[] })),
  ]);
  // The week before: what Co sent (offers, search results, proactive
  // texts) and what they said, newest kept when it's long.
  const [earlierMem, earlierSends] = await Promise.all([
    pool
      .query(
        `SELECT created_at, memory_type, content FROM co_memories
         WHERE user_id = $1 AND created_at >= $2::timestamptz - make_interval(days => $3) AND created_at < $2
           AND (memory_type = 'text_exchange' OR memory_type = 'recommendation_offered' OR (memory_type = 'system' AND content LIKE '[search]%'))
         ORDER BY created_at DESC LIMIT 200`,
        [userId, since.toISOString(), EARLIER_DAYS],
      )
      .catch(() => ({ rows: [] as any[] })),
    pool
      .query(
        `SELECT sent_at, type, message FROM proactive_sends WHERE user_id = $1 AND sent_at >= $2::timestamptz - make_interval(days => $3) AND sent_at < $2 AND message IS NOT NULL ORDER BY sent_at DESC LIMIT 30`,
        [userId, since.toISOString(), EARLIER_DAYS],
      )
      .catch(() => ({ rows: [] as any[] })),
  ]);
  return reviewDataFromRows({
    userId,
    firstName: user.rows[0]?.first_name ?? "Member",
    msgs: msgs.rows,
    decisions: decisions.rows,
    emotions: emotions.rows,
    issues: issues.rows,
    asks: asks.rows,
    earlierMem: earlierMem.rows,
    earlierSends: earlierSends.rows,
  });
}

// Pure: the rows the review reads, shaped for it (tests replay real rows).
export function reviewDataFromRows(r: { userId: string; firstName: string; msgs: any[]; decisions: any[]; emotions: any[]; issues: any[]; asks: any[]; earlierMem: any[]; earlierSends: any[] }): ReviewData {
  const { userId } = r;
  const iso = (d: any) => new Date(d).toISOString();
  const day = (d: any) => new Date(d).toISOString().slice(0, 10);
  const sent: string[] = [];
  const theySaid: string[] = [];
  const coSaid: string[] = [];
  for (const m of r.earlierMem) {
    const c = String(m.content).replace(/\s+/g, " ").trim();
    if (m.memory_type === "text_exchange" && c.startsWith("User said:")) theySaid.push(`[${day(m.created_at)}] "${clip(c.replace(/^User said:\s*/, ""), 200)}"`);
    else if (m.memory_type === "text_exchange") coSaid.push(`[${day(m.created_at)}] "${clip(c.replace(/^Co replied:\s*/, ""), 200)}"`);
    else if (m.memory_type === "recommendation_offered") {
      const name = (() => { try { return JSON.parse(c).name; } catch { return null; } })();
      if (name) sent.push(`[${day(m.created_at)}] recommended "${clip(String(name), 120)}"`);
    } else sent.push(`[${day(m.created_at)}] ${clip(c.replace(/^\[search\]\s*/, ""), 240)}`);
  }
  for (const x of r.earlierSends) sent.push(`[${day(x.sent_at)}] texted them unprompted (${x.type}): "${clip(String(x.message).replace(/\s+/g, " "), 160)}"`);
  return {
    userId,
    firstName: r.firstName,
    messages: r.msgs.map((r: any) => {
      const c = String(r.content);
      const from = c.startsWith("User said:") ? "member" : c.startsWith("Co replied:") ? "co" : "call";
      return { id: String(r.id), at: iso(r.created_at), from, text: c.replace(/^(User said|Co replied):\s*/, "").trim() } as ReviewMessage;
    }),
    decisions: r.decisions.map((r: any) => ({ id: Number(r.id), at: iso(r.created_at), decision: r.decision, outcome: r.outcome, action: r.action, reason: r.reason, proposal: r.proposal, checks: r.checks })),
    emotions: r.emotions.map((r: any) => ({ at: iso(r.created_at), source: r.source, emotion: r.emotion, intensity: r.intensity, about: r.about, quote: r.quote, target: r.target })),
    issues: r.issues.map((r: any) => ({ at: iso(r.created_at), message: r.message, summary: r.summary, category: r.category, severity: r.severity })),
    openAsks: r.asks.map((r: any) => ({ text: String(r.ask_text), savedAt: iso(r.created_at) })),
    earlier: { sent: sent.slice(0, 50).reverse(), theySaid: theySaid.slice(0, 60).reverse(), coSaid: coSaid.slice(0, 60).reverse() },
  };
}

// Co's own judgment (2026-09-25): every tool Co chose, with the member's
// message and Co's stated reason, read by Jev in one request per member.
// Only clear mismatches are flagged ("a contact card when they wanted a
// link", "a search when they only wanted to talk"), always as a guess for a
// person to check. Member text goes to Jev only through the zero-retention
// gateway, and only where JEV_MEMBER=on (services/jevGateway.ts).
export const JUDGMENT_FLAG_BELOW = 0.3;
export async function judgmentFlags(data: ReviewData): Promise<ReviewFlag[]> {
  const calls = data.decisions.filter((d) => d.decision.startsWith("tool.") && d.outcome === "act");
  if (!calls.length) return [];
  const { askJevZdr, jevForMemberText } = await import("../services/jevGateway.js");
  if (!jevForMemberText()) return [];
  const { abilityForTool } = await import("../services/capabilities.js");
  const listed: Record<string, unknown> = {};
  const questions: Record<string, { type: "boolean"; instructions: string }> = {};
  calls.slice(0, 40).forEach((d, i) => {
    const tool = d.decision.slice(5);
    listed[`k${i}`] = {
      member_said: String(d.proposal?.message ?? "").slice(0, 300),
      co_chose: abilityForTool(tool)?.can ?? tool,
      co_reason: d.reason ?? "",
    };
    questions[`k${i}`] = {
      type: "boolean",
      instructions: `For calls.k${i}: was what co_chose a sensible response to what member_said? Yes if it fits what they asked for or clearly helps them. No only if it's a clear mismatch, like sending a contact card when they wanted a link, or searching when they only wanted to talk.`,
    };
  });
  const r = await askJevZdr({ calls: listed }, questions, 10_000).catch(() => null);
  if (!r) return [];
  const flags: ReviewFlag[] = [];
  calls.slice(0, 40).forEach((d, i) => {
    const p = r[`k${i}`];
    if (typeof p !== "number" || p >= JUDGMENT_FLAG_BELOW) return;
    flags.push({
      userId: data.userId,
      at: d.at,
      type: "questionable_tool_choice",
      severity: p < 0.1 ? "high" : "medium",
      snippet: `"${String(d.proposal?.message ?? "").slice(0, 120)}" → ${d.decision.slice(5)}`,
      decisionIds: [d.id],
      cause: `Jev thinks this was a mismatch (${Math.round(p * 100)}% sensible). Co's reason: ${d.reason || "none given"}`,
      causeConfirmed: false,
      source: "model",
    });
  });
  return flags;
}

export async function reviewWindow(since: Date, until: Date, opts: { model?: boolean; userIds?: string[] } = {}): Promise<{ flags: ReviewFlag[]; names: Record<string, string> }> {
  const flags: ReviewFlag[] = [];
  const names: Record<string, string> = {};
  for (const userId of opts.userIds ?? (await reviewUserIds())) {
    const data = await loadReviewData(userId, since, until);
    names[userId] = data.firstName;
    flags.push(...logFlags(data), ...conversationFlags(data), ...reactionFlags(data));
    if (opts.model !== false) flags.push(...(await modelFlags(data)), ...(await judgmentFlags(data).catch(() => [])));
  }
  return { flags: flags.sort((a, b) => ms(a.at) - ms(b.at)), names };
}

export type FlagGroup = { type: FlagType; count: number; worst: Severity; flags: ReviewFlag[] };

// By type, most frequent first, then worst severity.
export function groupFlags(flags: ReviewFlag[]): FlagGroup[] {
  const byType = new Map<FlagType, ReviewFlag[]>();
  for (const f of flags) byType.set(f.type, [...(byType.get(f.type) ?? []), f]);
  return [...byType.entries()]
    .map(([type, fs]) => ({ type, count: fs.length, worst: fs.reduce<Severity>((w, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), "low"), flags: fs }))
    .sort((a, b) => b.count - a.count || SEVERITY_RANK[b.worst] - SEVERITY_RANK[a.worst]);
}

const pacific = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", weekday: "short" });

// The morning text: the 6 flag types that fired most, one example each, so it
// stays readable (Royce, 2026-09-18). The full review keeps every type.
export const DIGEST_MAX_TYPES = 6;
export function renderDigest(flags: ReviewFlag[], names: Record<string, string>, label: string, maxGroups = DIGEST_MAX_TYPES): string[] {
  const groups = groupFlags(flags);
  if (!groups.length) return [`Co review, ${label}: nothing flagged.`];
  const lines = groups.slice(0, maxGroups).map((g) => {
    const ex = [...g.flags].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
    return `• ${FLAG_LABELS[g.type]} ×${g.count} (${g.worst})\n  ${names[ex.userId] ?? "?"}, ${pacific(ex.at)}: ${clip(ex.snippet, 140)}\n  Cause: ${clip(ex.cause, 110)}${ex.causeConfirmed ? "" : ex.cause.endsWith("(guess)") ? "" : " (guess)"}`;
  });
  const more = groups.length > maxGroups ? `\nPlus ${groups.length - maxGroups} less frequent type${groups.length - maxGroups === 1 ? "" : "s"} in the full review.` : "";
  return [`Co review, ${label}: ${flags.length} flag${flags.length === 1 ? "" : "s"} in ${groups.length} type${groups.length === 1 ? "" : "s"}.`, `${lines.join("\n")}${more}`, `Full detail with decision-log rows: ask Claude "what broke since ${label.replace(/^last /, "")}".`];
}

// Events the fit check turned down, so a wrongly rejected good one is visible (2026-09-21: we
// only ever see what Co sends). Pure half: dedupes by name, keeps the first reason, caps the list.
export type RejectedEvent = { name: string; why: string | null };

export function renderRejectedSample(items: RejectedEvent[], max = 6): string | null {
  const seen = new Set<string>();
  const unique = items.filter((i) => i.name && !seen.has(i.name.toLowerCase()) && seen.add(i.name.toLowerCase()));
  if (!unique.length) return null;
  const shown = unique.slice(0, max).map((i) => `• ${clip(i.name, 60)}${i.why ? `: ${clip(i.why, 80)}` : ""}`);
  const more = unique.length > max ? `\nPlus ${unique.length - max} more.` : "";
  return `Events Co turned down as not fitting (${unique.length}). Skim for a good one it missed:\n${shown.join("\n")}${more}`;
}

// The morning report as an email (Royce, 2026-09-30: "It needs to be neater to
// read ... Place the morning report into the emails and stop texting my phone").
// Every flag type, most frequent first; each with what it means in plain words,
// the worst example and its likely cause. Then the events Co turned down.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SEVERITY_STYLE: Record<Severity, { bg: string; fg: string; label: string }> = {
  high: { bg: "#FDE8E8", fg: "#9B1C1C", label: "High" },
  medium: { bg: "#FEF3C7", fg: "#92400E", label: "Medium" },
  low: { bg: "#E5E7EB", fg: "#374151", label: "Low" },
};

export function renderDigestEmail(
  flags: ReviewFlag[],
  names: Record<string, string>,
  opts: { date: Date; rejected?: RejectedEvent[] } ,
): { subject: string; html: string; text: string } {
  const groups = groupFlags(flags);
  const day = opts.date.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });
  const high = groups.filter((g) => g.worst === "high").length;
  const subject = groups.length
    ? `Co morning report, ${day}: ${flags.length} flag${flags.length === 1 ? "" : "s"}${high ? `, ${high} high` : ""}`
    : `Co morning report, ${day}: nothing flagged`;
  const seenRejected = new Set<string>();
  const rejected = (opts.rejected ?? []).filter((i) => i.name && !seenRejected.has(i.name.toLowerCase()) && seenRejected.add(i.name.toLowerCase())).slice(0, 10);

  const chip = (sev: Severity) => {
    const s = SEVERITY_STYLE[sev];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${s.bg};color:${s.fg};font-size:12px;font-weight:600">${s.label}</span>`;
  };
  const card = (g: FlagGroup) => {
    const ex = [...g.flags].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
    const cause = `${ex.cause}${ex.causeConfirmed ? "" : ex.cause.endsWith("(guess)") ? "" : " (likely)"}`;
    return `<tr><td style="padding:0 0 12px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:10px"><tr><td style="padding:16px 18px">
<div style="font-size:15px;font-weight:600;color:#111827">${esc(FLAG_LABELS[g.type])} <span style="color:#6B7280;font-weight:400">× ${g.count}</span> &nbsp;${chip(g.worst)}</div>
<div style="margin-top:10px;font-size:13px;color:#6B7280">${esc(names[ex.userId] ?? "Someone")} · ${esc(pacific(ex.at))}</div>
<div style="margin-top:4px;font-size:14px;color:#1F2937;line-height:1.5;border-left:3px solid #E5E7EB;padding-left:10px">${esc(clip(ex.snippet, 260))}</div>
<div style="margin-top:8px;font-size:13px;color:#374151;line-height:1.5"><b>Cause:</b> ${esc(clip(cause, 220))}</div>
</td></tr></table></td></tr>`;
  };
  const summaryRows = groups
    .map((g) => `<tr><td style="padding:4px 0;font-size:14px;color:#1F2937">${esc(FLAG_LABELS[g.type])}</td><td style="padding:4px 0;font-size:14px;color:#1F2937;text-align:right;white-space:nowrap">${g.count} &nbsp;${chip(g.worst)}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F3F4F6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<tr><td style="padding:0 4px 18px 4px">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280">Co morning report</div>
<div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px">${esc(day)}</div>
<div style="font-size:14px;color:#4B5563;margin-top:6px">Last 24 hours on co-test: ${groups.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"} in ${groups.length} type${groups.length === 1 ? "" : "s"}${high ? `, ${high} of them high` : ""}.` : "nothing flagged."}</div>
</td></tr>
${groups.length ? `<tr><td style="padding:0 0 16px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:10px"><tr><td style="padding:14px 18px">
<div style="font-size:13px;font-weight:600;color:#6B7280;margin-bottom:6px">At a glance</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${summaryRows}</table>
</td></tr></table></td></tr>
<tr><td style="padding:4px 4px 10px 4px;font-size:13px;font-weight:600;color:#6B7280">One example of each, worst first</td></tr>
${groups.map(card).join("\n")}` : ""}
${rejected.length ? `<tr><td style="padding:8px 0 12px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:10px"><tr><td style="padding:14px 18px">
<div style="font-size:15px;font-weight:600;color:#111827">Events Co turned down <span style="color:#6B7280;font-weight:400">× ${rejected.length}</span></div>
<div style="font-size:13px;color:#6B7280;margin:4px 0 8px 0">Skim for a good one it missed.</div>
${rejected.map((r) => `<div style="font-size:14px;color:#1F2937;padding:5px 0;border-top:1px solid #F3F4F6"><b>${esc(clip(r.name, 70))}</b>${r.why ? `<br><span style="color:#6B7280;font-size:13px">${esc(clip(r.why, 120))}</span>` : ""}</div>`).join("")}
</td></tr></table></td></tr>` : ""}
<tr><td style="padding:8px 4px;font-size:12px;color:#9CA3AF">Full detail with decision-log rows: ask Claude "what broke since 24h".</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Co morning report, ${day}`,
    groups.length ? `${flags.length} flags in ${groups.length} types.` : "Nothing flagged.",
    ...groups.map((g) => {
      const ex = [...g.flags].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
      return `
${FLAG_LABELS[g.type]} x${g.count} (${g.worst})
  ${names[ex.userId] ?? "Someone"}, ${pacific(ex.at)}: ${clip(ex.snippet, 200)}
  Cause: ${clip(ex.cause, 160)}`;
    }),
    ...(rejected.length ? [`
Events Co turned down (${rejected.length}):`, ...rejected.map((r) => `- ${r.name}${r.why ? `: ${r.why}` : ""}`)] : []),
  ].join("\n");
  return { subject, html, text };
}

// The sweep records why each event was turned down (sweep.surface: the fit gate's rejections and
// the personal-fit "doesn't fit" skips). Newest first, deduped by name.
export async function rejectedEvents(since: Date, until: Date, limit = 40): Promise<RejectedEvent[]> {
  const { rows } = await pool.query(
    `SELECT proposal FROM harness_decisions WHERE decision = 'sweep.surface' AND created_at >= $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 200`,
    [since, until],
  );
  const out: RejectedEvent[] = [];
  for (const r of rows) {
    const p = r.proposal ?? {};
    for (const x of Array.isArray(p.scope?.relevanceRejected) ? p.scope.relevanceRejected : []) if (typeof x?.name === "string") out.push({ name: x.name, why: typeof x.why === "string" ? x.why : null });
    for (const x of Array.isArray(p.skipped) ? p.skipped : [])
      if (typeof x?.name === "string" && typeof x?.why === "string" && /^doesn't fit/i.test(x.why)) out.push({ name: x.name, why: x.why.replace(/^doesn't fit:\s*/i, "") });
    if (out.length >= limit) break;
  }
  return out;
}

// Plain-text report for a session ("what broke since X"): every flag, grouped.
export function renderReport(flags: ReviewFlag[], names: Record<string, string>, decisionNames: Map<number, string>): string {
  const groups = groupFlags(flags);
  if (!groups.length) return "Nothing flagged.";
  return groups
    .map(
      (g) =>
        `== ${FLAG_LABELS[g.type]} ×${g.count} (worst: ${g.worst})\n` +
        g.flags
          .map(
            (f) =>
              `- ${names[f.userId] ?? f.userId} ${pacific(f.at)} [${f.severity}, ${f.source}]\n  ${f.snippet}\n  cause: ${f.cause}${f.causeConfirmed ? " (log)" : f.cause.endsWith("(guess)") ? "" : " (guess)"}\n  decisions: ${f.decisionIds.map((id) => `${id} ${decisionNames.get(id) ?? ""}`.trim()).join(", ") || "none"}`,
          )
          .join("\n"),
    )
    .join("\n\n");
}

function flagKey(f: ReviewFlag): string {
  return createHash("sha1").update(`${f.userId}|${f.type}|${f.at}|${f.snippet}`).digest("hex");
}

export async function storeFlags(flags: ReviewFlag[]): Promise<number> {
  if (!reviewEnabled()) return 0;
  let stored = 0;
  for (const f of flags) {
    const r = await pool.query(
      `INSERT INTO review_flags (flag_key, user_id, flagged_at, type, severity, snippet, decision_ids, cause, cause_confirmed, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (flag_key) DO NOTHING RETURNING id`,
      [flagKey(f), f.userId, f.at, f.type, f.severity, f.snippet, f.decisionIds, f.cause, f.causeConfirmed, f.source],
    );
    stored += r.rowCount ?? 0;
  }
  return stored;
}

// For a session ("what broke since X"): prints the full report or the digest.
// On co-test, where the scripts folder isn't built:
//   node --input-type=module -e "const m = await import('/app/co-test/dist/api/src/harness/devReview.js'); await m.printReview({ since: '24h' })"
export async function printReview(opts: { since?: string; until?: string; model?: boolean; digest?: boolean; store?: boolean } = {}): Promise<void> {
  const when = (v: string | undefined, fallback: Date): Date => {
    if (!v) return fallback;
    const rel = v.match(/^(\d+(?:\.\d+)?)(h|d)$/);
    if (rel) return new Date(Date.now() - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000));
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`can't read the time "${v}"`);
    return d;
  };
  const until = when(opts.until, new Date());
  const since = when(opts.since, new Date(until.getTime() - 86_400_000));
  const { flags, names } = await reviewWindow(since, until, { model: opts.model !== false });
  const label = opts.since ? `since ${opts.since}` : "last 24h";
  if (opts.digest) {
    console.log(renderDigest(flags, names, label).join("\n\n"));
  } else {
    const ids = [...new Set(flags.flatMap((f) => f.decisionIds))];
    const { rows } = ids.length ? await pool.query(`SELECT id, decision, action FROM harness_decisions WHERE id = ANY($1::bigint[])`, [ids]) : { rows: [] as any[] };
    const decisionNames = new Map<number, string>(rows.map((r: any) => [Number(r.id), `${r.decision}${r.action ? `:${r.action}` : ""}`]));
    console.log(`What broke ${label} (${since.toISOString()} to ${until.toISOString()}): ${flags.length} flags\n`);
    console.log(renderReport(flags, names, decisionNames));
  }
  const rejectedText = renderRejectedSample(await rejectedEvents(since, until).catch(() => []), 12);
  if (rejectedText) console.log(`\n${rejectedText}`);
  if (opts.store) console.log(reviewEnabled() ? `\nstored ${await storeFlags(flags)} new flags` : "\nnot stored: only on co-test with DEV_REVIEW=true");
  await pool.end();
}

// The morning job: the last 24 hours, stored, and emailed to Royce only
// (services/reportEmail.ts). No longer texted (Royce, 2026-09-30).
export async function runMorningReview(now = new Date()): Promise<void> {
  if (!reviewEnabled()) return;
  try {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const { flags, names } = await reviewWindow(since, now);
    const stored = await storeFlags(flags);
    const rejected = await rejectedEvents(since, now).catch(() => [] as RejectedEvent[]);
    const email = renderDigestEmail(flags, names, { date: now, rejected });
    const { sendReportEmail } = await import("../services/reportEmail.js");
    const result = await sendReportEmail(email.subject, email.html, email.text);
    await recordDecision({
      layer: 3,
      decision: "devReview.digest",
      userId: null,
      outcome: result.sent ? "act" : "skip",
      action: result.sent ? `emailed ${result.to}` : "email_not_sent",
      proposal: { since: since.toISOString(), until: now.toISOString(), flags: flags.length, stored, groups: groupFlags(flags).map((g) => ({ type: g.type, count: g.count, worst: g.worst })) },
    });
  } catch (err: any) {
    console.error("devReview: morning review failed (non-fatal):", err?.message ?? err);
    await recordDecision({ layer: 3, decision: "devReview.digest", userId: null, outcome: "skip", action: "failed", reason: String(err?.message ?? err) }).catch(() => {});
  }
}
