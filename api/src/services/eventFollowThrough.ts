// Post-event follow-through (Royce, 2026-10-05, November event set, item 2). After a member tells Co who they met
// at a Co event (the next-morning debrief, services/eventCheckinFollowUp.ts), Co sends back: what landed, and for
// the people worth keeping, a short note they could send, in their own voice.
//
// What it will not do:
//   - Send anything. Every draft goes to the member and nowhere else. The code in this file has no way to text or
//     email anyone but the member (checked by evals/presence/followThrough.ts).
//   - Use anything about the other person. A draft is built only from the member's OWN words about the
//     conversation, their own ask and their own earlier messages (for the voice). Nothing about the person they
//     met is read: no profile, no ranking, no stored memory. A draft may not carry a name, number or fact that the
//     member didn't give (groundedIn).
//   - Draft for someone the member didn't name, or for someone they were critical of.
//   - Add contact details. If they want to reach someone, the member already has a way, or Co's own double opt-in
//     intro (services/eventGuestMatchHandoff.ts) is the only path that shares contact details.
import pool from "../db/db.js";
import { notToTeammate } from "./teamLines.js";

export const FOLLOW_THROUGH = { maxPeople: 3, maxSentencesPerNote: 3, maxNoteChars: 420, voiceMessages: 8 };

export type Met = { name: string; note: string; tone: "positive" | "neutral" | "critical" };

// ---------------------------------------------------------------- rules (pure)

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;

// A name is theirs only if it's in their own message (so a name can never come from anywhere else).
export function nameIsTheirs(name: string, theirMessage: string): boolean {
  const n = norm(name).trim();
  return n.length >= 2 && norm(theirMessage).includes(` ${n} `);
}

// Who gets a note: named by them, in their own words, and someone they were positive about (a neutral or critical
// mention is not a connection worth keeping).
export function worthKeeping(met: Met[], theirMessage: string): Met[] {
  const seen = new Set<string>();
  const out: Met[] = [];
  for (const m of met) {
    const key = norm(m.name).trim();
    if (!key || seen.has(key) || m.tone !== "positive" || !nameIsTheirs(m.name, theirMessage)) continue;
    seen.add(key);
    // The note is shown back as "what you told me", so it has to be their words: anything else is blanked.
    out.push({ ...m, note: m.note.trim() && norm(theirMessage).includes(norm(m.note)) ? m.note.trim() : "" });
    if (out.length >= FOLLOW_THROUGH.maxPeople) break;
  }
  return out;
}

