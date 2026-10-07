// Another member's details never reach a member's reply context (Royce,
// 2026-10-01, #49): memories are made safe when they're read, before the
// relevance filter and the reply prompt ever see them, not by asking the
// model to hold back. The fact check cut a leak in the Maya case, but only
// after the reply agent had drafted it from a Co-written match memory.
//
// The tension: "Co introduced you to Maya" is the member's own history and
// stays; "Maya is building grid storage and left Tesla" is Maya's, and goes.
//   - Their own words ("User said:" lines) are theirs and stay as they are.
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
const OWN_WORDS = /^\s*(User said:|User:)/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Pure: what one history sentence about a member says, from the sentence that named them.
export function historyLine(sentence: string, name: string): string {
  if (/\bintro(duc\w*)?\b|\bconnect(ed|ing)?\b/i.test(sentence)) return `Co introduced them to ${name}, another member.`;
  if (/\bmatch\w*|\bsuggest\w*|\bnudg\w*|\bworth meeting\b|\bpoint\w* (them|you) (to|toward)/i.test(sentence)) return `Co suggested ${name}, another member, as someone to meet.`;
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
      return t === "network_offer_pending" || !name ? "Co mentioned that another member could be worth meeting, without naming them." : `Co offered to introduce them to ${name}, another member.`;
    } catch {
      return null;
    }
  }
  let text = content;
  // Tier 0 is a person: keep who, drop the reason (it's about them).
  // The rest of the line is events and openings, kept as written.
  if (t === "recommendation") return text.replace(/\[Tier 0\]\s*([^:|]+?)\s*:\s*[^|]*/g, (_m, name: string) => `[Tier 0] ${name.trim()}, another member (Co suggested meeting them) `).trim() || null;
  const names = linkedNames.map((n) => n.trim()).filter((n) => n.length >= 2);
  if (!names.length) return text.trim() || null;
  const named = new RegExp(`\\b(${names.map(escape).join("|")})\\b`);
  const out = text
    .split("\n")
    .map((line) => {
      if (OWN_WORDS.test(line) || !named.test(line)) return line;
      const seen = new Set<string>();
      const strip = (s: string) => {
        const m = s.match(named);
        if (!m) return s;
        const h = historyLine(s, m[1]);
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
    if (INTRO_RECORDS.has(r.memory_type ?? "")) out.push(`Co's record: ${(safeMemory(r.memory_type ?? null, String(r.content), []) ?? "").replace(/\s*\(score \d+\)/g, "").trim()}`);
    if (r.memory_type === "recommendation") for (const m of String(r.content).matchAll(/\[Tier 0\]\s*([^:|]+?)\s*:/g)) out.push(`Co's record: Co suggested ${m[1].trim()}, another member, to them as someone worth meeting.`);
  }
  return out;
}

// The members this one has been matched, nudged or introduced with: the only
// names stripped from Co's own lines, so their own people (a mentor who
// shares a member's first name) aren't touched in what they said.
export async function linkedMemberNames(userId: string): Promise<string[]> {
  const { rows } = await pool
    .query(
      `SELECT DISTINCT u.first_name FROM users u
       WHERE u.id <> $1 AND u.first_name IS NOT NULL AND u.id IN (
         SELECT candidate_id FROM event_guest_match_nudges WHERE person_id = $1
         UNION SELECT person_id FROM event_guest_match_nudges WHERE candidate_id = $1
         UNION SELECT candidate_id FROM event_guest_match_opt_ins WHERE person_id = $1
         UNION SELECT person_id FROM event_guest_match_opt_ins WHERE candidate_id = $1
         UNION SELECT candidate_id FROM event_match_offers WHERE person_id = $1 AND candidate_id IS NOT NULL
         UNION SELECT unnest(candidate_ids) FROM event_match_offers WHERE person_id = $1
         UNION SELECT person_id FROM event_match_offers WHERE candidate_id = $1 OR $1 = ANY(candidate_ids)
       )`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.first_name));
}

// Names Co's own records give for this member: the JSON intro offers and Tier 0 picks.
export function namesInRecords(rows: { content: string; memory_type?: string | null }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.memory_type === "network_offer_pending" || r.memory_type === "network_intro_offer_pending") {
      try {
        const n = JSON.parse(r.content)?.candidate?.first_name;
        if (n) out.push(String(n));
      } catch {}
    }
    if (r.memory_type === "recommendation") for (const m of r.content.matchAll(/\[Tier 0\]\s*([^:|]+?)\s*:/g)) out.push(m[1].trim());
  }
  return out;
}

// Memories as the reply may read them.
// linked: the names from linkedMemberNames, when the caller already has them.
export async function memberSafe(userId: string, rows: { content: string; memory_type?: string | null }[], linked?: string[]): Promise<string[]> {
  const names = [...new Set([...(linked ?? (await linkedMemberNames(userId))), ...namesInRecords(rows)])];
  return rows.map((r) => safeMemory(r.memory_type ?? null, String(r.content ?? ""), names)).filter((x): x is string => !!x);
}
