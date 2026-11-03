// What a member asked Cue not to bring up, and how they asked Cue to reply (member preferences, PR C; Royce's spec 2026-11-02, section 3:
// "Apply relevant preferences to text, calls, matching, searches, helper results and scheduled work. Saving a note isn't success").
// The rules are theirs (services/memberPreferences.ts, areas "avoid_topic" and "reply_style"); this file applies them where Cue decides:
//   - finds: each thing kept (a sweep's keep, a reply search's share) is read against the subjects, one model read for all of them
//     (memberLimits.ts limitsGate calls judgeTopics);
//   - proactive candidates: one Cue starts on its own (an offer, a check-in) that's about a subject is never queued (enqueueCandidate
//     calls candidateTopicHold), and what's already waiting leaves when the rule is set (dropTopicWork);
//   - replies: the reply check's read (judgeReplyRules) cuts a sentence that raises a subject they didn't raise, and flags a reply that
//     clearly breaks how they asked Cue to reply (logged; style isn't guaranteed in code, it's measured by tests).
// Relevance is always a model read, never words matched in code: "don't bring up my divorce" is about what a thing is about, and no
// word list knows that. A read that can't be had holds what Cue would start on its own (never sent unread), and never holds what they
// asked for themselves.
import pool from "../db/db.js";
import { recordDecision, type GateCheck } from "../harness/core.js";
import { inForce, type Preference, type ReplyRules } from "./memberPreferences.js";
import { readAvoidAnswer, realJudgeDeps, type JudgeDeps, type Judged } from "./memberLimits.js";
import { parseModelJson } from "./modelJson.js";

// Pure: the subjects they asked Cue not to bring up, in force now, in their own words (explicit only: an inferred read stays tentative),
// each with its rule's id. Logs carry the id, never the subject (their words stay on their record only).
export function topicRules(prefs: Preference[] | null | undefined, now: Date = new Date()): { id: string; topic: string }[] {
  const out = new Map<string, string>();
  for (const p of prefs ?? []) if (p.area === "avoid_topic" && p.basis === "explicit" && p.rule.topic && inForce(p, now) && !out.has(p.rule.topic.trim())) out.set(p.rule.topic.trim(), p.id);
  return [...out].map(([topic, id]) => ({ id, topic }));
}
export function topicsToAvoid(prefs: Preference[] | null | undefined, now: Date = new Date()): string[] {
  return topicRules(prefs, now).map((t) => t.topic);
}
// Pure: the words a log says for one of their subjects: its rule, never the subject.
export const topicRef = (id: string | null | undefined): string => `a subject they asked Cue not to bring up (rule ${id ?? "?"})`;

// ---------------------------------------------------------------- the read: is this thing about one of their subjects?