// Anything in the draft that wasn't given to it: a capitalized word in the middle of a sentence (a name, a company), a
// word with a digit or currency sign (40k, $5, 2nd, 40%), or a number, that is not in the sources. The sources for ONE
// note are only what the member said about THAT person, their ask, the event and the two first names: never the rest of
// their message (it may hold a third party) and never their earlier texts. A word that only starts a sentence is not
// checked (it can't be told from an ordinary capital); the draft prompt also forbids new names.
export function groundedIn(draft: string, sources: string[], allowed: string[]): string | null {
  const known = norm([...sources, ...allowed].join(" "));
  for (const sentence of draft.split(/(?<=[.!?\n])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/^[("'“‘#@]+|[)"'”’.,;:!?]+$/g, "").replace(/['’]s$/i, "");
      if (!w) continue;
      const hasDigit = /[\d$%]/.test(w);
      const isName = i > 0 && /^\p{Lu}[\p{L}'’-]{1,}$/u.test(w) && w.length >= 2;
      if (/^I['’]/.test(w)) continue;
      if (!hasDigit && !isName) continue;
      const bare = w.replace(/[$%]/g, "").toLowerCase();
      if (!known.includes(` ${bare} `)) return w;
    }
  }
  return null;
}

export function noContactOrLinks(draft: string): boolean {
  return !(
    /@[a-z0-9._-]+/i.test(draft) ||
    /https?:\/\/|www\.|\blu\.ma\//i.test(draft) ||
    /\b[a-z0-9-]+\.(?:com|io|co|ai|org|net|app|dev|me|xyz)\b/i.test(draft) ||
    /\b[a-z0-9._-]+\s+(?:at|\(at\))\s+[a-z0-9-]+\s+(?:dot|\(dot\))\s+[a-z]{2,}\b/i.test(draft) ||
    /(?:\+?\d[\s().-]*){10,}/.test(draft)
  );
}

// A note that promises something Co will do, or claims what the other person felt or said.
export function claimsOthersWords(draft: string): boolean {
  return /\b(?:co will|cue will|i'?ll have (?:co|cue)|co can|cue can|my assistant|my ai)\b/i.test(draft) || /\b(?:told me (?:he|she|they)|said (?:he|she|they) (?:would|wanted|loved)|i heard (?:you|from))\b/i.test(draft);
}

export function sentenceCount(text: string): number {
  return text.split(/[.?!](?:\s|$)/).map((s) => s.trim()).filter(Boolean).length;
}

// Whether a note passes every code check, with the first failure named.
export function noteProblem(draft: string, o: { theirNote: string; theirAsk: string | null; eventName: string; theirFirstName: string; otherName: string }): string | null {
  const t = draft.trim();
  if (!t) return "empty";
  if (!noContactOrLinks(t)) return "carries a link, email or number";
  if (claimsOthersWords(t)) return "claims what the other person said or promises something Cue will do";
  if (/[—–]|!/.test(t)) return "has an em dash or an exclamation point";
  if (t.length > FOLLOW_THROUGH.maxNoteChars) return `too long (${t.length} chars)`;
  if (sentenceCount(t) > FOLLOW_THROUGH.maxSentencesPerNote + 1) return "too many sentences";
  const ungrounded = groundedIn(t, [o.theirNote, o.theirAsk ?? ""], [o.eventName, o.theirFirstName, o.otherName]);
  if (ungrounded) return `says "${ungrounded}", which they didn't give`;
  return null;
}

// ---------------------------------------------------------------- reads (the member's own data only)

// Their own recent messages, for the register of the note (never anyone else's).
export async function theirVoice(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT $2`, [userId, FOLLOW_THROUGH.voiceMessages])
    .catch(() => ({ rows: [] as any[] }));
  // A line can carry Co's own earlier text they replied to, or a description of a photo: neither is their voice.
  return rows
    .map((r: any) =>
      String(r.content)
        .replace(/^User said:\s*/i, "")
        .replace(/\s*\[(?:Replying to|They also sent a photo)[^\]]*\]/gi, "")
        .replace(/\[sent a photo[^\]]*\]/gi, "")
        // A file's note (services/inboundFile.ts fileRecordNote) is the record's, not their voice.
        .replace(/\s*\[(?:also )?sent (?:a|an) [^\]]*\]/gi, "")
        .trim()
        .slice(0, 240),
    )
    .filter(Boolean);
}

export async function theirAsk(userId: string): Promise<string | null> {
  const { statedAsk } = await import("./preArrival.js");
  return statedAsk(userId);
}

export async function alreadySent(userId: string, eventId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_follow_throughs WHERE user_id = $1 AND event_id = $2`, [userId, eventId]).catch(() => ({ rows: [] as any[] }));
  return rows.length > 0;
}

export async function notGoing(userId: string, eventId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM event_presence WHERE user_id = $1 AND event_api_id = $2 AND not_going_at IS NOT NULL`, [userId, eventId]).catch(() => ({ rows: [] as any[] }));
  return rows.length > 0;
}

export async function recordFollowThrough(userId: string, eventId: string, peopleCount: number): Promise<void> {
  // A count only: who they named stays in their own conversation, never in anything that is read across members.
  await pool.query(`INSERT INTO event_follow_throughs (user_id, event_id, people_count) VALUES ($1, $2, $3) ON CONFLICT (user_id, event_id) DO NOTHING`, [userId, eventId, peopleCount]);
}

// ---------------------------------------------------------------- model steps

export async function extractMet(message: string, firstName: string): Promise<Met[]> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { MODELS } = await import("../models.js");
  const { parseModelJson } = await import("./modelJson.js");
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    experimental_telemetry: { isEnabled: true, functionId: "agent.followThrough.extractMet", recordInputs: false, recordOutputs: false },
    prompt: `${firstName} told Cue about who they met at an event. List only the people they say they met or talked to, using only their message. For each: the name exactly as they wrote it, a few of their own words on what they said about the conversation (copied, not rephrased), and the tone: "positive" (they liked it or want to follow up), "neutral", or "critical" (it went badly or they didn't connect). Do not infer anyone not named. If no one is named, return an empty list.

Message: """${message.slice(0, 1200)}"""

Return ONLY JSON: {"met": [{"name": "...", "note": "...", "tone": "positive"|"neutral"|"critical"}]}`,
  });
  const rows = parseModelJson<{ met?: Met[] }>(text).met ?? [];
  return rows.filter((r) => r && typeof r.name === "string" && ["positive", "neutral", "critical"].includes(r.tone)).map((r) => ({ name: r.name.trim(), note: String(r.note ?? "").slice(0, 200), tone: r.tone }));
}

export async function draftNote(o: { firstName: string; other: Met; eventName: string; ask: string | null; voice: string[]; feedback: string | null }): Promise<string | null> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");
  const { MODELS } = await import("../models.js");
  const { brandSafe } = await import("./brandGuard.js");
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    experimental_telemetry: { isEnabled: true, functionId: "agent.followThrough.draftNote", recordInputs: false, recordOutputs: false },
    prompt: `Write a short note that ${o.firstName} could send to ${o.other.name}, whom they met at ${o.eventName}. Write it as ${o.firstName}, in their own register: it should sound like these messages they have written, not like Cue.

${o.firstName}'s own recent messages (for the register only):
${o.voice.map((v) => `- ${v}`).join("\n") || "- (none: keep it plain and warm)"}

What ${o.firstName} said about meeting ${o.other.name}: "${o.other.note}"
${o.ask ? `What ${o.firstName} is looking for: ${o.ask}\n` : ""}
Rules: two or three short sentences. Thank them or pick up the thing ${o.firstName} said, and suggest one easy next step (a coffee, a call, sending something) without a date or place. Use ONLY the words and facts above: no new names, companies, numbers or details. Do not say what ${o.other.name} said, felt or wants. No links, emails or phone numbers. No exclamation points, no em dashes. Never mention Cue, an assistant or AI.${o.feedback ? `\nYour last draft was rejected: ${o.feedback}. Fix that.` : ""}

Return ONLY the note.`,
  });
  const t = brandSafe(text.trim().replace(/^["']|["']$/g, "").trim());
  return t || null;
}

// What landed, in their own words (copied, so nothing here is Co's claim), and what the next bubbles are.
export function recapLine(eventName: string, met: Met[]): string {
  const clean = (t: string) => t.replace(/\s*[—–]\s*/g, ", ").replace(/!+/g, ".").replace(/[.]{2,}/g, ".").trim().replace(/[.]+$/, "");
  const landed = met.map((m) => (m.note.trim() ? `${m.name} (${clean(m.note)})` : m.name)).join(", ");
  return `What stood out from ${eventName}, from what you told me: ${landed}. Below ${met.length === 1 ? "is a note" : "are notes"} you can send, or change. I won't send ${met.length === 1 ? "it" : "them"} for you.`;
}

// The whole message set for one member: what landed, then one bubble per note. Null when there is nothing to send.
export type Steps = { alreadySent: typeof alreadySent; notGoing: typeof notGoing; extractMet: typeof extractMet; theirVoice: typeof theirVoice; theirAsk: typeof theirAsk; draftNote: typeof draftNote };
const REAL: Steps = { alreadySent, notGoing, extractMet, theirVoice, theirAsk, draftNote };

export async function buildFollowThrough(o: { userId: string; firstName: string; eventId: string; eventName: string; theirMessage: string }, steps: Steps = REAL): Promise<{ messages: string[]; people: number } | { skip: string }> {
  if (await steps.alreadySent(o.userId, o.eventId)) return { skip: "already sent for this event" };
  if (await steps.notGoing(o.userId, o.eventId)) return { skip: "they told Cue they weren't going" };
  const met = worthKeeping(await steps.extractMet(o.theirMessage, o.firstName).catch(() => []), o.theirMessage);
  if (!met.length) return { skip: "they didn't name anyone worth a note" };
  const [voice, ask] = await Promise.all([steps.theirVoice(o.userId), steps.theirAsk(o.userId)]);
  const notes: { name: string; text: string; met: Met }[] = [];
  for (const m of met) {
    const check = (t: string) => noteProblem(t, { theirNote: m.note, theirAsk: ask, eventName: o.eventName, theirFirstName: o.firstName, otherName: m.name });
    let draft = await steps.draftNote({ firstName: o.firstName, other: m, eventName: o.eventName, ask, voice, feedback: null }).catch(() => null);
    let why = draft ? check(draft) : "no draft";
    if (why) {
      draft = await steps.draftNote({ firstName: o.firstName, other: m, eventName: o.eventName, ask, voice, feedback: why }).catch(() => null);
      why = draft ? check(draft) : "no draft";
    }
    if (!why && draft) notes.push({ name: m.name, text: draft, met: m });
  }
  if (!notes.length) return { skip: "no note passed the checks" };
  const messages = [recapLine(o.eventName, notes.map((n) => n.met)), ...notes.map((n) => `${n.name}:\n${n.text}`)];
  return { messages, people: notes.length };
}
