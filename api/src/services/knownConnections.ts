// Relationship-aware matching (Royce, 2026-11-02): Cue never introduces two people who already know each other as if they were
// strangers. One check, alreadyConnected, read by all three matching paths before the tease and again right before any send,
// queued and deferred work included:
//   - the room (roomMatching.ts mayAsk / directAskStale, eventGuestMatchHandoff.ts sendIntroEmail),
//   - the same outside event (eventMatching.ts scores through the same room path),
//   - network intros (harness/matchGate.ts gatherNetworkFacts at queue and reveal, networkIntroNudge.ts networkAskStale and the
//     intro email), the no-show note's intro pick included (it goes through gateNetworkCandidate).
//
// What counts as "they know each other", and what doesn't:
//   - an intro Cue completed: a pair's intro email went (co_pairs.intro_sent_at, any event), a network intro was made
//     (network_introductions 'introduced'), or a connection is on record (member_connections);
//   - one of them said so: "X and I work together", "I already know them" (co_facts 'already_knows', owner-only, shown in what Cue
//     knows and removable there). Written by the post-turn read on a text (turnLearning.ts), the GPT-Live post-call read
//     (callLearning.ts), and the reply read on a yes to a named intro (saysAlreadyKnow, below). A model reads the statement, never a
//     regex: "I want to meet X" is the opposite and writes nothing. It is tied to one member only with explicit context (their reply
//     to Cue's own question about that person) or a full name: a person Cue named to them with that first AND last name, or, at check
//     time, the one active member with that full name. A first name alone never ties to anyone, even when Cue once named exactly one
//     person by it: it's kept as said and blocks nobody (same name is not same member);
//   - a direct personal invite: a referral naming the other person (referrals.recipient is their phone or email), or a vouch
//     (invite_codes.vouched_by). Joining through someone's invite LINK proves nothing: the link may have been forwarded.
//     KNOWN LIMIT: this signal is dead today and fails safe. vouched_by has had no writer since Mo was removed, and referrals is filled
//     only by an endpoint nothing calls (0 rows on dev), its recipient free text. Both read as "not known" until something writes them.
// What it never does: tell either member anything (a block is silent, as a decline is), or say which side said it.
//
// A reconnection is not an intro: this check only stops Cue presenting an existing contact as someone new. A separate, honest
// reconnection suggestion is not built here (it needs its own wording and Royce's yes).
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";

export const ALREADY_KNOWS = "already_knows";

export type ConnectionKind = "introduced" | "said" | "personal_invite";
export type Connection = { known: false } | { known: true; kind: ConnectionKind; why: string };

export type ConnectionRow = { introduced_room: boolean; introduced_network: boolean; connected: boolean; said: boolean; said_by_name: boolean; referral: boolean; vouched: boolean };

// Pure: the row's verdict. A forwarded invite link isn't in the row at all (it proves nothing). exceptNetwork: the network intro being
// sent right now marks its own row 'introduced' before the email goes (its claim), so its own send leaves that row out.
export function connectionFrom(r: Partial<ConnectionRow> | null | undefined, o: { exceptNetwork?: boolean } = {}): Connection {
  if (!r) return { known: false };
  if (r.introduced_room || (r.introduced_network && !o.exceptNetwork) || r.connected) return { known: true, kind: "introduced", why: "Cue already introduced them" };
  if (r.said || r.said_by_name) return { known: true, kind: "said", why: "one of them said they already know each other" };
  if (r.referral || r.vouched) return { known: true, kind: "personal_invite", why: "one personally invited the other" };
  return { known: false };
}

