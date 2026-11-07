// Another member's details never reach a member's reply context (Royce,
// 2026-10-01, #49): memories are made safe when they're read, before the
// relevance filter and the reply prompt ever see them, not by asking the
// model to hold back. The fact check cut a leak in the Maya case, but only
// after the reply agent had drafted it from a Co-written match memory.
//
// The tension: "Co introduced you to Maya" is the member's own history and
// stays; "Maya is building grid storage and left Tesla" is Maya's, and goes.
//   - Their own words are theirs and stay as they are: "User said:" lines (how their texts are stored) and
//     "user:" lines (how a call transcript stores their turns, elevenLabsCalls.ts transcriptFromTurns). A
//     capitalized "User: ..." line is neither (no writer stores that form) and is stripped like any other
//     (2026-10-18: "User: coffee with Noor about her Oakland gallery" got through).
//   - A linked name is found in any case and with or without its accents, as a whole word ("noor", "NOOR",
//     "noor's", "Zoe" for Zoë): see nameFinder.
//   - Templated intro records (an intro email sent, a match nudge, an opt-in)
//     carry only names and the event, so they stay whole as history.
//   - Records that carry the other member's profile (network intro offers,
//     Tier 0 recommendations) are rewritten to the history line alone.
//   - Any other line Co wrote (a recap, a check-in, its own replies) keeps
//     every sentence that doesn't name a member they've been linked with; a
//     sentence that does becomes one plain history line about that person.
import pool from "../db/db.js";

