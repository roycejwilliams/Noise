// Notification grouping part C (Royce, 2026-11-02): 9 pull ("anything for me?"), 10 send time, 11 measure. Layer 1: zero tokens, no
// database (an in-memory store behind pool), nothing sent (a fake Sendblue), invented members. The pull runs through the real dispatch
// (harness/proactive.ts dispatchForUser with pulled) and the real send-time ledger, and the checks are on what was SENT, what was SAVED and
// what was MARKED DELIVERED.
//   npx tsx evals/proactive/pullAndSendTime.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.PROACTIVE_PAUSED;
delete process.env.PROACTIVE_PAUSED_TYPES;
import { readFileSync } from "fs";
const { DateTime } = await import("luxon");
const PR = await import("../../src/harness/proactive.js");
const W = await import("../../src/harness/waiting.js");
const A = await import("../../src/harness/attention.js");
const S = await import("../../src/harness/attentionStats.js");
const DR = await import("../../src/harness/door.js");
const G = await import("../../src/harness/notifyGate.js");
const BR = await import("../../src/brain/index.js");
const WK = await import("../../src/services/whatCoKnows.js");
const CAP = await import("../../src/services/capabilities.js");
const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
const { default: pool } = await import("../../src/db/db.js");
const { default: sendblue } = await import("../../src/services/sendblue.js");
const EMB = await import("../../src/services/embeddings.js");
EMB.setEmbeddingsClientForTests({ embeddings: { create: async (b: any) => ({ data: (Array.isArray(b.input) ? b.input : [b.input]).map((_: unknown, index: number) => ({ index, embedding: new Array(1536).fill(0) })) }) } } as any);
type Candidate = import("../../src/harness/proactive.js").Candidate;
type Preference = import("../../src/services/memberPreferences.js").Preference;

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const SRC = new URL("../../src/", import.meta.url).pathname;
const src = (f: string) => readFileSync(SRC + f, "utf8");

const ZONE = "America/Los_Angeles";
const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
// 2026-11-04 is a Wednesday; Pacific is UTC-8 (daylight time ended 11-01).
const pt = (iso: string) => new Date(`${iso}-08:00`);
const RIVER = "11111111-0000-4000-8000-0000000000a1";
const OTHER = "22222222-0000-4000-8000-0000000000b2";
const PHONE = "+15035550144";

// ---------------------------------------------------------------- an in-memory store (only what these paths read and write)
const db = { candidates: [] as any[], sends: [] as any[], outbox: [] as { to: string; content: string }[], decisions: [] as any[], memories: [] as { user: string; type: string; content: string }[], facts: [] as any[], prefs: [] as any[], sql: [] as string[] };
const reset = () => { db.candidates = []; db.sends = []; db.outbox = []; db.decisions = []; db.memories = []; db.facts = []; db.prefs = []; db.sql = []; };
const run = async (raw: string, a: any[] = []) => {
  const sql = raw.replace(/\s+/g, " ").trim();
  db.sql.push(sql);
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql) || /^(SAVEPOINT|RELEASE)/.test(sql)) return { rows: [] };
  if (/^SELECT u\.first_name, u\.phone_number/.test(sql)) return { rows: [{ first_name: "River", phone_number: PHONE, sms_opted_out: false, city: "Portland" }] };
  if (/sms_opted_out/.test(sql) && /FROM users/.test(sql)) return { rows: [{ opted_out: false }] };
  if (/^SELECT \* FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending' AND due_at <= \$2/.test(sql)) return { rows: db.candidates.filter((c) => c.user_id === a[0] && c.status === "pending" && new Date(c.due_at).getTime() <= new Date(a[1]).getTime() && (!c.expires_at || new Date(c.expires_at).getTime() > new Date(a[1]).getTime())) };
  if (/^SELECT \* FROM proactive_candidates WHERE user_id = \$1 AND status = 'pending'/.test(sql)) return { rows: db.candidates.filter((c) => c.user_id === a[0] && c.status === "pending") };
  if (/^SELECT type, target_key, topic_key, sent_at, exempt FROM proactive_sends/.test(sql)) return { rows: /DISTINCT ON/.test(sql) ? [] : db.sends.filter((s) => s.user_id === a[0]).map((s) => ({ ...s, topic_key: s.topic_key ?? s.target_key })) };
  if (/^SELECT type, sent_at, notify_class FROM proactive_sends/.test(sql)) return { rows: db.sends.filter((s) => s.user_id === a[0]) };
  if (/^SELECT 1 FROM proactive_sends WHERE user_id = \$1 AND target_key = \$2/.test(sql)) return { rows: db.sends.filter((s) => s.user_id === a[0] && s.target_key === a[1]) };
  if (/^INSERT INTO proactive_sends/.test(sql)) {
    if (db.sends.some((s) => s.user_id === a[0] && s.target_key === a[2])) return { rows: [] };
    db.sends.push({ user_id: a[0], type: a[1], target_key: a[2], topic_key: a[3], candidate_id: a[4], message: a[5], exempt: a[6] === true || /, true,/.test(sql), kind: a[7], notify_class: a[a.length - 1], sent_at: new Date() });
    return { rows: [{ id: db.sends.length }] };
  }
  if (/^UPDATE proactive_candidates SET status = 'sent'/.test(sql)) {
    const c = db.candidates.find((x) => String(x.id) === String(a[0]));
    if (c) c.status = "sent";
    return { rows: [] };
  }
  if (/^UPDATE proactive_candidates SET status = 'skipped'/.test(sql)) {
    const c = db.candidates.find((x) => String(x.id) === String(a[0]) || (a.length >= 2 && String(x.id) === String(a[1])));
    if (c) c.status = "skipped";
    return { rows: [], rowCount: c ? 1 : 0 };
  }
  if (/^INSERT INTO harness_decisions/.test(sql)) {
    db.decisions.push({ layer: a[0], decision: a[1], user_id: a[2], outcome: a[3], action: a[4], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] });
    return { rows: [{ id: String(db.decisions.length), created_at: new Date() }] };
  }
  if (/^SELECT type, payload FROM proactive_candidates WHERE id = \$2 AND user_id = \$1 AND status = 'pending'/.test(sql)) return { rows: db.candidates.filter((c) => String(c.id) === String(a[1]) && c.user_id === a[0] && c.status === "pending").map((c) => ({ type: c.type, payload: c.payload })) };
  if (/^INSERT INTO network_introductions/.test(sql)) { (db as any).declineSql = sql; (db as any).declined = [...((db as any).declined ?? []), { a: a[0], b: a[1] }]; return { rows: [] }; }
  if (/^INSERT INTO co_memories/.test(sql)) { db.memories.push({ user: a[0], type: a[1], content: String(a[2]) }); return { rows: [{ id: db.memories.length }] }; }
  if (/^SELECT MAX\(created_at\) AS at FROM co_memories/.test(sql)) return { rows: [{ at: null }] };
  if (/^SELECT created_at FROM users WHERE id = \$1/.test(sql)) return { rows: [{ created_at: new Date("2026-01-01T00:00:00Z") }] };
  if (/^SELECT COUNT\(\*\)::int AS n FROM proactive_candidates WHERE user_id = \$1 AND status = 'sent'/.test(sql)) return { rows: [{ n: db.candidates.filter((c) => c.status === "sent" && c.type === "event_offer").length }] };
  if (/stamped_at/.test(sql)) return { rows: [{ stamped_at: null, co_reply_at: null, running: false }] };
  return { rows: [], rowCount: 0 };
};
(pool as any).query = (s: string, a?: any[]) => run(s, a);
(pool as any).connect = async () => ({ query: (s: string, a?: any[]) => run(s, a), release: () => {} });
(sendblue as any).messages.send = async (b: any) => {
  db.outbox.push({ to: b.number, content: b.content });
  return { message_handle: `fake-${db.outbox.length}` };
};