// One read, both directions. $1 < $2.
export const CONNECTION_SQL = `SELECT
  EXISTS (SELECT 1 FROM co_pairs WHERE a_id = $1 AND b_id = $2 AND intro_sent_at IS NOT NULL) AS introduced_room,
  EXISTS (SELECT 1 FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2 AND status = 'introduced') AS introduced_network,
  EXISTS (SELECT 1 FROM member_connections WHERE person_a = $1 AND person_b = $2) AS connected,
  EXISTS (SELECT 1 FROM co_facts f WHERE f.relation = '${ALREADY_KNOWS}' AND f.retired_at IS NULL
            AND ((f.owner_user_id = $1 AND f.meta->>'otherId' = $2::text) OR (f.owner_user_id = $2 AND f.meta->>'otherId' = $1::text))) AS said,
  EXISTS (SELECT 1 FROM co_facts f JOIN users o ON o.id = CASE WHEN f.owner_user_id = $1 THEN $2::uuid ELSE $1::uuid END
          WHERE f.relation = '${ALREADY_KNOWS}' AND f.retired_at IS NULL AND f.owner_user_id IN ($1, $2) AND f.meta->>'otherId' IS NULL
            AND COALESCE(f.meta->>'lastName', '') <> '' AND lower(f.meta->>'name') = lower(o.first_name) AND lower(f.meta->>'lastName') = lower(COALESCE(o.last_name, ''))
            AND (SELECT count(*) FROM users d WHERE lower(d.first_name) = lower(o.first_name) AND lower(COALESCE(d.last_name, '')) = lower(COALESCE(o.last_name, '')) AND d.archived_at IS NULL) = 1) AS said_by_name,
  EXISTS (SELECT 1 FROM referrals r JOIN users o ON o.id = CASE WHEN r.referrer_id = $1 THEN $2::uuid ELSE $1::uuid END
          WHERE r.referrer_id IN ($1, $2)
            AND ((o.email IS NOT NULL AND lower(trim(r.recipient)) = lower(o.email))
              OR (length(regexp_replace(r.recipient, '\\D', '', 'g')) >= 10 AND o.phone_number IS NOT NULL
                  AND right(regexp_replace(r.recipient, '\\D', '', 'g'), 10) = right(regexp_replace(o.phone_number, '\\D', '', 'g'), 10)))) AS referral,
  EXISTS (SELECT 1 FROM invite_codes c WHERE (c.vouched_by = $1 AND c.used_by = $2) OR (c.vouched_by = $2 AND c.used_by = $1)) AS vouched`;

// Do these two already know each other? A read that fails counts as not known (the other gates still hold) and is logged.
export async function alreadyConnected(x: string, y: string, o: { exceptNetwork?: boolean } = {}): Promise<Connection> {
  if (!x || !y || x === y) return { known: false };
  const [a, b] = x < y ? [x, y] : [y, x];
  try {
    const { rows } = await pool.query(CONNECTION_SQL, [a, b]);
    return connectionFrom(rows[0], o);
  } catch (err: any) {
    console.error("knownConnections: read failed (non-fatal):", err?.message ?? err);
    return { known: false };
  }
}

// The reason a match between x and y shouldn't go, or null, logged once per call site. For the paths' existing "why not" checks.
export async function knownReason(x: string, y: string, action: string): Promise<string | null> {
  const c = await alreadyConnected(x, y);
  if (!c.known) return null;
  await recordDecision({ layer: 6, decision: "match.known", userId: x, outcome: "skip", action, proposal: { other: y, kind: c.kind }, checks: [{ name: "not_already_connected", pass: false, reason: c.why }] }).catch(() => {});
  return `already connected (${c.kind})`;
}