// Already just names and the event (eventGuestMatchHandoff.ts,
// proactiveRegistry.ts, networkIntroNudge.ts).
const SAFE_TYPES = new Set(["event_intro_email_sent", "event_guest_match_nudge", "event_guest_match_optin", "network_offer_resolved"]);
// "User said:" in any case; "user:" only as the transcript writes it (lowercase), so a capitalized "User:" line isn't skipped.
const OWN_WORDS = { test: (line: string) => /^\s*User said:/i.test(line) || /^\s*user:/.test(line) };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// First names that are also everyday words. Any other linked name is found in any case. One of these is found when it's
// written with a capital ("Rose", "ROSE"), unless it opens a question as the verb ("Will you come?", "May I ask"); written in
// lowercase only in a person-like place: before "'s" or a person's verb ("rose said yes", "will's"), or after a verb that takes
// a person ("meet rose", "coffee with may"). So "the gallery rose in value" and "it will rain" stay. The tradeoff: a lowercase
// one of these anywhere else ("saw rose at the opening") is kept, one in a person-like place that isn't the person is stripped
// ("a cake with rose petals"), and so is a capitalized one ("Rose gold", "in May"). Every other name is matched in any case
// wherever it stands, so a place or thing that shares it is stripped too ("Jordan River trip" with a member named Jordan): safety over context, since "Jordan Rivers" is the person.
export const WORD_NAMES = new Set(
  "will may june april august rose grace hope faith joy mark bill pat art frank rich drew grant chase hunter dawn summer autumn sky ray max miles lane dean reed brook ivy iris lily daisy ruby amber jade pearl olive hazel holly penny robin sunny sandy rusty crystal heather violet rocky cliff gene jack ash eve sage river rain storm wren star melody harmony destiny bob sue rob don carol bud buck dot kit nick peg"
    .split(" "),
);
// The names that are also a question's opening verb.
const QUESTION_VERBS = new Set(["will", "may"]);
const PERSON_AFTER = /^(?:['’]s\b|\s+(?:said|says|told|tells|asked|asks|wants|wanted|thinks|thought|mentioned|replied|texted|called|emailed|agreed|is|was|has)\b)/i;
const PERSON_BEFORE = /\b(?:meet|met|meeting|introduce|introduced|intro|ask|asked|tell|told|text|texted|call|called|email|emailed|with)\s+$/i;
const PRONOUN_AFTER = /^\s+(?:i|you|we|they|he|she|it|this|that|there|not)\b/i;
const OPENS_SENTENCE = /(?:^|[.!?:]\s+|\n)\s*["'“‘(]?$/;

// Pure: a string without its accents, and where each of its characters came from in the original (one more entry for the end):
// "Zoë", "Zoe" and a decomposed "Zoe\u0308" all read "Zoe". Case is kept (the match is case-insensitive; personLike reads case).
function folded(s: string): { text: string; from: number[] } {
  let text = "";
  const from: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "");
    for (let k = 0; k < f.length; k++) from.push(i);
    text += f;
    i += ch.length;
  }
  from.push(i);
  return { text, from };
}
const fold = (s: string) => folded(s).text;

function personLike(s: string, at: number, hit: string, name: string): boolean {
  if (!WORD_NAMES.has(fold(name).toLowerCase()) || /\s/.test(name)) return true;
  const before = s.slice(0, at);
  const after = s.slice(at + hit.length);
  if (hit[0] === hit[0].toLowerCase()) return PERSON_AFTER.test(after) || PERSON_BEFORE.test(before);
  return !(QUESTION_VERBS.has(fold(name).toLowerCase()) && OPENS_SENTENCE.test(before) && PRONOUN_AFTER.test(after));
}

// Pure: a finder for the linked names. Each name is a whole word (letters on either side don't count, accents included) in any
// case, accents folded on both sides; it returns the name as given (not as written), for the leftmost one that stands for a
// person, or null.
export function nameFinder(linkedNames: string[]): (s: string) => string | null {
  const span = nameSpanFinder(linkedNames);
  return (s: string) => span(s)?.name ?? null;
}

// Pure: the same finder, with where the leftmost hit stands in s ([at, end) in s's own characters), for a caller that rewrites it
// (services/memberSnapshot.ts takes every linked name out of the snapshot).
export function nameSpanFinder(linkedNames: string[]): (s: string) => { at: number; end: number; name: string } | null {
  const names = [...new Set(linkedNames.map((n) => n.trim()).filter((n) => n.length >= 2))];
  if (!names.length) return () => null;
  const res = names.map((name) => ({ name, re: new RegExp(`(?<![\\p{L}\\p{N}_])${escape(fold(name)).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "giu") }));
  // Folding each character on its own also reads a decomposed form ("e" + a combining mark) as its letter, so no NFC pass is needed.
  return (s: string) => {
    const f = folded(s);
    let best: { at: number; end: number; name: string } | null = null;
    for (const { name, re } of res) {
      for (const m of f.text.matchAll(re)) {
        const at = f.from[m.index ?? 0];
        const end = f.from[(m.index ?? 0) + m[0].length];
        if (best && at >= best.at) break;
        if (personLike(s, at, s.slice(at, end), name)) {
          best = { at, end, name };
          break;
        }
      }
    }
    return best;
  };
}

// What historyLine writes (whole, or its first part when split on "; "): never rewritten again. The name slot is captured, and the line
// only counts as the strip's own when that slot is exactly a linked member's name (ownHistory): anything else, even with the suffix, is stripped.
const OWN_HISTORY = /^(?:Cue introduced them to ([^,;]+), another member\.?|Cue suggested ([^,;]+), another member, as someone to meet\.?|([^,;]+), another member, came up here(?:; their details aren't kept for this conversation\.?)?)$/;
const ownHistory = (line: string, names: string[]): boolean => {
  const m = OWN_HISTORY.exec(line.trim());
  // The slot is compared as written (no trim): "Maya , another member, came up here" isn't the strip's own output, so it is rewritten.
  const slot = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  return !!slot && names.some((n) => n.trim() === slot);
};
// Everything after a linked member's name is hers until the text clearly turns back to the member (2026-11-06, Royce: no cross-member leaks,
// safe side). The rewrite replaces the part that names her; the parts after it are dropped too, however they refer back ("She left
// Stripe", "Left Stripe last week", "It rained. She left"), across sentences, "; " items and the lines of one paragraph. It ends at:
//   - a part that opens with the member speaking (I, my, me, we) AND points back at no one (no she/he/her/him/they/them/their, no
//     descriptor): "I told him she's moving" and "I'm pregnant, she said" keep going. In a Cue-written line (a "Co replied:" line, a
//     snapshot line) "I" is Cue, never the member, so it ends nothing there;
//   - a part with the member's own first name or "the member" and no pointer back (Cue's third-person lines about them);
//   - the start of a bullet, numbered item, header or label line, or a blank line (a new paragraph): never crossed;
//   - a part that names a different linked member (its own strip), or the end of the text.
// A "User said:" line is the member's own words and is kept; one that named her keeps the carry into the next line.
// A part that opens with a quote is never the member speaking: it may be her words ("I'm pregnant.").
const MEMBER_SPEAKS = /^[\s\-*•\d.)>]*(?:i|my|me|we)\b/i;
// Cue's own third-person line about the member: opens with their name or "the member" and says what THEY want, nothing about anyone else.
const MEMBER_WANTS = /^\s*(?:the member|NAME)(?:['’]s)?\s+(?:wants?|needs?|is looking for|are looking for|would like|likes?|prefers?|hopes?|is hoping|is free|is available|is open to|asked for|is interested in)\b/i;
// A part with no finite verb cue: a bare detail ("Pregnant, moving to Austin", "Left Stripe last week"), with no subject of its own.
const FINITE = /\b(?:am|is|are|was|were|has|have|had|will|would|can|could|do|does|did|wants?|needs?|likes?|loves?|prefers?|said|says|told|asked|thinks?|[a-z]{3,}ed)\b/i;
const fragment = (s: string) => !FINITE.test(s);
const POINTS_BACK = /\b(?:she|he|her|hers|him|his|herself|himself|they|them|their|theirs|themselves)\b/i;
const DESCRIPTOR = /\b(?:the|that|this|said)\s+(?:[\w-]+\s+)?(?:founder|cofounder|co-founder|ceo|cto|designer|engineer|developer|artist|director|manager|investor|partner|friend|colleague|boss|mentor|candidate|person|woman|man|guy|lady|owner|writer|photographer|doctor|lawyer|consultant|other member|other person)\b/i;
const pointsBack = (s: string) => POINTS_BACK.test(s) || DESCRIPTOR.test(s);
const STRUCTURAL = /^\s*(?:(?:[-*•–]|\d+[.)])\s+|#{1,6}\s|[^.!?\n]{1,80}:\s*$|\[[^\]\n]{1,40}\]\s*$)/;
const BULLET = /^\s*(?:[-*\u2022\u2013]|\d+[.)])\s+/;
const CUE_LABEL = /^\s*(?:co|cue)\b[^:\n]{0,40}:/i;
// The suffix historyLine ends a "came up" line with; a stripped part followed by it on a "; " split doesn't carry it twice.
const SUFFIX_ONLY = /^their details aren't kept for this conversation\.?$/i;

// Pure: what one history sentence about a member says, from the sentence that named them.
export function historyLine(sentence: string, name: string): string {
  const kind = historyKind(sentence);
  if (kind === "intro") return `Cue introduced them to ${name}, another member.`;
  if (kind === "suggested") return `Cue suggested ${name}, another member, as someone to meet.`;
  return `${name}, another member, came up here; their details aren't kept for this conversation.`;
}
// Pure: which history a sentence about another member is (the one classification historyLine and namelessHistoryLine share).
export function historyKind(sentence: string): "intro" | "suggested" | "came_up" {
  if (/\bintro(duc\w*)?\b|\bconnect(ed|ing)?\b/i.test(sentence)) return "intro";
  if (/\bmatch\w*|\bsuggest\w*|\bnudg\w*|\bworth meeting\b|\bpoint\w* (them|you) (to|toward)/i.test(sentence)) return "suggested";
  return "came_up";
}
// Pure: the same history line without the name, for a store that holds no other member's name at all (services/memberSnapshot.ts).
export function namelessHistoryLine(sentence: string): string {
  const kind = historyKind(sentence);
  if (kind === "intro") return "Cue introduced them to another member.";
  if (kind === "suggested") return "Cue suggested another member as someone to meet.";
  return "Another member came up here; their details aren't kept.";
}

// Pure: the one policy for stripping a text around linked members, shared by safeMemory (a history line with the name) and the snapshot's
// fenceLine (nameless). Parts are lines, sentences and "; " items. A part that names a member is rewritten (or kept whole when it is the strip's
// own output, keepPart), and carries: every part after it is dropped until the text turns back to the member (see MEMBER_SPEAKS above), a bullet,
// header or paragraph starts, or a member is named again. A line keepLine accepts (their own stored words) is kept. n counts the parts rewritten.
export function stripAfterNames(
  text: string,
  o: {
    named: (s: string) => boolean;
    keepLine?: (line: string) => boolean;
    keepPart?: (s: string) => boolean;
    noSplit?: (sentence: string) => boolean;
    rewrite: (s: string) => string;
    // The member's own first name(s): a part with one and no pointer back is Cue talking about the member, which ends the carry.
    ownNames?: string[];
    // False when every line is Cue's (the snapshot): "I" there is Cue. Otherwise "I" is the member's, except in a "Co replied:" line.
    iIsMember?: boolean;
  },
): { text: string; n: number } {
  const own = (o.ownNames ?? []).map((x) => x.trim()).filter((x) => x.length >= 2);
  const memberWants = new RegExp(MEMBER_WANTS.source.replace("NAME", own.length ? own.map((x) => escape(x).replace(/\s+/g, "\\s+")).join("|") : "(?!)"), "iu");
  let carrying = false;
  let carryBullet = false; // the line that started the carry was a bullet
  let underHeader = false; // a header line came before: bullets are independent items of a section
  let justEnded = false; // the carry just ended on the member's own part: a bare detail right after it still goes
  let cue = !o.iIsMember;
  let n = 0;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      // A blank line is a new paragraph for Cue's cue state only; the carry goes on unless the next line is a header or turns back to the member.
      cue = !o.iIsMember;
      lines.push(line);
      continue;
    }
    const isBullet = BULLET.test(line);
    const isHeader = STRUCTURAL.test(line) && !isBullet;
    if (isHeader) {
      carrying = false;
      justEnded = false;
      underHeader = true;
    } else if (isBullet && carrying && carryBullet && underHeader && !POINTS_BACK.test(line.replace(BULLET, "").trim().split(/\s+/)[0] ?? "")) {
      // Sibling items of a section (a recap's bullets) are independent; one that starts by pointing back at her keeps the carry.
      carrying = false;
    }
    if (o.iIsMember && CUE_LABEL.test(line)) cue = true;
    if (o.keepLine?.(line)) {
      // Their own words stay; if they named her, the next line is still about her. One that doesn't name her leaves the carry as it is.
      if (o.named(line)) carrying = true;
      lines.push(line);
      continue;
    }
    if (!carrying && !justEnded && !o.named(line)) {
      lines.push(line);
      continue;
    }
    // A bullet keeps its marker; the rest of the line is what's judged.
    const marker = BULLET.exec(line)?.[0] ?? "";
    const body = marker ? line.slice(marker.length) : line;
    const seen = new Set<string>();
    const endsCarry = (part: string): boolean => {
      if (pointsBack(part)) return false;
      if (memberWants.test(part)) return true;
      return !cue && MEMBER_SPEAKS.test(part);
    };
    const step = (part: string): string => {
      // The history line's own tail, when it was split on "; ": never a detail, and it doesn't end the carry.
      if (SUFFIX_ONLY.test(part.trim())) return part;
      if (o.named(part)) {
        carrying = true;
        carryBullet = !!marker;
        justEnded = false;
        if (o.keepPart?.(part)) return part;
        const h = o.rewrite(part);
        n++;
        if (seen.has(h)) return "";
        seen.add(h);
        return h;
      }
      if (!carrying) {
        if (justEnded && fragment(part)) {
          carrying = true;
          justEnded = false;
          return "";
        }
        justEnded = false;
        return part;
      }
      if (endsCarry(part)) {
        carrying = false;
        justEnded = true;
        return part;
      }
      return "";
    };
    const sentences = body.split(/(?<=[.!?])\s+/).map((sentence) => {
      // List items ("Wants right now: a cofounder; ...") are judged one by one, so the member's own items stay.
      if (!sentence.includes("; ") || !(carrying || o.named(sentence)) || o.keepPart?.(sentence) || o.noSplit?.(sentence)) return step(sentence);
      let joined = "";
      for (const item of sentence.split("; ")) {
        const out = step(item);
        if (!out) continue;
        if (SUFFIX_ONLY.test(out.trim()) && joined.includes("their details aren't kept for this conversation")) continue;
        // After a part that already ends a sentence, the next one is a new sentence, not "; ...".
        joined = !joined ? out : /[.!?]$/.test(joined) ? `${joined} ${out}` : `${joined}; ${out}`;
      }
      return joined;
    });
    const out = sentences.filter(Boolean).join(" ");
    if (out) lines.push(`${marker}${out}`);
  }
  return { text: lines.join("\n").trim(), n };
}

// Pure: one memory made safe, or null when nothing safe is left in it.
export function safeMemory(type: string | null, content: string, linkedNames: string[], ownNames: string[] = []): string | null {
  const t = type ?? "";
  // An additive offer never named anyone to them: older rows listed who arrived in parentheses. Never passed on.
  if (t === "event_guest_match_nudge" && /^Additive offer\b/.test(content)) return content.replace(/\s*\([^)]*\)\s*$/, "").replace(/\bcandidate\(s\) checked in\b/, "more people checked in") + (/\bno one has been named\b/.test(content) ? "" : " No one has been named to them.");
  if (SAFE_TYPES.has(t)) return content;
  // The other member's whole profile, as JSON.
  if (t === "network_offer_pending" || t === "network_intro_offer_pending") {
    try {
      const name = String(JSON.parse(content)?.candidate?.first_name ?? "").trim();
      // The tease never named them to this member; the offer after it did.
      return t === "network_offer_pending" || !name ? "Cue mentioned that another member could be worth meeting, without naming them." : `Cue offered to introduce them to ${name}, another member.`;
    } catch {
      return null;
    }
  }
  let text = content;
  // Tier 0 is a person: keep who, drop the reason (it's about them).
  // The rest of the line is events and openings, kept as written.
  if (t === "recommendation") return text.replace(/\[Tier 0\]\s*([^:|]+?)\s*:\s*[^|]*/g, (_m, name: string) => `[Tier 0] ${name.trim()}, another member (Cue suggested meeting them) `).trim() || null;
  const names = linkedNames.map((n) => n.trim()).filter((n) => n.length >= 2);
  if (!names.length) return text.trim() || null;
  const find = nameFinder(names);
  const out = stripAfterNames(text, {
    named: (x) => find(x) !== null,
    keepLine: (line) => OWN_WORDS.test(line),
    keepPart: (x) => ownHistory(x, names),
    rewrite: (x) => historyLine(x, find(x) ?? ""),
    ownNames,
    iIsMember: true,
  }).text;
  return out || null;
}

// Co's own intro records, written by code when the intro happened: facts
// about what Co did, so "I introduced you to Maya" isn't cut as unbacked
// (they aren't in co_facts). Names and the event only.
const INTRO_RECORDS = new Set(["event_intro_email_sent", "event_guest_match_nudge", "event_guest_match_optin"]);
// A Tier 0 pick (recommendation.ts writes it when Co sends it) is one too:
// without it, "I flagged Maya as worth meeting" was cut (2026-10-01 live run).
export function introFacts(rows: { content: string; memory_type?: string | null }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.content) continue;
    // Never the internal match score (older nudge rows carried "(score 88)").
    if (INTRO_RECORDS.has(r.memory_type ?? "")) out.push(`Cue's record: ${(safeMemory(r.memory_type ?? null, String(r.content), []) ?? "").replace(/\s*\(score \d+\)/g, "").trim()}`);
    if (r.memory_type === "recommendation") for (const m of String(r.content).matchAll(/\[Tier 0\]\s*([^:|]+?)\s*:/g)) out.push(`Cue's record: Cue suggested ${m[1].trim()}, another member, to them as someone worth meeting.`);
  }
  return out;
}

