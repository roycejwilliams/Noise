// A fake world for the in-room matching path (analysis/in-room-matching, 2026-10-07).
// Model-free: pool.query and pool.connect are an in-memory store that answers the exact SQL the in-room code runs,
// fetch is stubbed (Luma from a fake calendar, Anthropic from a deterministic scorer/drafter, embeddings zero,
// everything else refused), and Sendblue's send is captured, never sent. Invented people only, test-range numbers.
//
// Import this FIRST (before any src import): it sets placeholder keys and a dead DATABASE_URL.
process.env.SENDBLUE_API_API_KEY ||= "ci";
process.env.SENDBLUE_API_API_SECRET ||= "ci";
process.env.SENDBLUE_API_KEY ||= "ci";
process.env.SENDBLUE_SECRET_KEY ||= "ci";
process.env.ANTHROPIC_API_KEY ||= "ci";
process.env.OPENAI_API_KEY ||= "ci";
process.env.LUMA_API_KEY ||= "ci";
process.env.SENDBLUE_PHONE_NUMBER ||= "+14155550100";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.JEV_PRUNE = "off";

export type Member = {
  id: string;
  first_name: string;
  phone_number: string | null;
  email: string;
  sms_opted_out?: boolean;
  archived_at?: string | null;
  last_name?: string | null;
  invite_verified?: boolean;
  city?: string | null;
  goals?: string[];
  blockers?: string[];
  activity_preferences?: string[];
  long_term_direction?: string | null;
  intent?: unknown[];
  memories?: string[]; // private memories (co_memories rows other than text the test writes)
  ownerFacts?: string[]; // owner-only co_facts
  safetyHold?: boolean; // co_profiles.safety_hold_until in the future (services/safety.ts)
};

export type FakeEvent = {
  api_id: string;
  name: string;
  start_at: string;
  end_at: string | null;
  // Luma guest rows: email/phone as Luma has them, plus approval_status.
  guests: { email: string | null; phone: string | null; name: string; approval_status: string }[];
};

type Row = Record<string, any>;

export const W = {
  members: new Map<string, Member>(),
  events: new Map<string, FakeEvent>(),
  nudges: [] as Row[], // event_guest_match_nudges (event_id, person_id) unique
  offers: [] as Row[], // event_match_offers (event_id, person_id, candidate_key) unique
  optIns: [] as Row[], // event_guest_match_opt_ins (event_id, person_id, candidate_id) unique
  rankings: new Map<string, Row>(), // `${event}|${person}`
  proactiveSends: [] as Row[],
  candidates: [] as Row[], // proactive_candidates
  memoriesWritten: [] as Row[], // co_memories inserts from code
  presence: new Map<string, Row>(), // `${event}|${user}`
  walkins: [] as Row[],
  solicited: new Map<string, number>(),
  scoringDebounce: new Map<string, number>(),
  additiveDebounce: new Map<string, number>(),
  networkIntros: [] as Row[],
  checkinFollowups: [] as Row[], // event_checkin_followups (for resolveNamedEventGuest)
  unmatchedFollowups: [] as Row[],
  unmatchedNotices: [] as Row[],
  decisions: [] as Row[],
  sent: [] as { to: string; content: string }[],
  emails: [] as string[],
  unknownSql: new Set<string>(),
  pairs: [] as Row[], // co_pairs (services/roomMatching.ts): one row per (event, pair)
  roomClosures: new Map<string, Row>(), // event_room_closures
  // Scorer: (askText, candidate) => score/share/mutual. Default: keyword overlap.
  scorer: null as null | ((ask: string, cand: Member) => { score: number; share: boolean; mutual?: boolean }),
  // The scorer's model call fails (a 400) while true.
  scorerFail: false,
  // Consent read verdict (the model half of introConsent): default no violation.
  consentViolation: (_msg: string) => false,
  // The end-of-night close drafter (null: a warm default naming them).
  closeDraft: null as null | ((name: string) => string),
  // Luma's guest list read fails (a 500) while true.
  lumaGuestListFail: false,
  llmCalls: [] as { kind: string; prompt: string }[],
};

export function reset(): void {
  W.members.clear();
  W.events.clear();
  for (const k of ["nudges", "offers", "optIns", "proactiveSends", "candidates", "memoriesWritten", "walkins", "networkIntros", "checkinFollowups", "unmatchedFollowups", "unmatchedNotices", "decisions", "sent", "emails", "llmCalls"] as const) (W as any)[k].length = 0;
  W.rankings.clear();
  W.presence.clear();
  W.solicited.clear();
  W.scoringDebounce.clear();
  W.additiveDebounce.clear();
  W.unknownSql.clear();
  W.pairs.length = 0;
  W.roomClosures.clear();
  W.scorer = null;
  W.scorerFail = false;
  W.consentViolation = () => false;
  W.closeDraft = null;
  W.lumaGuestListFail = false;
}

let seq = 0;
export function uuid(): string {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

// Test-range numbers (+1 415 555 01xx) only.
let phoneSeq = 10;
export function addMember(m: Partial<Member> & { first_name: string }): Member {
  const id = m.id ?? uuid();
  const phone = m.phone_number === undefined ? `+141555501${String(phoneSeq++).padStart(2, "0")}` : m.phone_number;
  const full: Member = {
    id,
    email: m.email ?? `${m.first_name.toLowerCase().replace(/\W/g, "")}.${id.slice(-4)}@example.test`,
    phone_number: phone,
    sms_opted_out: false,
    archived_at: null,
    city: null,
    goals: [],
    blockers: [],
    activity_preferences: [],
    long_term_direction: null,
    intent: [],
    memories: [],
    ownerFacts: [],
    ...m,
    id,
    first_name: m.first_name,
  };
  // A tag the stub scorer reads back from the digest line to know who it is scoring (never shown to anyone).
  full.activity_preferences = [...(full.activity_preferences ?? []), `tag${id.slice(-6)}`];
  W.members.set(id, full);
  return full;
}

// Test members have said Co may mention their asks in intros (shareable), unless a test says otherwise.
export const ask = (text: string, type: "seeking" | "offering" = "seeking", shareable = true) => ({ id: uuid(), text, type, status: "active", kind: "ask", shareable });
export const goal = (text: string) => ({ id: uuid(), text, type: "seeking", status: "active", kind: "goal" });

export function addEvent(e: Partial<FakeEvent> & { api_id: string; name: string }, attendees: { m: Member; status?: string; via?: "email" | "phone" | "both"; emailCase?: "upper" }[] = []): FakeEvent {
  const ev: FakeEvent = {
    start_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    end_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    guests: [],
    ...e,
  };
  for (const a of attendees) {
    const via = a.via ?? "email";
    ev.guests.push({
      email: via === "phone" ? null : a.emailCase === "upper" ? a.m.email.toUpperCase() : a.m.email,
      phone: via === "email" ? null : a.m.phone_number,
      name: a.m.first_name,
      approval_status: a.status ?? "approved",
    });
  }
  W.events.set(ev.api_id, ev);
  return ev;
}

const now = () => Date.now();
const prof = (m: Member) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number, email: m.email, city: m.city, goals: m.goals, blockers: m.blockers, activity_preferences: m.activity_preferences, intent: m.intent });

