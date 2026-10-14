// Restraint with memory (Royce, 2026-10-08: "silence is data"). Every proactive message Co starts is tracked by what KIND of message it
// is (a find, an intro follow-up, a deadline, a goal nudge, something they said they'd do). Two of the same kind in a row that the
// member let pass, with no reply and no reaction, means Co stops sending that kind to them and records the learned preference
// (member_kind_preferences, plus a decision row). A member answering one (a reply in its window, a positive tapback on it, or a
// threaded reply to it, however late) resets the streak and turns the kind back on.
//
// This sits ON TOP of everything else: quiet hours, the pause switches, opt-out, the caps and spacing all still gate every send
// (harness/proactive.ts). Restraint only ever takes a kind away; it never lets anything through.
//
// Definitions (all in code, nothing guessed by a model):
//   ignored   no reply and no positive reaction attributable to the send by the end of its window: RESTRAINT.windowHours after it
//             went out, or the next send of the same kind if that came sooner. A thumbs down ("Disliked") is ignored too.
//   answered  attributable to the send: (a) a tapback or threaded reply that quotes it, at any time; (b) any other text from them
//             (a reply, a positive tapback quoting nothing Co sent, a call) inside its window. (b) is generous on purpose: a member
//             who is talking to Co is not a member to go quiet on.
//   suppressed  RESTRAINT.ignoredToSuppress ignored in a row with no answered one between. Off for RESTRAINT.offDays, then ONE trial
//             message of that kind may go (Royce, 2026-10-08: "30 days off, then one trial message"). Trial answered: back on.
//             Trial let pass: off for another RESTRAINT.offDays. Nothing is muted for good from old data.
//   counting  starts at deploy (Royce: "clean slate, count forward"): only sends from the first send the ledger tagged with a kind
//             count; nothing a member let pass before restraint existed holds them back.
// Answers to their own explicit ask (an event offer for an open ask) are never suppressed: they asked (harness/proactive.ts).
// Every read and write is scoped to one member.
import pool from "../db/db.js";

export const PROACTIVE_KINDS = ["find", "intro_followup", "deadline", "goal_nudge", "member_commitment"] as const;
export type ProactiveKind = (typeof PROACTIVE_KINDS)[number];

export const RESTRAINT = {
  // How long a send waits for an answer before it counts as let pass (or until the next send of its kind).
  windowHours: 48,
  // This many let pass in a row turns the kind off for the member.
  ignoredToSuppress: 2,
  // How far back the history is read; an older suppression is held by the stored preference.
  historyDays: 120,
  // How long a kind stays off before one trial message may go.
  offDays: 30,
};

// Pure: what kind a proactive type is. null: not tracked (companion check-ins, debriefs, logistics, briefs, Mo's own flow).
export function kindOf(type: string, payload: unknown = null): ProactiveKind | null {
  const p = (payload ?? {}) as { reminder?: boolean; kind?: string };
  switch (type) {
    case "event_offer":
      return p.reminder ? "deadline" : "find";
    case "event_match_nudge":
    case "network_tease":
      return "find";
    case "deadline_nudge":
      return "deadline";
    case "intro_nudge":
      return "intro_followup";
    case "goal_nudge":
    case "goal_checkin":
    case "goal_recheck":
      return "goal_nudge";
    case "commitment_nudge":
      return "member_commitment";
    case "window_followup":
      return p.kind === "commitment" ? "member_commitment" : null;
    default:
      return null;
  }
}

export type KindSend = { id: string; kind: ProactiveKind; sentAt: Date; message: string | null };
export type InboundLine = { at: Date; text: string };
export type StoredPref = { kind: ProactiveKind; state: "suppressed" | "enabled"; suppressedAt: Date | null; enabledAt: Date | null; evidence: string[] };
export type KindVerdict = {
  kind: ProactiveKind;
  suppressed: boolean;
  // Off, but its RESTRAINT.offDays are up: one trial message may go (the stored preference stays "suppressed" until it's answered).
  trial?: boolean;
  // When it was turned off (suppressed) or last answered (enabled).
  since: Date | null;
  // The sends that were let pass (suppressed), or the one that was answered (enabled).
  evidence: string[];
  reason: string;
};

type Signal = "reply" | "positive" | "negative";
export type ReadInbound = { at: Date; signal: Signal; quoted: string | null };

