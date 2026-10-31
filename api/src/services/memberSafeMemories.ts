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
const WORD_NAMES = new Set(
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

// Pure: what one history sentence about a member says, from the sentence that named them.
export function historyLine(sentence: string, name: string): string {
  if (/\bintro(duc\w*)?\b|\bconnect(ed|ing)?\b/i.test(sentence)) return `Cue introduced them to ${name}, another member.`;
  if (/\bmatch\w*|\bsuggest\w*|\bnudg\w*|\bworth meeting\b|\bpoint\w* (them|you) (to|toward)/i.test(sentence)) return `Cue suggested ${name}, another member, as someone to meet.`;
  return `${name}, another member, came up here; their details aren't kept for this conversation.`;
}

// Pure: one memory made safe, or null when nothing safe is left in it.
export function safeMemory(type: string | null, content: string, linkedNames: string[]): string | null {
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
  const named = { test: (x: string) => find(x) !== null };
  const out = text
    .split("\n")
    .map((line) => {
      if (OWN_WORDS.test(line) || !named.test(line)) return line;
      const seen = new Set<string>();
      const strip = (s: string) => {
        const name = find(s);
        if (!name) return s;
        const h = historyLine(s, name);
        if (seen.has(h)) return "";
        seen.add(h);
        return h;
      };
      // List items ("Wants right now: a cofounder; …") are stripped one by one,
      // so their own items on the same line stay.
      return line
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => (sentence.includes("; ") && named.test(sentence) ? sentence.split("; ").map(strip).filter(Boolean).join("; ") : strip(sentence)))
        .filter(Boolean)
        .join(" ");
    })
    .join("\n")
    .trim();
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
export async function memberSafeLine(userId: string, linked?: string[]): Promise<(s: string) => string | null> {
  const names = linked ?? (await memberNamesStrict(userId));
  return (s: string) => safeMemory("context", String(s ?? ""), names);
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
export async function memberSafe(userId: string, rows: { content: string; memory_type?: string | null }[], linked?: string[]): Promise<string[]> {
  const names = [...new Set([...(linked ?? (await linkedMemberNames(userId))), ...namesInRecords(rows)])];
  return rows.map((r) => safeMemory(r.memory_type ?? null, String(r.content ?? ""), names)).filter((x): x is string => !!x);
}
