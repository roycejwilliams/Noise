// The draft against the move and the whole exchange (Royce, 2026-11-03: "judge its next move against the whole exchange, not just
// whether the next sentence sounds reasonable"). The move and the record come from services/exchangeRecord.ts; this reads only Cue's own
// draft against them (facts: what was sent, what they answered, what "that" was resolved to, what they closed). It never reads their
// words for intent: that's the turn read's job. On a miss the reply gets one rewrite toward the move (agent/conversationTools.ts
// sendReply), in its own words, never a canned line; on a call the sentence is held and Cue answers again in its own words
// (services/callLlmProxy.ts, the #365 hold). Pure.
import { ALWAYS_ASKABLE, questionsIn, sameQuestion } from "./repeatAsk.js";
import { namesItem } from "../services/callClaims.js";
import { INTEREST_Q, MOVE_MEANINGS, normUrl, OFFER_Q, type CallReadInput, type CallTurnRead, type DoneItem, type ExchangeRecord } from "../services/exchangeRecord.js";

export type MoveMiss = { name: "resend" | "reoffer" | "double_ask" | "reask" | "wrong_referent" | "ignores_correction" | "reopen" | "question_after_close" | "find_after_close" | "off_move"; why: string };

const URL = /https?:\/\/[^\s)>\]"']+/g;
// A question a safety or consent check may always ask again (harness/repeatAsk.ts).
const askable = (q: string) => ALWAYS_ASKABLE.test(q);
// A question about how they are, in Cue's own words: never held as a question after a close (review of #368).
export const WELLBEING_Q = /\b(?:are you (?:doing |feeling )?(?:ok|okay|alright|all right|safe|good)|how are you (?:doing|holding up|feeling)|how(?:'s| is) (?:your heart|it sitting|everything)|you (?:ok|okay|good)\b|anyone (?:with you|you can (?:call|talk to)))/i;

// Pure: the draft mentions this item (its link, or most of its words).
export function mentions(draft: string, d: Pick<DoneItem, "label" | "url">): boolean {
  if (d.url && draft.toLowerCase().includes(normUrl(d.url))) return true;
  return d.label.length > 3 && namesItem(draft, d.label);
}
// Words that say what kind of ask it is, never what it's about.
const ASK_FRAME = new Set("find found finding look looking search searching seeking option options some few couple two three four any get got want wants need needs for the and with near into from about your their his her our my you they them this that these those one ones more another also new good great best real just still week weekend".split(" "));
const topicWords = (t: string) => [...new Set((t.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9][a-z0-9'-]+/g) ?? []).map((w) => w.replace(/'s$/, "").replace(/(?<=[a-z]{3})s$/, "")).filter((w) => w.length >= 2 && !ASK_FRAME.has(w) && !/^https?$|^example$|^www$|^com$/.test(w)))];
// Pure: the draft is about an open or closed item: three of its topic words, or most of them for a short label.
export function about(draft: string, label: string): boolean {
  const w = topicWords(label);
  if (!w.length) return false;
  const said = new Set(topicWords(draft));
  const hit = w.filter((x) => said.has(x)).length;
  return w.length <= 2 ? hit === w.length : hit >= 3 || hit / w.length >= 0.5;
}

// Pure: what the draft gets wrong against the move and the record. Empty when nothing does (or when there's no read to judge from).
export function moveMisses(draft: string, rec: ExchangeRecord | null | undefined): MoveMiss[] {
  if (!rec?.read || !draft.trim()) return [];
  const r = rec.read;
  const out: MoveMiss[] = [];
  const qs = questionsIn(draft.replace(URL, "")).filter((q) => !askable(q));
  const urls = (draft.match(URL) ?? []).map(normUrl);
  const again = r.again ? rec.done.find((d) => d.id === r.again) : null;

  // Done: a link, find or card already sent, sent again with no ask for it.
  for (const d of rec.done.filter((x) => x.url && (x.kind === "link" || x.kind === "find"))) {
    if (urls.includes(normUrl(d.url!)) && d !== again) out.push({ name: "resend", why: `re-sends ${d.id} (${d.label}), already sent and not asked for again` });
  }
  if (/\[sent (?:Cue|Co)'s contact card\]/i.test(draft) && rec.done.some((d) => d.kind === "card") && again?.kind !== "card") out.push({ name: "resend", why: "sends the contact card again, already sent and not asked for" });
  // Done: an offer or question already made and answered, made again (reworded counts, as after a yes).
  for (const q of qs) {
    const prior = rec.done.find((d) => (d.kind === "offer" || d.kind === "question") && d.replied && sameQuestion(q, d.label, true));
    if (prior) out.push({ name: prior.kind === "offer" ? "reoffer" : "reask", why: `asks again what ${prior.id} already asked ("${prior.label.slice(0, 80)}"), and they answered` });
  }
  // Two interest questions in one draft, or a new one while one of Cue's is still unanswered.
  const interest = qs.filter((q) => INTEREST_Q.test(q) || OFFER_Q.test(q));
  if (interest.length > 1) out.push({ name: "double_ask", why: "asks whether they're interested (or want something) more than once in one reply" });
  else if (interest.length === 1 && rec.done.some((d) => (d.kind === "question" || d.kind === "offer") && !d.replied && INTEREST_Q.test(d.label))) out.push({ name: "double_ask", why: "asks again whether they're interested while the last such question still has no answer" });
  // Told: a question they already answered.
  for (const q of qs) {
    const t = r.told.find((x) => sameQuestion(q, x.q, true));
    if (t && !out.some((m) => m.name === "reask" && m.why.includes(t.q.slice(0, 40)))) out.push({ name: "reask", why: `asks what they already told you ("${t.q.slice(0, 80)}": "${t.a.slice(0, 80)}")` });
  }
  // Meant: "that" resolved to one item; the draft talks about a different one and not it, or about the one they said they didn't mean.
  const m = r.meant;
  if (m?.item) {
    const it = rec.done.find((d) => d.id === m.item)!;
    const other = rec.done.find((d) => d.id !== m.item && (d.kind === "link" || d.kind === "find" || d.kind === "document") && mentions(draft, d));
    if (other && !mentions(draft, it)) out.push({ name: "wrong_referent", why: `"${m.phrase}" means ${it.id} (${it.label}), but the draft is about ${other.id} (${other.label})` });
  }
  if (m?.notItem) {
    const not = rec.done.find((d) => d.id === m.notItem)!;
    if (mentions(draft, not) && !(m.item && mentions(draft, rec.done.find((d) => d.id === m.item)!))) out.push({ name: "ignores_correction", why: `they said they didn't mean ${not.id} (${not.label}), and the draft is still about it` });
  }
  // Unresolved: something they closed, reopened (a find, an offer or a question about it).
  const closing = new Set(r.closes.map((c) => c.item));
  // What they bring back this turn is theirs again: their latest message wins over the 14-day closed record (review of #368).
  const back = new Set(r.reopens);
  for (const u of rec.unresolved.filter((x) => !back.has(x.id) && (closing.has(x.id) || x.state === "solved" || x.state === "dropped"))) {
    const reopens = (urls.length || qs.length || /\b(?:found|another one|still (?:looking|on it)|i'?ll (?:keep|look|send|find))\b/i.test(draft)) && about(draft, u.label);
    if (reopens) out.push({ name: "reopen", why: `reopens ${u.id} (${u.label.slice(0, 80)}), which they closed` });
  }
  // The move itself.
  if (r.move === "close") {
    const asked = qs.filter((q) => !WELLBEING_Q.test(q));
    if (asked.length) out.push({ name: "question_after_close", why: `adds a question after they closed: "${asked[0].slice(0, 80)}"` });
    if (urls.some((u) => !again?.url || normUrl(again.url) !== u)) out.push({ name: "find_after_close", why: "brings a new link or find after they closed" });
  } else if (r.move === "summarize" && qs.length) out.push({ name: "off_move", why: "asks a question in a summary they asked for" });
  else if (r.move === "feeling" && urls.length) out.push({ name: "off_move", why: "brings a link or find while they're with a feeling" });
  return out;
}

// The one rewrite's note: what missed, and the move to perform. Never a line to say.
export function moveRedraftNote(misses: MoveMiss[], rec: ExchangeRecord): string {
  const move = rec.read?.move;
  return `Not sent. Judged against the whole exchange, this draft ${misses.map((x) => x.why).join("; ")}. ${move ? `This turn's move is ${move}: ${MOVE_MEANINGS[move]}. ` : ""}Rewrite it in your own words so it does that and none of the above, then call sendReply again.`;
}

// Calls: a sentence the call brain is about to say, against the call so far, the record and the read of their latest words
// (services/exchangeRecord.ts readCallTurn). Their latest words win (review of #368): with no read (not back yet, or failed) nothing is
// held; a question is a re-ask only when the read says their reply answered it ("what?" never does); what they ask for again or bring
// back is never held. Pure.
export function callSentenceMiss(sentence: string, o: { rec: ExchangeRecord | null; callTurns: { from: "co" | "them"; text: string }[]; delivered: string[]; read: CallTurnRead | null }): MoveMiss | null {
  if (!o.read) return null;
  const s = sentence.trim();
  const isQ = /\?["')\]]*\s*$/.test(s) && !askable(s) && !WELLBEING_Q.test(s);
  if (isQ) {
    const answered = o.read.answered.find((q) => sameQuestion(s, q, true));
    if (answered) return { name: "reask", why: `asks again what they answered on this call ("${answered.slice(0, 80)}")` };
  }
  // An offer to text something already delivered on this call or already sent in the exchange, unless they asked for it again.
  if (OFFER_Q.test(s) || /\b(?:i'?ll|let me) (?:text|send|shoot)\b/i.test(s)) {
    const sent = callSentItems(o.rec, o.delivered).filter((d) => !o.read!.again.includes(d.label));
    const hit = sent.find((d) => mentions(s, d));
    if (hit) return { name: "reoffer", why: `offers to send ${hit.label.slice(0, 80)} again, already sent` };
  }
  for (const label of callClosedItems(o.rec)) {
    if (o.read.back.includes(label)) continue;
    if ((isQ || OFFER_Q.test(s)) && about(s, label)) return { name: "reopen", why: `reopens ${label.slice(0, 80)}, which they closed` };
  }
  return null;
}
// The read's input from the call so far (pure): Cue's questions that got a reply, with that reply; what was sent; what they closed.
export function callSentItems(rec: ExchangeRecord | null, delivered: string[]): { label: string; url: string | null }[] {
  return [...delivered.map((label) => ({ label, url: /^https?:/.test(label) ? label : null })), ...(rec?.done ?? []).filter((d) => d.kind === "link" || d.kind === "find" || d.kind === "card" || d.kind === "document").map((d) => ({ label: d.label, url: d.url }))];
}
export const callClosedItems = (rec: ExchangeRecord | null): string[] => (rec?.unresolved ?? []).filter((x) => x.state === "solved" || x.state === "dropped").map((x) => x.label);
export function callReadInput(callTurns: { from: "co" | "them"; text: string }[], rec: ExchangeRecord | null, delivered: string[]): CallReadInput {
  const recent = callTurns.slice(-15);
  const questions: { q: string; reply: string }[] = [];
  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i].from !== "co") continue;
    const reply = recent.slice(i + 1).find((t) => t.from === "them" && t.text.trim());
    if (!reply) continue;
    for (const q of questionsIn(recent[i].text)) if (!askable(q)) questions.push({ q, reply: reply.text.slice(0, 300) });
  }
  const latest = [...callTurns].reverse().find((t) => t.from === "them")?.text ?? "";
  return { questions: questions.slice(-6), sent: callSentItems(rec, delivered).map((d) => d.label).slice(0, 10), closed: callClosedItems(rec).slice(0, 8), latest: latest.slice(0, 500) };
}
