// Lane moves (Royce, 2026-10-13): "Define every allowed move between lanes. A task becomes a lookout only on my words. Every other
// lane change is Co proposing and me confirming, and every confirmed change leaves a one-line, member-visible note ('moved X from
// tasks to lookouts'). No silent re-promotion through a side door."
//
// The lanes, where they live:
//   task     co_tasks (open work, source ask or promise), and open ask_checkins that aren't lookouts (kind help, intent question)
//   lookout  ask_checkins intent 'lookout' (kind find), and co_tasks source 'lookout'
//   goal     co_profiles.intent entries of kind goal, and co_profiles.goals, with their state in goal_states (services/goalEdges.ts)
//   interest co_profiles.activity_preferences
//
// The moves (LANE_RULES):
//   task -> lookout   only on their own words: the intent split reads a lookout from what they said (askLifecycle.ts readIntents,
//                     settleAskIntent below). Never a tool, never Co's proposal.
//   task -> goal, goal -> lookout, lookout -> goal
//                     Co proposes in a question naming the move, their yes in this message confirms it (the moveLane tool, confirm
//                     their_yes in toolGuard.ts, whole un-negated words: services/theirYes.ts; offersMove). A confirmed
//                     move returns one note ("moved the jazz nights from goals to lookouts") that code puts in the reply, once
//                     (carryLaneNotes), and logs lane.move with their quoted yes.
//   interest          inferred to confirmed only on their words: the claims hold that (claims.ts mergeClaims: only their own words
//                     re-confirm). Nothing moves into or out of interests.
//   closing or ending anything stays where it is (closeTask, closeAsk, markGoal, expiry).
//
// Side doors, closed here so every lane write has one home:
//   - the kind jobs (askKind.ts classifyOpenAsks, goalEdges.ts helpAsk) change an ask's kind only through setAskKind, which never
//     changes a lookout's (askKindAfter)
//   - the profile read never adds a goal or an interest from a one-off ask's subject: the extraction's rule (turnLearning.ts), and in
//     code the exact restatement of an ask read as one-off (isOneOffAsk, turnAskLane; profileExtraction.ts heldAsOneOff)
//   - a goal moved out leaves co_profiles.goals and isn't read back in from the conversation (profileExtraction.ts storeProfile)
//   - a lookout started without their own watch words never restates one of their tasks or open asks (lookoutRestatesTask;
//     conversationTools.ts startTask)
//   - a new member's first look that promised nothing is withdrawn, never turned into Co's own lookout (theDoor.ts settleFirstRead;
//     Royce, 2026-10-13: "Stop it, no exception"). No code sets a task's source to lookout.
// Every read and write is scoped to one member (user_id).
import crypto from "crypto";
import pool from "../db/db.js";
import type { AskKind } from "./askKind.js";
import { meaningWords } from "./profileExtraction.js";
import { offerLines, yesIsTheirs } from "./theirYes.js";