// The members this one was told about or introduced to, in their own conversation (MEMBER_NAMES_SQL): the only names stripped from
// Cue's own lines, so their own people (a mentor who shares a member's first name) aren't touched in what they said, and never a
// name only the other side's state knows. The same set as memberNamesStrict, network
// intros included, and it fails the same way: a failed lookup throws, so a caller leaves the text out instead of reading it
// unstripped (it returned no names, so nothing was stripped; context-sources review, 2026-10-27).
export async function linkedMemberNames(userId: string): Promise<string[]> {
  return memberNamesStrict(userId);
}

// Names Co's own records give for this member: the named intro offers and Tier 0 picks, each written when it reached them. Not a
// tease (network_offer_pending): it never named the person to them, and its row is rewritten to an unnamed line on its own
// (safeMemory), so its name on the list only told them who it was (2026-10-28, own side only).
export function namesInRecords(rows: { content: string; memory_type?: string | null }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.memory_type === "network_intro_offer_pending") {
      try {
        const n = JSON.parse(r.content)?.candidate?.first_name;
        if (n) out.push(String(n));
      } catch {}
    }
    if (r.memory_type === "recommendation") for (const m of r.content.matchAll(/\[Tier 0\]\s*([^:|]+?)\s*:/g)) out.push(m[1].trim());
  }
  return out;
}

