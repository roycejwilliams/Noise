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
  invite_verified?: boolean;
  city?: string | null;
  goals?: string[];
  blockers?: string[];
  activity_preferences?: string[];
  long_term_direction?: string | null;
  intent?: unknown[];
  memories?: string[]; // private memories (co_memories rows other than text the test writes)
  ownerFacts?: string[]; // owner-only co_facts
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
  // Scorer: (askText, candidate) => score/share/mutual. Default: keyword overlap.
  scorer: null as null | ((ask: string, cand: Member) => { score: number; share: boolean; mutual?: boolean }),
  // Consent read verdict (the model half of introConsent): default no violation.
  consentViolation: (_msg: string) => false,
  llmCalls: [] as { kind: string; prompt: string }[],
};

export function reset(): void {
  W.members.clear();
  W.events.clear();
  for (const k of ["nudges", "optIns", "proactiveSends", "candidates", "memoriesWritten", "walkins", "networkIntros", "checkinFollowups", "unmatchedFollowups", "unmatchedNotices", "decisions", "sent", "emails", "llmCalls"] as const) (W as any)[k].length = 0;
  W.rankings.clear();
  W.presence.clear();
  W.solicited.clear();
  W.scoringDebounce.clear();
  W.additiveDebounce.clear();
  W.unknownSql.clear();
  W.scorer = null;
  W.consentViolation = () => false;
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

export const ask = (text: string, type: "seeking" | "offering" = "seeking") => ({ id: uuid(), text, type, status: "active", kind: "ask" });
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
    return R([...W.members.values()].filter((m) => ((m.phone_number && phones.includes(m.phone_number)) || emails.includes(m.email.toLowerCase())) && !m.sms_opted_out).map(prof));
  }
  // eventMembers (eventPresence.ts), the real-Luma branch
  if (has("SELECT u.id AS user_id, u.first_name, u.phone_number FROM users u WHERE (u.phone_number = ANY($1::text[]) OR LOWER(u.email) = ANY($2::text[]))")) {
    const phones: string[] = p[0];
    const emails: string[] = p[1];
    return R([...W.members.values()].filter((m) => ((m.phone_number && phones.includes(m.phone_number)) || emails.includes(m.email.toLowerCase())) && !m.sms_opted_out && !m.archived_at && m.phone_number).map((m) => ({ user_id: m.id, first_name: m.first_name, phone_number: m.phone_number })));
  }
  // mergeWalkinsIntoGuestPool
  if (has("FROM event_walkin_checkins ewc JOIN co_profiles cp")) {
    return R(W.walkins.filter((w) => w.event_api_id === p[0]).map((w) => W.members.get(w.person_id)).filter((m): m is Member => !!m && !m.sms_opted_out).map(prof));
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

  // in-room sends cap / ledger
  if (has("SELECT COUNT(*)::int AS n FROM proactive_sends WHERE user_id = $1 AND type = 'in_room' AND target_key LIKE $2")) {
    const re = new RegExp("^" + String(p[1]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
    return R([{ n: W.proactiveSends.filter((s) => s.user_id === p[0] && s.type === "in_room" && re.test(s.target_key)).length }]);
  }
  if (has("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt) VALUES ($1, 'in_room'")) {
    if (!W.proactiveSends.some((s) => s.user_id === p[0] && s.target_key === p[1])) W.proactiveSends.push({ user_id: p[0], type: "in_room", target_key: p[1], message: p[2] });
    return R([]);
  }
  if (has("INSERT INTO proactive_sends (user_id, type, target_key, topic_key, message, exempt) VALUES ($1, $2, $3, $3, $4, true)")) {
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
    W.candidates.push({ user_id: p[0], type: p[1], target_key: p[2], summary: p[4], payload: JSON.parse(p[5]), status: "pending" });
    return R([{ id: W.candidates.length }]);
  }

  // presence
  if (has("SELECT sharing_seen_at, arrived_at FROM event_presence WHERE event_api_id = $1 AND user_id = $2")) {
    const r = W.presence.get(`${p[0]}|${p[1]}`);
    return R(r ? [r] : []);
  }
  if (has("FROM event_presence WHERE event_api_id = $1 AND user_id = ANY($2::uuid[])")) {
    return R((p[1] as string[]).map((u) => W.presence.get(`${p[0]}|${u}`) && { user_id: u, ...W.presence.get(`${p[0]}|${u}`) }).filter(Boolean) as Row[]);
  }

  // memories
  if (has("INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, $2, $3) RETURNING id")) {
    W.memoriesWritten.push({ user_id: p[0], memory_type: p[1], content: p[2] });
    return R([{ id: W.memoriesWritten.length }]);
  }
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
    if (!W.unmatchedFollowups.some((r) => r.event_api_id === p[1] && r.user_id === p[0])) W.unmatchedFollowups.push({ user_id: p[0], event_api_id: p[1], event_name: p[2], send_at: new Date(p[3]).getTime(), sent_at: null });
    return R([]);
  }
  if (has("SELECT DISTINCT event_api_id, event_name FROM event_unmatched_followups")) {
    const seen = new Set<string>();
    return R(W.unmatchedFollowups.filter((r) => !r.sent_at && r.send_at <= now() && !seen.has(r.event_api_id) && seen.add(r.event_api_id)).map((r) => ({ event_api_id: r.event_api_id, event_name: r.event_name })));
  }
  if (has("SELECT user_id FROM event_unmatched_followups WHERE event_api_id = $1")) {
    return R(W.unmatchedFollowups.filter((r) => r.event_api_id === p[0] && !r.sent_at && r.send_at <= now()).map((r) => ({ user_id: r.user_id })));
  }
  if (has("UPDATE event_unmatched_followups SET sent_at = NOW()")) {
    for (const r of W.unmatchedFollowups) if (r.event_api_id === p[0] && (p[1] as string[]).includes(r.user_id)) r.sent_at = now();
    return R([]);
  }
  if (has("SELECT 1 FROM event_unmatched_notices")) return R(W.unmatchedNotices.filter((r) => r.event_id === p[0] && r.person_id === p[1]).map(() => ({ x: 1 })));
  if (has("INSERT INTO event_unmatched_notices")) {
    W.unmatchedNotices.push({ event_id: p[0], person_id: p[1], paired_with_id: p[2] });
    return R([]);
  }

  // resolveNamedEventGuest
  if (has("SELECT event_api_id, event_name FROM event_checkin_followups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1")) {
    return R(W.checkinFollowups.filter((r) => r.user_id === p[0]).slice(-1).map((r) => ({ event_api_id: r.event_api_id, event_name: r.event_name })));
  }

  // Everything else (co_facts writes, outbound_messages, checkin followups, user state): accepted, nothing returned.
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
  return { score, share: /their own stated/.test(line) && score > 0, mutual: false };
}

function anthropic(init: any): Response {
  const prompt = promptOf(init);
  if (prompt.startsWith("Someone wants to be connected with people who match this:")) {
    W.llmCalls.push({ kind: "score", prompt });
    const askText = prompt.match(/match this: "([\s\S]*?)"\n/)?.[1] ?? "";
    const digest = prompt.split("one per line:\n")[1]?.split("\n\nFor each candidate")[0] ?? "";
    const results = digest
      .split("\n")
      .filter((l) => /^\d+\. /.test(l))
      .map((l) => {
        const index = Number(l.match(/^(\d+)\./)![1]);
        const tag = l.match(/tag(\d{6})/)?.[1];
        const cand = [...W.members.values()].find((mm) => mm.id.endsWith(tag ?? "--"));
        const s = W.scorer && cand ? W.scorer(askText, cand) : defaultScore(askText, l);
        return { index, score: s.score, reason: "internal", share_reason: s.share ? "their stated ask fits" : "", mutual: !!s.mutual };
      });
    return anthropicText(JSON.stringify({ results }));
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
  if (prompt.includes("nothing stood out as a strong pull tonight")) {
    W.llmCalls.push({ kind: "soloAck", prompt });
    return anthropicText("Nothing jumped out as a strong pull tonight, and I'm still glad you came.");
  }
  const d = prompt.match(/You're texting ([^ ]+) about "([^"]*)\." ([^,]+), who's also going, said they'd like to be introduced/);
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
    const ev = W.events.get(url.searchParams.get("event_id") ?? "");
    if (!ev) return json({ message: "not found" }, 404);
    return json({ entries: ev.guests.map((g, i) => ({ guest: { id: `gst-${i}`, user_email: g.email, user_name: g.name, phone_number: g.phone, approval_status: g.approval_status } })), has_more: false });
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
  if (url.host === "api.anthropic.com") return anthropic(init);
  if (url.host === "api.openai.com") {
    const b = JSON.parse(init?.body ?? "{}");
    const inputs = Array.isArray(b.input) ? b.input : [b.input ?? ""];
    return json({ object: "list", data: inputs.map((_: unknown, index: number) => ({ object: "embedding", index, embedding: new Array(1536).fill(0) })), usage: { prompt_tokens: 0, total_tokens: 0 } });
  }
  if (url.host === "public-api.luma.com") return luma(url);
  throw new Error(`inroom world: refused outside call to ${url.host}`);
}) as typeof fetch;
void realFetch;

// ------------------------------------------------------------------ wire it up
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, params?: any[]) => handle(sql, params ?? []);
(pool as any).connect = async () => ({ query: async (sql: string, params?: any[]) => handle(sql, params ?? []), release: () => {} });

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