export type Lane = "task" | "lookout" | "goal" | "interest";
export const LANE_WORDS: Record<Lane, string> = { task: "tasks", lookout: "lookouts", goal: "goals", interest: "interests" };
export type MoveRule = "their_words" | "confirmed";
export const LANE_RULES: Readonly<Partial<Record<`${Lane}>${Lane}`, MoveRule>>> = {
  "task>lookout": "their_words",
  "task>goal": "confirmed",
  "goal>lookout": "confirmed",
  "lookout>goal": "confirmed",
};
// Pure: how a move may happen, or null when it never does.
export function ruleFor(from: Lane, to: Lane): MoveRule | null {
  return LANE_RULES[`${from}>${to}`] ?? null;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set((norm(s).match(/[a-z0-9']{3,}/g) ?? []).filter((w) => !["the", "and", "for", "with", "from"].includes(w)));
// The lane a question of Co's names, in words a member would read (review, 2026-10-13: a yes counts only for the move Co offered).
const NAMES_LANE: Partial<Record<Lane, RegExp>> = {
  goal: /\bgoals?\b/i,
  lookout: /\b(?:lookouts?|look ?out for|keep an eye (?:out|on)|keep (?:watching|looking)|watch(?:ing)? for)\b/i,
};
// Pure: Co asked them about THIS move in the recent exchange (theirYes.ts exchangeText): in Co's turn since their previous message or
// the one before it (a clarifying question can sit between), a question that names where it goes and shares a meaning word with the
// thing. A yes to some other offer moves nothing.
export function offersMove(recent: string | null | undefined, to: Lane, itemText: string): boolean {
  const names = NAMES_LANE[to];
  if (!names || !recent) return false;
  const item = meaningWords(itemText);
  return offerLines(recent)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .some((q) => /\?\s*["')\]]*$/.test(q.trim()) && names.test(q) && [...meaningWords(q)].some((w) => item.has(w)));
}

// ---------------------------------------------------------------- the note

// Pure: the one line a confirmed move leaves. No em dashes, no exclamation points, no quotes; short.
export function laneNote(label: string, from: Lane, to: Lane): string {
  let what = String(label ?? "").replace(/[“”"]/g, "").replace(/\s*[—–]\s*/g, ", ").replace(/!/g, "").replace(/\s+/g, " ").trim().replace(/[.,;:?]+$/, "");
  if (what.length > 80) what = what.slice(0, 80).replace(/\s+\S*$/, "");
  return `moved ${what} from ${LANE_WORDS[from]} to ${LANE_WORDS[to]}`;
}
// Pure: Co's short name for the thing, only when it names the same thing (a word in common); else the item's own words.
export function noteLabel(label: string | null | undefined, itemText: string): string {
  const l = String(label ?? "").trim();
  const mine = words(itemText);
  return l && l.length <= 80 && [...words(l)].some((w) => mine.has(w)) ? l : itemText;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The note as written, any case, with or without its period.
const notePattern = (note: string) => new RegExp(`${escape(note).replace(/ /g, "\\s+")}\\.?`, "gi");
// A note stored without its period gets one; a fixed line already ending its sentence (an approved line, services/voiceReadConsent.ts)
// is carried exactly as written, never "Want me to?." (2026-10-28).
const ENDS_SENTENCE = /[.!?]["')\]]*$/;
const ASKS = /\?["')\]]*$/;
const asSentence = (note: string) => {
  const t = `${note.charAt(0).toUpperCase()}${note.slice(1)}`;
  return ENDS_SENTENCE.test(t.trim()) ? t : `${t}.`;
};
const tidy = (t: string) => t.split(/\n\s*\n/).map((p) => p.replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean).join("\n\n");

// Pure: the reply carries each pending note exactly once, and nothing already sent this turn again. A note already in the draft stays
// where Co put it (first time only); one missing goes at the end of the first paragraph that isn't a question, so it rides in a text
// that's going anyway, never as a text of its own. A fixed line that is itself a question goes last, as its own paragraph.
export function carryLaneNotes(draft: string, pending: readonly string[], sent: readonly string[] = []): { text: string; carried: string[] } {
  let text = draft;
  for (const n of sent) text = text.replace(notePattern(n), "");
  const carried: string[] = [];
  for (const n of pending) {
    if (sent.some((s) => norm(s) === norm(n)) || carried.some((c) => norm(c) === norm(n))) continue;
    let seen = false;
    text = text.replace(notePattern(n), (m) => (seen ? "" : ((seen = true), m)));
    if (!seen) {
      const paras = tidy(text).split(/\n\n/).filter(Boolean);
      const at = paras.findIndex((p) => !/\?\s*["')\]]*$/.test(p));
      // A fixed line that asks them something is the reply's question: its own last paragraph, word for word, never spliced into
      // Co's text ahead of another paragraph.
      if (!paras.length || ASKS.test(n.trim())) paras.push(asSentence(n));
      else if (at >= 0) paras[at] = `${paras[at].replace(/\s+$/, "")}${/[.!?]["')\]]*$/.test(paras[at].trim()) ? "" : "."} ${asSentence(n)}`;
      else paras[0] = `${asSentence(n)} ${paras[0]}`;
      text = paras.join("\n\n");
    }
    carried.push(n);
  }
  return { text: tidy(text), carried };
}

// ---------------------------------------------------------------- the kind jobs never change a lookout's lane

// Pure: the kind a kind job may write for an ask, or null to leave it. A lookout keeps its kind; one never read gets find, which is
// what a lookout is (find + intent lookout).
export function askKindAfter(row: { kind: string | null; intent: string | null }, proposed: AskKind): AskKind | null {
  // Outside the purpose boundary (askKind.ts outsideAsk): even a look-out is remembered only, never swept or checked in on.
  if (proposed === "outside") return row.kind === "outside" ? null : "outside";
  if (row.intent === "lookout") return row.kind ? null : "find";
  return row.kind === proposed ? null : proposed;
}
type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
// The one write of an ask's kind (askKind.ts, goalEdges.ts). `read` is the row as the job read it: the write only lands while the row is
// still that (a lookout read since is left alone). Marks it checked either way.
export async function setAskKind(db: Db, o: { id: string | number; userId?: string | null; read: { kind: string | null; intent: string | null }; kind: AskKind; version?: number | null; connection?: string | null }): Promise<boolean> {
  const next = askKindAfter(o.read, o.kind);
  const r = await db.query(
    `UPDATE ask_checkins SET kind = COALESCE($2, kind), kind_checked_at = NOW(), kind_version = COALESCE($3, kind_version), scope_connection = COALESCE($7, scope_connection)
     WHERE id = $1 AND ($4::text IS NULL OR user_id::text = $4) AND kind IS NOT DISTINCT FROM $5 AND intent IS NOT DISTINCT FROM $6`,
    [o.id, next, o.version ?? null, o.userId ?? null, o.read.kind, o.read.intent, o.connection ?? null],
  );
  return next !== null && (r.rowCount ?? 0) > 0;
}

// The one way an ask becomes a lookout: the intent split, from their own words (askLifecycle.ts readIntents). Written once.
export async function settleAskIntent(askRowId: string, intent: "question" | "lookout", why: string, db: Db = pool): Promise<boolean> {
  const r = await db.query(`UPDATE ask_checkins SET intent = $2, intent_why = $3 WHERE id = $1 AND intent IS NULL`, [askRowId, intent, why]);
  return (r.rowCount ?? 0) > 0;
}

// Pure: a lookout started without their own watch words that restates one of their tasks (or open asks) is a task becoming a lookout
// without their words. Refused (startTask). Stemmed meaning words, the watching and finding verbs left out, so a paraphrase counts.
const WATCH_WORDS = ["keep", "eye", "out", "watch", "watching", "track", "let", "know", "when", "if", "ping", "text", "lookout", "posted", "new", "come", "comes", "show", "turns", "anything", "something", "up", "for"];
export function lookoutRestatesTask(goal: string, taskGoals: readonly string[]): string | null {
  const g = meaningWords(goal, WATCH_WORDS);
  if (!g.size) return null;
  for (const t of taskGoals) {
    const w = meaningWords(t, WATCH_WORDS);
    if (!w.size) continue;
    const shared = [...g].filter((x) => w.has(x)).length;
    if (shared / Math.min(g.size, w.size) >= 0.6) return t;
  }
  return null;
}

// ---------------------------------------------------------------- one-off asks never become goals or interests

// Pure: the turn's ask is one-off when Co's own reads typed it an errand (entryKind.ts: research, a document, advice, a single search)
// and the intent split read it as a question. Unread is not one-off (review, 2026-10-13: fail open to the extraction's own rule, never
// into holding). An offer of theirs is not a request.
export type TurnAsk = { text: string; oneOff: boolean; why: string };
export function isOneOffAsk(a: { entryKind: "ask" | "goal" | null | undefined; type?: string | null; intent: "question" | "lookout" | null }): boolean {
  return a.entryKind === "ask" && a.type !== "offering" && a.intent === "question";
}
// This turn's ask as the lanes read it, from what the intent capture wrote (profileExtraction.ts persistIntentFrom). The intent split runs
// now for it if it hasn't (it would within the hour anyway, and it's kept on the row). Unread, or no ask row: not one-off.
export async function turnAskLane(userId: string, written: { id?: string; text?: string; type?: string; kind?: "ask" | "goal" } | null): Promise<TurnAsk | null> {
  if (!written?.text || !written.id) return null;
  if (written.kind === "goal" || written.type === "offering") return { text: written.text, oneOff: false, why: written.kind === "goal" ? "typed a goal" : "an offer" };
  const { rows } = await pool.query(
    `SELECT id, user_id, ask_id, ask_text, kind, intent, created_at, last_mentioned_at, resolved_at, expired_at, closed_reason, awaiting_response_since FROM ask_checkins WHERE user_id = $1 AND ask_id = $2 AND resolved_at IS NULL LIMIT 1`,
    [userId, written.id],
  );
  if (!rows[0]) return { text: written.text, oneOff: false, why: "no ask row to read" };
  let intent: "question" | "lookout" | null = rows[0].intent === "lookout" || rows[0].intent === "question" ? rows[0].intent : null;
  if (!intent) {
    const L = await import("./askLifecycle.js");
    intent = (await L.defaultDeps().intent!(userId, [rows[0]]).catch(() => new Map())).get(rows[0].id) ?? null;
  }
  const oneOff = isOneOffAsk({ entryKind: written.kind ?? "ask", type: written.type, intent });
  return { text: written.text, oneOff, why: oneOff ? "an errand, read as a question" : intent ? `read as a ${intent}` : "unread" };
}

// ---------------------------------------------------------------- the move

export type LaneItem = { lane: Lane; store: "task" | "ask" | "goal_entry" | "goal_text"; id: string; text: string; goalPiece?: boolean };
export type LaneStore = {
  items: (userId: string, lane: Lane) => Promise<LaneItem[]>;
  addGoal: (userId: string, text: string, from: Lane, theirYes: string) => Promise<boolean>;
  addLookout: (userId: string, text: string, from: Lane, theirYes: string) => Promise<boolean>;
  // Takes the item out of its lane: a task or lookout closes (dropped at their word), a goal is set aside as moved.
  leave: (userId: string, item: LaneItem, to: Lane, theirYes: string) => Promise<boolean>;
  log: (d: { userId: string; outcome: "act" | "skip"; action: string; reason: string | null; proposal: Record<string, unknown> }) => Promise<void>;
};
// recent: the exchange before their message (theirYes.ts exchangeText), where Co's question offering this move must be.
export type MoveInput = { userId: string; from: Lane; to: Lane; item: string; label?: string | null; theirYes: string; message: string; recent: string | null };
export type MoveResult = { ok: true; note: string; item: string; partial?: boolean } | { ok: false; why: string };

// Pure: the one item a member means, from the lane's items: "task #12", or its words as listed.
export function matchLaneItem(items: LaneItem[], ref: string): LaneItem[] {
  const id = ref.match(/#\s*(\d+)/)?.[1];
  if (id) return items.filter((i) => i.store === "task" && i.id === id);
  const want = norm(ref);
  if (!want) return [];
  const exact = items.filter((i) => norm(i.text) === want);
  return exact.length ? exact : items.filter((i) => norm(i.text).includes(want) || want.includes(norm(i.text)));
}

export async function moveLane(input: MoveInput, store: LaneStore = currentStore()): Promise<MoveResult> {
  const { userId, from, to } = input;
  const refuse = async (why: string, action: string) => {
    await store.log({ userId, outcome: "skip", action, reason: why, proposal: { from, to, item: input.item.slice(0, 200), theirYes: String(input.theirYes ?? "").slice(0, 200) } }).catch(() => {});
    return { ok: false as const, why };
  };
  const rule = from === to ? null : ruleFor(from, to);
  if (rule === "their_words") return refuse("a task becomes a lookout only on their own words, never by a move Cue proposes; if they ask you to keep watching, that's theirs to say", "refused_their_words_only");
  if (!rule) return refuse(`${LANE_WORDS[from]} to ${LANE_WORDS[to]} isn't a move Cue makes`, "refused_not_a_move");
  // The fact (their quoted yes is in this message); whether it's a yes to this offer is the tool guard's read (services/theirYes.ts).
  if (!yesIsTheirs(input.theirYes, input.message, userId)) return refuse("the quoted yes isn't in their message", "needs_yes");
  const hits = matchLaneItem(await store.items(userId, from), input.item);
  if (hits.length !== 1) return refuse(hits.length ? `"${input.item.slice(0, 80)}" matches more than one of their ${LANE_WORDS[from]}` : `"${input.item.slice(0, 80)}" isn't one of their ${LANE_WORDS[from]}`, hits.length ? "ambiguous" : "not_found");
  const item = hits[0];
  if (!offersMove(input.recent, to, item.text)) return refuse(`their yes wasn't to this move: your recent texts didn't ask about moving it to their ${LANE_WORDS[to]}`, "not_offered");
  if (item.goalPiece) return refuse("that's a piece of a goal they handed Cue; it stays with its goal", "refused_goal_piece");
  // The new lane first, then out of the old: a failure leaves it where it was, never nowhere.
  const added = to === "goal" ? await store.addGoal(userId, item.text, from, input.theirYes) : await store.addLookout(userId, item.text, from, input.theirYes);
  if (!added) return refuse(`it couldn't be added to their ${LANE_WORDS[to]}, so nothing moved`, "add_failed");
  const left = await store.leave(userId, item, to, input.theirYes).catch(() => false);
  const note = laneNote(noteLabel(input.label, item.text), from, to);
  await store.log({ userId, outcome: "act", action: `${from}>${to}`, reason: left ? null : "added to the new lane, but it couldn't be taken out of the old one", proposal: { item: item.text.slice(0, 200), store: item.store, id: item.id, theirYes: String(input.theirYes).slice(0, 200), note, ...(left ? {} : { partial: true }) } }).catch(() => {});
  return { ok: true, note, item: item.text, ...(left ? {} : { partial: true }) };
}

// ---------------------------------------------------------------- the real store

const realStore: LaneStore = {
  items: async (userId, lane) => {
    const out: LaneItem[] = [];
    if (lane === "task" || lane === "lookout") {
      const { rows: tasks } = await pool.query(`SELECT id, goal, source, followup FROM co_tasks WHERE user_id = $1 AND status = 'open' AND kind = 'work'`, [userId]);
      for (const t of tasks) {
        // A new member's first look from before 2026-10-13 (paced as Co's own then): not theirs to move.
        if (t.followup?.lookoutFrom === "first_read") continue;
        if ((t.source === "lookout") !== (lane === "lookout")) continue;
        out.push({ lane, store: "task", id: String(t.id), text: String(t.goal), goalPiece: t.followup?.goalId != null });
      }
      const { rows: asks } = await pool.query(`SELECT ask_id, ask_text, intent FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL`, [userId]);
      for (const a of asks) if ((a.intent === "lookout") === (lane === "lookout")) out.push({ lane, store: "ask", id: String(a.ask_id), text: String(a.ask_text) });
    } else if (lane === "goal") {
      const [{ rows: prof }, { goalStates, goalHash }] = await Promise.all([pool.query(`SELECT intent, goals FROM co_profiles WHERE user_id = $1`, [userId]), import("./goalEdges.js")]);
      const states = await goalStates(userId).catch(() => new Map());
      const seen = new Set<string>();
      for (const e of Array.isArray(prof[0]?.intent) ? prof[0].intent : []) {
        if (e?.kind !== "goal" || e?.status !== "active" || typeof e?.text !== "string") continue;
        if ((states.get(goalHash(e.text))?.state ?? "active") !== "active") continue;
        seen.add(norm(e.text));
        out.push({ lane, store: "goal_entry", id: String(e.id), text: e.text });
      }
      for (const g of Array.isArray(prof[0]?.goals) ? prof[0].goals : []) {
        if (seen.has(norm(g)) || (states.get(goalHash(String(g)))?.state ?? "active") !== "active") continue;
        seen.add(norm(g));
        out.push({ lane, store: "goal_text", id: goalHash(String(g)), text: String(g) });
      }
    }
    return out;
  },
  addGoal: async (userId, text, from, theirYes) => {
    const { goalHash, goalStates, setGoalState } = await import("./goalEdges.js");
    const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
    const intent: any[] = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
    const prior = (await goalStates(userId).catch(() => new Map())).get(goalHash(text));
    // Moved back: the goal they had is current again, at their word.
    if (prior && prior.state !== "active" && !(await setGoalState(userId, text, "active", `moved back to goals at their word: "${theirYes.slice(0, 120)}"`, "member"))) return false;
    if (intent.some((e) => e?.kind === "goal" && e?.status === "active" && norm(e?.text) === norm(text))) return true;
    const now = new Date().toISOString();
    const entry = { id: crypto.randomUUID(), kind: "goal", text, type: "seeking", status: "active", concrete_preferences: [], wants: [], availability: null, embedding: null, created_at: now, confirmed_at: now, moved_from: from, moved_quote: theirYes.slice(0, 240) };
    await pool.query(
      `INSERT INTO co_profiles (user_id, intent, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET intent = COALESCE(co_profiles.intent, '[]'::jsonb) || EXCLUDED.intent, updated_at = NOW()`,
      [userId, JSON.stringify([entry])],
    );
    return true;
  },
  addLookout: async (userId, text, from, theirYes) => {
    const [{ askExpiresAtForUser }, { ASK_KIND_VERSION, outsideAsk }] = await Promise.all([import("./askExpiry.js"), import("./askKind.js")]);
    const { rows: open } = await pool.query(`SELECT 1 FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL AND intent = 'lookout' AND lower(trim(ask_text)) = lower(trim($2)) LIMIT 1`, [userId, text]);
    if (open.length) return true;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const expires = await askExpiresAtForUser(userId, text).catch(() => null);
    await pool.query(
      `INSERT INTO co_profiles (user_id, intent, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET intent = COALESCE(co_profiles.intent, '[]'::jsonb) || EXCLUDED.intent, updated_at = NOW()`,
      [userId, JSON.stringify([{ id, kind: "ask", text, type: "seeking", status: "active", concrete_preferences: [], wants: [], availability: null, embedding: null, created_at: now, moved_from: from }])],
    );
    await pool.query(
      `INSERT INTO ask_checkins (user_id, ask_id, ask_text, expires_at, kind, kind_checked_at, kind_version, intent, intent_why, last_mentioned_at)
       VALUES ($1, $2, $3, $4, $7, NOW(), $5, 'lookout', $6, NOW()) ON CONFLICT (user_id, ask_id) DO NOTHING`,
      [userId, id, text, expires, ASK_KIND_VERSION, `moved from ${LANE_WORDS[from]} at their word: "${theirYes.slice(0, 160)}"`, outsideAsk(text) ? "outside" : "find"],
    );
    return true;
  },
  leave: async (userId, item, to, theirYes) => {
    const why = `moved to ${LANE_WORDS[to]} at their word`;
    if (item.store === "task") return (await import("./coTasks.js")).closeTask(userId, Number(item.id), "dropped", why, { theirWord: theirYes });
    if (item.store === "ask") return (await import("./askKind.js")).closeAsk(userId, item.id, "moved", `${why}: "${theirYes.slice(0, 160)}"`);
    const { setGoalState } = await import("./goalEdges.js");
    if (item.store === "goal_entry") {
      const { rows } = await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId]);
      const intent: any[] = Array.isArray(rows[0]?.intent) ? rows[0].intent : [];
      const next = intent.map((e) => (e?.id === item.id ? { ...e, status: "moved", moved_to: to, moved_at: new Date().toISOString(), moved_quote: theirYes.slice(0, 240) } : e));
      await pool.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
    }
    // Off the goals list too (review, 2026-10-13: many readers use co_profiles.goals without goal_states); its history stays in goal_states.
    const { rows: prof } = await pool.query(`SELECT goals FROM co_profiles WHERE user_id = $1`, [userId]);
    const goals: string[] = Array.isArray(prof[0]?.goals) ? prof[0].goals : [];
    if (goals.some((g) => norm(g) === norm(item.text))) await pool.query(`UPDATE co_profiles SET goals = $2, updated_at = NOW() WHERE user_id = $1`, [userId, goals.filter((g) => norm(g) !== norm(item.text))]);
    // Out of the goal sweep, told already (source member), for both stores.
    return setGoalState(userId, item.text, "stale", `${why}: "${theirYes.slice(0, 120)}"`, "member");
  },
  log: async (d) => {
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({ layer: 3, decision: "lane.move", userId: d.userId, outcome: d.outcome, action: d.action, reason: d.reason, proposal: d.proposal });
  },
};
let testStore: LaneStore | null = null;
export function setLaneStoreForTests(s: LaneStore | null): void {
  testStore = s;
}
// The store a move uses: a test's, else the real one. Null in a dry run with no test store (nothing is read or written).
export function laneStoreFor(dryRun: boolean): LaneStore | null {
  return testStore ?? (dryRun ? null : realStore);
}
function currentStore(): LaneStore {
  return testStore ?? realStore;
}