// One line at a time, keeping positions: a strip function for structured context (threads, loops, carrying, transcripts) that
// isn't a co_memories row. The same rule and the same names as memberSafe (review of #118): the members Cue told them about
// (nudges, asks and offers that reached them), plus the names Co's own records give (Tier 0 picks, named intro offers) and anyone
// introduced to them. The
// member's own words ("User said: ...") are theirs and kept. A failed name lookup throws, so callers that catch it leave the
// context out instead of sending it unstripped.
export async function memberSafeLine(userId: string, linked?: string[], own?: string[]): Promise<(s: string) => string | null> {
  const names = linked ?? (await memberNamesStrict(userId));
  const ownNames = own ?? (linked ? [] : await ownFirstName(userId));
  return (s: string) => safeMemory("context", String(s ?? ""), names, ownNames);
}

// The member's own first name, for the strip to see where Cue's text turns back to them. Only asked when the caller is already reading the database
// for the linked names; a failed lookup is none (the strip then drops more, never less).
export async function ownFirstName(userId: string): Promise<string[]> {
  try {
    const r = await pool.query("SELECT first_name FROM users WHERE id = $1", [userId]);
    const n = String(r.rows?.[0]?.first_name ?? "").trim();
    return n ? [n] : [];
  } catch {
    return [];
  }
}