// iMessage reactions arrive as text: Loved “…”, Liked “…”, Disliked “…”, Laughed at “…”, Emphasized “…”, Questioned “…”, and the
// newer Reacted 🔥 to “…”. A threaded reply is logged with [Replying to Co's text: "…"] (services/inlineReply.ts).
const TAPBACK = /^(loved|liked|disliked|laughed at|emphasized|questioned|reacted\s+(\S+)\s+to)\s+[“"']([\s\S]+?)[”"']\s*$/i;
const THREADED = /\[Replying to Co's text: "([\s\S]+?)"(?:\s*\([^)]*\))?\]\s*$/;

// Pure: one of their lines as a signal. `text` is what they sent (the "User said: " prefix is removed by the reader).
export function readInbound(line: InboundLine): ReadInbound {
  const text = line.text.trim();
  const tb = text.match(TAPBACK);
  if (tb) {
    const verb = tb[1].toLowerCase();
    const emoji = tb[2] ?? "";
    const negative = verb === "disliked" || /👎/.test(emoji);
    return { at: line.at, signal: negative ? "negative" : verb === "questioned" ? "reply" : "positive", quoted: tb[3].replace(/…$/, "").trim() };
  }
  const th = text.match(THREADED);
  if (th) return { at: line.at, signal: "reply", quoted: th[1].replace(/…$/, "").trim() };
  return { at: line.at, signal: "reply", quoted: null };
}

const norm = (s: string) => s.toLowerCase().replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
// Pure: whether a quoted piece is from this send's text (iMessage shortens long quotes).
export function quotes(send: Pick<KindSend, "message">, quoted: string): boolean {
  const q = norm(quoted).slice(0, 60);
  return q.length >= 8 && !!send.message && norm(send.message).includes(q);
}

// Sends of one kind this close together went out as one text.
export const SAME_TEXT_MINUTES = 10;

type Outcome = { sendId: string; kind: ProactiveKind; at: Date; answered: boolean };

// Pure: what happened to each send, then the streak per kind. `stored` keeps a suppression older than the history alive until
// they answer something of that kind after it.
export function evaluateKindRestraint(o: { sends: KindSend[]; inbound: InboundLine[]; stored?: StoredPref[]; now: Date; windowHours?: number }): Map<ProactiveKind, KindVerdict> {
  const W = (o.windowHours ?? RESTRAINT.windowHours) * 3_600_000;
  // Offers that rode in one text (harness/proactive.ts pickSiblingOffers) are one message, not several let pass.
  const sends: KindSend[] = [];
  for (const s of [...o.sends].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    const prev = [...sends].reverse().find((x) => x.kind === s.kind);
    if (prev && s.sentAt.getTime() - prev.sentAt.getTime() <= SAME_TEXT_MINUTES * 60_000) {
      prev.message = [prev.message, s.message].filter(Boolean).join("\n\n") || null;
      continue;
    }
    sends.push({ ...s });
  }
  const lines = o.inbound.map(readInbound).sort((a, b) => a.at.getTime() - b.at.getTime());
  // A quoted reaction or threaded reply belongs to the newest send before it that it quotes, of any kind.
  const quotedTo = new Map<ReadInbound, string>();
  for (const l of lines) {
    if (!l.quoted) continue;
    const hit = [...sends].reverse().find((s) => s.sentAt.getTime() < l.at.getTime() && quotes(s, l.quoted!));
    if (hit) quotedTo.set(l, hit.id);
  }
  const outcomes: Outcome[] = [];
  for (let i = 0; i < sends.length; i++) {
    const s = sends[i];
    const next = sends.slice(i + 1).find((x) => x.kind === s.kind);
    const end = Math.min(s.sentAt.getTime() + W, next ? next.sentAt.getTime() : Infinity);
    const own = lines.filter((l) => quotedTo.get(l) === s.id && l.at.getTime() > s.sentAt.getTime());
    const firstOwn = own[0];
    if (firstOwn) {
      outcomes.push({ sendId: s.id, kind: s.kind, at: firstOwn.at, answered: firstOwn.signal !== "negative" });
      continue;
    }
    // Anything else they sent in the window (not a reaction to a different send of Co's).
    const inWindow = lines.find((l) => l.at.getTime() > s.sentAt.getTime() && l.at.getTime() <= end && !quotedTo.has(l));
    if (inWindow) {
      outcomes.push({ sendId: s.id, kind: s.kind, at: inWindow.at, answered: inWindow.signal !== "negative" });
      continue;
    }
    if (end <= o.now.getTime()) outcomes.push({ sendId: s.id, kind: s.kind, at: new Date(end), answered: false });
    // else: still waiting, neither.
  }
  const out = new Map<ProactiveKind, KindVerdict>();
  for (const kind of PROACTIVE_KINDS) {
    const evs = outcomes.filter((x) => x.kind === kind).sort((a, b) => a.at.getTime() - b.at.getTime());
    let streak: Outcome[] = [];
    let suppressedAt: Date | null = null;
    let suppressedBy: string[] = [];
    let lastAnswered: Outcome | null = null;
    for (const e of evs) {
      if (e.answered) {
        streak = [];
        suppressedAt = null;
        suppressedBy = [];
        lastAnswered = e;
        continue;
      }
      streak.push(e);
      if (!suppressedAt && streak.length >= RESTRAINT.ignoredToSuppress) {
        suppressedAt = e.at;
        suppressedBy = streak.slice(-RESTRAINT.ignoredToSuppress).map((x) => x.sendId);
      } else if (suppressedAt) {
        // A trial let pass: off for another stretch, from now.
        suppressedAt = e.at;
        suppressedBy = [e.sendId];
      }
    }
    const stored = o.stored?.find((p) => p.kind === kind);
    const heldByStore = stored?.state === "suppressed" && !!stored.suppressedAt && !(lastAnswered && lastAnswered.at.getTime() > stored.suppressedAt.getTime());
    const offAt = suppressedAt ?? (heldByStore ? stored!.suppressedAt : null);
    if (offAt) {
      const OFF = RESTRAINT.offDays * 86_400_000;
      // A trial already went and is still waiting for its answer: no second one.
      const trialOut = sends.some((x) => x.kind === kind && x.sentAt.getTime() > offAt.getTime() && !outcomes.some((oc) => oc.sendId === x.id));
      const up = o.now.getTime() - offAt.getTime() >= OFF && !trialOut;
      const why = suppressedAt ? `they let ${RESTRAINT.ignoredToSuppress} ${kind} texts in a row pass with no reply or reaction` : `turned off earlier (${RESTRAINT.ignoredToSuppress} ${kind} texts let pass) and nothing of that kind answered since`;
      out.set(kind, up
        ? { kind, suppressed: false, trial: true, since: offAt, evidence: suppressedAt ? suppressedBy : stored!.evidence, reason: `off since ${offAt.toISOString().slice(0, 10)} (${why}); ${RESTRAINT.offDays} days are up, so one trial message may go` }
        : { kind, suppressed: true, since: offAt, evidence: suppressedAt ? suppressedBy : stored!.evidence, reason: why });
    } else {
      out.set(kind, { kind, suppressed: false, since: lastAnswered?.at ?? null, evidence: lastAnswered ? [lastAnswered.sendId] : [], reason: lastAnswered ? `they answered a ${kind} text` : "no streak" });
    }
  }
  return out;
}

// Pure: what changed against what's stored, so a preference is written (and logged) only when it flips.
export function preferenceChanges(verdicts: Map<ProactiveKind, KindVerdict>, stored: StoredPref[]): { kind: ProactiveKind; to: "suppressed" | "enabled"; verdict: KindVerdict }[] {
  const out: { kind: ProactiveKind; to: "suppressed" | "enabled"; verdict: KindVerdict }[] = [];
  for (const v of verdicts.values()) {
    const s = stored.find((p) => p.kind === v.kind);
    // Off, or off again after a trial was let pass (a newer off date than the stored one): recorded, restarting the clock.
    if (v.suppressed && (s?.state !== "suppressed" || (!!v.since && !!s.suppressedAt && v.since.getTime() > s.suppressedAt.getTime() && v.evidence.some((id) => !s.evidence.includes(id))))) out.push({ kind: v.kind, to: "suppressed", verdict: v });
    // Only a kind that was turned off is turned back on (a trial window is not "on": it stays suppressed until the trial is answered).
    if (!v.suppressed && !v.trial && s?.state === "suppressed") out.push({ kind: v.kind, to: "enabled", verdict: v });
  }
  return out;
}

export function suppressedKinds(verdicts: Map<ProactiveKind, KindVerdict>): ProactiveKind[] {
  return [...verdicts.values()].filter((v) => v.suppressed).map((v) => v.kind);
}

// ---------------------------------------------------------------- reads and writes (one member)

type Queryable = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

export async function loadStoredPrefs(db: Queryable, userId: string): Promise<StoredPref[]> {
  const { rows } = await db
    .query(`SELECT kind, state, suppressed_at, enabled_at, evidence FROM member_kind_preferences WHERE user_id = $1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  return rows
    .filter((r: any) => (PROACTIVE_KINDS as readonly string[]).includes(r.kind))
    .map((r: any) => ({
      kind: r.kind,
      state: r.state === "suppressed" ? "suppressed" : "enabled",
      suppressedAt: r.suppressed_at ? new Date(r.suppressed_at) : null,
      enabledAt: r.enabled_at ? new Date(r.enabled_at) : null,
      evidence: Array.isArray(r.evidence) ? r.evidence.map(String) : [],
    }));
}

// The member's kinded sends (the ledger's kind, or the kind of the candidate behind an older row) and their own lines since.
export async function loadKindHistory(db: Queryable, userId: string): Promise<{ sends: KindSend[]; inbound: InboundLine[] }> {
  // From deploy only (Royce, 2026-10-08): the first send the ledger tagged with a kind marks when restraint began. Before it, nothing
  // counts; after it, a row the ledger didn't tag (a sibling offer in the same text) is kinded from its candidate.
  const { rows } = await db.query(
    `SELECT ps.id, ps.type, ps.kind, ps.message, ps.sent_at, pc.payload
     FROM proactive_sends ps LEFT JOIN proactive_candidates pc ON pc.id = ps.candidate_id
     WHERE ps.user_id = $1 AND ps.sent_at > NOW() - ($2 || ' days')::interval
       AND ps.sent_at >= COALESCE((SELECT MIN(sent_at) FROM proactive_sends WHERE kind IS NOT NULL), 'infinity'::timestamptz)
     ORDER BY ps.sent_at`,
    [userId, RESTRAINT.historyDays],
  );
  const sends: KindSend[] = [];
  for (const r of rows) {
    const kind = ((PROACTIVE_KINDS as readonly string[]).includes(r.kind) ? r.kind : kindOf(String(r.type), r.payload)) as ProactiveKind | null;
    if (kind) sends.push({ id: String(r.id), kind, sentAt: new Date(r.sent_at), message: r.message ?? null });
  }
  if (!sends.length) return { sends, inbound: [] };
  const { rows: lines } = await db.query(
    `SELECT created_at, content FROM co_memories
     WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User %' OR content LIKE '[Call]%') AND created_at > $2
     ORDER BY created_at`,
    [userId, sends[0].sentAt],
  );
  return { sends, inbound: lines.map((l: any) => ({ at: new Date(l.created_at), text: String(l.content).replace(/^User said:\s*/, "") })) };
}

// The live verdicts for one member, read inside whatever transaction the caller holds.
export async function loadKindRestraint(db: Queryable, userId: string, now = new Date()): Promise<{ verdicts: Map<ProactiveKind, KindVerdict>; stored: StoredPref[] }> {
  const [h, stored] = await Promise.all([loadKindHistory(db, userId), loadStoredPrefs(db, userId)]);
  return { verdicts: evaluateKindRestraint({ ...h, stored, now }), stored };
}

// Writes the learned preference when it flips, and logs the decision. Never throws.
export async function syncKindPreferences(userId: string, verdicts: Map<ProactiveKind, KindVerdict>, stored: StoredPref[]): Promise<number> {
  const changes = preferenceChanges(verdicts, stored);
  if (!changes.length) return 0;
  const { recordDecision } = await import("../harness/core.js");
  for (const c of changes) {
    try {
      await pool.query(
        `INSERT INTO member_kind_preferences (user_id, kind, state, suppressed_at, enabled_at, reason, evidence, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
         ON CONFLICT (user_id, kind) DO UPDATE SET state = EXCLUDED.state,
           suppressed_at = COALESCE(EXCLUDED.suppressed_at, member_kind_preferences.suppressed_at),
           enabled_at = COALESCE(EXCLUDED.enabled_at, member_kind_preferences.enabled_at),
           reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, updated_at = NOW()`,
        [userId, c.kind, c.to, c.to === "suppressed" ? (c.verdict.since ?? new Date()) : null, c.to === "enabled" ? (c.verdict.since ?? new Date()) : null, c.verdict.reason, JSON.stringify(c.verdict.evidence)],
      );
      await recordDecision({ layer: 7, decision: "proactive.kindRestraint", userId, outcome: "act", action: `${c.to === "suppressed" ? "suppress" : "enable"}:${c.kind}`, reason: c.verdict.reason, proposal: { kind: c.kind, evidence: c.verdict.evidence, since: c.verdict.since?.toISOString() ?? null } }).catch(() => {});
    } catch (err: any) {
      console.error(`kindRestraint: saving the ${c.kind} preference failed (non-fatal):`, err?.message ?? err);
    }
  }
  return changes.length;
}

// Hourly: members with a kinded send lately, so a preference is recorded even when nothing is waiting to go out.
export async function runKindRestraintSync(now = new Date()): Promise<number> {
  const { rows } = await pool
    .query(`SELECT DISTINCT user_id FROM proactive_sends WHERE sent_at > NOW() - INTERVAL '14 days' UNION SELECT user_id FROM member_kind_preferences WHERE state = 'suppressed'`)
    .catch(() => ({ rows: [] as any[] }));
  let changed = 0;
  for (const r of rows) {
    try {
      const { verdicts, stored } = await loadKindRestraint(pool, r.user_id, now);
      changed += await syncKindPreferences(r.user_id, verdicts, stored);
    } catch (err: any) {
      console.error("kindRestraint: sync failed for a member (non-fatal):", err?.message ?? err);
    }
  }
  return changed;
}
