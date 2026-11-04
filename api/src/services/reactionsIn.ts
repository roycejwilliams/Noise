// Reactions they give Cue's texts (Royce, 2026-11-04: "add open ended tapbacks"; "an emoji alone isn't blanket permission to act").
// iMessage reactions reach the webhook as text: Loved “…”, Liked “…”, Disliked “…”, Laughed at “…”, Emphasized “…”, Questioned “…”,
// Reacted 🔥 to “…” (any emoji), and Removed a heart from “…”. This reads one, finds the Cue text it was on, and says what it means
// against that text. Nothing here ever acts: a reaction is a signal about one message, never a yes (the hard rule, below).
//
// The hard rule: a reaction never confirms an intro, spends, sends on their behalf, or shares anything. For a consequential ask it earns
// at most one light check in Cue's own words. Code holds it in three places: decideActions resolves nothing on a reaction
// (services/messageRouter.ts), yesIsTheirs is false for one (services/theirYes.ts, so every tool that needs their yes refuses),
// and the instruction below tells the reply. Text only: calls have no tapbacks.

export type ReactionKind = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "emoji";
export type IncomingReaction = { kind: ReactionKind; emoji: string; quoted: string; removed: boolean };

const bare = (s: string) => s.replace(/️/g, "").trim();
const EMOJI_KIND: [string, ReactionKind][] = [["❤", "love"], ["👍", "like"], ["👎", "dislike"], ["😂", "laugh"], ["‼", "emphasize"], ["❓", "question"], ["❔", "question"]];
const KIND_EMOJI: Record<Exclude<ReactionKind, "emoji">, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
const VERB_KIND: Record<string, Exclude<ReactionKind, "emoji">> = { loved: "love", liked: "like", disliked: "dislike", "laughed at": "laugh", emphasized: "emphasize", questioned: "question" };
// The exact iMessage strings and nothing looser (review of #384): case-sensitive, single literal spaces, the quote wrapping the WHOLE message,
// and the media form being the whole message. That is only the SHAPE of a reaction. A typed message can have the same shape ("Loved “Dune”,
// yes intro me to the “film club”"), so a quoted one counts only when its quote is from one of Cue's own recent texts, or the payload names
// the text (readReaction / verifyReaction). Unsure is NOT a reaction: a real message read as a tapback would lose its yes.
const MEDIA = "(?:an image|a photo|an attachment|a video|a voice message|a link|a sticker)";
const VERBS = "(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)";
const VERB = new RegExp(`^${VERBS} (?:“([\\s\\S]+)”|"([\\s\\S]+)"|${MEDIA})$`);
// A real emoji only (one, with skin tone or joined parts, a keycap, or a flag), never a word.
export const EMOJI_ONE = "(?:\\p{Extended_Pictographic}\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?)*|[0-9#*]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{2})";
const CUSTOM = new RegExp(`^Reacted (${EMOJI_ONE}) to (?:“([\\s\\S]+)”|"([\\s\\S]+)")$`, "u");
const REMOVED = new RegExp(`^Removed (an exclamation mark|a (?:heart|like|dislike|laugh|question mark)|a ${EMOJI_ONE}) from (?:“([\\s\\S]+)”|"([\\s\\S]+)")$`, "u");
const REMOVED_KIND: Record<string, ReactionKind> = { "a heart": "love", "a like": "like", "a dislike": "dislike", "a laugh": "laugh", "an exclamation mark": "emphasize", "a question mark": "question" };
const trimQuote = (s: string) => s.replace(/…$/, "").trim();
// Two quoted pieces inside one "quote" means someone typed it: Cue's reaction quote is one text.
const TWO_QUOTES = /”[\s\S]*“/;

export type ReactionShape = IncomingReaction & { wrapped: "curly" | "straight" | "none" };
export function kindOfEmoji(emoji: string): ReactionKind {
  const e = bare(emoji);
  return EMOJI_KIND.find(([k]) => e === k)?.[1] ?? "emoji";
}