// Only this member's own side (2026-10-28, Royce: no cross-member leaks). A name on this list is a member THIS member knows as one,
// because they learned it in their own conversation: Cue named the person to them, or the intro email went to both. The list is
// what Cue's lines are stripped of, and the strip says so out loud: "Sarah, another member, came up here" (historyLine), shown to the
// reply and on their what-Cue-knows page. So a name that came from the other side's state alone (someone else was nudged about
// them, said yes about them, was asked or offered them, or was among the people an additive offer counted) told them Sarah is a
// member and is linked to them, the first time anything in their thread said "Sarah" (their sister, a coworker, the same Sarah).
// Leaving those names off opens nothing: another member's details reach this member's lines only through what Cue told THIS member
// about them (every writer of a match line writes it to the person it told), and each of those is read here.
//   - a nudge that reached them and named the person: not an anonymous heads-up (it names no one), not a claim still pending;
//   - a question about the person that reached them (a nudge, a direct ask, the reveal after an additive yes), whatever came of it
//     since: not one queued or still being sent (it hasn't reached them), and never the people an additive offer counted;
//   - their own answer about the person, except an answer to an anonymous heads-up (they never heard who) and an intro they asked for
//     by name that hasn't been made: its opt-in rows exist only when the person they named was found, so the name on this list told
//     them she was found ("found/not-found results shouldn't leak", #294);
//   - the intro email went to both (co_pairs.intro_sent_at; before co_pairs, both said yes at that event, which sent it).
export const MEMBER_NAMES_SQL = `WITH my_pairs AS (
         SELECT event_id, CASE WHEN a_id = $1 THEN b_id ELSE a_id END AS other, origin, intro_sent_at FROM co_pairs WHERE a_id = $1 OR b_id = $1
       ), asked_by_name AS (
         SELECT other FROM my_pairs GROUP BY 1 HAVING bool_or(origin = 'member') AND NOT bool_or(intro_sent_at IS NOT NULL)
       )
       SELECT DISTINCT u.first_name FROM users u
       WHERE u.id <> $1 AND u.first_name IS NOT NULL AND u.id IN (
         SELECT candidate_id FROM event_guest_match_nudges WHERE person_id = $1 AND NOT anonymous AND NOT pending
         UNION SELECT candidate_id FROM event_match_offers WHERE person_id = $1 AND candidate_id IS NOT NULL AND kind <> 'additive'
           AND opened_at IS NOT NULL AND status NOT IN ('queued', 'sending')
         UNION SELECT o.candidate_id FROM event_guest_match_opt_ins o WHERE o.person_id = $1 AND o.candidate_id NOT IN (SELECT other FROM asked_by_name)
           AND NOT EXISTS (SELECT 1 FROM event_guest_match_nudges n WHERE n.event_id = o.event_id AND n.person_id = o.person_id AND n.candidate_id = o.candidate_id AND n.anonymous)
         UNION SELECT other FROM my_pairs WHERE intro_sent_at IS NOT NULL
         UNION SELECT o.candidate_id FROM event_guest_match_opt_ins o JOIN event_guest_match_opt_ins r ON r.event_id = o.event_id AND r.person_id = o.candidate_id AND r.candidate_id = o.person_id
           WHERE o.person_id = $1 AND o.status = 'interested' AND r.status = 'interested'
             AND NOT EXISTS (SELECT 1 FROM my_pairs p WHERE p.event_id = o.event_id AND p.other = o.candidate_id)
       )`;