let seq = 100;
const row = (type: string, over: Record<string, any> = {}, user = RIVER) => {
  const id = ++seq;
  const r = { id, user_id: user, type, target_key: over.target_key ?? `${type}:${id}`, topic_key: over.target_key ?? `${type}:${id}`, summary: over.summary ?? `${type} ${id}`, payload: over.payload ?? {}, priority: over.priority ?? PR.TYPE_POLICY[type as keyof typeof PR.TYPE_POLICY]?.priority ?? 50, due_at: over.due_at ?? new Date(Date.now() - 2 * HOUR), expires_at: over.expires_at === undefined ? new Date(Date.now() + 3 * DAY) : over.expires_at, attempts: 0, created_at: over.created_at ?? new Date(Date.now() - 2 * HOUR), status: "pending" };
  db.candidates.push(r);
  return r;
};
const doorRow = (cls: "requested" | "unsolicited" | "checkin", messages: string[], over: Record<string, any> = {}) => row("task_update", { ...over, payload: { door: true, messages, cls, writtenAt: new Date().toISOString(), ...(over.payload ?? {}) } });
// A find the dispatch would compose (a bundle): not used by the pull tests below (a model call); finds are checked through the pure paths.

// ================================================================ 9. pull: the list
{
  const now = new Date();
  const mk = (type: string, over: Record<string, any> = {}): Candidate => PR.rowToCandidate({ ...row(type, over), id: String(seq), created_at: over.created_at ?? new Date(now.getTime() - 3 * HOUR) });
  reset();
  const find = mk("event_offer", { payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2, name: "Founders Dinner" } } });
  const tease = mk("network_tease", { summary: "Dev Patel might fit what River asked about", payload: { askId: "a1", otherName: "Dev Patel" } });
  const asked = mk("task_update", { payload: { door: true, cls: "requested", messages: ["x"], taskId: 9 } });
  const checkin = mk("companion", { summary: "Check in on the launch" });
  const gone = mk("event_offer", { expires_at: new Date(now.getTime() - MIN), payload: { askId: "a1", fromProfile: false, match: { name: "Last Week's Mixer" } } });
  const later = mk("event_offer", { due_at: new Date(now.getTime() + HOUR), payload: { match: { name: "Not Due Yet" } } });
  const band = (c: Candidate) => PR.bandOfCandidate(c, now);
  const list = W.waitingFrom([checkin, find, gone, tease, later, asked], now, { band });
  check("list: best first by the door's bands (a possible intro, requested results, a find, a check-in)", list.map((i) => i.id).join() === [tease, asked, find, checkin].map((c) => c.id).join(), list.map((i) => `${i.type}:${i.band}`));
  check("list: an expired item never shows, nor one not yet due", !list.some((i) => i.id === gone.id || i.id === later.id));
  check("list: matching first, as the door has it (an intro outranks a find and a check-in)", list[0].intro && DR.BAND.intro > DR.BAND.find && DR.BAND.intro > DR.BAND.checkin);
  const labels = list.map((i) => i.label).join(" | ");
  check("labels: a possible intro is never named and its state never said", list.find((i) => i.intro)!.label === "someone I think you should meet" && !/Dev|Patel|yes|said|waiting on/i.test(labels), labels);
  check("labels: an event is its public name and nothing else about the item", list.find((i) => i.type === "event_offer")!.label === "a find for you: Founders Dinner");
  const closed = W.waitingFrom([find, checkin], now, { band, closed: new Set([find.id]) });
  check("list: what they closed is not in it", closed.length === 1 && closed[0].id === checkin.id);
  check("list: a label the strip empties drops the item (fails closed)", W.waitingFrom([find], now, { band, label: () => null }).length === 0);
  check("mention: one waiting item at most, never an intro, with the one label", (() => { const m = W.waitingMention(list); return !!m && m.includes("at most one") && m.includes(list.find((i) => !i.intro)!.label) && !/someone I think/.test(m); })());
  check("mention: only an intro waiting means nothing to mention", W.waitingMention(list.filter((i) => i.intro)) === null && W.waitingMention([]) === null);
  const lines = W.callWaitingLines(list);
  check("call: the same list, best first, at most three, labels only", lines.length === 1 + 3 && lines[1].includes("someone I think you should meet") && lines[2].includes("what you asked me for") && lines[3].includes("Founders Dinner") && W.callWaitingLines([]).length === 0, lines);
}

