// The draft against the move and the whole exchange (Royce, 2026-11-03: "judge its next move against the whole exchange, not just
// whether the next sentence sounds reasonable"). The move and the record come from services/exchangeRecord.ts; this reads only Cue's own
// draft against them (facts: what was sent, what they answered, what "that" was resolved to, what they closed). It reads their words for
// one thing only: a plain request for something already delivered (askedAgain), which lifts a resend hold; the rest is the turn read's.
// On a miss the reply gets one rewrite toward the move (agent/conversationTools.ts sendReply), in its own words, never a canned line; on
// a call the sentence is held and Cue answers again in its own words (services/callLlmProxy.ts, the #365 hold). Pure.
import { isLightCheck, LIGHT_CHECK } from "../services/reactionsIn.js";
import { ALWAYS_ASKABLE, questionsIn, sameQuestion } from "./repeatAsk.js";
import { namesItem } from "../services/callClaims.js";
import { INTEREST_Q, MOVE_MEANINGS, normUrl, OFFER_Q, type CallReadInput, type CallTurnRead, type DoneItem, type ExchangeBase, type ExchangeRecord } from "../services/exchangeRecord.js";

export type MoveMiss = { name: "resend" | "reoffer" | "double_ask" | "reask" | "wrong_referent" | "ignores_correction" | "referent_tie" | "asks_which" | "reopen" | "question_after_close" | "find_after_close" | "off_move"; why: string };
// A question asking which thing they meant, in Cue's own words.
export const WHICH_Q = /\b(?:which (?:one|of (?:these|those|them|the two|the))|which (?:\w+ )?(?:do|did) you mean|(?:do|did) you mean (?:the|that)|are you (?:asking|talking) about (?:the|that))\b/i;

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
const topicWords = (t: string) => [...new Set((t.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9][a-z0-9'-]+/g) ?? []).map((w) => w.replace(/'s$/, "").replace(/(?<=[a-z]{2})(?<![su])s$/, "")).filter((w) => w.length >= 2 && !ASK_FRAME.has(w) && !/^https?$|^example$|^www$|^com$/.test(w)))];
// Pure: the draft is about an open or closed item: three of its topic words, or most of them for a short label. Words in `not` never
// count (the over-suppression guard: what they raised in their latest message, or what's still open for them, belongs to that).
export function about(draft: string, label: string, not = ""): boolean {
  const theirs = new Set(not ? topicWords(not) : []);
  const w = topicWords(label).filter((x) => !theirs.has(x));
  if (!w.length) return false;
  const said = new Set(topicWords(draft));
  const hit = w.filter((x) => said.has(x)).length;
  return w.length <= 2 ? hit === w.length : hit >= 3 || hit / w.length >= 0.5;
}