// The network side, the same rule: their own yes to a named intro offer, or the intro made (both said yes). A tease they passed on
// ("want to hear who?" "no") writes a declined row with a person they never heard of, and the other side's yes alone isn't theirs.
// A named offer they turned down is theirs too, and comes from their own record of it (network_intro_offer_pending, namesInRecords).
export const NETWORK_NAMES_SQL = `SELECT DISTINCT u.first_name FROM network_introductions n JOIN users u ON u.id = CASE WHEN n.person_a_id = $1 THEN n.person_b_id ELSE n.person_a_id END
       WHERE (n.person_a_id = $1 OR n.person_b_id = $1) AND u.first_name IS NOT NULL
         AND (n.status = 'introduced' OR (CASE WHEN n.person_a_id = $1 THEN n.a_interested_at ELSE n.b_interested_at END) IS NOT NULL)`;

export async function memberNamesStrict(userId: string): Promise<string[]> {
  const [linked, records, intros] = await Promise.all([
    pool.query(
      MEMBER_NAMES_SQL,
      [userId],
    ),
    pool.query(`SELECT content, memory_type FROM co_memories WHERE user_id = $1 AND memory_type IN ('network_intro_offer_pending', 'recommendation') ORDER BY created_at DESC LIMIT 200`, [userId]),
    pool.query(NETWORK_NAMES_SQL, [userId]),
  ]);
  return [...new Set([...linked.rows.map((r: any) => String(r.first_name)), ...namesInRecords(records.rows), ...intros.rows.map((r: any) => String(r.first_name))])];
}

// Memories as the reply may read them.
// linked: the names from linkedMemberNames, when the caller already has them.
export async function memberSafe(userId: string, rows: { content: string; memory_type?: string | null }[], linked?: string[], own?: string[]): Promise<string[]> {
  const names = [...new Set([...(linked ?? (await linkedMemberNames(userId))), ...namesInRecords(rows)])];
  const ownNames = own ?? (linked ? [] : await ownFirstName(userId));
  return rows.map((r) => safeMemory(r.memory_type ?? null, String(r.content ?? ""), names, ownNames)).filter((x): x is string => !!x);
}