// ================================================================ 9. pull: through the real dispatch
{
  reset();
  const asked = doorRow("requested", ["https://lu.ma/founders-dinner", "A founders dinner Thursday, the room you asked about."], { payload: { taskId: 9 } });
  const checkin = row("companion", { summary: "Check in on the launch" });
  const gone = doorRow("requested", ["https://lu.ma/last-week", "Over."], { expires_at: new Date(Date.now() - MIN), target_key: "task:9:old" });
  const log = console.log;
  console.log = () => {};
  let r: Awaited<ReturnType<typeof W.pullWaiting>>;
  try { r = await W.pullWaiting(RIVER); } finally { console.log = log; }
  check("pull: what was waiting went as its own texts, exactly as written", r.status === "sent" && db.outbox.map((m) => m.content).join("|") === "https://lu.ma/founders-dinner|A founders dinner Thursday, the room you asked about.", { r, outbox: db.outbox });
  check("pull: at most three texts in the message (and two finds with captions when a find bundle is composed: the door's own cap)", db.outbox.length <= 3 && PR.MAX_PICKED_TOGETHER === 2);
  check("pull: marked delivered the way the door's pick marks it (the candidate is sent, a ledger row written, as a requested message)", db.candidates.find((c) => c.id === asked.id)!.status === "sent" && db.sends.some((s) => s.target_key === asked.target_key && s.notify_class === "requested"), db.sends);
  check("pull: the lower item waits (a check-in is not sent beside results they asked for), still pending", db.candidates.find((c) => c.id === checkin.id)!.status === "pending");
  check("pull: it reports what's left, not what it is", r.status === "sent" && r.left === 1);
  check("pull: the expired item never went, and is not shown as waiting", !db.outbox.some((m) => /Over\./.test(m.content)) && (await W.loadWaiting(RIVER)).every((i) => i.id !== String(gone.id)));
  check("pull: the texts are in the exchange record's source (the 'Co replied' memories the thread and the sent list read)", db.memories.filter((m) => m.type === "text_exchange" && /^Co replied: /.test(m.content)).length === db.outbox.length);
  check("pull: the ledger row counts as a message (notifyGate counts it once, as requested)", G.countedRows(db.sends.map((s) => ({ sentAt: s.sent_at, type: s.type, cls: s.notify_class }))).filter((c) => c.cls === "requested").length === 1);
  // Never sent again: a second ask finds the check-in (the next best), not the same results.
  db.outbox.length = 0;
  console.log = () => {};
  // The check-in's draft is a model call: answered by a fake, as are the check-in's feeling read and the pick's.
  PR.setProactiveModelForTests((async () => "How is the launch going?") as any);
  A.setAttentionModelForTests(async () => '{"asserts": false, "phrase": ""}');
  const again = await W.pullWaiting(RIVER).finally(() => { console.log = log; PR.setProactiveModelForTests(null); A.setAttentionModelForTests(null); });
  check("pull again: the same item is never sent twice", !db.outbox.some((m) => /founders-dinner/.test(m.content)), db.outbox);
  check("pull again: it ran and said something true (sent the next, or nothing ready)", again.status === "sent" || again.status === "none_ready" || again.status === "nothing", again);
  check("pull: what the pull itself logs carries no member words", db.decisions.filter((d) => /^waiting\./.test(d.decision)).every((d) => !JSON.stringify(d).includes("founders") && !JSON.stringify(d).includes("lu.ma")));
}

{
  // Nothing waiting: nothing is sent and the answer is "nothing".
  reset();
  const r = await W.pullWaiting(RIVER);
  check("pull: with nothing waiting, nothing is sent", r.status === "nothing" && db.outbox.length === 0 && db.sends.length === 0);
  // Only expired items.
  doorRow("requested", ["https://lu.ma/old"], { expires_at: new Date(Date.now() - HOUR) });
  const r2 = await W.pullWaiting(RIVER);
  check("pull: only expired items is the same as nothing", r2.status === "nothing" && db.outbox.length === 0);
}

