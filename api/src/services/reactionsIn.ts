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
const Q = `[“"']([\\s\\S]+?)[”"']`;
// "Loved an image" has no quote to find the text by.
const VERB = /^(loved|liked|disliked|laughed at|emphasized|questioned)\s+(?:[“"']([\s\S]+?)[”"']|an?\s+(?:image|photo|attachment|video|voice message|link|sticker)\b[\s\S]*)\s*$/i;
const CUSTOM = new RegExp(`^reacted\\s+(\\S+)\\s+to\\s+${Q}\\s*$`, "i");
const REMOVED = new RegExp(`^removed\\s+an?\\s+(heart|like|dislike|laugh|exclamation mark|question mark|[^“"']{1,24}?)\\s+from\\s+${Q}\\s*$`, "i");
const REMOVED_KIND: Record<string, ReactionKind> = { heart: "love", like: "like", dislike: "dislike", laugh: "laugh", "exclamation mark": "emphasize", "question mark": "question" };
const trimQuote = (s: string) => s.replace(/…$/, "").trim();

export function kindOfEmoji(emoji: string): ReactionKind {
  const e = bare(emoji);
  return EMOJI_KIND.find(([k]) => e === k)?.[1] ?? "emoji";
}

// Pure: their text as a reaction, or null when it's just a message.
export function parseReaction(text: string): IncomingReaction | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 700) return null;
  let m = t.match(VERB);
  if (m) {
    const kind = VERB_KIND[m[1].toLowerCase()];
    return { kind, emoji: KIND_EMOJI[kind], quoted: trimQuote(m[2] ?? ""), removed: false };
  }
  m = t.match(CUSTOM);
  if (m) return { kind: kindOfEmoji(m[1]), emoji: m[1], quoted: trimQuote(m[2]), removed: false };
  m = t.match(REMOVED);
  if (m) {
    const kind = REMOVED_KIND[m[1].toLowerCase()] ?? "emoji";
    return { kind, emoji: kind === "emoji" ? m[1] : KIND_EMOJI[kind as Exclude<ReactionKind, "emoji">], quoted: trimQuote(m[2]), removed: true };
  }
  return null;
}
export const isReaction = (text: string): boolean => parseReaction(text) !== null;

const norm = (s: string) => s.toLowerCase().replace(/[“”"'’‘]/g, "").replace(/\s+/g, " ").trim();
// Pure: whether a quoted piece (iMessage shortens long ones) is from this text.
export function quotesText(sent: string, quoted: string): boolean {
  const q = norm(quoted).slice(0, 60);
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
const OFFER = /\b(?:want me to|should i|shall i|do you want me to|would you like me to|can i|ok if i|okay if i|want to meet|want an intro)\b/i;
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

  if (r.removed) return done("removed", "They took that reaction back, so it says nothing now: don't reply to it or treat it as a change of mind.");
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