export function topicPrompt(items: Judged[], topics: string[], theirAsk?: string | null): string {
  return `A member asked Cue not to bring up these subjects: ${topics.map((t) => `"${t}"`).join(", ")}.
${theirAsk?.trim() ? `\nWhat they asked for this time, in their words: "${theirAsk.trim().slice(0, 400)}". A subject their own request is about is theirs to raise: don't mark a thing for it.\n` : ""}
For each thing below, say which of those subjects it is clearly about: its main subject, or something it would make Cue raise with them. A thing that only shares a word with a subject isn't about it. If it isn't clearly about one of them, null.

${items.map((it, i) => `${i + 1}. ${it.name}\n${it.details.replace(/\s+/g, " ").slice(0, 600) || "(only the name)"}`).join("\n\n")}

Answer only with JSON: [{"n": 1, "kind": "one of the subjects above, exactly as written" | null}, ...]`;
}

// Which subject each thing is about (null: none). Null for the whole list when the read couldn't be had or read: the caller holds.
export async function judgeTopics(items: Judged[], topics: string[], o: { ask?: string | null; deps?: JudgeDeps } = {}): Promise<(string | null)[] | null> {
  if (!items.length || !topics.length) return items.map(() => null);
  const raw = await (o.deps ?? realJudgeDeps).model(topicPrompt(items, topics, o.ask)).catch(() => "");
  return readAvoidAnswer(raw, items.length, topics);
}

// ---------------------------------------------------------------- proactive candidates

// Pure: what a candidate is about, for the read: its summary and the words its payload carries (a find's name and details, the ask it's
// for). Internal text only; never shown to the member.
export function candidateJudged(c: { summary?: string | null; payload?: any }): Judged {
  const pl = c.payload ?? {};
  const m = pl.match ?? null;
  const parts = [pl.askText, pl.goal, pl.topic, pl.text, pl.draft, m?.details?.description, m?.details?.summary, m?.reason, m?.whyItFits].filter((x) => typeof x === "string" && x.trim());
  return { name: String(m?.name ?? c.summary ?? "").slice(0, 200), details: [c.summary, ...parts].filter(Boolean).join(" ").slice(0, 600) };
}

// What Cue starts on its own (unsolicited offers and check-ins) is held to the subjects; what they asked for themselves never is: a
// requested delivery, a booked call's notice, and an offer that answers an open ask of theirs (the send gate's own class,
// harness/notifyGate.ts candidateClass with proactive.ts isAnswering). Unknown types count as Cue's own.
async function topicApplies(type: string, payload: any, answering?: boolean): Promise<boolean> {
  const { candidateClass } = await import("../harness/notifyGate.js");
  const ans = answering ?? (await import("../harness/proactive.js")).isAnswering({ type, payload } as any);
  return candidateClass(type, ans) !== "requested";
}

export type TopicDeps = { prefs: (userId: string) => Promise<Preference[]>; judge: (items: Judged[], topics: string[]) => Promise<(string | null)[] | null> };
export const realTopicDeps: TopicDeps = {
  prefs: async (userId) => (await import("./memberPreferences.js")).activePreferences(userId),
  judge: (items, topics) => judgeTopics(items, topics),
};

// enqueueCandidate's check (harness/proactive.ts), before a new candidate is queued: null when it may queue; else why not. A member with
// no such rule costs one indexed read of their rules and no model call.
// isNew: whether no candidate for this target exists yet (read only once the member has such a rule).
// answering: the candidate answers an open ask of theirs (proactive.ts isAnswering); read from the payload when left out.
// The reason it returns is logged: it names the rule's id, never the subject.
export async function candidateTopicHold(input: { userId: string; type: string; summary?: string | null; payload?: any; answering?: boolean }, deps: TopicDeps = realTopicDeps, isNew: () => Promise<boolean> = async () => true): Promise<string | null> {
  const rules = topicRules(await deps.prefs(input.userId).catch(() => [] as Preference[]));
  if (!rules.length || !(await topicApplies(input.type, input.payload, input.answering))) return null;
  if (!(await isNew().catch(() => true))) return null;
  const kinds = await deps.judge([candidateJudged(input)], rules.map((r) => r.topic)).catch(() => null);
  if (!kinds) return "their subjects couldn't be checked just now (not queued; the next run asks again)";
  return kinds[0] ? topicRef(rules.find((r) => r.topic === kinds[0])?.id) : null;
}

// When the rule is set (memberPreferences.ts applyRuleEffects): what's already waiting about the subject leaves. Pending candidates Cue
// started on its own are skipped, and finds waiting in their backlog go, each read against the subject (AVOID_JUDGE_MAX to a read). A
// read that fails leaves things where they are: each still meets the subject at its own gate (a find at the picker's keep, a new
// candidate at enqueue), so nothing about it can go out on a failed read here.
export type DropDeps = {
  judge: (items: Judged[], topics: string[], ask?: string | null) => Promise<(string | null)[] | null>;
  pending: (userId: string) => Promise<{ id: string; type: string; summary: string | null; payload: any }[]>;
  skipPending: (userId: string, id: string, reason: string) => Promise<boolean>;
  backlogs: (userId: string) => Promise<{ ask_id: string; items: any[] }[]>;
  removeFromBacklog: (userId: string, askId: string, names: Set<string>) => Promise<number>;
};
export const realDropDeps: DropDeps = {
  judge: (items, topics, ask) => judgeTopics(items, topics, { ask }),
  pending: async (userId) =>
    (await pool.query(`SELECT id, type, summary, payload FROM proactive_candidates WHERE user_id = $1 AND status = 'pending'`, [userId])).rows.map((r: any) => ({ id: String(r.id), type: String(r.type), summary: r.summary ?? null, payload: r.payload ?? {} })),
  skipPending: async (userId, id, reason) =>
    !!(await pool.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'pending'`, [id, userId, reason])).rowCount,
  backlogs: async (userId) => (await pool.query(`SELECT ask_id, items FROM event_backlogs WHERE user_id = $1`, [userId])).rows,
  // Under a row lock, merged into the row as it is now (a find a sweep saves meanwhile is never lost).
  removeFromBacklog: async (userId, askId, names) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT items FROM event_backlogs WHERE user_id = $1 AND ask_id = $2 FOR UPDATE`, [userId, askId]);
      const items: any[] = Array.isArray(rows[0]?.items) ? rows[0].items : [];
      const kept = items.filter((it) => !names.has(String(it?.match?.name ?? "")));
      if (kept.length !== items.length) await client.query(`UPDATE event_backlogs SET items = $3, updated_at = NOW() WHERE user_id = $1 AND ask_id = $2`, [userId, askId, JSON.stringify(kept)]);
      await client.query("COMMIT");
      return items.length - kept.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};
const JUDGE_MAX = 20;
async function judgeAll(items: Judged[], topics: string[], deps: Pick<DropDeps, "judge">, ask: string | null = null): Promise<(string | null)[] | null> {
  const out: (string | null)[] = [];
  for (let i = 0; i < items.length; i += JUDGE_MAX) {
    const part = await deps.judge(items.slice(i, i + JUDGE_MAX), topics, ask).catch(() => null);
    if (!part) return null;
    out.push(...part);
  }
  return out;
}
// ruleId: the rule's id, the only thing the skip reason and the log say about it.
export async function dropTopicWork(userId: string, topic: string, deps: DropDeps = realDropDeps, ruleId: string | null = null): Promise<{ skipped: number; removed: number; read: boolean }> {
  const reason = topicRef(ruleId);
  const pending: { id: string; type: string; summary: string | null; payload: any }[] = [];
  for (const c of await deps.pending(userId)) if (await topicApplies(c.type, c.payload)) pending.push(c);
  // Finds waiting for one of their own open asks answer that ask: theirs, never dropped by a subject (as an offer answering it isn't).
  // The rest (their profile's and goals' searches) are judged with the words they were searched for.
  const backlogs = await deps.backlogs(userId);
  const finds = backlogs
    .filter((b) => String(b.ask_id) === "profile" || !String(b.ask_id))
    .flatMap((b) => (Array.isArray(b.items) ? b.items : []).map((it: any) => ({ askId: String(b.ask_id), ask: typeof it?.askText === "string" ? it.askText : null, name: String(it?.match?.name ?? ""), judged: candidateJudged({ summary: it?.match?.name ?? null, payload: { match: it?.match } }) })))
    .filter((f) => f.name);
  let read = true;
  const pendingKinds = pending.length ? await judgeAll(pending.map(candidateJudged), [topic], deps) : [];
  if (!pendingKinds) read = false;
  const findKinds: (string | null)[] = [];
  for (const ask of [...new Set(finds.map((f) => f.ask))]) {
    const group = finds.filter((f) => f.ask === ask);
    const k = await judgeAll(group.map((f) => f.judged), [topic], deps, ask);
    if (!k) read = false;
    group.forEach((f, i) => (findKinds[finds.indexOf(f)] = k?.[i] ?? null));
  }
  let skipped = 0;
  let removed = 0;
  for (let i = 0; i < pending.length; i++) if (pendingKinds?.[i] && (await deps.skipPending(userId, pending[i].id, reason))) skipped++;
  const byAsk = new Map<string, Set<string>>();
  finds.forEach((f, i) => {
    if (!findKinds[i]) return;
    if (!byAsk.has(f.askId)) byAsk.set(f.askId, new Set());
    byAsk.get(f.askId)!.add(f.name);
  });
  for (const [askId, names] of byAsk) removed += await deps.removeFromBacklog(userId, askId, names);
  await recordDecision({ layer: 4, decision: "member.preference.topic_drop", userId, outcome: skipped + removed ? "act" : "skip", action: read ? "read" : "read_failed", proposal: { rule: ruleId, skipped, removed, judged: pending.length + finds.length } }).catch(() => {});
  return { skipped, removed, read };
}

// ---------------------------------------------------------------- the reply check's read

export const PREF_TOPIC = "pref_topic";
export const PREF_STYLE = "pref_style";
// recent: the exchange just before (their lines and Cue's), so a subject they raised a turn or two ago is still theirs ("how's the crypto
// fund?" ... "thanks!").
export function replyRulesPrompt(draft: string, rules: ReplyRules, message: string, recent: string = ""): string {
  const styles = rules.style.map((r, i) => `${i + 1}. ${r.topic ? `When the subject is ${r.topic}` : "Every reply"}: ${r.style} (their words: "${r.words.slice(0, 200)}")`).join("\n");
  return `Cue (an assistant) is about to send a member this text. Check it against the member's own rules for Cue.