// Their own latest words plainly asking for something Cue already delivered (Royce, 2026-11-03: "a useful new request is never
// suppressed because it resembles an old one"; a direct request in the member's own words always wins over the turn read, which can
// miss a plain one: "Can you send me a vCard" after a card that afternoon came back as not asked). Only lifts a hold (a card not sent
// twice, a resend miss): it never sends anything by itself. Words that only mention the item ("thanks for the card", "got your card",
// "that rooftop place was great") are not a request. Pure.
// Verbs that ask for something to be sent or given.
const REQ = String.raw`(?:send|resend|re-send|text|share|forward|give|drop|shoot|get|need|want|(?:can|could|may) i have)`;
// What may follow "your number" / "your contact" and still be the whole ask ("your number one pick" is not the card).
const TAIL = String.raw`(?=(?:\s+(?:again|please|pls|plz|lol|thanks|thx|ty|too|real quick|asap))*\s*[?!.]*\s*$)`;
// Cue's card, in their words: a vcard, a contact card, YOUR (or Cue's) card; your number or contact only as the whole object.
const CARD_TERM = String.raw`(?:v-?\s?cards?|vcf|contact card|(?:your|cue's) (?:new |updated |latest )?(?:contact )?card|(?:your|cue's) (?:number|digits|contact(?: info| details)?)${TAIL})`;
const CARD_ASK = [
  new RegExp(String.raw`\b${REQ}\b[^.?!]{0,30}?\b${CARD_TERM}`, "i"),
  new RegExp(String.raw`\bwhat(?:'s| is| was) ${CARD_TERM}`, "i"),
  new RegExp(String.raw`\b(?:the|that) card\b\s+again\b`, "i"),
  // The card named first, then "send it again" in the same breath ("not sure I saved your card can you send it again").
  new RegExp(String.raw`\b(?:v-?\s?cards?|vcf|contact card|(?:your|cue's) (?:\w+ )?card)\b[^.?!]{0,40}\b${REQ}\b(?: (?:me|us))? it\b`, "i"),
  /^\s*(?:(?:get|send|resend)\s+)?(?:your |the |a )?(?:v-?\s?card|contact card|card)\s*\?+\s*$/i,
  new RegExp(String.raw`^\s*(?:your|cue's) (?:number|digits|contact(?: info| details)?)${TAIL}`, "i"),
];
// A plain re-ask that names nothing: an object that points back (it, that, the link, that one) with "again", or a "what was that
// place" / "remind me what that place was" / "the link from earlier". "I want to go again" asks for nothing.
const THING = String.raw`(?:link|url|site|website|page|one|place|spot|bar|restaurant|event|party|venue|show|thing)`;
const AGAIN_ASK = [
  /\b(?:resend|re-send)\b/i,
  new RegExp(String.raw`\b(?:send|text|share|forward|give|drop|shoot|tell)(?: (?:me|us))? (?:it|that|this|those|them|(?:the|that|this) (?:\w+ )?${THING})\b[^.?!]{0,15}\bagain\b`, "i"),
  new RegExp(String.raw`\b(?:need|get|want)(?: (?:me|us))? (?:the|that|this) (?:\w+ )?${THING}\b[^.?!]{0,10}\bagain\b`, "i"),
  new RegExp(String.raw`\bwhat (?:was|were|is|'s) (?:that|the) (?:\w+ )?${THING}\b`, "i"),
  new RegExp(String.raw`\bremind me (?:what|which|where) (?:that|the) (?:\w+ )?${THING}\b`, "i"),
  new RegExp(String.raw`\b(?:which|what) (?:\w+ )?${THING} (?:was|is) (?:that|it)\b`, "i"),
  new RegExp(String.raw`\b${REQ}\b[^.?!]{0,20}\b(?:the|that) (?:\w+ )?${THING} (?:from|you sent|you shared)\b`, "i"),
  /\b(?:lost|can't find|cant find|missed|didn't get|didnt get|never got) (?:the|that|your) (?:link|url)\b/i,
  /\b(?:didn't get|didnt get|never got) it\b/i,
];
// Words that name a link, place or thing (never the card): the newest such item, not the card, is the one they mean.
const NOT_CARD = new RegExp(String.raw`\b${THING}s?\b`, "i");
// A named item: a request, some word pointing back at what was sent (or the label's word right before "link"/"one"), and a
// distinctive word of its label in their words.
const POINTS_BACK = /\b(?:again|resend|re-send|that|those|the one|you (?:sent|mentioned|shared|texted|gave|found)|earlier|before|last time|remind me)\b/i;
const NAMED_REQ = new RegExp(String.raw`\b${REQ}\b|\b(?:what|where|which) (?:was|were|is|'s)\b|\bremind me\b|\?`, "i");
const GENERIC_ITEM = new Set("place spot bar restaurant event night show club link page site thing one party venue".split(" "));
// A refusal in the same clause, before the ask ("don't send the card again", "no need to resend"). "not" and "never" refuse only right
// before the verb: "not sure I saved your card, can you send it again" and "I never got the link" still ask.
const NEG = new RegExp(String.raw`\b(?:don't|dont|do not|stop|no need|no more)\b|\b(?:not|never)\s+(?:to\s+)?${REQ}\b`, "i");
type Deliverable = { kind?: DoneItem["kind"]; label: string; url: string | null };
const kindOf = (d: Deliverable) => d.kind ?? (/contact card/i.test(d.label) ? "card" : "link");
const esc = (w: string) => w.replace(/[^a-z0-9'-]/g, "");
export function askedAgain<T extends Deliverable>(theirs: string, items: readonly T[]): T[] {
  const t = (theirs ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/\bwhats\b/g, "what's").replace(/\bur\b/g, "your").replace(/\bu\b/g, "you").trim();
  if (!t || !items.length) return [];
  // Clauses: a refusal stays in its own ("I don't need the card, just send the link again").
  const clauses = t.split(/(?<=[.!?;\n])|,|\b(?:just|but)\b/).map((c) => c.trim()).filter(Boolean);
  const asks = (re: RegExp) => clauses.some((c) => { const m = c.match(re); return !!m && !NEG.test(c.slice(0, (m.index ?? 0) + m[0].length)); });
  const deliverable = items.filter((d) => ["link", "find", "document", "card"].includes(kindOf(d)));
  const others = deliverable.filter((d) => kindOf(d) !== "card");
  const out = new Set<T>();
  // A distinctive word of an item's label in their words.
  const labelWords = (d: T) => topicWords(d.label).filter((w) => w.length >= 3 && !GENERIC_ITEM.has(w)).map(esc).filter(Boolean);
  const namesIt = (d: T) => labelWords(d).some((w) => w.length >= 4 && new RegExp(`\\b${w}`).test(t));
  if (CARD_ASK.some(asks)) deliverable.filter((d) => kindOf(d) === "card").forEach((d) => out.add(d));
  if (asks(NAMED_REQ)) {
    for (const d of others) {
      const before = labelWords(d).some((w) => new RegExp(`\\b${w}(?: \\w+)? (?:link|one)\\b`).test(t));
      if ((namesIt(d) && asks(POINTS_BACK)) || before) out.add(d);
    }
  }
  if (!out.size && AGAIN_ASK.some(asks)) {
    // An item whose label they name wins; then a place or thing named means the newest that isn't the card; else the newest.
    const newest = others.find(namesIt) ?? (NOT_CARD.test(t) ? others[0] : deliverable[0]);
    if (newest) out.add(newest);
  }
  return items.filter((d) => out.has(d));
}

// What the record alone can say about a draft, with no read of their latest message: the part a reply and a queued send share
// (Royce, 2026-11-03: what Cue already did and what they closed carry into "any queued work", not just the next reply).
//   again    the done item they asked for again this turn (never a resend)
//   closing  unresolved ids their latest message closes (a reply's read)
//   back     unresolved ids their latest message brings back (a reply's read): theirs again
//   theirs   words that belong to something live: their latest message, and what's still open for them. A closed item's topic words
//            that are also there never make a reopening, so a NEW ask that resembles a dropped one still gets its answer or its find
//   resendOk a reminder or a find marked to resurface: its link going again is the point
//   noReopen the send serves a subject of its own (an ask, goal, task, thread or loop, by id), whose state is read by id where the
//            send is decided: resemblance to something closed never holds it
//   droppedOnly  only what they DROPPED counts for resemblance (queued work): a solved ask leaves what it was for still ahead (the
//            party after "got the venue"), the same rule services/callReason.ts keeps for calls
//   optIn    the send is an intro or match opt-in (the double opt-in): its consent question is never held as a second interest question
//   theirsAt when their words in `theirs` were said (queued work). They lift a closed item only when said AFTER it closed: the message
//            that dropped it ("no need for the DJ") never counts as a new request for it. Unset: their message this turn (the reply),
//            newer than every stored close, but never for what this turn's read says it closes
//   asked    done items their own latest words plainly ask for again (askedAgain, a reply's turn): never a resend, like again
export type RecordOpts = { theirsAt?: Date | string | null; again?: DoneItem | null; asked?: readonly DoneItem[]; closing?: ReadonlySet<string>; back?: ReadonlySet<string>; theirs?: string; resendOk?: boolean; noReopen?: boolean; droppedOnly?: boolean; optIn?: boolean };
// A consent question for an intro or a match, in Cue's own words: never a double "interested?" (the double opt-in is its own ask).
export const OPT_IN_Q = /\b(?:introduce you|an? (?:intro|introduction)\b|connect (?:you|the two of you)|put you (?:two )?in touch|(?:meet|say hi to) (?:him|her|them)\b|want (?:to )?meet)/i;
export function recordMisses(draft: string, base: Pick<ExchangeBase, "done" | "unresolved">, o: RecordOpts = {}): MoveMiss[] {
  if (!draft.trim()) return [];
  const out: MoveMiss[] = [];
  const qs = questionsIn(draft.replace(URL, "")).filter((q) => !askable(q));
  const urls = (draft.match(URL) ?? []).map(normUrl);
  const again = o.again ?? null;
  const asked = o.asked ?? [];
  // Done: a link, find or card already sent, sent again with no ask for it.
  if (!o.resendOk) {
    for (const d of base.done.filter((x) => x.url && (x.kind === "link" || x.kind === "find"))) {
      if (urls.includes(normUrl(d.url!)) && d !== again && !asked.includes(d)) out.push({ name: "resend", why: `re-sends ${d.id} (${d.label}), already sent and not asked for again` });
    }
  }
  if (/\[sent (?:Cue|Co)'s contact card\]/i.test(draft) && base.done.some((d) => d.kind === "card") && again?.kind !== "card" && !asked.some((d) => d.kind === "card")) out.push({ name: "resend", why: "sends the contact card again, already sent and not asked for" });
  // Done: an offer or question already made and answered, made again (reworded counts, as after a yes).
  for (const q of qs) {
    const prior = base.done.find((d) => (d.kind === "offer" || d.kind === "question") && d.replied && sameQuestion(q, d.label, true));
    if (prior) out.push({ name: prior.kind === "offer" ? "reoffer" : "reask", why: `asks again what ${prior.id} already asked ("${prior.label.slice(0, 80)}"), and they answered` });
  }
  // Two interest questions in one draft, or a new one while one of Cue's is still unanswered.
  // After a tapback on an ask, only the one light check may follow: the same ask again, in any wording, is a miss (the tapback was seen,
  // not answered; services/reactionsIn.ts LIGHT_CHECK is the one allowed question).
  for (const q of qs) {
    if (LIGHT_CHECK.test(q) && !isLightCheck(q)) {
      out.push({ name: "reoffer", why: "the light check carries a second ask; after a tapback only the one question \"Is that a yes to…?\" may follow, nothing alongside it" });
      continue;
    }
    if (isLightCheck(q)) {
      // Asked once: not again for the same target after a second tapback.
      const spent = base.done.find((d) => d.reacted && (d.lightChecked || LIGHT_CHECK.test(d.label)));
      if (spent) out.push({ name: "reask", why: `the one light check was already asked (${spent.id}); a second tapback does not earn another` });
      continue;
    }
    const prior = base.done.find((d) => (d.kind === "offer" || d.kind === "question") && d.reacted && !d.replied && sameQuestion(q, d.label, true));
    if (prior) out.push({ name: prior.kind === "offer" ? "reoffer" : "reask", why: `asks again what ${prior.id} already asked ("${prior.label.slice(0, 80)}"), which they only reacted to; after a tapback only one light check ("Is that a yes to…?") may follow` });
  }
  const interest = o.optIn ? [] : qs.filter((q) => !isLightCheck(q) && (INTEREST_Q.test(q) || OFFER_Q.test(q)) && !OPT_IN_Q.test(q));
  if (interest.length > 1) out.push({ name: "double_ask", why: "asks whether they're interested (or want something) more than once in one reply" });
  else if (interest.length === 1 && base.done.some((d) => (d.kind === "question" || d.kind === "offer") && !d.replied && INTEREST_Q.test(d.label))) out.push({ name: "double_ask", why: "asks again whether they're interested while the last such question still has no answer" });
  // Unresolved: something they closed, reopened (a find, an offer or a question about it).
  if (!o.noReopen) {
    const closing = o.closing ?? new Set<string>();
    const back = o.back ?? new Set<string>();
    const open = base.unresolved.filter((u) => !closing.has(u.id) && (u.state === "open" || u.state === "delivered")).map((u) => u.label).join(" ");
    const saidAt = o.theirsAt ? new Date(o.theirsAt).getTime() : null;
    const liftedBy = (u: (typeof base.unresolved)[number]): boolean => {
      if (!o.theirs || closing.has(u.id)) return false;
      if (saidAt == null) return true;
      const at = u.closedAt ? new Date(u.closedAt).getTime() : NaN;
      return Number.isFinite(at) && saidAt > at;
    };
    for (const u of base.unresolved.filter((x) => !back.has(x.id) && (o.droppedOnly ? x.state === "dropped" : closing.has(x.id) || x.state === "solved" || x.state === "dropped"))) {
      const reopens = (urls.length || qs.length || /\b(?:found|another one|still (?:looking|on it)|i'?ll (?:keep|look|send|find))\b/i.test(draft)) && about(draft, u.label, liftedBy(u) ? `${o.theirs} ${open}` : open);
      if (reopens) out.push({ name: "reopen", why: `reopens ${u.id} (${u.label.slice(0, 80)}), which they closed` });
    }
  }
  return out;
}

// Pure: what the draft gets wrong against the move and the record. Empty when nothing does (or when there's no read to judge from).
// theirs: their latest message (its topic words never make a reopening: they raised it).
export function moveMisses(draft: string, rec: ExchangeRecord | null | undefined, theirs = ""): MoveMiss[] {
  if (!rec?.read || !draft.trim()) return [];
  const r = rec.read;
  const qs = questionsIn(draft.replace(URL, "")).filter((q) => !askable(q));
  const urls = (draft.match(URL) ?? []).map(normUrl);
  const again = r.again ? rec.done.find((d) => d.id === r.again) ?? null : null;
  // Their own words asking for something again count even when the read missed it.
  const theirsAsked = askedAgain(theirs, rec.done);
  const out = recordMisses(draft, rec, { again, asked: theirsAsked, closing: new Set(r.closes.map((c) => c.item)), back: new Set(r.reopens), theirs });
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
  // A "that" the exchange settles is answered, never asked about; a real tie gets one question, and the draft doesn't go ahead on a guess.
  if (m?.item && qs.some((q) => WHICH_Q.test(q))) out.push({ name: "asks_which", why: `asks which one they mean, but "${m.phrase}" is clear from the exchange: ${m.item} (${m.label})` });
  const tie = !m?.item && m?.between?.length ? m.between.filter((id) => rec.done.some((d) => d.id === id)) : [];
  if (tie.length >= 2 && qs.length !== 1) out.push({ name: "referent_tie", why: qs.length ? `"${m!.phrase}" could mean ${tie.join(" or ")}: ask which in one question, not ${qs.length}` : `"${m!.phrase}" could mean ${tie.join(" or ")} and the draft goes ahead without asking which` });
  if (m?.notItem) {
    const not = rec.done.find((d) => d.id === m.notItem)!;
    if (mentions(draft, not) && !(m.item && mentions(draft, rec.done.find((d) => d.id === m.item)!))) out.push({ name: "ignores_correction", why: `they said they didn't mean ${not.id} (${not.label}), and the draft is still about it` });
  }
  // The move itself.
  if (r.move === "close") {
    const asked = qs.filter((q) => !WELLBEING_Q.test(q));
    if (asked.length) out.push({ name: "question_after_close", why: `adds a question after they closed: "${asked[0].slice(0, 80)}"` });
    if (urls.some((u) => ![again, ...theirsAsked].some((d) => d?.url && normUrl(d.url) === u))) out.push({ name: "find_after_close", why: "brings a new link or find after they closed" });
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
    // What the read says they asked for again, and what their own last words plainly ask for again (askedAgain), is never held.
    const all = callSentItems(o.rec, o.delivered);
    const theirsAsked = askedAgain([...o.callTurns].reverse().find((t) => t.from === "them")?.text ?? "", all);
    const sent = all.filter((d) => !o.read!.again.includes(d.label) && !theirsAsked.includes(d));
    const hit = sent.find((d) => mentions(s, d));
    if (hit) return { name: "reoffer", why: `offers to send ${hit.label.slice(0, 80)} again, already sent` };
  }
  // What they just said and what's still open for them: a closed item's words there never make a reopening (a new ask like a dropped one).
  const live = [[...o.callTurns].reverse().find((t) => t.from === "them")?.text ?? "", ...(o.rec?.unresolved ?? []).filter((u) => u.state === "open" || u.state === "delivered").map((u) => u.label)].join(" ");
  for (const label of callClosedItems(o.rec)) {
    if (o.read.back.includes(label)) continue;
    if ((isQ || OFFER_Q.test(s)) && about(s, label, live)) return { name: "reopen", why: `reopens ${label.slice(0, 80)}, which they closed` };
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