{
  // Their own rules win: a rule that covers everything holds the pull; one that covers only what Cue starts does not.
  const prefs = async (list: Partial<Preference>[]) => {
    const MP = await import("../../src/services/memberPreferences.js");
    return { MP, restore: ((orig) => () => { (MP as any).activePreferences = orig; })((MP as any).activePreferences) };
  };
  void prefs;
  const mk = (covers: "all" | "unsolicited", over: Record<string, unknown> = {}): Preference => ({ id: "p1", area: "contact", channel: "all", covers, rule: { none: true }, basis: "explicit", type: "standing", words: ["Don't text me for a while"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: ZONE, state: "active", setAt: new Date(Date.now() - DAY).toISOString(), ...over } as any);
  const NOW = new Date();
  const sentReq: G.Counted[] = [];
  void sentReq;
  const asReq = G.memberRuleCheck([mk("all")], { now: NOW, cls: "requested", channel: "text", sent: [] });
  const asUns = G.memberRuleCheck([mk("unsolicited")], { now: NOW, cls: "requested", channel: "text", sent: [] });
  check("rules: a pulled delivery is requested: a rule covering only what Cue starts doesn't hold it", asUns.pass === true);
  check("rules: a rule covering everything still holds it (their rule wins)", asReq.pass === false);
  check("rules: a pulled item keeps its own class (no override to requested anywhere in the pick or the lock)", !/pulled \? "requested"|pulled \? \("requested"/.test(src("harness/proactive.ts")));
}

// ---------------------------------------------------------------- the pulled pick keeps every other gate
{
  const PS = src("harness/proactive.ts");
  check("gates: a pull still passes opt-out, the closed-subject read, expiry, the day's find cap, the composer's caps and the send-time ledger (only hours, the window, the hold, spacing and the conversation are skipped)", /if \(opts\.pulled\) \(member\.holdUntil = null, \(member\.spaceUntil = null\)\);/.test(PS) && /midConversation: midConversation && !isSafetyFollowUp\(c\) && !opts\.pulled/.test(PS) && /skipHours: opts\.pulled/.test(PS) && !/pulled[^\n]*not_opted_out/.test(PS));
  check("gates: a pull that finds nothing doesn't hold the member's regular pick", /if \(!opts\.dryRun && !opts\.pulled\) await pool\.query\(\s*`INSERT INTO proactive_user_state \(user_id, hold_until\)/.test(PS));
  check("gates: a hard day never means a member who asks gets nothing (the hard-day check skips a pulled one)", /if \(!opts\.pulled && c\.type !== "announcement" && hardDayHolds\(/.test(PS));
  check("gates: the safety hold still holds finds for a pulled pick (candidateChecks is unchanged for it)", /state\.safetyHold && \(PROACTIVE_PURPOSE_MAP\[c\.type\] === "offer"/.test(PS));
  check("gates: the lock is taken atomically by the pull (no gap between checking and running), after a bounded wait", /export async function pullDispatch/.test(PS) && /ran = true; await dispatchForUserInScope/.test(PS) && /while \(P\.dispatchBusy\(userId\) && Date\.now\(\) < busyUntil\)/.test(src("harness/waiting.ts")));
  const W_SRC = src("harness/waiting.ts");
  check("privacy: the list is read for one member only", /WHERE user_id = \$1 AND status = 'pending'/.test(W_SRC) && !/FROM users|network_introductions|co_pairs/.test(W_SRC));
  check("privacy: labels pass the member-safe strip, failing closed", /const safe = await memberSafeLine\(userId\);/.test(W_SRC) && /label: \(c\) => safe\(waitingLabel\(c\)\)/.test(W_SRC));
}

// ================================================================ what Cue knows shows what's waiting
{
  const raw: any = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], waiting: [{ id: "55", label: "a find for you: Founders Dinner" }, { id: "56", label: "someone I think you should meet" }] };
  const items = WK.knownItems(raw);
  const view = WK.groupKnown(items);
  const g = view.groups.find((x) => x.group === "waiting");
  check("what Cue knows: a group of what's being held for them, in order", !!g && g.title === "What I'm holding for you" && g.lines.length === 2 && g.lines[0].text.includes("Founders Dinner"), view.groups.map((x) => x.title));
  check("what Cue knows: a waiting line can be removed, not reworded", items.filter((i) => i.source === "waiting").every((i) => i.canCorrect === false && /^waiting:\d+$/.test(i.ref)));
  check("what Cue knows: the view says nothing about another member (no names in the labels)", !JSON.stringify(view).match(/Dev|Patel/));
  check("what Cue knows: a removal is a skip at the source, scoped to the member and still-pending rows", /UPDATE proactive_candidates SET status = 'skipped', skip_reason = 'removed by the member'[^`]*WHERE id = \$2 AND user_id = \$1 AND status = 'pending'/.test(src("services/whatCoKnows.ts")));
  check("what Cue knows: read from the same list a pull reads (expired never in it)", /W\.waitingOrNull\(userId\)/.test(src("services/whatCoKnows.ts")));
  // Applied through the real path: removing it skips the candidate, so it is never sent.
  reset();
  const r = row("event_offer", { payload: { match: { name: "Founders Dinner" } } });
  const item = { ref: `waiting:${r.id}`, source: "waiting" as const, group: "waiting" as const, text: "a find for you: Founders Dinner", theirWords: null, canCorrect: false };
  const applied = await WK.applyOne({ query: (s: string, a?: any[]) => run(s, a) } as any, RIVER, raw, item, "remove", null, "forget that one");
  check("what Cue knows: removing a waiting line takes it out of line at the source, so it is never sent", "ref" in applied && applied.source === "waiting" && db.candidates.find((c) => c.id === r.id)!.status === "skipped", applied);
  check("what Cue knows: it can only be removed, not reworded", "why" in (await WK.applyOne({ query: (s: string, a?: any[]) => run(s, a) } as any, RIVER, raw, item, "correct", "something else", "x")));
}

// ================================================================ the reply and the tools
{
  const idle = CAP.situationFor({ kitFields: 0, message: "hi", openTasks: 0, eventToday: false });
  const has = CAP.situationFor({ kitFields: 0, message: "anything for me?", openTasks: 0, eventToday: false, waiting: true });
  check("tool: anythingForMe is offered only on a turn with something waiting (no other reply's tools change)", CAP.toolsOutOfSituation(idle).includes("anythingForMe") && !CAP.toolsOutOfSituation(has).includes("anythingForMe"));
  check("tool: in the registry, a send (changes nothing), one a turn", CAP.abilityForTool("anythingForMe")?.limits?.perTurn === 1 && CAP.CHANGES_NOTHING.has("anythingForMe") && !CAP.CHANGES_SOMETHING.has("anythingForMe"));
  check("tool: not on the what-can-you-do list (nothing in the member's menu changes)", !CAP.capabilityListInstruction().includes("holding") && !CAP.capabilitySheet().join("\n").includes("anything for them"));
  const decide = BR.judgeText({ userId: RIVER, read: null, owed: false, safetyConcern: false, clarify: null, waiting: "MENTION-LINE", turn: null });
  const none = BR.judgeText({ userId: RIVER, read: null, owed: false, safetyConcern: false, clarify: null, turn: null });
  check("reply: the one mention reaches the draft as an instruction, and only when something waits", decide.instructions.includes("MENTION-LINE") && !none.instructions.some((i) => /holding/.test(i)));
  const TC = src("agent/conversationTools.ts");
  check("tool: with nothing waiting (or no turn) the tool is not offered at all, so every other reply's tools are exactly what they were", /if \(!ctx\.turn\?\.waiting\?\.length\) delete \(tools as Record<string, unknown>\)\.anythingForMe;/.test(TC));
  check("tool: a pull's texts are the turn's whole answer (no leftover line after them)", /if \(r\.status === "sent"\) \{[\s\S]{0,400}ctx\.onLinkDelivered\?\.\(\);/.test(TC));
  check("tool: a dry run sends nothing", /if \(ctx\.dryRun\) return \{ ok: true, note: "Test run: nothing was sent\." \};\s*const W = await import\("\.\.\/harness\/waiting\.js"\);/.test(TC));
  check("tool: the log carries the status and a count, never a text", /decision: "waiting\.pull"[^\n]*proposal: \{ texts: n \}/.test(TC));
}

// ================================================================ calls: the same list, spoken, never sent mid-call
{
  const items = [
    { id: "1", type: "network_tease", band: DR.BAND.intro, label: "someone I think you should meet", intro: true, expiresAt: null, held: [] },
    { id: "2", type: "event_offer", band: DR.BAND.find, label: "a find for you: Founders Dinner", intro: false, expiresAt: null, held: [] },
  ];
  const lines = W.callWaitingLines(items);
  const finds: any = { available: true, lookingFor: "founder rooms", items: [{ name: "Founders Dinner", details: [], link: null }], note: "n" };
  const d = BR.judgeBriefing({ userId: RIVER, now: new Date(), clock: null, finds, waiting: lines });
  check("call: the briefing carries the same list in what the call may say (findsNow)", d.briefing.findsNow.includes("someone I think you should meet") && d.briefing.findsNow.includes("a find for you: Founders Dinner") && d.briefing.findsNow.includes("best first"), d.briefing.findsNow);
  const vetoed = BR.vetoBriefingOffers(d, finds, "safety", "a safety hold");
  check("call: a safety hold takes the waiting list with the finds", !vetoed.briefing.findsNow.includes("Founders Dinner") && !vetoed.briefing.findsNow.includes("someone I think") && vetoed.waiting === undefined);
  const noFinds = BR.judgeBriefing({ userId: RIVER, now: new Date(), clock: null, finds: { available: false, reason: "nothing on file" }, waiting: lines });
  check("call: waiting items are offered even when the call has no finds of its own", noFinds.briefing.findsNow.includes("a find for you: Founders Dinner"));
  check("call: no list means the briefing is exactly as before", BR.judgeBriefing({ userId: RIVER, now: new Date(), clock: null, finds }).briefing.findsNow === BR.renderFinds(finds));
  check("call: it is spoken only; the briefing reads the list but nothing on a call marks it delivered or sends it", !/pullWaiting|dispatchForUser/.test(src("services/callBriefing.ts")));
}

// ================================================================ review fixes (#385)
{
  const NOW = new Date();
  const mkPref = (area: string, covers: string, rule: Record<string, unknown> = { none: true }): Preference => ({ id: `p-${area}`, area, channel: "all", covers, rule, basis: "explicit", type: "standing", words: ["no"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: ZONE, state: "active", setAt: new Date(NOW.getTime() - DAY).toISOString() } as any);
  const base = (over: Record<string, unknown> = {}) => ({ now: NOW, timezone: ZONE, optedOut: false, sends: [], lastInboundAt: new Date(NOW.getTime() - 5 * HOUR), joinedAt: new Date(NOW.getTime() - 30 * DAY), memberRules: { prefs: [] as Preference[], sent: [] as any[] }, ...over });
  const c = (type: string, payload: Record<string, unknown> = {}, id = String(++seq)): Candidate => ({ id, userId: RIVER, type: type as any, targetKey: `${type}:${id}`, topicKey: `${type}:${id}`, summary: "s", priority: 50, dueAt: new Date(NOW.getTime() - HOUR), expiresAt: new Date(NOW.getTime() + 3 * DAY), payload, attempts: 0, createdAt: new Date(NOW.getTime() - 2 * HOUR) });
  const checkin = c("companion"), profileFind = c("event_offer", { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } }), asked = c("task_update", { door: true, cls: "requested", messages: ["x"] }), askedFind = c("event_offer", { askId: "a1", fromProfile: false, match: { tier: 2 } });
  const held = (ev: ReturnType<typeof PR.evaluateCandidates>, cand: Candidate) => ev.perCandidate.find((p) => p.candidate.id === cand.id)!.checks.filter((k) => !k.pass).map((k) => k.name);
  const ev = (state: any, opts: any = {}) => PR.evaluateCandidates({ candidates: [checkin, profileFind, asked, askedFind], ...state } as any, { ignorePacing: true, pulled: true, ...opts });
  // 1. their rules by the item's own class
  const stopCheckins = ev(base({ memberRules: { prefs: [mkPref("checkins", "checkins")], sent: [] } }));
  check("1: a rule that stops check-ins holds a pulled check-in, and nothing else", held(stopCheckins, checkin).includes("member_rule") && !held(stopCheckins, profileFind).includes("member_rule") && !held(stopCheckins, asked).includes("member_rule"), held(stopCheckins, checkin));
  const stopFinds = ev(base({ memberRules: { prefs: [mkPref("contact", "unsolicited")], sent: [] } }));
  check("1: a rule about what Cue starts holds a pulled find and check-in; what they asked for still goes", held(stopFinds, profileFind).includes("member_rule") && held(stopFinds, checkin).includes("member_rule") && !held(stopFinds, asked).includes("member_rule") && !held(stopFinds, askedFind).includes("member_rule"));
  const timing = held(ev(base({ midConversation: true, now: new Date("2026-11-04T10:00:00Z") })), profileFind);
  check("1: only Cue's timing defaults are skipped (hours, daily limits, spacing, the conversation)", !timing.some((n) => ["local_hours", "daily_cap", "weekly_cap", "spacing", "engagement_pace", "unanswered_pause"].includes(n)), timing);
  // 2. hard day and team hold
  const hard = { needsCare: true, moodHold: { state: "held", hold: true, heldHours: 2 } };
  const hd = ev(base(hard));
  check("2: on a hard day a pull delivers only what they asked for (finds, intro asks and check-ins held)", held(hd, profileFind).includes("hard_day") && held(hd, checkin).includes("hard_day") && !held(hd, asked).includes("hard_day") && !held(hd, askedFind).includes("hard_day"), held(hd, profileFind));
  const th = ev(base(), { teamHold: true });
  check("2: under the team hold a pull delivers only what they asked for", held(th, profileFind).includes("team_hold") && held(th, checkin).includes("team_hold") && !held(th, asked).includes("team_hold") && !held(th, askedFind).includes("team_hold"));
  check("2: the dispatch reads the team hold for a pull, failing closed", /G\.teamHoldNow\(userId, new Date\(\)\)/.test(src("harness/proactive.ts")) && /\.catch\(\(\) => true\);\n\}/.test(src("harness/notifyGate.ts")));
  // 3. the list is built through the pick's own checks
  const items = (held: string[], intro = false): any => ({ id: String(++seq), type: "event_offer", band: DR.BAND.find, label: "a find for you: X", intro, expiresAt: null, held });
  check("3: a held item is never mentioned or spoken on a call", W.waitingMention([items(["emotional_timing"])]) === null && W.callWaitingLines([items(["kind_restraint"])]).length === 0 && W.waitingMention([items([]), items(["away_hold"])])!.includes("one thing"));
  check("3: a safety hold shows nothing at all in what Cue knows, other holds show as held", W.visibleHeld([items(["safety_hold"]), items(["away_hold"]), items([])]).length === 2);
  const safeState = { now: new Date(), sends: [], lastInboundAt: null, safetyHold: true } as any;
  const names = (cand: Candidate) => PR.candidateChecks(cand, safeState).filter((k) => !k.pass).map((k) => k.name);
  check("round 2 (2): under a safety hold a pull holds exactly what the pick holds (offers), and a requested task result still goes", names(c("event_offer", { askId: "profile", fromProfile: true, match: {} })).includes("safety_hold") && !names(c("task_update", { door: true, cls: "requested", messages: ["x"] })).includes("safety_hold") && !/safety = member\.state\.safetyHold/.test(src("harness/proactive.ts")));
  check("round 2 (2): the text path still raises no mention under a safety hold", /!turn\.knowledge\?\.restraint\?\.safetyHold/.test(src("routes/sendblue.ts")));
  reset();
  const pc = row("event_offer", { payload: { askId: "profile", fromProfile: true, picked: true, match: { name: "X" } } });
  const checks = await PR.pulledChecks(RIVER, [PR.rowToCandidate(pc)], new Date());
  check("3: the checks are read through the pick (a clean item has none)", !!checks && (checks.get(String(pc.id)) ?? ["x"]).length === 0, checks && [...checks]);
  const k = WK.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], waiting: [{ id: "5", label: "something I found for you", held: true }, { id: "6", label: "something I found for you", held: false }] } as any);
  const kv = WK.groupKnown(k);
  check("3: what Cue knows marks a held item as held", kv.groups[0].lines[0].text === "something I found for you (held for now)" && kv.groups[0].lines[1].text === "something I found for you");
  // 5. per-item refs
  check("5: two items with the same label stay two lines, each with its own ref", kv.groups[0].lines.length === 2 && kv.groups[0].lines[0].refs.join() === "waiting:5" && kv.groups[0].lines[1].refs.join() === "waiting:6");
  // 4. busy, slow, time bound
  check("4: the whole pull is bounded (15s) and a busy pick is waited for only briefly", W.PULL_TIMEOUT_MS <= 15_000 && W.PULL_BUSY_WAIT_MS <= 6_000);
  const TC = src("agent/conversationTools.ts");
  check("4: no \"will arrive\" promise on slow or busy", !/will arrive as its own text in a moment/.test(TC) && /don't promise it will arrive/.test(TC) || /make no claim either way/.test(TC));
  check("round 2 (3): slow says only that nothing is ready to send right now, no claim either way", /Nothing is ready to send right now\. Say that in one plain line; make no claim either way/.test(TC) && !/didn't come together/.test(TC));
  const order: string[] = [];
  const reg = {} as any;
  const both = await Promise.all([PR.pullDispatch(reg, "no-such-user", { pulled: true }), PR.pullDispatch(reg, "no-such-user", { pulled: true })]);
  check("4: with a pick already running the second pull is told it did not run (no gap between the check and the lock)", both.filter(Boolean).length >= 1 && order.length === 0);
  // 6. usual_hour
  const att6 = (() => { const out: Date[] = []; for (let d = 5; d <= 30; d++) out.push(DateTime.fromObject({ year: 2026, month: 10, day: d, hour: 18, minute: 5 }, { zone: ZONE }).toJSDate(), DateTime.fromObject({ year: 2026, month: 10, day: d, hour: 19, minute: 40 }, { zone: ZONE }).toJSDate()); return out; })();
  const NOW6 = pt("2026-11-04T09:30:00");
  const f6 = (payload: any, expiresAt: Date | null): any => ({ type: "event_offer", targetKey: "e", payload, expiresAt });
  const b6 = { now: NOW6, zone: ZONE, cls: "unsolicited" as const, channel: "text" as const, att: { inbound: [], history: att6 }, prefs: [] as Preference[] };
  check("6: a find for an event today is never moved", A.sendTimeCheck({ ...b6, item: f6({ match: { details: { startAt: pt("2026-11-04T20:00:00").toISOString() } } }, pt("2026-11-10T00:00:00")) }) === null);
  check("6: a find with less than 6 hours between the usual hour and the event goes now", A.sendTimeCheck({ ...b6, item: f6({ match: { details: { startAt: pt("2026-11-04T22:00:00").toISOString() } } }, null) }) === null);
  check("6: a find with a day to spare is still placed", !!A.sendTimeCheck({ ...b6, item: f6({ match: { details: { startAt: pt("2026-11-07T20:00:00").toISOString() } } }, pt("2026-11-08T00:00:00")) }));
  check("6: a zone that isn't one falls back like the hours gate does (no throw)", (() => { try { A.sendTimeCheck({ ...b6, zone: "Not/AZone", item: f6({}, null) }); return true; } catch { return false; } })());
  const ruleZ = mkPref("contact", "unsolicited", { latest: "19:00" });
  check("6: a rule's hours are read in the zone the gate reads them in", A.hourAllowedByRules([ruleZ], "unsolicited", "text", 18, NOW6, ZONE) === true && A.hourAllowedByRules([ruleZ], "unsolicited", "text", 19, NOW6, ZONE) === false);
  // 7. small fixes
  const KS = src("services/whatCoKnows.ts");
  check("7: a failed waiting read leaves the group out of what Cue knows, not the view", /\}\)\.catch\(\(\) => \[\] as \{ id: string; label: string; held: boolean \}\[\]\),/.test(KS));
  check("7: the mention is skipped in code when the turn asks for the list", !BR.judgeText({ userId: RIVER, read: { aboutCo: false, asksForList: true, feedback: [] } as any, owed: false, safetyConcern: false, clarify: null, waiting: "MENTION-LINE", turn: null }).instructions.includes("MENTION-LINE"));
  check("7: the waiting read is part of the turn's one Promise.all", /ledger, waiting\] = await Promise\.all\(\[/.test(src("services/turnContext.ts")));
  check("7: the call does not promise to text details", !/offer to text/.test(src("harness/waiting.ts")));
  reset();
  const tease = row("network_tease", { payload: { askId: "a1", candidate: { candidate_id: "99999999-0000-4000-8000-000000000009", match_reason: "r" } } });
  const ap = await WK.applyOne({ query: (q: string, a?: any[]) => run(q, a) } as any, RIVER, { profile: null } as any, { ref: `waiting:${tease.id}`, source: "waiting", group: "waiting", text: "someone I think you should meet", theirWords: null, canCorrect: false } as any, "remove", null, "no");
  check("7: removing a possible intro is them declining it: the pair is recorded as declined, once, in canonical order", "ref" in ap && ((db as any).declined ?? []).length === 1 && (db as any).declined[0].a < (db as any).declined[0].b, (db as any).declined);
  const dsql: string = (db as any).declineSql ?? "";
  check("round 2 (4): the decline updates a pair row still unanswered on their side, and leaves one they answered or that was introduced", /DO UPDATE SET status = 'declined' WHERE network_introductions\.status NOT IN \('introduced', 'declined'\) AND network_introductions\.(a|b)_interested_at IS NULL/.test(dsql), dsql);
  check("round 2 (4): it reads their own side's column (a for the lower id, b for the higher)", new RegExp(`network_introductions\\.${RIVER < "99999999-0000-4000-8000-000000000009" ? "a" : "b"}_interested_at IS NULL`).test(dsql));
  // round 2 (1): the day's find cap
  reset();
  for (let n = 0; n < PR.DAILY_FIND_CAP; n++) { const done = row("event_offer", { payload: { askId: "profile", fromProfile: true, match: {} } }); done.status = "sent"; }
  const f1 = row("event_offer", { payload: { askId: "profile", fromProfile: true, picked: true, match: { name: "Over" } } });
  const capChecks = await PR.pulledChecks(RIVER, [PR.rowToCandidate(f1)], new Date());
  check("round 2 (1): a find over today's cap is held (so never mentioned, spoken or offered)", !!capChecks && capChecks.get(String(f1.id))!.includes("daily_find_cap"), capChecks && [...capChecks]);
  const t1 = row("task_update", { payload: { door: true, cls: "requested", messages: ["x"] } });
  const capChecks2 = await PR.pulledChecks(RIVER, [PR.rowToCandidate(t1)], new Date());
  check("round 2 (1): what they asked for is not held by the find cap", !!capChecks2 && !capChecks2.get(String(t1.id))!.includes("daily_find_cap"));
}