// Pure: whether the text has the exact shape of an iMessage reaction. Not yet a reaction: see readReaction.
export function parseReactionShape(text: string): ReactionShape | null {
  const t = String(text ?? "");
  if (!t || t.length > 700) return null;
  const quoted = (curly: string | undefined, straight: string | undefined): { q: string; w: "curly" | "straight" } | null => {
    if (curly != null) return TWO_QUOTES.test(curly) ? null : { q: curly, w: "curly" };
    if (straight != null) return { q: straight, w: "straight" };
    return null;
  };
  let m = t.match(VERB);
  if (m) {
    const kind = VERB_KIND[m[1].toLowerCase()];
    const q = quoted(m[2], m[3]);
    if (!q && (m[2] != null || m[3] != null)) return null;
    return { kind, emoji: KIND_EMOJI[kind], quoted: q ? trimQuote(q.q) : "", removed: false, wrapped: q ? q.w : "none" };
  }
  m = t.match(CUSTOM);
  if (m) {
    const q = quoted(m[2], m[3]);
    return q ? { kind: kindOfEmoji(m[1]), emoji: m[1], quoted: trimQuote(q.q), removed: false, wrapped: q.w } : null;
  }
  m = t.match(REMOVED);
  if (m) {
    const q = quoted(m[2], m[3]);
    if (!q) return null;
    const named = REMOVED_KIND[m[1]];
    const emoji = named ? KIND_EMOJI[named as Exclude<ReactionKind, "emoji">] : m[1].slice(2);
    return { kind: named ?? kindOfEmoji(emoji), emoji, quoted: trimQuote(q.q), removed: true, wrapped: q.w };
  }
  return null;
}

// Pure: their text as a reaction given Cue's recent texts (newest or oldest, any order), or null when it's just a message. A quoted one
// must quote one of them (straight quotes too: older clients send those). cue null = no context: only a curly one is taken, which is the
// safe side for a guard (a tapback is never a yes) and used only where no thread is at hand.
export function readReaction(text: string, cueTexts: string[] | null): IncomingReaction | null {
  const sh = parseReactionShape(text);
  if (!sh) return null;
  const { wrapped, ...r } = sh;
  if (wrapped === "none") return r;
  if (cueTexts === null) return wrapped === "curly" ? r : null;
  return cueTexts.some((c) => quotesText(c, r.quoted)) ? r : null;
}
// Pure: a reaction when the payload names one of Cue's texts or the quote is from one (the webhook's check, with the send log).
export function verifyReaction(text: string, sent: SentText[], payloadHandle?: string | null): { reaction: IncomingReaction; target: ReactionTarget } | null {
  const sh = parseReactionShape(text);
  if (!sh) return null;
  const { wrapped, ...r } = sh;
  const target = wrapped === "none" ? null : pickTarget(r, sent, payloadHandle);
  if (wrapped !== "none" && !target) return null;
  return { reaction: r, target };
}
// Pure: a context-free guard read: the exact shape in curly quotes (or media). Never used to decide a reply, only to refuse a yes.
export const isReaction = (text: string): boolean => readReaction(text, null) !== null;
// Pure: Cue's texts in a stored thread ("Co replied: …", "Cue: …", with continuation lines) or an exchange ("Cue: a / b").
export function cueTextsFrom(conversation: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(conversation ?? "").split("\n")) {
    const line = raw.trim();
    const co = line.match(/^(?:Co replied|Cue replied|Co said|Cue said|Co|Cue):\s*(.*)$/i);
    if (co) out.push(co[1]);
    else if (/^(?:User said|User|Them|Member|User sent[^:]*):/i.test(line)) out.push("\u0000");
    else if (line && out.length && out[out.length - 1] !== "\u0000") out[out.length - 1] += ` ${line}`;
  }
  return out.filter((x) => x !== "\u0000");
}
// Verified in this process by the webhook (it has the send log): the guards refuse these as a yes even when the exchange they see is short.
const verifiedTexts = new Set<string>();
export function noteVerifiedReaction(text: string): void {
  if (verifiedTexts.size >= 200) verifiedTexts.delete(verifiedTexts.values().next().value as string);
  verifiedTexts.add(text);
}
// For a guard that has the exchange before their message (or none): a reaction when the webhook verified it, or the exchange shows its text.
export function isReactionIn(message: string, exchange?: string | null): boolean {
  if (verifiedTexts.has(message)) return true;
  return readReaction(message, exchange == null ? null : cueTextsFrom(exchange)) !== null;
}
// Pure: whether this raw text, before the member is even looked up, has a removal's shape (it never moves the debounce stamp).
export const isRemovalShape = (text: unknown): boolean => typeof text === "string" && parseReactionShape(text)?.removed === true;