// ---------------------------------------------------------------- their yes to an intro with someone they already know
//
// "yes! Maya and I already work together" to Cue's own "want to meet Maya?" (review of #359): the reply path acts on a yes before the
// post-turn read runs, so this is read first, only when a named intro's yes is about to be acted on (the one irreversible step), by a
// small model, never a regex. Yes: the pair is declined, silently (nobody is told why, the other person nothing at all), and the fact
// is kept against that person. A read that fails is no: the yes goes on as before, and the post-turn read still keeps what they said.
export function alreadyKnowReplyPrompt(firstName: string, message: string): string {
  return `Cue asked a member whether they'd like to be introduced to ${firstName}. Their reply: "${message.slice(0, 600)}"
Does the reply say they ALREADY know ${firstName} personally (they work together, are friends, have met before)? Wanting to meet ${firstName}, being curious about them, or saying yes to the intro is not knowing them.
Answer ONLY "yes" or "no".`;
}
export async function saysAlreadyKnow(firstName: string, message: string, read?: (prompt: string) => Promise<string>): Promise<boolean> {
  if (!firstName.trim() || !message.trim()) return false;
  try {
    const ask =
      read ??
      (async (prompt: string) => {
        const [{ generateText }, { anthropic }, { MODELS }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../models.js")]);
        const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 5, experimental_telemetry: { isEnabled: true, functionId: "knownConnections.replyRead" }, prompt });
        return text;
      });
    return /^\s*"?yes\b/i.test(await ask(alreadyKnowReplyPrompt(firstName, message)));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- "we already know each other"
//
// Read by the model, never a regex: the post-turn read on a text (turnLearning.ts, section 10) and the post-call read on a call
// (callLearning.ts, section 8) each return the people the member says they ALREADY know, with their exact words. A read, not a reply
// tool, as with advice (a tool Cue had to remember fired 1 time in 8): it runs on every turn whatever the reply did.

// The instruction both reads carry. A want to meet is the opposite; a mention is nothing.
export const ALREADY_KNOW_RULE = `anyone the person says they ALREADY know personally: they work together, are friends, have met before ("Ellis and I work together", "I already know Noor"). Only people they say they already know; someone they want to meet ("I'd love to meet Ellis"), ask about, or only mention is never one. For each: their first name, their last name only if the person said it (else null), and the person's exact words (at least a few words, copied from their own line). None when there are none.`;
export const ALREADY_KNOW_JSON = `"already_know": [{"name": "...", "last_name": null, "quote": "..."}]`;

export type AlreadyKnow = { name: string; lastName: string | null; quote: string };
const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: only with a quote really in their own words (code check, not the model's say), one entry per name, at most five.
export function alreadyKnowFrom(raw: unknown, theirWords: string): AlreadyKnow[] {
  const mine = squash(theirWords);
  const list = Array.isArray((raw as any)?.already_know) ? (raw as any).already_know : [];
  const out: AlreadyKnow[] = [];
  for (const x of list) {
    const name = String(x?.name ?? "").trim().split(/\s+/)[0] ?? "";
    const quote = typeof x?.quote === "string" ? x.quote.trim() : "";
    if (!name || squash(quote).split(" ").length < 3 || !mine.includes(squash(quote))) continue;
    const lastName = typeof x?.last_name === "string" && x.last_name.trim() ? x.last_name.trim() : null;
    if (!out.some((o) => o.name.toLowerCase() === name.toLowerCase() && (o.lastName ?? "").toLowerCase() === (lastName ?? "").toLowerCase())) out.push({ name, lastName, quote: quote.slice(0, 200) });
  }
  return out.slice(0, 5);
}

// What a read found, kept. Never throws.
export async function saveAlreadyKnow(x: string, found: AlreadyKnow[], source: "text" | "call"): Promise<number> {
  let n = 0;
  for (const k of found) {
    await noteAlreadyKnow(x, { name: k.name, lastName: k.lastName, theirWords: k.quote, source })
      .then(() => n++)
      .catch((err: any) => console.error("knownConnections: already-know write failed (non-fatal):", err?.message ?? err));
  }
  return n;
}

export type Named = { otherId: string; firstName: string; lastName?: string | null };

// Pure: who they mean, among the people Cue named to them. One first name (and last name, when given) to one member, or nothing.
export function resolveNamed(list: Named[], name: string, lastName?: string | null): Named | null {
  const first = String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const last = String(lastName ?? "").trim().toLowerCase();
  if (!first) return null;
  const hits = list.filter((n) => n.firstName.trim().toLowerCase() === first && (!last || String(n.lastName ?? "").trim().toLowerCase() === last));
  const ids = new Set(hits.map((h) => h.otherId));
  return ids.size === 1 ? hits[0] : null;
}

// The people Cue has named to this member: pairs it told them about, network reveals it made to them, intros it made.
export async function namedToThem(x: string): Promise<Named[]> {
  const [pairs, intros, reveals] = await Promise.all([
    import("./roomMatching.js").then((m) => m.pairsToldAbout(x)).catch(() => []),
    import("./secondContact.js").then((m) => m.introducedTo(x)).catch(() => []),
    pool
      .query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'network_intro_offer_pending' AND created_at > NOW() - INTERVAL '60 days'`, [x])
      .then((r) => r.rows.map((row: any) => { try { const c = JSON.parse(row.content)?.candidate; return c?.candidate_id ? { otherId: String(c.candidate_id), firstName: String(c.first_name ?? "") } : null; } catch { return null; } }).filter(Boolean) as Named[])
      .catch(() => [] as Named[]),
  ]);
  const ids = [...new Set([...pairs.map((p) => p.otherId), ...intros.map((i) => i.otherId), ...reveals.map((r) => r.otherId)])];
  if (!ids.length) return [];
  const { rows } = await pool.query(`SELECT id, first_name, last_name FROM users WHERE id = ANY($1::uuid[])`, [ids]).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ otherId: String(r.id), firstName: String(r.first_name ?? "").trim(), lastName: r.last_name ? String(r.last_name).trim() : null })).filter((n) => n.firstName);
}

// What they said, kept in their own record. Resolved to a member Cue named to them when one fits; otherwise kept by name (and last
// name, if they gave one), which blocks a match only through the one member with that full name (CONNECTION_SQL said_by_name).
// The result never says whether the person is a member, or whether they were resolved: the same answer either way.
// otherId: the member their words are plainly about (their reply to Cue's own question about that person), which needs no resolving.
export async function noteAlreadyKnow(x: string, o: { name: string; lastName?: string | null; theirWords: string; source: "text" | "call"; otherId?: string | null }, now = new Date()): Promise<{ resolved: boolean }> {
  const name = String(o.name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!name) return { resolved: false };
  const lastName = String(o.lastName ?? "").trim() || null;
  // Explicit context (otherId), or a full name Cue named to them. A first name alone ties to nobody (review of #359).
  const hit: Named | null = o.otherId ? { otherId: o.otherId, firstName: name, lastName } : lastName ? resolveNamed(await namedToThem(x), name, lastName) : null;
  // Said already (a live call tool and the call's read can both hear it): kept once.
  const { rows: had } = await pool
    .query(
      `SELECT 1 FROM co_facts WHERE owner_user_id = $1 AND relation = '${ALREADY_KNOWS}' AND retired_at IS NULL
         AND (($2::text IS NOT NULL AND meta->>'otherId' = $2::text) OR ($2::text IS NULL AND meta->>'otherId' IS NULL AND lower(meta->>'name') = lower($3) AND lower(COALESCE(meta->>'lastName', '')) = lower($4)))
       LIMIT 1`,
      [x, hit?.otherId ?? null, name, lastName ?? ""],
    )
    .catch(() => ({ rows: [] as any[] }));
  if (had.length) return { resolved: !!hit };
  const shown = hit ? `${hit.firstName}${hit.lastName && lastName ? ` ${hit.lastName}` : ""}` : `${name}${lastName ? ` ${lastName}` : ""}`;
  const { recordFactChecked } = await import("./coFacts.js");
  await recordFactChecked({
    ownerUserId: x, subject: "member", relation: ALREADY_KNOWS, label: `Already knows ${shown} (said ${now.toISOString().slice(0, 10)})`, visibility: "owner",
    source: o.source === "call" ? "callLearning" : "noteAlreadyKnow", happenedAt: now,
    meta: { otherId: hit?.otherId ?? null, name, lastName, quote: String(o.theirWords ?? "").slice(0, 200) },
  });
  await recordDecision({ layer: 6, decision: "match.known", userId: x, outcome: "act", action: `said:${o.source}`, proposal: { resolved: !!hit, other: hit?.otherId ?? null } }).catch(() => {});
  return { resolved: !!hit };
}