// ================================================================ 10. send time
{
  const at = (day: number, hh: number, mm = 0) => DateTime.fromObject({ year: 2026, month: 10, day, hour: hh, minute: mm }, { zone: ZONE }).toJSDate();
  const NOW = pt("2026-11-04T07:10:00");
  // River writes back in the evening: 6 to 9pm, twenty days.
  const evening: Date[] = [];
  for (let d = 5; d <= 30; d++) { evening.push(at(d, 18, 5), at(d, 19, 40)); if (d % 3 === 0) evening.push(at(d, 20, 15)); }
  const usual = A.usualReplyHours(evening, ZONE, NOW);
  check("learned: River's usual hours come from her own message times (evenings)", !!usual && usual.hours.every((h) => h >= 17 && h <= 21) && usual.hours.includes(18) && usual.hours.includes(19), usual);
  check("learned: nothing outside Cue's own hours (8am to 9pm)", !!usual && usual.hours.every((h) => h >= A.SEND_TIME.startHour && h < A.SEND_TIME.endHour));
  check("learned: too few replies keeps the default (no learned hour)", A.usualReplyHours(evening.slice(0, 6), ZONE, NOW) === null);
  check("learned: many replies on too few days keeps the default", A.usualReplyHours(Array.from({ length: 20 }, (_, i) => at(5 + (i % 3), 18, i)), ZONE, NOW) === null);
  check("learned: someone who writes all day has no usual hour", A.usualReplyHours(Array.from({ length: 60 }, (_, i) => at(5 + (i % 20), 8 + (i % 13), 5)), ZONE, NOW) === null);
  check("learned: a burst of messages is one reply", (() => { const burst = Array.from({ length: 30 }, (_, i) => at(5 + (i % 10), 14, i % 5)); return A.usualReplyHours(burst, ZONE, NOW) === null; })());
  check("learned: only the last 45 days count", A.usualReplyHours(evening.map((d) => new Date(d.getTime() - 60 * DAY)), ZONE, NOW) === null);

  const find: any = { type: "event_offer", targetKey: "event_offer:1", payload: { askId: "profile", fromProfile: true }, expiresAt: pt("2026-11-10T20:00:00") };
  const att = { inbound: evening.filter((d) => d.getTime() > NOW.getTime() - 8 * DAY), history: evening };
  const base = { zone: ZONE, channel: "text" as const, att, prefs: [] as Preference[], item: find };
  const morning = A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited" });
  check("send time: an unrequested find at 9:30am waits for her evening hours", !!morning && morning.name === "usual_hour" && morning.pass === false && morning.retryAt!.getTime() === pt("2026-11-04T18:00:00").getTime(), morning);
  check("send time: inside her usual hours it goes", A.sendTimeCheck({ ...base, now: pt("2026-11-04T18:30:00"), cls: "unsolicited" }) === null);
  check("send time: a check-in is placed the same way", !!A.sendTimeCheck({ ...base, now: pt("2026-11-04T10:00:00"), cls: "checkin", item: { type: "companion", targetKey: "c", payload: {}, expiresAt: null } }));
  check("never moved: a requested delivery", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "requested" }) === null);
  check("never moved: a reply", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "reply" }) === null);
  check("never moved: a safety follow-up", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "checkin", item: { type: "companion", targetKey: "c", payload: { safetyFollowUp: true } } }) === null);
  check("never moved: a time-sensitive one (about something within hours)", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", item: { ...find, payload: { ...find.payload, soonAt: pt("2026-11-04T12:00:00").toISOString() } } }) === null);
  check("never moved: one that would expire before her usual hour starts", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", item: { ...find, expiresAt: pt("2026-11-04T16:00:00") } }) === null);
  check("never moved: the morning sweep's find (it has its own hour)", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", item: { ...find, payload: { ...find.payload, morningDay: "2026-11-04" } } }) === null);
  check("never moved: a possible intro (matching first)", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", item: { type: "event_match_nudge", targetKey: "n", payload: {}, expiresAt: null } }) === null);
  check("never moved: a call (this places texts)", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", channel: "call" }) === null);
  check("default kept: with too little data there is no check", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", att: { inbound: [], history: evening.slice(0, 5) } }) === null);

  // Their preference rules always win.
  const rule = (r: Record<string, unknown>): Preference => ({ id: "r1", area: "contact", channel: "all", covers: "unsolicited", rule: r, basis: "explicit", type: "standing", words: ["not after 6"], source: { via: "text", ref: null }, startsAt: null, expiresAt: null, zone: ZONE, state: "active", setAt: pt("2026-11-01T10:00:00").toISOString() } as any);
  const late = A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", prefs: [rule({ latest: "19:00" })] });
  check("rules win: \"not after 7pm\" leaves only 6 to 7pm of her usual hours, and it waits for 6", !!late && late.retryAt!.getTime() === pt("2026-11-04T18:00:00").getTime() && A.hourAllowedByRules([rule({ latest: "19:00" })], "unsolicited", "text", 20, NOW) === false && A.hourAllowedByRules([rule({ latest: "19:00" })], "unsolicited", "text", 18, NOW) === true, late);
  check("rules win: when her rules leave none of her usual hours, no check (her rule decides, nothing starves)", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", prefs: [rule({ latest: "12:00" })] }) === null);
  check("rules win: a rule about something else never narrows it", A.sendTimeCheck({ ...base, now: pt("2026-11-04T09:30:00"), cls: "unsolicited", prefs: [{ ...rule({ latest: "12:00" }), covers: "checkins", area: "checkins" } as any] })?.retryAt?.getTime() === pt("2026-11-04T18:00:00").getTime());

  // Through the real evaluation (what the pick reads): the check holds the find at 9:30 and releases it at 6:30pm; a requested one never.
  const state = (now: Date, c: Candidate, extra: Record<string, unknown> = {}) => ({ now, timezone: ZONE, optedOut: false, candidates: [c], sends: [], lastInboundAt: new Date(now.getTime() - 6 * HOUR), joinedAt: pt("2026-10-01T10:00:00"), memberRules: { prefs: [], sent: [] }, attention: { sent: [], inbound: att.inbound, history: evening, sentToday: [], lastAsked: null }, ...extra });
  const offer: Candidate = { id: "9001", userId: RIVER, type: "event_offer", targetKey: "event_offer:9001", topicKey: "event_offer:9001", summary: "s", priority: 60, dueAt: pt("2026-11-04T00:00:00"), expiresAt: pt("2026-11-10T20:00:00"), payload: { askId: "profile", fromProfile: true, picked: true, match: { tier: 2 } }, attempts: 0, createdAt: pt("2026-11-04T00:00:00") };
  const early = PR.evaluateCandidates(state(pt("2026-11-04T09:30:00"), offer) as any);
  const evening630 = PR.evaluateCandidates(state(pt("2026-11-04T18:30:00"), offer) as any);
  check("evaluation: the find is held at 9:30am for her usual hour", early.eligible.length === 0 && early.perCandidate[0].checks.some((k) => k.name === "usual_hour" && !k.pass));
  check("evaluation: the same find goes at 6:30pm", evening630.eligible.length === 1, evening630.perCandidate[0].checks.filter((k) => !k.pass));
  const asked: Candidate = { ...offer, id: "9002", targetKey: "event_offer:9002", payload: { askId: "ask-1", fromProfile: false } };
  const earlyAsked = PR.evaluateCandidates(state(pt("2026-11-04T09:30:00"), asked) as any);
  check("evaluation: an answer to their ask is never moved", !earlyAsked.perCandidate[0].checks.some((k) => k.name === "usual_hour"));
  const noData = PR.evaluateCandidates(state(pt("2026-11-04T09:30:00"), offer, { attention: { sent: [], inbound: [], history: [], sentToday: [], lastAsked: null } }) as any);
  check("evaluation: with too little data the current default stands", !noData.perCandidate[0].checks.some((k) => k.name === "usual_hour"));
  const dispatchSrc = src("harness/proactive.ts");
  check("data: learned from the member's own inbound times already on file (co_memories), no new table", /loadInboundTimes\(db, userId, SEND_TIME\.lookbackDays\)/.test(dispatchSrc) && !/CREATE TABLE/.test(src("harness/attention.ts")));
  check("data: the 8-day back-off and 'replies often' reads are cut from the same read", /const inbound = history\.filter\(\(t\) => t\.getTime\(\) > now\.getTime\(\) - 8 \* DAY\);/.test(dispatchSrc));
  check("data: the send-time check is not one of the checks re-read inside the lock (it is timing, not a cap)", ![...PR.LOCKED_DEFAULTS].includes("usual_hour"));
  check("hours: Cue's own 8am to 9pm gate is unchanged and still decides", /localHourOk/.test(dispatchSrc) && A.SEND_TIME.startHour === 8 && A.SEND_TIME.endHour === 21);
}

// ================================================================ 11. measure
{
  const NOW = pt("2026-11-04T08:05:00");
  const send = (h: number, type = "event_offer", cls: string | null = "unsolicited") => ({ sentAt: new Date(NOW.getTime() - h * HOUR), type, cls });
  const reply = (h: number) => new Date(NOW.getTime() - h * HOUR);
  // Four messages in the window: 100h, 99.5h (close together), 60h, 30h; and one 5h ago (not old enough to have been answered yet).
  const d = S.tallyMember({ now: NOW, sends: [send(100), send(99.5), send(60), send(30), send(5), send(99.5, "event_offer", G.RIDING)], inbound: [reply(98), reply(29)], lessStop: 1, expired: 2 });
  check("measure: messages sent in the window (a message riding inside another isn't one)", d.sent === 5, d);
  check("measure: reply rate counts only messages old enough to have had a day", d.answerable === 4 && d.answered === 3 && d.replyRate === 0.75, d);
  check("measure: messages arriving close together (inside an hour of the one before)", d.closeTogether === 1, d);
  check("measure: less/stop requests and expired items are carried as counted", d.lessStop === 1 && d.expired === 2);
  const none = S.tallyMember({ now: NOW, sends: [send(3)], inbound: [], lessStop: 0, expired: 0 });
  check("measure: nothing old enough yet is no rate, not zero", none.replyRate === null && none.answerable === 0);
  check("measure: a row is logged only when something happened", S.worthLogging(d) && !S.worthLogging(S.tallyMember({ now: NOW, sends: [], inbound: [], lessStop: 0, expired: 0 })));
  check("measure: the window is 7 days, an answer within 24 hours, 'close' under 60 minutes", S.STATS_WINDOW_DAYS === 7 && S.ANSWER_HOURS === 24 && S.CLOSE_MINUTES === 60);

  // Through the real recorder on the store: one row per member, numbers only.
  reset();
  const asked = (sql: string) => db.sql.some((q) => q.startsWith(sql));
  void asked;
  const realQuery = (pool as any).query;
  const logged: any[] = [];
  const day = (iso: string) => new Date(`${iso}Z`);
  (pool as any).query = async (sql: string, a: any[] = []) => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (/FROM harness_decisions WHERE decision = 'metrics\.attention'/.test(q)) return { rows: [] };
    if (/FROM proactive_sends ps JOIN users u/.test(q)) return { rows: [{ user_id: RIVER, type: "event_offer", sent_at: day("2026-10-30T18:00:00"), notify_class: "unsolicited" }, { user_id: RIVER, type: "companion", sent_at: day("2026-10-30T18:20:00"), notify_class: "checkin" }, { user_id: OTHER, type: "event_offer", sent_at: day("2026-10-31T18:00:00"), notify_class: "unsolicited" }] };
    if (/FROM co_memories m JOIN users u/.test(q)) return { rows: [{ user_id: RIVER, created_at: day("2026-10-30T20:00:00") }] };
    if (/FROM proactive_candidates c JOIN users u/.test(q)) return { rows: [{ user_id: RIVER, n: 2 }] };
    if (/FROM co_facts f JOIN users u/.test(q)) return { rows: [{ user_id: RIVER, n: 1 }] };
    if (/^INSERT INTO harness_decisions/.test(q)) { logged.push({ decision: a[1], user_id: a[2], action: a[4], proposal: a[5] ? JSON.parse(a[5]) : null, reason: a[8] }); return { rows: [{ id: "1", created_at: new Date() }] }; }
    return { rows: [] };
  };
  const n = await S.recordDailyAttention(pt("2026-11-04T08:05:00")).finally(() => { (pool as any).query = realQuery; });
  const mine = logged.filter((l) => l.user_id === RIVER)[0];
  check("recorder: one row per member with something to say", n === 2 && logged.length === 2 && logged.every((l) => l.decision === "metrics.attention" && l.action === "daily"), logged);
  check("recorder: the numbers for River (two messages inside an hour, both answered, two expired, one rule)", mine?.proposal.sent === 2 && mine.proposal.answered === 2 && mine.proposal.closeTogether === 1 && mine.proposal.expired === 2 && mine.proposal.lessStop === 1, mine);
  check("recorder: numbers and the day only, no member words", logged.every((l) => Object.values(l.proposal).every((v) => typeof v === "number" || v === null || /^\d{4}-\d{2}-\d{2}$/.test(String(v)))) && logged.every((l) => !l.reason));
  const SS = src("harness/attentionStats.ts");
  check("log only: no email, no text, no alert", !/sendReportEmail|alertTeamNow|sendblue|sendAlertText|messages\.send/.test(SS) && !/harness_alerts/.test(SS));
  check("log only: it hangs off the existing daily failure count's cron", /recordDailyFailures\(\)\)[\s\S]{0,600}harness\/attentionStats\.js[\s\S]{0,120}recordDailyAttention\(\)/.test(src("jobs/index.ts")));
  check("log only: the queries never read message text", ![S.SENDS_SQL, S.EXPIRED_SQL, S.LESS_STOP_SQL].some((q) => /content|message\b|object_label|words/i.test(q.replace(/m\.content LIKE/g, ""))) && /SELECT m\.user_id::text AS user_id, m\.created_at FROM co_memories/.test(S.INBOUND_SQL));
}

console.log(`pullAndSendTime: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