// The same shape as a stored tapback line ("User said: Loved “…”"), in curly quotes, for a query that must skip them (harness/proactive.ts
// loadLastWrittenInbound). Ranking only, never what a message means: the readers above decide. Tested against parseReactionShape.
const SQL_EMOJI = "([0-9#*]️?⃣|[^ -~“”[:space:]]{1,24})";
export const REACTION_LINE_SQL = `^User[^:]*: (Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Reacted ${SQL_EMOJI} to|Removed (an exclamation mark|a (heart|like|dislike|laugh|question mark|${SQL_EMOJI})) from) “(?![^”]*”.*“).+”$|^User[^:]*: (Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) (an image|a photo|an attachment|a video|a voice message|a link|a sticker)$`;
export const sameEmoji = (a: string, b: string): boolean => bare(a) === bare(b);
// The one light check Cue may send after a tapback on a consequential ask ("Is that a yes to meeting Dana?"): exempt from the repeat-
// question rules, which would otherwise read it as asking again what the tapback "answered".
export const LIGHT_CHECK = /^\s*(?:so\s+)?is that a yes\b/i;
// A second ask riding in the same sentence ("…, and want me to book the 8pm?") makes it a new offer, not the light check.
const SECOND_ASK = /\b(?:and|or|also|plus|then|while)\b[^?]*\b(?:want me to|want (?:a|the)|should i|shall i|can i|would you like|do you want|book|send|draft|share|reserve|order|introduce|intro)\b/i;
export const isLightCheck = (q: string): boolean => LIGHT_CHECK.test(q) && !SECOND_ASK.test(q);

// Pure: whether a taken-back reaction ends the turn with no reply. It does only when nothing of theirs is waiting for an answer: reading
// their lines newest first (rows: their thread's lines, oldest first, as stored; ownId is the removal's own row), a written line of theirs
// before any Cue reply means the removal must not end the turn (a "yes, book the 8pm" in the same burst is still owed its answer).
export function removalEndsTurn(rows: { id: number | string; content: string }[], ownId: number | string): boolean {
  const lines = rows.filter((r) => String(r.id) !== String(ownId));
  const cue = lines.filter((r) => /^(?:Co|Cue) (?:replied|said):/.test(r.content)).map((r) => r.content.replace(/^(?:Co|Cue) (?:replied|said):\s*/, ""));
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = lines[i].content;
    if (/^(?:Co|Cue) (?:replied|said):/.test(c)) return true;
    const mine = c.match(/^User[^:]*:\s*([\s\S]*)$/);
    if (!mine) continue;
    if (readReaction(mine[1], cue)) continue;
    return false;
  }
  return true;
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’‘]/g, "").replace(/\s+/g, " ").trim();
// Pure: whether a quoted piece (iMessage shortens long ones) is from this text.
export function quotesText(sent: string, quoted: string): boolean {
  const q = norm(quoted).slice(0, 60);
  if (q.length >= 2 && q.length < 6) return norm(sent) === q;
  return q.length >= 6 && norm(sent).includes(q);
}

// ---------------------------------------------------------------- which Cue text, and what it was

export type SentText = { handle: string | null; text: string };
export type ReactionTarget = { handle: string | null; text: string; how: "handle" | "quote" } | null;

// Pure: the Cue text a reaction is on. The payload's own handle wins when it names one of Cue's texts; else the newest text (candidates
// newest first) that the quote is from. Null when neither settles it: nothing is guessed.
export function pickTarget(r: IncomingReaction, candidates: SentText[], payloadHandle?: string | null): ReactionTarget {
  if (payloadHandle) {
    const h = candidates.find((c) => c.handle === payloadHandle);
    if (h) return { handle: h.handle, text: h.text, how: "handle" };
  }
  if (!r.quoted) return null;
  const q = candidates.find((c) => quotesText(c.text, r.quoted));
  return q ? { handle: q.handle, text: q.text, how: "quote" } : null;
}

// Cue's recent texts to this member, newest first (the send log, one row per text, so a handle is one part of a multi-part reply).
export async function recentSentTexts(userId: string, limit = 40): Promise<SentText[]> {
  const { default: pool } = await import("../db/db.js");
  const { rows } = await pool.query(`SELECT message_handle, content FROM outbound_messages WHERE user_id = $1 AND sender = 'co' AND content IS NOT NULL ORDER BY sent_at DESC LIMIT $2`, [userId, limit]);
  return rows.map((x: any) => ({ handle: x.message_handle ?? null, text: String(x.content) }));
}