// ------------------------------------------------------------------ SQL
function handle(sqlRaw: string, p: any[] = []): { rows: Row[]; rowCount: number } {
  const sql = sqlRaw.replace(/\s+/g, " ").trim();
  const R = (rows: Row[]) => ({ rows, rowCount: rows.length });
  const has = (s: string) => sql.includes(s);

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || has("pg_advisory_xact_lock")) return R([]);
  if (has("INSERT INTO harness_decisions")) {
    W.decisions.push({ layer: p[0], decision: p[1], user_id: p[2], outcome: p[3], action: p[4], proposal: p[5], checks: p[6], reason: p[8] });
    return R([]);
  }

  // matchGuestsToUsers (eventScoring.ts)
  if (has("FROM co_profiles cp JOIN users u ON u.id = cp.user_id WHERE (u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[])) AND coalesce(u.sms_opted_out, false) = false")) {
    const phones: string[] = p[0];
    const emails: string[] = p[1];
    return R([...W.members.values()].filter((m) => ((m.phone_number && phones.includes(m.phone_number)) || emails.includes(m.email.toLowerCase())) && !m.sms_opted_out && (!/archived_at IS NULL/.test(sql) || !m.archived_at)).map(prof));
  }
  // eventMembers (eventPresence.ts), the real-Luma branch
  if (has("SELECT u.id AS user_id, u.first_name, u.phone_number FROM users u WHERE (u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[]))")) {
    const phones: string[] = p[0];
    const emails: string[] = p[1];
    return R([...W.members.values()].filter((m) => ((m.phone_number && phones.includes(m.phone_number)) || emails.includes(m.email.toLowerCase())) && !m.sms_opted_out && !m.archived_at && m.phone_number).map((m) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number })));
  }
  // mergeWalkinsIntoGuestPool
  if (has("FROM event_walkin_checkins ewc JOIN co_profiles cp")) {
    return R(W.walkins.filter((w) => w.event_api_id === p[0]).map((w) => W.members.get(w.person_id)).filter((m): m is Member => !!m && !m.sms_opted_out && (!/archived_at IS NULL/.test(sql) || !m.archived_at)).map(prof));
  }
  if (has("INSERT INTO event_walkin_checkins")) {
    if (W.walkins.some((w) => w.event_api_id === p[0] && w.person_id === p[1])) return R([]);
    W.walkins.push({ event_api_id: p[0], person_id: p[1] });
    return R([{ id: W.walkins.length }]);
  }

  // scoring debounce (15s) and solicitations
  if (has("INSERT INTO event_scoring_debounce")) {
    const last = W.scoringDebounce.get(p[0]);
    if (last !== undefined && now() - last < Number(p[1]) * 1000) return R([]);
    W.scoringDebounce.set(p[0], now());
    return R([{ event_id: p[0] }]);
  }
  if (has("FROM event_ask_solicitations")) {
    const t = W.solicited.get(`${p[0]}|${p[1]}`);
    return R(t !== undefined && now() - t < Number(p[2]) * 86_400_000 ? [{ "?column?": 1 }] : []);
  }
  if (has("INSERT INTO event_ask_solicitations")) {
    W.solicited.set(`${p[0]}|${p[1]}`, now());
    return R([]);
  }

  // rankings
  // linkedMemberNames (memberSafeMemories.ts MEMBER_NAMES_SQL): only this member's own side (2026-10-28). A nudge that reached them
  // and named the person, a question about the person that reached them (not queued, not still sending, never an additive offer's
  // count), their own answer (not to an anonymous heads-up, not a by-name ask that wasn't introduced), and an intro email that went
  // (before co_pairs: both said yes at that event). Nothing from the other side's state.
  if (has("SELECT DISTINCT u.first_name FROM users u WHERE u.id <> $1")) {
    const me = p[0];
    const ids = new Set<string>();
    const mine = W.pairs.filter((r) => r.a_id === me || r.b_id === me);
    const other = (r: Row) => (r.a_id === me ? r.b_id : r.a_id);
    const byName = new Set(mine.filter((r) => r.origin === "member").map(other).filter((o) => !mine.some((r) => other(r) === o && r.intro_sent_at)));
    const anonymousTo = (o: Row) => W.nudges.some((n) => n.event_id === o.event_id && n.person_id === o.person_id && n.candidate_id === o.candidate_id && n.anonymous);
    for (const n of W.nudges) if (n.person_id === me && !n.anonymous && !n.pending) ids.add(n.candidate_id);
    for (const o of W.offers) if (o.person_id === me && o.candidate_id && o.kind !== "additive" && o.opened_at && !["queued", "sending"].includes(o.status)) ids.add(o.candidate_id);
    for (const o of W.optIns) if (o.person_id === me && !byName.has(o.candidate_id) && !anonymousTo(o)) ids.add(o.candidate_id);
    for (const r of mine) if (r.intro_sent_at) ids.add(other(r));
    for (const o of W.optIns) {
      if (o.person_id !== me || o.status !== "interested") continue;
      const back = W.optIns.some((r) => r.event_id === o.event_id && r.person_id === o.candidate_id && r.candidate_id === me && r.status === "interested");
      if (back && !mine.some((r) => r.event_id === o.event_id && other(r) === o.candidate_id)) ids.add(o.candidate_id);
    }
    ids.delete(me);
    return R([...new Set([...ids].map((id) => W.members.get(id)?.first_name).filter(Boolean))].map((first_name) => ({ first_name })));
  }
  // event_match_offers (services/inRoomOffers.ts)
  if (has("INSERT INTO event_match_offers") && has("'open', NOW()")) {
    const [event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, asker_id, event_name] = p;
    const row = W.offers.find((o) => o.event_id === event_id && o.person_id === person_id && o.candidate_key === candidate_key);
    const opened_at = new Date(Date.now() + W.offers.length); // strictly increasing, so "most recent" is well defined
    if (row) Object.assign(row, { kind, candidate_ids, asker_id, event_name: event_name ?? row.event_name, status: "open", opened_at });
    else W.offers.push({ event_id, person_id, candidate_key, kind, candidate_id, candidate_ids: candidate_ids ?? [], asker_id, event_name, status: "open", opened_at, created_at: new Date() });
    return R([]);
  }
  // A nudge's or heads-up's place (claimOfferSlot), exact queries only: what's open or on its way, the row it takes, and its release.
  if (has("SELECT event_id, candidate_key FROM event_match_offers WHERE person_id = $1 AND ((status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval) OR (status = 'sending' AND opened_at > NOW() - ($3 || ' minutes')::interval))")) {
    const days = Number(p[1]) * 86_400_000, mins = Number(p[2]) * 60_000;
    return R(W.offers.filter((o) => o.person_id === p[0] && ((o.status === "open" && now() - +o.opened_at < days) || (o.status === "sending" && now() - +o.opened_at < mins))).map((o) => ({ event_id: o.event_id, candidate_key: o.candidate_key })));
  }
  if (has("SELECT status, opened_at, kind, candidate_id, candidate_ids FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3")) {
    return R(W.offers.filter((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2]).map((o) => ({ status: o.status, opened_at: o.opened_at, kind: o.kind, candidate_id: o.candidate_id, candidate_ids: o.candidate_ids })));
  }
  if (has("INSERT INTO event_match_offers (event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, event_name, status, opened_at)") && has("'sending', NOW()")) {
    const [event_id, person_id, candidate_key, kind, candidate_id, candidate_ids, event_name] = p;
    const row = W.offers.find((o) => o.event_id === event_id && o.person_id === person_id && o.candidate_key === candidate_key);
    const opened_at = new Date(Date.now() + W.offers.length);
    if (row) Object.assign(row, { kind, candidate_id, candidate_ids: candidate_ids ?? [], status: "sending", opened_at });
    else W.offers.push({ event_id, person_id, candidate_key, kind, candidate_id, candidate_ids: candidate_ids ?? [], asker_id: null, event_name, status: "sending", opened_at, created_at: new Date() });
    return R([]);
  }
  if (has("UPDATE event_match_offers SET status = $4, opened_at = $5, kind = $6, candidate_id = $7, candidate_ids = $8::uuid[] WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'sending'")) {
    const row = W.offers.find((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2] && o.status === "sending");
    if (row) Object.assign(row, { status: p[3], opened_at: p[4], kind: p[5], candidate_id: p[6], candidate_ids: p[7] ?? [] });
    return R([]);
  }
  // The one question slot (claimAskSlot): a direct ask on its way holds it ('sending'); a queued ask being sent takes it in place.
  if (has("INSERT INTO event_match_offers") && has("'sending', NOW()")) {
    const [event_id, person_id, candidate_key, candidate_id, asker_id, event_name] = p;
    const row = W.offers.find((o) => o.event_id === event_id && o.person_id === person_id && o.candidate_key === candidate_key);
    const opened_at = new Date(Date.now() + W.offers.length);
    if (!row) W.offers.push({ event_id, person_id, candidate_key, kind: "direct_ask", candidate_id, candidate_ids: [], asker_id, event_name, status: "sending", opened_at, created_at: new Date() });
    else if (row.status === "queued" || row.status === "sending") Object.assign(row, { status: "sending", opened_at });
    return R([]);
  }
  if (has("DELETE FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'sending'")) {
    const i = W.offers.findIndex((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2] && o.status === "sending");
    if (i >= 0) W.offers.splice(i, 1);
    return R([]);
  }
  // Only the exact one-slot predicate (inRoomOffers.ts SLOT_TAKEN) is answered: a changed query is unknown and fails the sim, so the
  // real SQL is what's tested (review of #211).
  if (has("SELECT 1 FROM event_match_offers WHERE person_id = $1 AND ((status = 'open' AND opened_at > NOW() - ($2 || ' minutes')::interval) OR (status = 'sending' AND opened_at > NOW() - ($3 || ' minutes')::interval)) LIMIT 1")) {
    const openMs = Number(p[1]) * 60_000; // OPEN_SLOT_MINUTES
    const mins = Number(p[2]) * 60_000;
    return R(W.offers.filter((o) => o.person_id === p[0] && ((o.status === "open" && now() - +o.opened_at < openMs) || (o.status === "sending" && now() - +o.opened_at < mins))).slice(0, 1).map(() => ({ "?column?": 1 })));
  }
  if (has("INSERT INTO event_match_offers") && has("'queued'")) {
    const [event_id, person_id, candidate_key, candidate_id, asker_id, event_name] = p;
    if (!W.offers.some((o) => o.event_id === event_id && o.person_id === person_id && o.candidate_key === candidate_key)) W.offers.push({ event_id, person_id, candidate_key, kind: "direct_ask", candidate_id, candidate_ids: [], asker_id, event_name, status: "queued", opened_at: null, created_at: new Date(Date.now() + W.offers.length) });
    return R([]);
  }
  // The open-question cap (inRoomOffers.ts MAX_OPEN_QUESTIONS) and every open question (openOffers), exact queries only.
  if (has("SELECT count(*)::int AS n FROM event_match_offers WHERE person_id = $1 AND status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval")) {
    return R([{ n: W.offers.filter((o) => o.person_id === p[0] && o.status === "open" && now() - +o.opened_at < Number(p[1]) * 86_400_000).length }]);
  }
  if (has("FROM event_match_offers") && has("WHERE person_id = $1 AND status = 'open' AND opened_at > NOW() - ($2 || ' days')::interval") && has("ORDER BY opened_at DESC LIMIT 10")) {
    return R(W.offers.filter((o) => o.person_id === p[0] && o.status === "open" && now() - +o.opened_at < Number(p[1]) * 86_400_000).sort((a, b) => +b.opened_at - +a.opened_at).slice(0, 10));
  }
  if (has("SELECT 1 FROM event_match_offers WHERE person_id = $1 AND status = 'open'")) return R(W.offers.filter((o) => o.person_id === p[0] && o.status === "open").slice(0, 1).map(() => ({ "?column?": 1 })));
  if (has("FROM event_match_offers WHERE person_id = $1 AND status = 'open'")) return R(W.offers.filter((o) => o.person_id === p[0] && o.status === "open").sort((a, b) => +b.opened_at - +a.opened_at).slice(0, 1));
  if (has("FROM event_match_offers WHERE person_id = $1 AND status = 'queued'")) return R(W.offers.filter((o) => o.person_id === p[0] && o.status === "queued").sort((a, b) => +a.created_at - +b.created_at).slice(0, 1));
  if (has("UPDATE event_match_offers SET status = 'answered'")) {
    for (const o of W.offers) if (o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2]) Object.assign(o, { status: "answered", answer: p[3] });
    return R([]);
  }
  if (has("SELECT DISTINCT person_id FROM event_match_offers WHERE status = 'queued'")) return R([...new Set(W.offers.filter((o) => o.status === "queued").map((o) => o.person_id))].map((person_id) => ({ person_id })));
  if (has("UPDATE event_match_offers SET status = 'queued', opened_at = NULL") && has("WHERE status = 'sending' AND kind = 'direct_ask' AND opened_at <= NOW() - ($1 || ' minutes')::interval RETURNING person_id")) {
    const mins = Number(p[0]) * 60_000;
    const out: Row[] = [];
    for (const o of W.offers) if (o.status === "sending" && o.kind === "direct_ask" && now() - +o.opened_at >= mins) { Object.assign(o, { status: "queued", opened_at: null }); out.push({ person_id: o.person_id }); }
    return R(out);
  }
  if (has("UPDATE event_match_offers SET status = 'expired' WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'queued'")) {
    for (const o of W.offers) if (o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2] && o.status === "queued") o.status = "expired";
    return R([]);
  }
  if (has("SELECT 1 FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status = 'queued'")) return R(W.offers.filter((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2] && o.status === "queued").map(() => ({ "?column?": 1 })));
  if (has("SELECT 1 FROM event_match_offers WHERE event_id = $1 AND person_id = $2 AND candidate_key = $3 AND status <> 'queued'")) return R(W.offers.filter((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_key === p[2] && o.status !== "queued").map(() => ({ "?column?": 1 })));
  if (has("SELECT first_name, phone_number, email FROM users WHERE id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ first_name: m.first_name, phone_number: m.phone_number, email: m.email }] : []);
  }
  if (has("SELECT id AS user_id, last_name FROM users WHERE id = ANY($1::uuid[])")) return R((p[0] as string[]).map((id) => W.members.get(id)).filter((m): m is Member => !!m).map((m) => ({ user_id: m.id, last_name: m.last_name ?? null })));
  if (has("SELECT id AS user_id, first_name, phone_number, email FROM users WHERE id = ANY($1::uuid[])")) return R((p[0] as string[]).map((id) => W.members.get(id)).filter((m): m is Member => !!m).map((m) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number, email: m.email })));
  if (has("SELECT ranked_candidates FROM event_guest_rankings")) {
    const r = W.rankings.get(`${p[0]}|${p[1]}`);
    return R(r ? [{ ranked_candidates: r.ranked_candidates }] : []);
  }
  if (has("INSERT INTO event_guest_rankings")) {
    W.rankings.set(`${p[0]}|${p[1]}`, { ranked_candidates: JSON.parse(p[2]), method_summary: p[3] });
    return R([]);
  }

  // match nudges
  if (has("INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score, pending)")) {
    if (W.nudges.some((n) => n.event_id === p[0] && n.person_id === p[1])) return R([]);
    W.nudges.push({ event_id: p[0], person_id: p[1], candidate_id: p[2], score: p[3], pending: true, anonymous: false, sent_at: now() });
    return R([{ event_id: p[0] }]);
  }
  if (has("INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score, anonymous)")) {
    if (!W.nudges.some((n) => n.event_id === p[0] && n.person_id === p[1])) W.nudges.push({ event_id: p[0], person_id: p[1], candidate_id: p[2], score: p[3], pending: false, anonymous: p[4], sent_at: now() });
    return R([]);
  }
  if (has("INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, person_id) DO UPDATE")) {
    const ex = W.nudges.find((n) => n.event_id === p[0] && n.person_id === p[1]);
    if (ex) Object.assign(ex, { candidate_id: p[2], score: p[3], sent_at: now() });
    else W.nudges.push({ event_id: p[0], person_id: p[1], candidate_id: p[2], score: p[3], pending: false, anonymous: false, sent_at: now() });
    return R([]);
  }
  if (has("DELETE FROM event_guest_match_nudges")) {
    W.nudges = W.nudges.filter((n) => !(n.event_id === p[0] && n.person_id === p[1]));
    return R([]);
  }
  if (has("UPDATE event_guest_match_nudges SET pending = false")) {
    for (const n of W.nudges) if (n.event_id === p[0] && n.person_id === p[1]) n.pending = false;
    return R([]);
  }
  if (has("SELECT 1 FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3")) {
    return R(W.nudges.filter((n) => n.event_id === p[0] && n.person_id === p[1] && n.candidate_id === p[2]).map(() => ({ x: 1 })));
  }
  if (has("SELECT 1 FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2")) {
    return R(W.nudges.filter((n) => n.event_id === p[0] && n.person_id === p[1]).map(() => ({ x: 1 })));
  }
  if (has("SELECT candidate_id FROM event_guest_match_nudges WHERE event_id = $1 AND person_id = $2")) {
    return R(W.nudges.filter((n) => n.event_id === p[0] && n.person_id === p[1]).map((n) => ({ candidate_id: n.candidate_id })));
  }
  if (has("FROM event_guest_match_nudges n JOIN users u ON u.id = n.candidate_id WHERE n.person_id = $1")) {
    const rows = W.nudges
      .filter((n) => n.person_id === p[0] && !String(n.event_id).startsWith("network:") && now() - n.sent_at < Number(p[1]) * 86_400_000)
      .filter((n) => !W.optIns.some((o) => o.event_id === n.event_id && o.person_id === n.person_id && o.candidate_id === n.candidate_id))
      // A closed room's nudges are never answered (the real query's NOT EXISTS on event_room_closures).
      .filter((n) => !has("event_room_closures") || !W.roomClosures.get(n.event_id)?.closed_at)
      .sort((a, b) => b.sent_at - a.sent_at)
      .slice(0, 1)
      .map((n) => {
        const u = W.members.get(n.candidate_id)!;
        return { event_id: n.event_id, candidate_id: n.candidate_id, anonymous: n.anonymous, candidate_first_name: u.first_name, candidate_phone: u.phone_number, candidate_email: u.email };
      });
    return R(rows);
  }
  if (has("FROM event_guest_match_nudges WHERE person_id = $1") || has("SELECT candidate_id FROM event_guest_match_nudges WHERE person_id")) return R([]);

  // opt-ins
  if (has("FROM event_guest_match_opt_ins WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3 AND status = 'interested'")) {
    return R(W.optIns.filter((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_id === p[2] && o.status === "interested").map(() => ({ x: 1 })));
  }
  if (has("INSERT INTO event_guest_match_opt_ins")) {
    if (!W.optIns.some((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_id === p[2])) W.optIns.push({ event_id: p[0], person_id: p[1], candidate_id: p[2], status: p[3] });
    return R([]);
  }

  // The member's own rules and what's been sent (harness/notifyGate.ts): this world's members set none.
  if (has("FROM co_facts WHERE owner_user_id = $1 AND relation = 'prefers'")) return R([]);
  // The team's holds (services/teamHold.ts): none in the simulated room.
  if (has("FROM team_holds")) return R([]);
  if (has("SELECT type, sent_at, notify_class FROM proactive_sends WHERE user_id = $1")) return R(W.proactiveSends.filter((s) => s.user_id === p[0]).map((s) => ({ type: s.type, sent_at: new Date(), notify_class: null })));
  if (has("SELECT created_at, reason FROM harness_decisions WHERE user_id = $1 AND decision = 'call.gate'")) return R([]);
  // in-room sends cap / ledger
  if (has("SELECT target_key FROM proactive_sends WHERE user_id = $1 AND type = 'in_room' AND target_key LIKE 'in_room:%'")) {
    return R(W.proactiveSends.filter((s) => s.user_id === p[0] && s.type === "in_room" && String(s.target_key).startsWith("in_room:")).map((s) => ({ target_key: s.target_key })));
  }
  if (has("SELECT COUNT(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'in_room' AND target_key LIKE $2")) {
    const re = new RegExp("^" + String(p[1]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
    return R([{ n: W.proactiveSends.filter((s) => s.user_id === p[0] && s.type === "in_room" && re.test(s.target_key)).length }]);
  }
  if (has("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt) VALUES ($1, 'in_room'") || has("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, notify_class) VALUES ($1, 'in_room'")) {
    if (!W.proactiveSends.some((s) => s.user_id === p[0] && s.target_key === p[1])) W.proactiveSends.push({ user_id: p[0], type: "in_room", target_key: p[1], message: p[2] });
    return R([]);
  }
  if (has("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind) VALUES ($1, $2, $3, $3, $4, true, $5)") || has("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt, kind, notify_class) VALUES ($1, $2, $3, $3, $4, true, $5, $6)")) {
    if (W.proactiveSends.some((s) => s.user_id === p[0] && s.target_key === p[2])) return R([]);
    W.proactiveSends.push({ user_id: p[0], type: p[1], target_key: p[2], message: p[3], id: W.proactiveSends.length + 1 });
    return R([{ id: W.proactiveSends.length }]);
  }
  if (has("SELECT COALESCE(sms_opted_out, false) AS opted_out FROM users WHERE id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ opted_out: !!m.sms_opted_out }] : []);
  }
  if (has("SELECT 1 FROM proactive_sends WHERE user_id = $1 AND target_key = $2")) {
    return R(W.proactiveSends.filter((s) => s.user_id === p[0] && s.target_key === p[1]).map(() => ({ x: 1 })));
  }
  if (has("FROM proactive_candidates WHERE user_id = $1 AND target_key = $2 FOR UPDATE")) {
    return R(W.candidates.filter((c) => c.user_id === p[0] && c.target_key === p[1]));
  }
  if (has("INSERT INTO proactive_candidates")) {
    if (W.candidates.some((c) => c.user_id === p[0] && c.target_key === p[2])) return R([]);
    W.candidates.push({ user_id: p[0], type: p[1], target_key: p[2], topic_key: p[3], summary: p[4], payload: JSON.parse(p[5]), due_at: new Date(p[6]), expires_at: p[7] ? new Date(p[7]) : null, status: "pending" });
    return R([{ id: W.candidates.length }]);
  }

  // presence
  if (has("SELECT sharing_seen_at, arrived_at, location_stopped_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2")) {
    const r = W.presence.get(`${p[0]}|${p[1]}`);
    return R(r ? [r] : []);
  }
  if (has("FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])")) {
    return R((p[1] as string[]).map((u) => W.presence.get(`${p[0]}|${u}`) && { user_id: u, ...W.presence.get(`${p[0]}|${u}`) }).filter(Boolean) as Row[]);
  }

  // memories
  if (has("INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, $2, $3) RETURNING id")) {
    W.memoriesWritten.push({ user_id: p[0], memory_type: p[1], content: p[2], created_at: new Date() });
    return R([{ id: W.memoriesWritten.length }]);
  }
  // The asker's note that an intro ask Cue said it would send didn't go out (services/deferredSends.ts noteIntroAskNotSent).
  if (has("INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'system', $2)")) {
    W.memoriesWritten.push({ user_id: p[0], memory_type: "system", content: p[1], created_at: new Date() });
    return R([]);
  }
  // ---------------------------------------------------------------- the no-show flow (services/eventNoShow.ts)
  if (has("INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'network_offer_pending', $2)")) {
    W.memoriesWritten.push({ user_id: p[0], memory_type: "network_offer_pending", content: p[1], created_at: new Date() });
    return R([]);
  }
  // harness/proactive.ts lastInboundAt: their last text.
  if (has("SELECT MAX(created_at) AS at FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange'")) {
    const ats = W.memoriesWritten.filter((m) => m.user_id === p[0] && m.memory_type === "text_exchange" && /^(User |\[Call\])/.test(m.content)).map((m) => +m.created_at);
    return R([{ at: ats.length ? new Date(Math.max(...ats)) : null }]);
  }
  if (has("SELECT 1 FROM co_profiles WHERE user_id = $1 AND safety_hold_until > NOW()")) return R(W.members.get(p[0])?.safetyHold ? [{ x: 1 }] : []);
  const pres = (e: string, u: string) => {
    const k = `${e}|${u}`;
    if (!W.presence.has(k)) W.presence.set(k, { sharing_seen_at: null, arrived_at: null });
    return W.presence.get(k)!;
  };
  if (has("INSERT INTO event_presence (event_api_id, user_id, noshow_asked_at)")) {
    const r = pres(p[0], p[1]);
    r.noshow_asked_at ??= new Date();
    return R([]);
  }
  if (has("INSERT INTO event_presence (event_api_id, user_id, not_going_at)")) {
    pres(p[0], p[1]).not_going_at = has("VALUES ($1, $2, NOW())") ? new Date() : null;
    return R([]);
  }
  if (has("INSERT INTO event_presence (event_api_id, user_id, arrived_at, arrived_via)")) {
    const r = pres(p[0], p[1]);
    if (r.arrived_at) return R([]);
    r.arrived_at = new Date();
    r.arrived_via = p[2];
    return R([{ user_id: p[1] }]);
  }
  if (has("SELECT event_api_id, user_id, noshow_asked_at, not_going_at FROM event_presence WHERE noshow_asked_at IS NOT NULL AND noshow_settled_at IS NULL")) {
    return R([...W.presence.entries()].filter(([, r]) => r.noshow_asked_at && !r.noshow_settled_at).map(([k, r]) => ({ event_api_id: k.split("|")[0], user_id: k.split("|")[1], noshow_asked_at: r.noshow_asked_at, not_going_at: r.not_going_at ?? null })));
  }
  if (has("UPDATE event_presence SET noshow_settled_at = NOW(), noshow_outcome = $3")) {
    const r = W.presence.get(`${p[0]}|${p[1]}`);
    if (r && !r.noshow_settled_at) Object.assign(r, { noshow_settled_at: new Date(), noshow_outcome: p[2] });
    return R([]);
  }
  if (has("SELECT event_api_id, noshow_settled_at FROM event_presence WHERE user_id = $1 AND noshow_asked_at >")) {
    const hit = [...W.presence.entries()].filter(([k, r]) => k.endsWith(`|${p[0]}`) && r.noshow_asked_at && now() - +r.noshow_asked_at < Number(p[1]) * 3_600_000).sort((a, b) => +b[1].noshow_asked_at - +a[1].noshow_asked_at);
    return R(hit.slice(0, 1).map(([k, r]) => ({ event_api_id: k.split("|")[0], noshow_settled_at: r.noshow_settled_at ?? null })));
  }
  // services/eventBrief.ts presenceFlags: their brief-name answer for this event.
  if (has("SELECT name_asked_at, name_ok, brief_sent_at, not_going_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2")) {
    const r = W.presence.get(`${p[0]}|${p[1]}`);
    return R(r ? [{ name_asked_at: r.name_asked_at ?? null, name_ok: r.name_ok ?? null, brief_sent_at: r.brief_sent_at ?? null, not_going_at: r.not_going_at ?? null }] : []);
  }
  if (sql === "SELECT 1 FROM event_presence WHERE event_api_id = $1 AND user_id = $2") return R(W.presence.has(`${p[0]}|${p[1]}`) ? [{ x: 1 }] : []);
  if (has("UPDATE co_memories SET content_embedding")) return R([]);
  if (has("SELECT content FROM co_memories WHERE user_id = $1 AND memory_type <> 'intent'")) {
    const m = W.members.get(p[0]);
    return R([...(m?.memories ?? []), ...W.memoriesWritten.filter((x) => x.user_id === p[0]).map((x) => x.content)].map((content) => ({ content })));
  }

  // profiles
  if (has("SELECT goals, blockers, activity_preferences, long_term_direction, intent FROM co_profiles WHERE user_id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ goals: m.goals, blockers: m.blockers, activity_preferences: m.activity_preferences, long_term_direction: m.long_term_direction, intent: m.intent }] : []);
  }
  if (has("SELECT intent FROM co_profiles WHERE user_id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ intent: m.intent }] : []);
  }
  // A member's stored zone (memberTime.ts memberZone; the zone reads for sends use it since the 2026-10-29 place fix).
  if (has("SELECT city, timezone, timezone_city FROM co_profiles WHERE user_id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ city: m.city ?? null, timezone: (m as any).timezone ?? null, timezone_city: m.city ?? null }] : []);
  }
  if (has("SELECT city FROM co_profiles WHERE user_id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ city: m.city }] : []);
  }
  if (has("FROM co_facts WHERE owner_user_id = $1 AND subject = 'member' AND visibility = 'owner'")) {
    return R((W.members.get(p[0])?.ownerFacts ?? []).map((object_label) => ({ object_label })));
  }

  // activity check in gatherNetworkFacts: everyone with a phone and not opted out counts as active here.
  if (has("SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND coalesce(u.sms_opted_out, false) = false AND u.phone_number IS NOT NULL")) {
    return R((p[0] as string[]).filter((id) => {
      const m = W.members.get(id);
      return m && !m.sms_opted_out && m.phone_number;
    }).map((id) => ({ id })));
  }
  if (has("FROM network_introductions WHERE person_a_id = $1 AND person_b_id = $2")) {
    return R(W.networkIntros.filter((n) => n.a === p[0] && n.b === p[1]).map(() => ({ x: 1 })));
  }

  // additive debounce
  if (has("INSERT INTO event_walkin_offer_batches")) {
    const k = `${p[0]}|${p[1]}`;
    const last = W.additiveDebounce.get(k);
    if (last !== undefined && now() - last < Number(p[2]) * 60_000) return R([]);
    W.additiveDebounce.set(k, now());
    return R([{ event_api_id: p[0] }]);
  }

  // unmatched follow-up
  if (has("INSERT INTO event_unmatched_followups")) {
    if (W.unmatchedFollowups.some((r) => r.event_api_id === p[1] && r.user_id === p[0])) return R([]);
    // send_at is $4, or NOW() (a walk-in's close backfilled at close time: services/eventUnmatchedFollowUp.ts).
    W.unmatchedFollowups.push({ user_id: p[0], event_api_id: p[1], event_name: p[2], send_at: p.length > 3 ? new Date(p[3]).getTime() : now(), sent_at: null });
    return R(/RETURNING user_id/.test(sql) ? [{ user_id: p[0] }] : []);
  }
  if (has("SELECT DISTINCT event_api_id, event_name FROM event_unmatched_followups")) {
    const seen = new Set<string>();
    return R(W.unmatchedFollowups.filter((r) => !r.sent_at && r.send_at <= now() && !seen.has(r.event_api_id) && seen.add(r.event_api_id)).map((r) => ({ event_api_id: r.event_api_id, event_name: r.event_name })));
  }
  if (has("SELECT user_id, send_at FROM event_unmatched_followups WHERE event_api_id = $1")) {
    return R(W.unmatchedFollowups.filter((r) => r.event_api_id === p[0] && !r.sent_at && r.send_at <= now()).map((r) => ({ user_id: r.user_id, send_at: new Date(r.send_at) })));
  }
  if (has("UPDATE event_unmatched_followups SET sent_at = NOW()")) {
    for (const r of W.unmatchedFollowups) if (r.event_api_id === p[0] && (p[1] as string[]).includes(r.user_id)) r.sent_at = now();
    return R([]);
  }
  if (has("SELECT 1 FROM event_unmatched_notices")) return R(W.unmatchedNotices.filter((r) => r.event_id === p[0] && r.person_id === p[1]).map(() => ({ x: 1 })));
  if (has("INSERT INTO event_unmatched_notices")) {
    // ON CONFLICT (event_id, person_id) DO NOTHING RETURNING 1: the claim (services/eventUnmatchedFollowUp.ts claimClose).
    if (W.unmatchedNotices.some((r) => r.event_id === p[0] && r.person_id === p[1])) return R([]);
    W.unmatchedNotices.push({ event_id: p[0], person_id: p[1], paired_with_id: p[2] ?? null });
    return R([{ x: 1 }]);
  }
  if (has("DELETE FROM event_unmatched_notices WHERE event_id = $1 AND person_id = $2")) {
    W.unmatchedNotices = W.unmatchedNotices.filter((r) => !(r.event_id === p[0] && r.person_id === p[1]));
    return R([]);
  }

  // resolveNamedEventGuest
  if (has("SELECT event_api_id, event_name FROM event_checkin_followups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1")) {
    return R(W.checkinFollowups.filter((r) => r.user_id === p[0]).slice(-1).map((r) => ({ event_api_id: r.event_api_id, event_name: r.event_name })));
  }

  // ---------------------------------------------------------------- the pair record (services/roomMatching.ts co_pairs), added for the
  // room simulation (evals/roomsim): one row per (event, pair), a_id < b_id, with the lifecycle the gates read (asked, answered,
  // declined, both yes, the intro claim and send, value lines). Without it a big room silently skipped those gates.
  const pairAt = (e: string, a: string, b: string) => W.pairs.find((r) => r.event_id === e && r.a_id === a && r.b_id === b);
  if (has("INSERT INTO co_pairs (event_id, a_id, b_id, origin)")) {
    if (!pairAt(p[0], p[1], p[2])) W.pairs.push({ id: uuid(), event_id: p[0], a_id: p[1], b_id: p[2], origin: p[3], state: "suggested", created_at: new Date(), asked_a_at: null, asked_b_at: null, a_answer: null, b_answer: null, declined_at: null, both_yes_at: null, intro_claimed_at: null, intro_sent_at: null, intro_held_at: null, intro_attempts: 0, value_verdict: null, blocked_reason: null, expired_at: null });
    return R([]);
  }
  if (has("SELECT * FROM co_pairs WHERE a_id = $1 AND b_id = $2")) return R(W.pairs.filter((r) => r.a_id === p[0] && r.b_id === p[1]).sort((x, y) => +y.created_at - +x.created_at));
  if (has("SELECT 1 FROM co_pairs WHERE event_id = $1 AND a_id = $2 AND b_id = $3")) return R(pairAt(p[0], p[1], p[2]) ? [{ x: 1 }] : []);
  // The room close's declined pairs (roomMatching.ts runRoomCloses: a "no" leaves the asker the same note as silence).
  if (has("FROM co_pairs WHERE event_id = $1 AND state = 'declined'")) return R(W.pairs.filter((r) => r.event_id === p[0] && r.state === "declined"));
  if (has("UPDATE co_pairs SET asked_a_at") || has("UPDATE co_pairs SET asked_b_at")) {
    const r = pairAt(p[0], p[1], p[2]);
    const col = has("SET asked_a_at") ? "asked_a_at" : "asked_b_at";
    if (r) {
      if (!r[col] || (r.expired_at && r[col] <= r.expired_at)) r[col] = new Date();
      if (r.state === "suggested") r.state = "asked";
    }
    return R([]);
  }
  if (has("UPDATE co_pairs SET a_answer") || has("UPDATE co_pairs SET b_answer")) {
    const r = pairAt(p[0], p[1], p[2]);
    const side = has("SET a_answer") ? "a" : "b";
    if (r) {
      r[`${side}_answer`] = p[3];
      r.state = p[4];
      if (p[4] === "declined") r.declined_at ??= new Date();
      if (p[4] === "both_yes") r.both_yes_at ??= new Date();
    }
    return R([]);
  }
  if (has("UPDATE co_pairs SET intro_claimed_at = NOW()")) {
    const r = pairAt(p[0], p[1], p[2]);
    if (r && !r.intro_sent_at && !r.intro_claimed_at) {
      r.intro_claimed_at = new Date();
      return R([{ id: r.id }]);
    }
    return R([]);
  }
  if (has("UPDATE co_pairs SET intro_claimed_at = NULL")) {
    const r = pairAt(p[0], p[1], p[2]);
    if (r && !r.intro_sent_at) r.intro_claimed_at = null;
    return R([]);
  }
  if (has("UPDATE co_pairs SET intro_sent_at")) {
    const r = pairAt(p[0], p[1], p[2]);
    if (r) {
      r.intro_sent_at ??= new Date();
      if (r.state !== "met") r.state = "intro_sent";
    }
    return R([]);
  }
  if (has("UPDATE co_pairs SET value_line_a")) {
    const r = pairAt(p[0], p[1], p[2]);
    if (r) {
      r.value_line_a = p[3];
      r.value_line_b = p[4];
      r.value_why = p[6];
      r.value_judged_at = new Date();
      r.value_verdict = p[5];
      if (!p[7] && r.state === "suggested") r.state = "blocked";
      r.blocked_reason = p[7] ? null : p[8];
    }
    return R([]);
  }
  if (has("UPDATE co_pairs SET origin = 'member'")) {
    const r = pairAt(p[0], p[1], p[2]);
    if (r) r.origin = "member";
    return R([]);
  }
  if (has("UPDATE co_pairs SET state = 'expired'")) {
    const hit = W.pairs.filter((r) => r.event_id === p[0] && ["suggested", "asked"].includes(r.state));
    for (const r of hit) {
      r.state = "expired";
      r.expired_at = p[1];
    }
    return R(hit.map((r) => ({ id: r.id })));
  }
  if (has("UPDATE co_pairs SET intro_held_at") || has("UPDATE co_pairs SET intro_attempts")) return R([]);
  if (has("FROM co_pairs p JOIN users u")) return R([]);
  // The member's own outcome signals (roomMatching.ts ownOutcomeSignals): their side of each introduced pair, never the other's.
  if (has("SELECT CASE WHEN a_id = $1 THEN a_evidence ELSE b_evidence END AS ev")) return R(W.pairs.filter((r: any) => (r.a_id === p[0] || r.b_id === p[0]) && r.intro_sent_at).map((r: any) => ({ ev: (r.a_id === p[0] ? r.a_evidence : r.b_evidence) ?? {}, line: r.a_id === p[0] ? r.value_line_a : r.value_line_b })));
  // Do these two already know each other (services/knownConnections.ts)? In this world: only an intro Cue already sent.
  if (has("AS introduced_room") && has("AS vouched")) return R([{ introduced_room: W.pairs.some((r: any) => r.a_id === p[0] && r.b_id === p[1] && r.intro_sent_at), introduced_network: false, connected: false, said: false, said_by_name: false, referral: false, vouched: false }]);
  if (has("SELECT status FROM event_guest_match_opt_ins WHERE event_id = $1 AND person_id = $2 AND candidate_id = $3")) {
    return R(W.optIns.filter((o) => o.event_id === p[0] && o.person_id === p[1] && o.candidate_id === p[2]).map((o) => ({ status: o.status })));
  }
  // Reads and writes the night touches that hold nothing the sim scores: answered from the members, or empty, or kept.
  if (has("SELECT first_name FROM users WHERE id = $1")) {
    const m = W.members.get(p[0]);
    return R(m && (!has("archived_at IS NULL") || !m.archived_at) ? [{ first_name: m.first_name }] : []);
  }
  if (has("SELECT goals, life_chapters, intent FROM co_profiles WHERE user_id = $1")) {
    const m = W.members.get(p[0]);
    return R(m ? [{ goals: m.goals ?? [], life_chapters: [], intent: m.intent ?? [] }] : []);
  }
  if (has("FROM matching_pauses")) return R([]);
  // The end of the night (services/roomMatching.ts scheduleRoomClose / runRoomCloses).
  if (has("INSERT INTO event_room_closures")) {
    const prev = W.roomClosures.get(p[0]);
    if (!prev || !prev.closed_at) W.roomClosures.set(p[0], { ...(prev ?? {}), event_id: p[0], event_name: p[1], ends_at: new Date(p[2]), due_at: new Date(p[3]), closed_at: null, claimed_at: prev?.claimed_at ?? null });
    return R([]);
  }
  if (has("UPDATE event_room_closures SET claimed_at = $1")) {
    const at = new Date(p[0]).getTime();
    const due = [...W.roomClosures.values()].filter((r) => !r.closed_at && r.due_at && +r.due_at <= at && (!r.claimed_at || at - +r.claimed_at > 10 * 60_000)).slice(0, 10);
    for (const r of due) r.claimed_at = new Date(at);
    return R(due.map((r) => ({ event_id: r.event_id, event_name: r.event_name, ends_at: r.ends_at })));
  }
  if (has("UPDATE event_room_closures SET closed_at = $2")) {
    const r = W.roomClosures.get(p[0]);
    if (r) Object.assign(r, { closed_at: new Date(p[1]), expired_offers: p[2], expired_pairs: p[3] });
    return R([]);
  }
  if (has("UPDATE event_match_offers SET status = 'expired'")) {
    // The statuses the query expires (its WHERE ... status IN (...)), read from the SQL itself; an ask that never went out (queued,
    // sending) loses its opened_at as it expires, as the real statement does (review of #295).
    const live = (sql.match(/WHERE[\s\S]*?status IN \(([^)]*)\)/)?.[1] ?? "").split(",").map((x) => x.trim().replace(/'/g, ""));
    const hit = W.offers.filter((o) => o.event_id === p[0] && live.includes(o.status));
    for (const o of hit) Object.assign(o, { status: "expired", answered_at: null, ...(o.status === "queued" || o.status === "sending" ? { opened_at: null } : {}) });
    return R(hit.map((o) => ({ person_id: o.person_id })));
  }
  if (has("UPDATE deferred_sends SET due_at = $2 WHERE status = 'queued' AND after_kind = 'event_direct_ask'")) return R([]);
  if (has("FROM event_room_closures")) return R([...W.roomClosures.values()].filter((r) => r.event_id === p[0] && r.closed_at));
  if (has("INSERT INTO member_connections") || has("INSERT INTO co_facts") || has("UPDATE co_facts SET retired_at") || has("UPDATE proactive_user_state SET hold_until = NULL")) return R([]);
  // A direct ask held for their hours or the pause (deferredSends.ts hasQueuedWithPrefix): W.deferredAsks holds whose are waiting.
  if (has("SELECT 1 FROM deferred_sends WHERE user_id = $1 AND starts_with(target_key, $2) AND status IN ('queued', 'sending') LIMIT 1")) return R((W as any).deferredAsks?.has(`${p[0]}|${p[1]}`) ? [{ x: 1 }] : []);
  if (has("FROM deferred_sends") || has("FROM person_snapshots") || has("FROM co_facts") || has("FROM ask_checkins")) return R([]);
  if (has("INSERT INTO event_checkin_followups")) {
    if (W.checkinFollowups.some((r) => r.event_api_id === p[1] && r.user_id === p[0])) return R([]);
    W.checkinFollowups.push({ user_id: p[0], event_api_id: p[1], event_name: p[2], send_at: p[3], created_at: new Date() });
    return R(has("RETURNING id") ? [{ id: W.checkinFollowups.length }] : []);
  }

  // The end-of-night close's evidence that someone came (services/eventUnmatchedFollowUp.ts cameTonight).
  if (has("SELECT 1 FROM event_presence WHERE event_api_id = $1 AND user_id = $2 AND arrived_at IS NOT NULL")) return R(W.presence.get(`${p[0]}|${p[1]}`)?.arrived_at ? [{ x: 1 }] : []);
  if (has("SELECT 1 FROM event_walkin_checkins WHERE event_api_id = $1 AND person_id = $2")) return R(W.walkins.some((w) => w.event_api_id === p[0] && w.person_id === p[1]) ? [{ x: 1 }] : []);

  // Anything else is a query the fake world doesn't know: recorded (the room simulation fails on any), nothing returned.
  W.unknownSql.add(sql.slice(0, 120));
  return R([]);
}

// ------------------------------------------------------------------ fetch
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function anthropicText(text: string): Response {
  return json({ id: "msg_stub", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
}

function promptOf(init: any): string {
  try {
    const b = JSON.parse(init?.body ?? "{}");
    return (b.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(""))).join("\n");
  } catch {
    return "";
  }
}

function defaultScore(askText: string, line: string): { score: number; share: boolean; mutual: boolean } {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const a = words(askText);
  const l = words(line);
  let hit = 0;
  for (const w of a) if (l.has(w)) hit++;
  const score = Math.min(100, hit * 30);
  return { score, share: /asks they agreed to share/.test(line) && score > 0, mutual: false };
}

// The scorer's share_ask: the shared ask on this digest line that the match rests on. The one that shares the most words
// with the asker's ask; with no overlap, the only shared ask if there is exactly one, else none.
function shareLabel(askText: string, line: string): string {
  const shared = [...(line.split("asks they agreed to share: ")[1] ?? "").matchAll(/\[(S\d+)\] \w+ "([^"]*)"/g)].map((m) => ({ label: m[1], text: m[2] }));
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const a = words(askText);
  const ranked = shared.map((x) => ({ ...x, hit: [...words(x.text)].filter((w) => a.has(w)).length })).sort((p, q) => q.hit - p.hit);
  if (ranked[0]?.hit) return ranked[0].label;
  return shared.length === 1 ? shared[0].label : "";
}

function fakeAnthropic(init: any): Response {
  const prompt = promptOf(init);
  if (prompt.startsWith("Someone wants to be connected with people who match this:")) {
    W.llmCalls.push({ kind: "score", prompt });
    if (W.scorerFail) return json({ type: "error", error: { type: "invalid_request_error", message: "scorer down" } }, 400);
    const askText = prompt.match(/match this: "([\s\S]*?)"\n/)?.[1] ?? "";
    const digest = prompt.split("one per line:\n")[1]?.split("\n\nFor each candidate")[0] ?? "";
    const results = digest
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => {
        const index = Number(l.match(/^(\d+)\./)![1]);
        const tag = l.match(/tag(\d{6})/)?.[1];
        const cand = [...W.members.values()].find((mm) => mm.id.endsWith(tag ?? "--"));
        // The stub scores on what a line shows, never its hidden part (matching.ts HIDDEN_LABEL), so hidden_only is never true here.
        const s = W.scorer && cand ? W.scorer(askText, cand) : defaultScore(askText, l.split("hidden, to judge fit only")[0]);
        return { index, score: s.score, reason: "internal", share_ask: s.share ? shareLabel(askText, l) : "", hidden_only: false, mutual: !!s.mutual };
      });
    return anthropicText(JSON.stringify({ results }));
  }
  // The value-line judge (services/roomMatching.ts valueGate, one call per side): strong, the line naming the other
  // member's first shared ask in the same form the share reason used to take.
  if (prompt.startsWith("Cue is a friend to every member of a private club")) {
    W.llmCalls.push({ kind: "valueLine", prompt });
    const shared = [...(prompt.match(/said Cue may tell people they meet: ([^\n]*)/)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (!shared.length) return anthropicText(JSON.stringify({ line: "", verdict: "weak", why: "nothing shared" }));
    return anthropicText(JSON.stringify({ line: `what they've said they can offer: "${shared[0]}"`, verdict: "strong", why: "stub" }));
  }
  if (prompt.includes("Is this message a consent violation?")) {
    W.llmCalls.push({ kind: "consent", prompt });
    const msg = prompt.match(/Message: "([\s\S]*?)"\n\nIs this message/)?.[1] ?? "";
    return anthropicText(JSON.stringify({ violation: W.consentViolation(msg), why: "stub" }));
  }
  if (prompt.includes("Below is what a member of a private social club has said")) {
    W.llmCalls.push({ kind: "peopleGraph", prompt });
    return anthropicText(JSON.stringify({ wants: [], offers: [] }));
  }
  const m = prompt.match(/You found someone else going who's genuinely worth them meeting: ([^.]+)\. Why they're worth meeting: ([^\n]*)/);
  if (m) {
    W.llmCalls.push({ kind: "nudgeDraft", prompt });
    const why = m[2].replace(/^what they've said they're looking for: /, "they're looking for ").replace(/^what they've said they can offer: /, "they can offer ").replace(/"/g, "");
    return anthropicText(`${m[1]} is here tonight and worth finding: ${why}.`);
  }
  if (prompt.includes("more people have checked in") || prompt.includes("more person has checked in") || prompt.includes("person has checked in")) {
    W.llmCalls.push({ kind: "additiveDraft", prompt });
    return anthropicText("A few more people just checked in who could be good for you. Want to hear who?");
  }
  const u = prompt.match(/Nothing came up as a strong match for them tonight\. ([^ ]+) is also there\. What they might have in common: ([^\n]*)/);
  if (u) {
    W.llmCalls.push({ kind: "unmatchedPairDraft", prompt });
    return anthropicText(`Might be worth a quick hello to ${u[1]} before you head out.`);
  }
  // The network reveal (services/networkIntroNudge.ts networkRevealPrompt), drafted before an intro offer goes out.
  const rv = prompt.match(/they said yes, they want to hear who\. Draft a short, warm text \(2-3 sentences, no em dashes, normal sentence capitalization\) naming ([^ ]+) and explaining in your own words why they're worth meeting: ([^\n]*?)\. Use only that reason/);
  if (rv) {
    W.llmCalls.push({ kind: "networkReveal", prompt });
    return anthropicText(`${rv[1]} came to mind. ${rv[1]} is someone you'd get a lot from. Want me to see if ${rv[1]} is open to an intro too?`);
  }
  if (prompt.includes("Write the goodbye a good host gives at the door")) {
    W.llmCalls.push({ kind: "closeDraft", prompt });
    const name = prompt.match(/You're texting ([^ ]+) near the end/)?.[1] ?? "there";
    return anthropicText(W.closeDraft ? W.closeDraft(name) : `Really glad you came tonight, ${name}.`);
  }
  if (prompt.includes("nothing stood out as a strong pull tonight")) {
    W.llmCalls.push({ kind: "soloAck", prompt });
    return anthropicText("Nothing jumped out as a strong pull tonight, and I'm still glad you came.");
  }
  // The recipient's first name can have a space ("Remy 2" once a room has more people than NAMES): it runs up to ' about "'.
  const d = prompt.match(/You're texting (.+?) about "([^"]*)\." ([^,]+), who's also going, said they'd like to be introduced/);
  if (d) {
    W.llmCalls.push({ kind: "directAsk", prompt });
    return anthropicText(`${d[3]} from ${d[2]} would like an intro. Open to it?`);
  }
  if (prompt.includes("another member of the club is going too") || prompt.includes("Another member of the club is going too")) {
    W.llmCalls.push({ kind: "anonDraft", prompt });
    return anthropicText("Another member going seems worth meeting. Want an intro? I'll share who once I've checked with them.");
  }
  W.llmCalls.push({ kind: "other", prompt: prompt.slice(0, 200) });
  return anthropicText("SKIP");
}

function luma(url: URL): Response {
  if (url.pathname === "/v1/events/guests/list") {
    if (W.lumaGuestListFail) return json({ message: "upstream error" }, 500);
    const ev = W.events.get(url.searchParams.get("event_id") ?? "");
    if (!ev) return json({ message: "not found" }, 404);
    return json({ entries: ev.guests.map((g, i) => ({ guest: { id: `gst-${i}`, user_email: g.email, user_name: g.name, phone_number: g.phone, approval_status: g.approval_status, checked_in_at: (g as any).checked_in_at ?? null } })), has_more: false });
  }
  if (url.pathname === "/v1/event/get") {
    const ev = W.events.get(url.searchParams.get("api_id") ?? "");
    if (!ev) return json({ message: "not found" }, 404);
    return json({ event: { api_id: ev.api_id, name: ev.name, start_at: ev.start_at, end_at: ev.end_at } });
  }
  if (url.pathname === "/v1/calendars/events/list") {
    return json({ entries: [...W.events.values()].map((e) => ({ event: { id: e.api_id, name: e.name, start_at: e.start_at, end_at: e.end_at, timezone: "America/Los_Angeles" } })), has_more: false });
  }
  return json({ message: "unknown" }, 404);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input));
  if (url.host === "api.anthropic.com") return fakeAnthropic(init);
  if (url.host === "api.openai.com") {
    const b = JSON.parse(init?.body ?? "{}");
    const inputs = Array.isArray(b.input) ? b.input : [b.input ?? ""];
    return json({ object: "list", data: inputs.map((_: unknown, index: number) => ({ object: "embedding", index, embedding: new Array(1536).fill(0) })), usage: { prompt_tokens: 0, total_tokens: 0 } });
  }
  if (url.host === "public-api.luma.com") return luma(url);
  throw new Error(`inroom world: refused outside call to ${url.host}`);
}) as typeof fetch;
void realFetch;

// ------------------------------------------------------------------ timing and locks (sim gap A1, Royce 2026-10-14)
// In Postgres a read and the write that follows it are separate round trips, so two replies landing together can interleave
// between them. With W.latency set, every query waits a few (seeded) milliseconds first, so the fake world interleaves the same
// way. Locks are then real: a transaction's pg_advisory_xact_lock and SELECT ... FOR UPDATE hold until its COMMIT, ROLLBACK or
// release, and memberTurn() holds a member's replies one at a time the way routes/sendblue.ts's per-member lock does. One statement
// still runs whole, as one Postgres statement does. Off (no wait) unless a test sets W.latency.
export const latency = { next: null as null | (() => number) };
const held = new Map<string, Promise<void>>();
async function acquire(key: string): Promise<() => void> {
  while (held.has(key)) await held.get(key);
  let free!: () => void;
  held.set(key, new Promise<void>((r) => (free = r)));
  return () => {
    held.delete(key);
    free();
  };
}
export async function memberTurn<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(`member:${userId}`);
  try {
    return await fn();
  } finally {
    release();
  }
}
const wait = () => (latency.next ? new Promise<void>((r) => setTimeout(r, latency.next!())) : Promise.resolve());
export const lockStats = { waits: 0 };

// ------------------------------------------------------------------ wire it up
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, params?: any[]) => {
  await wait();
  return handle(sql, params ?? []);
};
(pool as any).connect = async () => {
  const mine: (() => void)[] = [];
  const freeAll = () => {
    while (mine.length) mine.pop()!();
  };
  return {
    query: async (sql: string, params?: any[]) => {
      await wait();
      const flat = sql.replace(/\s+/g, " ").trim();
      if (/pg_advisory_xact_lock/.test(flat)) {
        const key = `xact:${params?.[0]}`;
        if (held.has(key)) lockStats.waits++;
        mine.push(await acquire(key));
      } else if (/ FOR UPDATE/.test(flat)) {
        const key = `row:${flat.split(" WHERE ")[0]}|${JSON.stringify(params ?? [])}`;
        if (held.has(key)) lockStats.waits++;
        mine.push(await acquire(key));
      }
      const out = handle(sql, params ?? []);
      if (/^(COMMIT|ROLLBACK)/.test(flat)) freeAll();
      return out;
    },
    release: freeAll,
  };
};

const { default: sendblue } = await import("../../src/services/sendblue.js");
(sendblue as any).messages.send = async (body: any) => {
  W.sent.push({ to: body.number, content: body.content });
  return { message_handle: `h-${W.sent.length}`, status: "SENT" };
};

// ------------------------------------------------------------------ check helper
export const results = { total: 0, failed: 0, findings: [] as string[] };
export function check(label: string, ok: boolean, detail?: unknown): void {
  results.total++;
  if (!ok) {
    results.failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
// An open finding: a defect the in-room analysis reproduced (2026-10-07). It FAILS while the defect reproduces and passes
// once its fix lands, so the suite stays red until every hole is closed. `demonstrated` is true when the defect shows.
export function finding(label: string, demonstrated: boolean, detail?: unknown): void {
  results.total++;
  if (demonstrated) {
    results.failed++;
    results.findings.push(label);
    console.log(`FAIL (open finding) ${label}${detail !== undefined ? `  :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