${styles ? `\nHow they asked Cue to reply:\n${styles}\n` : ""}${rules.avoid.length ? `\nSubjects they asked Cue not to bring up: ${rules.avoid.map((t) => `"${t}"`).join(", ")}\n` : ""}
${recent.trim() ? `The conversation just before:\n${recent.trim().slice(-1500)}\n\n` : ""}Their message: "${message.slice(0, 1500)}"

Cue's reply: "${draft.slice(0, 3000)}"

Report only clear breaks, never close calls:
- style: the numbers of the reply rules the reply clearly breaks. A rule for one subject applies only when the reply is about that subject.
- raises: each sentence of the reply that brings up one of the subjects when they didn't bring it up themselves, in their message or in their own lines just before (a subject they raised there is theirs: answering about it is fine). Copy the sentence exactly.

Answer only with JSON: {"style": [], "raises": [{"topic": "one of the subjects above, exactly as written", "sentence": "..."}]}`;
}

// Pure: the read's answer, checked in code: a rule number must be one listed, a subject one on the list, a sentence one the reply holds.
export function readReplyRulesAnswer(raw: string, draft: string, rules: ReplyRules): GateCheck[] {
  let out: { style?: unknown; raises?: unknown } | null = null;
  try {
    out = parseModelJson<{ style?: unknown; raises?: unknown }>(raw);
  } catch {
    return [];
  }
  if (!out || typeof out !== "object") return [];
  const checks: GateCheck[] = [];
  const nums = Array.isArray(out.style) ? [...new Set(out.style.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= rules.style.length))] : [];
  for (const n of nums) {
    const r = rules.style[n - 1];
    // Logged by the rule's id, never their words.
    checks.push({ name: PREF_STYLE, pass: false, reason: `style: the reply clearly breaks one of their reply rules (rule ${r.id ?? "?"})` });
  }
  const byLower = new Map(rules.avoid.map((t) => [t.toLowerCase().trim(), t]));
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  for (const x of Array.isArray(out.raises) ? out.raises : []) {
    const topic = typeof (x as any)?.topic === "string" ? byLower.get((x as any).topic.toLowerCase().trim()) : undefined;
    const sentence = typeof (x as any)?.sentence === "string" ? flat((x as any).sentence) : "";
    if (!topic || sentence.length < 6 || !flat(draft).includes(sentence)) continue;
    // The reason names the sentence (it's cut by it, and the sentence is Cue's own draft), never the subject in their words.
    checks.push({ name: PREF_TOPIC, pass: false, reason: `${PREF_TOPIC}: "${sentence}" (raises a subject they asked Cue not to bring up)` });
  }
  return checks;
}

// One small read, only for a member with such rules. A read that fails flags nothing (the reply's facts already carry the rules).
export async function judgeReplyRules(draft: string, rules: ReplyRules, message: string, deps: JudgeDeps = realJudgeDeps, recent: string = ""): Promise<GateCheck[]> {
  if (!draft.trim() || (!rules.style.length && !rules.avoid.length)) return [];
  const raw = await deps.model(replyRulesPrompt(draft, rules, message, recent)).catch(() => "");
  return readReplyRulesAnswer(raw, draft, rules);
}