export type TargetClass = "consequential_ask" | "interest_ask" | "find" | "update" | "unknown";
// An ask that would do, send, spend or share something, or connect them with a person, if it were said yes to.
const ACTION_ASK = /\b(?:intro(?:duce|duction)?|connect (?:you|the two)|put you (?:two )?in touch|meet (?:him|her|them|[A-Z]\w+)|opt[- ]?in|share (?:your|my|that|it)|on your behalf|book|reserve|rsvp|sign you up|pay|buy|purchase|send (?:it|that|this|them|him|her|the)|email (?:them|him|her)|draft|reach out|message (?:them|him|her))\b/i;
const OFFER = /\b(?:want me to|should i|shall i|do you want me to|would you like me to|can i|ok if i|okay if i|want to meet|want an intro|want to come|wanna come|you in|are you in|save you a seat|save you a spot|join|come with|come along|rsvp for you|count you in)\b/i;
const INTEREST = /\b(?:interest(?:s|ed)? you|interested\??$|worth a look|worth (?:it|your time)|on your radar|appeal to you|fit for you|sound (?:good|fun|like you))\b/i;

// Pure: what the targeted text asked of them. Consequential wins: when in doubt about an ask, it is one.
export function classifyTarget(text: string | null | undefined): TargetClass {
  const t = String(text ?? "").trim();
  if (!t) return "unknown";
  const asks = t.includes("?");
  if (asks && (ACTION_ASK.test(t) || OFFER.test(t))) return "consequential_ask";
  if (asks && INTEREST.test(t)) return "interest_ask";
  if (/https?:\/\//i.test(t)) return "find";
  return "update";
}

// ---------------------------------------------------------------- what it means

export type ReactionMeaning = "acknowledgment" | "interest" | "unconfirmed_yes" | "feedback" | "question" | "laugh" | "removed" | "unclear";
export type Interpretation = { meaning: ReactionMeaning; target: TargetClass; instruction: string; actsOn: false };

const POSITIVE: ReactionKind[] = ["love", "like", "emphasize", "emoji"];

// Pure. `actsOn` is false for every reaction: there is no branch that lets one confirm, send, spend or share.
export function interpretReaction(r: IncomingReaction, target: ReactionTarget): Interpretation {
  const cls = classifyTarget(target?.text);
  const on = target ? `Cue's text "${target.text.slice(0, 160)}"` : "a text of Cue's that couldn't be matched";
  const head = `They reacted ${r.emoji} to ${on}.`;
  const rule = "A reaction is never a yes: don't confirm, introduce, send, book, spend, or share anything because of it.";
  const done = (meaning: ReactionMeaning, line: string): Interpretation => ({ meaning, target: cls, instruction: `${head} ${line} ${rule}`, actsOn: false });

  if (r.removed) return done("removed", "They took that reaction back, so it says nothing now: don't reply to the removal itself or treat it as a change of mind, and answer anything of theirs that is still waiting.");
  if (!target) return done("unclear", "Don't guess which text it meant. If it matters to what comes next, ask which one in a few words; otherwise leave it.");
  if (r.kind === "dislike") return done("feedback", "Read it as feedback on that specific text: it didn't land. Don't resend or defend it, and don't go ahead with what it proposed. If it isn't obvious what missed, ask once, briefly.");
  if (r.kind === "question") return done("question", "Read it as puzzlement about that specific text. Clear that one up plainly, and don't go ahead with what it proposed.");
  if (cls === "consequential_ask") {
    return done("unconfirmed_yes", `That text asked about something Cue would do or set in motion. The reaction may be a yes but it isn't one. Check once, lightly, in your own words and one line (for example "Is that a yes to meeting Dana?", using the real name and thing), then wait for their words.`);
  }
  if (r.kind === "laugh") return done("laugh", "They found that text funny. Take it lightly; nothing to do or ask.");
  if (POSITIVE.includes(r.kind) && (cls === "find" || cls === "interest_ask")) {
    return done("interest", "It most likely means interest in that text's find or idea. You can offer the next step in one line (the details or link, if you haven't sent them), but record nothing as an answer and don't act for them.");
  }
  return done("acknowledgment", "On a plain update it is just an acknowledgment: nothing to ask, answer or do. If you reply at all, one beat, and don't ask again what that text already asked.");
}

// What the exchange record shows beside the Cue text they reacted to.
export function reactionNote(r: IncomingReaction): string {
  return r.removed ? "" : `they reacted ${r.emoji}`;
}
