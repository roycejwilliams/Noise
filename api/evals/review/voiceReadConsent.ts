// The voice read on calls runs only on the member's own recorded yes (services/voiceReadConsent.ts, services/voiceRead.ts), in a fake
// database and a fake Twilio/Hume. Zero tokens, no outside calls.
//   npx tsx evals/review/voiceReadConsent.ts
// 2026-10-28, Royce: "members need a clear opt-in and an easy way to withdraw. A database switch isn't consent. Check permission for
// anyone already enabled too; knowing about it isn't automatically agreeing to it. Withdrawal should stop future analysis immediately."
//   1. The flag alone does nothing: users.voice_read_ok = true, no yes on file, means no fork, no stream, no read.
//   2. Consent turns it on: only their yes, quoted with its time, after Cue's question; a yes before the question, or no answer, is off.
//   3. Withdrawal stops the next run: the next call's TwiML, a stream starting, the live read already running, and the post-call
//      analysis all stop at once; what it noted is deleted, their yes's words go, the times stay.
//   4. No re-ask after a no (or after no answer, or a withdrawal): the question is queued once ever, and never in production.
//   5. Nothing changes where the read can't run: the entry and its tool are left out unless the turn knows the read can run.
//   6. When they raise it first, the approved question rides in Cue's reply word for word: the reply's checks (the fact check, its
//      length and question cuts, the stock-line filter) see only Cue's own draft, the line is added after them as the reply's own last
//      paragraph, and the send's clean-up changes no word of it. The yes and stop lines ride the same way.
//   7. A hard day and a safety hold delay the question, never drop it.
//   8. A stop during the post-call read keeps nothing of the voice (read again before the write; the insert's own guard).
//   9. It counts as asked only once the reply carrying the question went.
//  10. Never a yes on a call: Cue says it will text the question, it is queued as their ask, and only a yes by text counts.
//  11. Their words don't outlive a stop: the decision log keeps the answer only; their calls' read logs are deleted.
//  12. A stop while a stream is starting: Hume never opens.
//  13. A yes needs the question on file, enforced by the statement.
//  14. Re-review: a stop forgets their trace text and no voice moment reaches a later reply; the question goes once whichever ask
//      was queued; no call line when nothing will go; a yes sent before the question went doesn't count; the read log is written
//      only while it's on; the withdrawal is written before the delete.
import { readFileSync } from "node:fs";
const V = await import("../../src/services/voiceRead.js");
const C = await import("../../src/services/voiceReadConsent.js");
const B = await import("../../src/services/mediaStreamBridge.js");
const EL = await import("../../src/services/elevenLabsCalls.js");
const L = await import("../../src/services/voiceStreamLink.js");
const K = await import("../../src/services/whatCoKnows.js");
const CAP = await import("../../src/services/capabilities.js");
const PR = await import("../../src/harness/proactive.js");

let total = 0, failed = 0;
const say = console.log; // FAIL lines print even while a section quiets console.log
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; say(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const errLog = console.error;
console.error = () => {}; // the decision log's failed writes (no database here) are expected and non-fatal

const REAL = "+14155551234";
const TEST = "+14155550123";
const env = (e: Record<string, string | undefined> = {}) => ({ RAILWAY_ENVIRONMENT_NAME: "co-test", HUME_API_KEY: "dummy", API_URL: "https://co-test.example.app", TWILIO_AUTH: "dummy-auth", ...e }) as NodeJS.ProcessEnv;

// ---------------------------------------------------------------- a fake database: just the statements this path runs
type Consent = { asked_at: Date | null; answer: "yes" | "no" | null; answered_at: Date | null; yes_quote: string | null; withdrawn_at: Date | null };
const db = {
  users: new Map<string, { phone_number: string; voice_read_ok: boolean }>(),
  consents: new Map<string, Consent>(),
  signals: [] as { id: number; user_id: string; basis: string | null; quote: string | null }[],
  decisions: [] as { user_id: string; decision: string }[],
  log: [] as string[],
  async query(sql: string, args: unknown[] = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    db.log.push(q);
    const id = String(args[0]);
    const row = () => db.consents.get(id);
    const blank = (): Consent => ({ asked_at: null, answer: null, answered_at: null, yes_quote: null, withdrawn_at: null });
    if (/voice_read_ok/.test(q)) throw new Error("the old flag was read");
    if (q.startsWith("SELECT phone_number FROM users WHERE id = $1")) { const u = db.users.get(id); return { rows: u ? [{ phone_number: u.phone_number }] : [] }; }
    if (q.startsWith("SELECT asked_at, answer, answered_at, withdrawn_at FROM voice_read_consents WHERE user_id = $1")) { const r = row(); return { rows: r ? [{ ...r }] : [] }; }
    if (q.startsWith("INSERT INTO voice_read_consents (user_id, asked_at)")) { const r = row() ?? blank(); r.asked_at ??= new Date(); db.consents.set(id, r); return { rows: [], rowCount: 1 }; }
    if (q.startsWith("UPDATE voice_read_consents SET answer = 'yes'")) {
      const r = row();
      // Honors the statement's own guard, so the test reads the SQL, not a rule of its own.
      if (!r || (/WHERE user_id = \$1 AND asked_at IS NOT NULL/.test(q) && !r.asked_at)) return { rows: [], rowCount: 0 };
      if (/AND asked_at <= \$3/.test(q) && r.asked_at && +r.asked_at > +new Date(args[2] as any)) return { rows: [], rowCount: 0 };
      Object.assign(r, { answer: "yes", answered_at: new Date(), yes_quote: String(args[1]), withdrawn_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE voice_read_consents SET withdrawn_at = NOW(), yes_quote = NULL")) { const r = row(); if (r) Object.assign(r, { withdrawn_at: new Date(), yes_quote: null }); return { rows: [], rowCount: r ? 1 : 0 }; }
    if (q.startsWith("INSERT INTO voice_read_consents (user_id, answer, answered_at) VALUES ($1, 'no', NOW())")) { const r = row() ?? blank(); Object.assign(r, { answer: "no", answered_at: new Date(), yes_quote: null }); db.consents.set(id, r); return { rows: [], rowCount: 1 }; }
    if (q.startsWith("DELETE FROM emotion_signals WHERE user_id = $1 AND basis = 'voice'")) { const before = db.signals.length; db.signals = db.signals.filter((s) => !(s.user_id === id && s.basis === "voice")); return { rows: [], rowCount: before - db.signals.length }; }
    if (q.startsWith("DELETE FROM harness_decisions WHERE user_id = $1 AND decision = 'call.voice_read'")) { const before = db.decisions.length; db.decisions = db.decisions.filter((d) => !(d.user_id === id && d.decision === "call.voice_read")); return { rows: [], rowCount: before - db.decisions.length }; }
    throw new Error(`unexpected statement: ${q.slice(0, 120)}`);
  },
};
const U = "11111111-2222-3333-4444-555555555555";
db.users.set(U, { phone_number: REAL, voice_read_ok: true }); // Royce's state today: the hand-set flag, nothing else

// ---------------------------------------------------------------- the fake call: TwiML, Twilio's stream, Hume
const EL_TWIML = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="wss://api.us.elevenlabs.io/v1/convai/conversation/twilio?agent_id=x"><Parameter name="a" value="b"/></Stream></Connect></Response>`;
const links = L.memoryVoiceStreamLinks();
const fork = (userId = U, phone = REAL) => EL.withVoiceReadFork(EL_TWIML, { userId, callToken: `tok-${userId}`, memberPhone: phone }, env(), { consent: (id) => C.readVoiceReadConsent(id, db), links });
type Handler = (...a: any[]) => void;
class FakeSocket {
  readyState = 0; closed = false; sent: unknown[] = []; handlers = new Map<string, Handler[]>();
  on(e: string, fn: Handler) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), fn]); return this; }
  emit(e: string, ...a: any[]) { for (const fn of this.handlers.get(e) ?? []) fn(...a); }
  send(d: unknown) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; this.emit("close"); }
}
let humes: FakeSocket[] = [];
let clock = 9_000_000;
B.setBridgeDeps({
  connectHume: () => { const h = new FakeSocket(); humes.push(h); return h as any; },
  takeLink: (id) => L.takeVoiceStreamLink(id, links, new Date(clock)),
  now: () => clock,
  log: () => {},
  record: () => {},
  apiKey: () => "dummy",
  // The real check, against the fake database.
  allowed: (userId) => C.voiceReadOnFor(userId, db, env()),
});
const tick = () => new Promise((r) => setImmediate(r));
const startMsg = (streamId: string) => JSON.stringify({ event: "start", streamSid: "MZ1", start: { callSid: "CA1", streamSid: "MZ1", tracks: ["inbound"], customParameters: { stream: streamId } } });
const streamIdOf = (twiml: string) => /<Parameter name="stream" value="([^"]+)"/.exec(twiml)?.[1] ?? null;
const openWith = async (streamId: string) => { const tw = new FakeSocket(); B.handleTwilioStream(tw as any); tw.emit("message", startMsg(streamId)); await tick(); await tick(); return tw; };
const humeReady = (h: FakeSocket) => { h.readyState = 1; h.emit("open"); h.emit("message", JSON.stringify({ type: "session.updated" })); };
const score = (h: FakeSocket, utt: number, s: number, e: number) => h.emit("message", JSON.stringify({ type: "measurement.result", utterance_id: utt, audio_start_ms: s, audio_end_ms: e, expressions: [["tiredness", 0.8], ["exhaustion", 0.7]].map(([name, probability]) => ({ name, probability })), voice_attributes: [] }));
const key = B.callKeyOf(U, `tok-${U}`);

// ---------------------------------------------------------------- 1. the flag alone does nothing
B.resetVoiceSessions(); humes = [];
check("1. the flag alone: the read is off for them", !(await C.voiceReadOnFor(U, db, env())));
check("1. the flag alone: no fork in the call's TwiML", (await fork()) === EL_TWIML);
check("1. the flag alone: the old column is never read", !db.log.some((q) => /voice_read_ok/.test(q)));
const sneak = await L.issueVoiceStreamLink(U, key, links, new Date(clock)); // a stream link issued anyway (an older TwiML)
const tw0 = await openWith(sneak);
check("1. the flag alone: a stream for them is refused at the start and Hume never opened", tw0.closed && humes.length === 0 && B.sessionShape(key) === null);
check("1. the pure gate: a real member with nothing on file is off; asked with no answer is off", !V.voiceReadAllowed({ memberPhone: REAL, consent: null }, env()) && !V.voiceReadAllowed({ memberPhone: REAL, consent: { askedAt: new Date(), answer: null, answeredAt: null, withdrawnAt: null } }, env()));
const el = readFileSync(new URL("../../src/services/elevenLabsCalls.ts", import.meta.url), "utf8");
check("1. the call's gate reads the consent record, never the flag", /readVoiceReadConsent/.test(el) && !/SELECT[^`]*voice_read_ok/.test(el) && !/consented/.test(el));

// ---------------------------------------------------------------- 2. consent turns it on
check("2. a yes before Cue's question isn't consent", (await C.recordVoiceReadYes(U, "sure, read my voice", db)).ok === false && !(await C.voiceReadOnFor(U, db, env())));
await C.noteVoiceReadAsked(U, db);
check("2. asked, no answer yet: still off (no answer means no)", !(await C.voiceReadOnFor(U, db, env())) && V.voiceReadState(await C.readVoiceReadConsent(U, db)) === "asked");
const yes = await C.recordVoiceReadYes(U, "yes, go ahead", db);
const onFile = db.consents.get(U)!;
check("2. their yes is kept as their words with its time", yes.ok && onFile.answer === "yes" && onFile.yes_quote === "yes, go ahead" && onFile.answered_at instanceof Date && !!onFile.asked_at);
check("2. consent turns it on", await C.voiceReadOnFor(U, db, env()));
const twiml = await fork();
check("2. the next call's TwiML gets the fork", twiml !== EL_TWIML && twiml.includes("<Start>") && !!streamIdOf(twiml));
const tw1 = await openWith(streamIdOf(twiml)!);
check("2. its stream starts and Hume opens", !tw1.closed && humes.length === 1 && B.sessionShape(key) !== null);
check("2. in production it stays off even with a yes", !V.voiceReadAllowed({ memberPhone: REAL, consent: C.consentFromRow(onFile) }, env({ RAILWAY_ENVIRONMENT_NAME: "production" })));

// ---------------------------------------------------------------- 3. withdrawal stops the next run, at once
const h = humes[0];
humeReady(h);
for (let i = 0; i < 6; i++) score(h, 1, i * 3000, i * 3000 + 3000);
check("3. (before) the live read holds scores", (B.sessionShape(key)?.windows ?? 0) > 0);
db.signals.push({ id: 1, user_id: U, basis: "voice", quote: "I'm fine, honestly" }, { id: 2, user_id: U, basis: null, quote: "work has been a lot" }, { id: 3, user_id: "someone-else", basis: "voice", quote: "theirs" });
const off = await C.turnVoiceReadOff(U, "stop", db);
check("3. the live read on this call ends now: Hume closed, scores dropped, no line for the call brain", off.endedLive === 1 && h.closed && B.sessionShape(key) === null && B.voiceReadLineFor(key, "I'm fine", ["I'm fine"], { safety: false }) === null);
check("3. nothing from this call is judged or kept after it", (await B.takeVoiceMoments(key, [{ text: "I'm fine", startMs: 0, endMs: 3000 }] as any, 10)).length === 0);
check("3. what it noted is deleted (theirs, voice only); their text read and other members' rows stay", off.deleted === 1 && db.signals.map((s) => s.id).join(",") === "2,3");
const after = db.consents.get(U)!;
check("3. their yes's words are gone; the times stay as the fingerprint", after.yes_quote === null && after.withdrawn_at instanceof Date && after.answered_at instanceof Date && V.voiceReadState(C.consentFromRow(after)) === "withdrawn");
check("3. the next call gets no fork", !(await C.voiceReadOnFor(U, db, env())) && (await fork()) === EL_TWIML);
const late = await L.issueVoiceStreamLink(U, key, links, new Date(clock));
const humesBefore = humes.length;
const tw2 = await openWith(late);
check("3. a stream starting after it (a TwiML made before the stop) is refused, Hume never opened", tw2.closed && humes.length === humesBefore);
// Withdrawn after the call ended but before its post-call analysis ran (the session is no longer live, so nothing ends it): the
// after-call step reads the consent again and keeps nothing.
const V2 = "22222222-3333-4444-5555-666666666666";
db.users.set(V2, { phone_number: REAL, voice_read_ok: false });
await C.noteVoiceReadAsked(V2, db);
await C.recordVoiceReadYes(V2, "yes please", db);
const key2 = B.callKeyOf(V2, `tok-${V2}`);
const tw3 = await openWith(streamIdOf(await fork(V2))!);
const h2 = humes[humes.length - 1];
humeReady(h2);
for (let i = 0; i < 6; i++) score(h2, 1, i * 3000, i * 3000 + 3000);
tw3.emit("message", JSON.stringify({ event: "stop" }));
h2.close();
await tick();
await C.turnVoiceReadOff(V2, "stop", db, { endLive: () => 0 });
check("3. queued analysis: withdrawn between the call's end and the post-call step, nothing is kept", (await B.takeVoiceMoments(key2, [{ text: "I'm fine", startMs: 0, endMs: 3000 }] as any, 10)).length === 0 && B.sessionShape(key2) === null);
check("3. a test number that took it back is off too", !V.voiceReadAllowed({ memberPhone: TEST, consent: C.consentFromRow(after) }, env()) && V.voiceReadAllowed({ memberPhone: TEST, consent: null }, env()));

// ---------------------------------------------------------------- 4. asked once; never again after a no
const queued: any[] = [];
const enqueue = async (i: any) => { queued.push(i); return { queued: true }; };
const W = "33333333-4444-5555-6666-777777777777";
db.users.set(W, { phone_number: REAL, voice_read_ok: false });
const now = new Date("2026-10-28T18:00:00Z");
check("4. never asked: the question is queued, once ever (its own key), not on top of the call's follow-up, no expiry", (await C.queueVoiceReadAsk(W, { db, env: env(), now, enqueue })) && queued.length === 1 && queued[0].type === "voice_read_ask" && queued[0].targetKey === "voice_read_ask" && queued[0].dueAt.getTime() > now.getTime() && queued[0].expiresAt === null);
check("4. never in production", !(await C.queueVoiceReadAsk("44444444-5555-6666-7777-888888888888", { db, env: env({ RAILWAY_ENVIRONMENT_NAME: "production" }), now, enqueue })) && queued.length === 1);
await C.noteVoiceReadAsked(W, db);
check("4. asked with no answer: never asked again", !(await C.queueVoiceReadAsk(W, { db, env: env(), now, enqueue })) && queued.length === 1);
await C.turnVoiceReadOff(W, "no", db, { endLive: () => 0 });
check("4. after a no: it stays off and is never asked again", !(await C.voiceReadOnFor(W, db, env())) && !(await C.queueVoiceReadAsk(W, { db, env: env(), now, enqueue })) && queued.length === 1);
check("4. after a withdrawal: never asked again", !(await C.queueVoiceReadAsk(U, { db, env: env(), now, enqueue })) && queued.length === 1);
check("4. the pure rule: due only when nothing is on file", V.voiceReadAskDue(null, env()) && (["asked", "yes", "no", "withdrawn"] as const).every((s) => !V.voiceReadAskDue({ askedAt: new Date(), answer: s === "yes" || s === "withdrawn" ? "yes" : s === "no" ? "no" : null, answeredAt: null, withdrawnAt: s === "withdrawn" ? new Date() : null }, env())));
const reg = readFileSync(new URL("../../src/harness/proactiveRegistry.ts", import.meta.url), "utf8");
const regEntry = reg.slice(reg.indexOf("  voice_read_ask: {"), reg.indexOf("  // Fixed, approved wording, not a draft (services/announcements.ts)"));
check("4. the queued send reads the state again and skips unless it's still due; it marks asked when sent", /voiceReadTextDue\(await C\.readVoiceReadConsent\(c\.userId\), \(c\.payload as \{ theyAsked\?: boolean \} \| null\)\?\.theyAsked === true, process\.env, c\.createdAt \? new Date\(c\.createdAt\) : null\)/.test(regEntry) && /return skip\(/.test(regEntry) && /noteVoiceReadAsked\(c\.userId\)/.test(regEntry));
const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
const toolSrc = tools.slice(tools.indexOf("    voiceRead: tool({"), tools.indexOf("    answerShareAsks: tool({"));
check("4. the reply tool won't put the question to them again after a no or a withdrawal", /answer === "explain" && \(was === "no" \|\| was === "withdrawn"\)\) \{[^}]*return \{ ok: false/.test(toolSrc));
check("4. the reply tool takes only their own words, and a yes counts only after the question", /quoteIsTheirs\(theirWords, ctx\.resolvedContent\)/.test(toolSrc) && /if \(!onFile\?\.askedAt \|\| answer === "explain"\) \{/.test(toolSrc) && toolSrc.indexOf("if (!onFile?.askedAt || answer") < toolSrc.indexOf("recordVoiceReadYes"));
check("4. no regex reads what they meant: the model picks yes/no/stop/explain", /answer: z\.enum\(\["yes", "no", "stop", "explain"\]\)/.test(toolSrc) && !/\.test\(ctx\.resolvedContent\)/.test(toolSrc));

// ---------------------------------------------------------------- the words (Copy, for Royce)
check("the question passes the send's own checks", PR.checkDraft(C.VOICE_READ_ASK, C.VOICE_READ_ASK_RULES).every((c) => c.pass), PR.checkDraft(C.VOICE_READ_ASK, C.VOICE_READ_ASK_RULES).filter((c) => !c.pass));
check("the question says what it is, who hears it, what's kept and for how long, that it's off without a yes, and that it stops", /how you sound/.test(C.VOICE_READ_ASK) && /Hume/.test(C.VOICE_READ_ASK) && /keeps none of it/.test(C.VOICE_READ_ASK) && /don't keep the audio/.test(C.VOICE_READ_ASK) && /until you ask me to drop them/.test(C.VOICE_READ_ASK) && /off unless you say yes/.test(C.VOICE_READ_ASK) && /stop anytime/.test(C.VOICE_READ_ASK));
check("no line names Noise or a role, and none has an em dash", [C.VOICE_READ_ASK, C.VOICE_READ_YES_LINE, C.VOICE_READ_STOP_LINE, C.voiceReadKnownLine("2026-10-28")].every((l) => !/Noise|matchmaker|AI\b|[—–]/.test(l)));
check("the stop confirmation is one line", C.VOICE_READ_STOP_LINE.split(/(?<=[.!?])\s+/).length <= 2 && !C.VOICE_READ_STOP_LINE.includes("\n"));

// ---------------------------------------------------------------- what Cue knows: on, and removable
const base = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [] } as any;
const item = K.knownItems({ ...base, voiceRead: { since: "2026-10-28" } }).find((i) => i.ref === "grant:voice_read");
check("what Cue knows shows it while it's on", !!item && item.text === C.voiceReadKnownLine("2026-10-28"));
check("and not when it's off", !K.knownItems({ ...base, voiceRead: null }).some((i) => i.ref === "grant:voice_read"));
const wk = readFileSync(new URL("../../src/services/whatCoKnows.ts", import.meta.url), "utf8");
check("removing it there is the same withdrawal", /a === "voice_read" \? removeVoiceRead\(userId, item\.ref, was\)/.test(wk) && /async function removeVoiceRead[\s\S]{0,200}turnVoiceReadOff\(userId, "stop"\)/.test(wk) && K.fieldFor("grant:voice_read") !== K.fieldFor("grant:calendar"));

// ---------------------------------------------------------------- 5. nothing changes where it can't run (and for golden replays)
const s0 = CAP.situationFor({ kitFields: 0, message: "hi", openTasks: 0, eventToday: false });
check("5. a turn that doesn't know the read can run: no entry, no tool", !("voiceRead" in s0) && CAP.toolsOutOfSituation(s0).includes("voiceRead") && !CAP.capabilitySheet({ situation: s0 }).some((l) => /how they sound/.test(l)) && !CAP.capabilitySheet().some((l) => /how they sound/.test(l)));
const s1 = CAP.situationFor({ kitFields: 0, message: "hi", openTasks: 0, eventToday: false, voiceRead: true });
check("5. where it can run: listed, with its tool", !CAP.toolsOutOfSituation(s1).includes("voiceRead") && CAP.capabilitySheet({ situation: s1 }).some((l) => /how they sound/.test(l)));
check("5. the prereqs are the read's own (never production)", !V.voiceReadPrereqs(env({ RAILWAY_ENVIRONMENT_NAME: "production" })) && V.voiceReadPrereqs(env()) && !V.voiceReadPrereqs({} as NodeJS.ProcessEnv));
check("5. the reply tool is removed wherever the read can't run, with or without a turn", /if \(!voiceReadPrereqs\(\)\) delete \(tools as Record<string, unknown>\)\.voiceRead;/.test(tools));

// ---------------------------------------------------------------- 6. the question rides in a reply word for word
{
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  const { toBeats } = await import("../../src/services/beats.js");
  const { cleanCoMessage } = await import("../../src/services/sendblue.js");
  const LM = await import("../../src/services/laneMoves.js");
  const saved = { ...process.env };
  Object.assign(process.env, env());
  const words = (t: string) => t.replace(/\s+/g, " ").trim();
  const ASKED = "wait, can you actually hear how I'm feeling on our calls?";
  // The harshest reply check there is: every question dropped, every stock opener dropped, cut to 40 characters. It sees only Cue's draft.
  const gateSaw: string[] = [];
  const harsh = async (d: string) => {
    gateSaw.push(d);
    return d.split(/(?<=[.!?])\s+/).filter((x) => !/\?$/.test(x) && !/^(good question|great question)/i.test(x)).join(" ").slice(0, 40);
  };
  const turn = (gate: (d: string) => Promise<string>) => {
    const t: any = createConversationTools({
      userId: "u-6", phoneNumber: "+10000000000", resolvedContent: ASKED, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true,
      ackSent: "👍", lastCoMessage: "How did the pitch go?", sendCoReply: async () => true, facts: { add: () => {}, text: () => "" }, gate,
    } as any);
    return { tools: t.tools as any, state: t.state as any };
  };
  const logLine = console.log;
  console.log = () => {}; // the dry run's "would reply" lines
  const drafts = ["Good question. Yes, if you want it.", "Fair to ask.\n\nHow did the pitch land, by the way?", "Of course"];
  const sent: string[] = [];
  for (const d of drafts) {
    const { tools, state } = turn(harsh);
    const r = await tools.voiceRead.execute({ answer: "explain", theirWords: ASKED }, {});
    const s = await tools.sendReply.execute({ message: d }, {});
    sent.push(r?.ok && s?.ok ? state.sentMessages[0] : "");
  }
  console.log = logLine;
  check("6. the reply tool is offered where the read can run", sent.every(Boolean), sent);
  check("6. the reply's checks never see the fixed question: they run on Cue's draft only", gateSaw.length === drafts.length && gateSaw.every((g) => !g.includes("Hume") && !g.includes("Want me to?")));
  check("6. the question goes word for word as the reply's own last paragraph, once, even after the harshest cut", sent.every((m) => m.endsWith(`\n\n${C.VOICE_READ_ASK}`) && m.split(C.VOICE_READ_ASK).length === 2), sent);
  check("6. no stray period after its question mark", sent.every((m) => !m.includes("?.")));
  const beats = sent.map((m) => toBeats(m).map((b) => cleanCoMessage(b)));
  check("6. as texted: its own last text, and the send's clean-up changes no word of it", beats.every((b) => words(b[b.length - 1]) === C.VOICE_READ_ASK), beats.map((b) => b[b.length - 1]));
  // Cue already answered with its own text this turn: the question still goes, in a short second reply, word for word.
  {
    const { tools, state } = turn(async (d) => d);
    await tools.sendReply.execute({ message: "Good timing, I was going to ask." }, {});
    const r = await tools.voiceRead.execute({ answer: "explain", theirWords: ASKED }, {});
    await tools.sendReply.execute({ message: "One more thing." }, {});
    check("6. after a reply already went, the next one carries it word for word", /already went/.test(r.note) && state.sentMessages.length === 2 && state.sentMessages[1].endsWith(C.VOICE_READ_ASK) && !state.sentMessages[0].includes("Hume"));
    await tools.sendReply.execute({ message: `Also: ${C.VOICE_READ_ASK}` }, {});
    check("6. and never twice in a turn", state.sentMessages.length === 3 && !state.sentMessages[2].includes("Hume"), state.sentMessages[2]);
  }
  check("6. the tool tells Cue its own part asks nothing beside the question", /yours asks nothing/.test(tools.slice(tools.indexOf("    voiceRead: tool({"), tools.indexOf("    answerShareAsks: tool({"))));
  // The yes and stop lines already end their sentence: carried as written, never "anytime..".
  for (const [name, line] of [["yes", C.VOICE_READ_YES_LINE], ["stop", C.VOICE_READ_STOP_LINE]] as const) {
    const out = LM.carryLaneNotes("Got it.", [line]).text;
    check(`6. the ${name} line rides word for word, no doubled period`, out === `Got it. ${line}` && !out.includes(".."), out);
  }
  check("6. a lane note without its period still gets one (unchanged)", LM.carryLaneNotes("Sounds good.", ["moved the jazz nights from goals to lookouts"]).text === "Sounds good. Moved the jazz nights from goals to lookouts.");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// ---------------------------------------------------------------- 7. a hard day and a safety hold delay the question, never drop it
{
  const NOW7 = new Date("2026-10-28T18:00:00Z");
  const q = { id: "c7", userId: U, type: "voice_read_ask", targetKey: "voice_read_ask", topicKey: "voice_read_ask", summary: "ask", payload: {}, priority: PR.TYPE_POLICY.voice_read_ask.priority, dueAt: new Date(NOW7.getTime() - 3600_000), expiresAt: null, attempts: 0, createdAt: new Date(NOW7.getTime() - 7200_000) } as any;
  const st = (o: Record<string, unknown> = {}) => ({ now: NOW7, sends: [], lastInboundAt: null, needsCare: false, safetyHold: false, undeliveredYes: false, suppressedKinds: [], away: null, joinedAt: null, ...o }) as any;
  const failing = (o: Record<string, unknown>) => PR.candidateChecks(q, st(o)).filter((k) => !k.pass).map((k) => k.name);
  check("7. a hard day holds it", PR.HOLD_WHILE_STRUGGLING.has("voice_read_ask") && failing({ needsCare: true }).includes("emotional_timing"), failing({ needsCare: true }));
  check("7. the capped mood hold holds it while it holds, and lets it go when it lifts", failing({ needsCare: true, moodHold: { state: "held", hold: true, heldHours: 3 } }).includes("emotional_timing") && !failing({ needsCare: true, moodHold: { state: "capped", hold: false, heldHours: 49 } }).includes("emotional_timing"));
  check("7. a safety hold holds it", PR.SAFETY_HOLD_ALSO.has("voice_read_ask") && failing({ safetyHold: true }).includes("safety_hold"), failing({ safetyHold: true }));
  check("7. delayed, never dropped: no expiry, and once they're okay it's eligible again", q.expiresAt === null && failing({}).length === 0 && PR.evaluateCandidates({ ...st(), candidates: [q], timezone: null, optedOut: false, joinedAt: null } as any).eligible.length === 1, failing({}));
}

// ---------------------------------------------------------------- 8. a stop during the post-call read keeps nothing of the voice
{
  const X = "88888888-1111-2222-3333-444444444444";
  db.users.set(X, { phone_number: REAL, voice_read_ok: false });
  await C.noteVoiceReadAsked(X, db);
  await C.recordVoiceReadYes(X, "yes", db);
  const voiced = [{ source: "call", emotion: "tired", basis: "voice" }];
  check("8. on: the call's voice moments are kept", (await C.keepVoiceIfStillOn(X, voiced, db, env())).length === 1);
  // The stop lands while the call's feelings are being read (between takeVoiceMoments and the write).
  await C.turnVoiceReadOff(X, "stop", db, { endLive: () => 0 });
  check("8. stopped during the read: nothing of the voice is written", (await C.keepVoiceIfStillOn(X, voiced, db, env())).length === 0);
  const co = readFileSync(new URL("../../src/routes/co.ts", import.meta.url), "utf8");
  const emo = readFileSync(new URL("../../src/harness/emotion.ts", import.meta.url), "utf8");
  check("8. the post-call write reads it again right before inserting", /keepVoiceIfStillOn\(user_id, v\)\)\)[^\n]*\n\s*await recordEmotionSignals\(user_id, \[\.\.\.moments, \.\.\.frustrated, \.\.\.voiced\]/.test(co));
  check("8. and the insert itself refuses voice rows after a no or a withdrawal", /WHERE x\.basis IS DISTINCT FROM 'voice'\s+OR NOT EXISTS \(SELECT 1 FROM voice_read_consents c WHERE c\.user_id = \$1 AND \(c\.answer = 'no' OR c\.withdrawn_at IS NOT NULL\)\)/.test(emo));
}

// ---------------------------------------------------------------- 9-10. asked only once the question reached them; never a yes on a call
{
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  const saved = { ...process.env };
  Object.assign(process.env, env());
  const queued9: any[] = [];
  C.setVoiceReadDepsForTests({ db, enqueue: async (i) => (queued9.push(i), { queued: true }) });
  const logLine = console.log;
  const make = (userId: string, message: string, o: { onCall?: boolean; sendOk?: () => boolean } = {}) => {
    const t: any = createConversationTools({
      userId, phoneNumber: "+10000000000", resolvedContent: message, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, onCall: !!o.onCall,
      ackSent: "👍", lastCoMessage: "How did the pitch go?", sendCoReply: async () => (o.sendOk ? o.sendOk() : true), facts: { add: () => {}, text: () => "" }, gate: async (d: string) => d,
    } as any);
    return { tools: t.tools as any, state: t.state as any };
  };
  console.log = () => {};
  // 9. by text, they ask first
  const Y = "99999999-1111-2222-3333-444444444444";
  db.users.set(Y, { phone_number: REAL, voice_read_ok: false });
  const ASKED9 = "can you hear how I'm feeling on calls?";
  const a = make(Y, ASKED9, { sendOk: () => false });
  await a.tools.voiceRead.execute({ answer: "explain", theirWords: ASKED9 }, {});
  const askedAtTool = db.consents.get(Y)?.asked_at ?? null;
  await a.tools.sendReply.execute({ message: "Good question." }, {});
  const askedAfterFail = db.consents.get(Y)?.asked_at ?? null;
  const b = make(Y, ASKED9);
  await b.tools.voiceRead.execute({ answer: "explain", theirWords: ASKED9 }, {});
  await b.tools.sendReply.execute({ message: "Good question." }, {});
  const askedAfterSend = db.consents.get(Y)?.asked_at ?? null;
  check("9. the tool alone doesn't mark it asked", askedAtTool === null);
  check("9. a reply that failed to send doesn't mark it asked", askedAfterFail === null);
  check("9. the reply carrying the question went: asked", askedAfterSend instanceof Date && b.state.sentMessages.some((m: string) => m.includes(C.VOICE_READ_ASK)));
  // A yes before any question, by text: the question goes, nothing is on.
  const Z = "77777777-1111-2222-3333-444444444444";
  db.users.set(Z, { phone_number: REAL, voice_read_ok: false });
  const zz = make(Z, "yes, read my voice on calls", { sendOk: () => false });
  const zr = await zz.tools.voiceRead.execute({ answer: "yes", theirWords: "yes, read my voice on calls" }, {});
  check("9. a yes before the question: the question is carried, nothing is on or asked until it goes", zr.line === C.VOICE_READ_ASK && !db.consents.get(Z)?.asked_at && !(await C.voiceReadOnFor(Z, db, env())));
  // 10. on a call
  const before = queued9.length;
  const callYes = make(Z, "yes, you can listen to my voice", { onCall: true });
  const cr = await callYes.tools.voiceRead.execute({ answer: "yes", theirWords: "yes, you can listen to my voice" }, {});
  check("10. on a call a yes isn't taken: Cue says the fixed line and nothing is on", cr.say === C.VOICE_READ_CALL_LINE && !(await C.voiceReadOnFor(Z, db, env())) && db.consents.get(Z)?.answer !== "yes", cr);
  check("10. the question is queued to go by text, as their own ask", queued9.length === before + 1 && queued9[before].type === "voice_read_ask" && queued9[before].payload?.theyAsked === true && /^voice_read_ask:asked:\d{4}-\d{2}-\d{2}$/.test(queued9[before].targetKey), queued9[before]);
  const callExplain = make(Y, "how does the voice thing work?", { onCall: true });
  const ce = await callExplain.tools.voiceRead.execute({ answer: "explain", theirWords: "how does the voice thing work?" }, {});
  check("10. asking about it on a call after the question already went by text: nothing new is queued or promised, and it isn't a yes", !ce.say && queued9.length === before + 1 && !(await C.voiceReadOnFor(Y, db, env())), ce);
  check("10. their own ask goes after a no or a withdrawal, never while it's on or already sent and unanswered; Cue's own ask only when nothing is on file", V.voiceReadTextDue({ askedAt: new Date(Date.now() - 86_400_000), answer: "no", answeredAt: new Date(), withdrawnAt: null }, true, env()) && !V.voiceReadTextDue({ askedAt: new Date(), answer: null, answeredAt: null, withdrawnAt: null }, true, env()) && !V.voiceReadTextDue({ askedAt: new Date(), answer: null, answeredAt: null, withdrawnAt: null }, false, env()) && !V.voiceReadTextDue({ askedAt: new Date(), answer: "yes", answeredAt: new Date(), withdrawnAt: null }, true, env()) && !V.voiceReadTextDue(null, true, env({ RAILWAY_ENVIRONMENT_NAME: "production" })));
  // Then the written question went (the queue's onSent), and a yes by text counts.
  await C.noteVoiceReadAsked(Z, db);
  const textYes = make(Z, "yes please");
  await textYes.tools.voiceRead.execute({ answer: "yes", theirWords: "yes please" }, {});
  check("10. a yes by text after the written question: on", await C.voiceReadOnFor(Z, db, env()));
  const callStop = make(Z, "actually stop listening to my voice", { onCall: true });
  const cs = await callStop.tools.voiceRead.execute({ answer: "stop", theirWords: "stop listening to my voice" }, {});
  check("10. a stop works on a call", cs.say === C.VOICE_READ_STOP_LINE && !(await C.voiceReadOnFor(Z, db, env())));
  console.log = logLine;
  C.setVoiceReadDepsForTests(null);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// ---------------------------------------------------------------- 11. their words don't outlive a stop in the logs
{
  const G = await import("../../src/agent/toolGuard.js");
  const r = G.voiceReadReceipt("voiceRead", { answer: "yes", theirWords: "yes go ahead, my sister says I sound flat", why: "they said yes", theirYes: "yes go ahead" });
  check("11. the decision log keeps the answer read, never their words", JSON.stringify(r) === JSON.stringify({ answer: "yes" }) && G.voiceReadReceipt("sendReply", {}) === null);
  const guard = readFileSync(new URL("../../src/agent/toolGuard.ts", import.meta.url), "utf8");
  check("11. the guard logs voiceRead like a removal: no message, no input, no why", /const removal = removalReceipt\(name, input\) \?\? voiceReadReceipt\(name, input\);/.test(guard));
  const Q = "66666666-1111-2222-3333-444444444444";
  db.users.set(Q, { phone_number: REAL, voice_read_ok: false });
  await C.noteVoiceReadAsked(Q, db);
  await C.recordVoiceReadYes(Q, "yes", db);
  db.decisions.push({ user_id: Q, decision: "call.voice_read" }, { user_id: Q, decision: "call.voice_read" }, { user_id: Q, decision: "tool.sendReply" }, { user_id: "someone-else", decision: "call.voice_read" });
  await C.turnVoiceReadOff(Q, "stop", db, { endLive: () => 0 });
  check("11. a stop deletes their calls' read logs, nobody else's, nothing else", db.decisions.filter((d) => d.user_id === Q).map((d) => d.decision).join() === "tool.sendReply" && db.decisions.some((d) => d.user_id === "someone-else"), db.decisions);
}

// ---------------------------------------------------------------- 12. a stop while the stream starts: Hume never opens
{
  const R = "55555555-1111-2222-3333-444444444444";
  db.users.set(R, { phone_number: REAL, voice_read_ok: false });
  await C.noteVoiceReadAsked(R, db);
  await C.recordVoiceReadYes(R, "yes", db);
  let reads = 0;
  // The first read sees the yes; the stop lands right after it, before the session is registered.
  B.setBridgeDeps({
    connectHume: () => { const h = new FakeSocket(); humes.push(h); return h as any; },
    takeLink: (id) => L.takeVoiceStreamLink(id, links, new Date(clock)),
    now: () => clock, log: () => {}, record: () => {}, apiKey: () => "dummy",
    allowed: async (userId) => {
      const ok = await C.voiceReadOnFor(userId, db, env());
      if (reads++ === 0) await C.turnVoiceReadOff(R, "stop", db, { endLive: (u) => B.endVoiceSessionsFor(u) });
      return ok;
    },
  });
  const humesBefore = humes.length;
  const link = await L.issueVoiceStreamLink(R, B.callKeyOf(R, "tok-r"), links, new Date(clock));
  const tw = await openWith(link);
  for (let i = 0; i < 5; i++) await tick();
  check("12. stopped while the stream was starting: refused, Hume never opened, no session", humes.length === humesBefore && tw.closed && B.sessionShape(B.callKeyOf(R, "tok-r")) === null, { opened: humes.length - humesBefore, closed: tw.closed });
}

// ---------------------------------------------------------------- 13. a yes needs the question on file, in the statement itself
{
  const N = "44444444-1111-2222-3333-444444444444";
  db.users.set(N, { phone_number: REAL, voice_read_ok: false });
  await C.turnVoiceReadOff(N, "no", db, { endLive: () => 0 }); // a no on file, never asked
  check("13. a row with no question on it: a yes is refused by the statement's guard", (await C.recordVoiceReadYes(N, "ok fine yes", db)).ok === false && !(await C.voiceReadOnFor(N, db, env())));
}

// ---------------------------------------------------------------- 14. re-review: traces, the question once, the call line, a yes in flight, the read log, order
{
  const T = await import("../../src/services/llmTraceText.js");
  const E = await import("../../src/harness/emotion.js");
  const MB = await import("../../src/services/mediaStreamBridge.js");
  const { proactiveRegistry } = await import("../../src/harness/proactiveRegistry.js");
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  // Our own copy of their model calls' text, in a fake store.
  const traces: { user_id: string; text: string }[] = [];
  T.traceTextStore.db = async () => ({ query: async (sql: string, args: unknown[] = []) => {
    if (/^DELETE FROM llm_trace_text WHERE user_id = \$1/.test(sql.trim())) { const before = traces.length; for (let i = traces.length - 1; i >= 0; i--) if (traces[i].user_id === args[0]) traces.splice(i, 1); return { rows: [], rowCount: before - traces.length }; }
    return { rows: [], rowCount: 0 };
  } }) as any;
  const A = "12121212-1111-2222-3333-444444444444";
  db.users.set(A, { phone_number: REAL, voice_read_ok: false });
  await C.noteVoiceReadAsked(A, db);
  await C.recordVoiceReadYes(A, "yes", db);
  const now = new Date();
  db.signals.push({ id: 41, user_id: A, basis: "voice", quote: "it's fine" }, { id: 42, user_id: A, basis: null, quote: "work is a lot" });
  traces.push({ user_id: A, text: "[tool calls] voiceRead {answer: yes, theirWords: yes}" }, { user_id: A, text: "Their last call: sounded tired (voice)" }, { user_id: "someone-else", text: "theirs" });
  const sig = (r: { basis: string | null; quote: string | null }) => ({ source: "call", emotion: "tired", intensity: "high", valence: "negative", about: null, quote: r.quote, at: new Date(now.getTime() - 3600_000), target: "life", basis: r.basis }) as any;
  const momentsBefore = E.summarizeSignals(db.signals.filter((r) => r.user_id === A).map(sig), now).lastCall?.moments ?? [];
  const logFrom = db.log.length;
  await C.turnVoiceReadOff(A, "stop", db, { endLive: () => 0 });
  const momentsAfter = E.summarizeSignals(db.signals.filter((r) => r.user_id === A).map(sig), now).lastCall?.moments ?? [];
  check("14A. a stop forgets their trace text (prompts and the tool call with their words), nobody else's", traces.length === 1 && traces[0].user_id === "someone-else", traces);
  check("14A. voice moments were in their last call before the stop, and can't reach a later reply after it", momentsBefore.some((m: any) => m.basis === "voice") && !momentsAfter.some((m: any) => m.basis === "voice"));
  const emoSrc = readFileSync(new URL("../../src/harness/emotion.ts", import.meta.url), "utf8");
  const gec = emoSrc.slice(emoSrc.indexOf("export async function getEmotionalContext"), emoSrc.indexOf("export async function getEmotionalContext") + 1500);
  check("14A. the reply's emotional context is read fresh from emotion_signals each time (no cache or copy to clear)", /FROM emotion_signals/.test(gec) && !/^(const|let) \w+ = new (Map|Set)\b/m.test(emoSrc));
  // F: the withdrawal is written before anything is deleted, so a racing insert (its own guard) sees it.
  const stopLog = db.log.slice(logFrom);
  const wi = stopLog.findIndex((q) => q.startsWith("UPDATE voice_read_consents SET withdrawn_at = NOW()"));
  const di = stopLog.findIndex((q) => q.startsWith("DELETE FROM emotion_signals"));
  check("14F. stop: the withdrawal is written before the delete", wi >= 0 && di > wi, { wi, di });
  const NO = "13131313-1111-2222-3333-444444444444";
  db.users.set(NO, { phone_number: REAL, voice_read_ok: false });
  const noFrom = db.log.length;
  await C.turnVoiceReadOff(NO, "no", db, { endLive: () => 0, forgetTrace: async () => 0 });
  const noLog = db.log.slice(noFrom);
  check("14F. no: the no is written before the delete", noLog.findIndex((q) => q.startsWith("INSERT INTO voice_read_consents (user_id, answer, answered_at)")) >= 0 && noLog.findIndex((q) => q.startsWith("DELETE FROM emotion_signals")) > noLog.findIndex((q) => q.startsWith("INSERT INTO voice_read_consents (user_id, answer, answered_at)")));

  // B: the question goes once, whichever ask was queued.
  const saved = { ...process.env };
  Object.assign(process.env, env());
  C.setVoiceReadDepsForTests({ db });
  const Bm = "14141414-1111-2222-3333-444444444444";
  db.users.set(Bm, { phone_number: REAL, voice_read_ok: false });
  const person = { userId: Bm, firstName: "Jo", phoneNumber: REAL, city: null, timezone: null } as any;
  const cand = (theyAsked: boolean, createdAt: Date) => ({ id: "x", userId: Bm, type: "voice_read_ask", targetKey: theyAsked ? "voice_read_ask:asked:2026-10-28" : "voice_read_ask", topicKey: "voice_read_ask", summary: "", payload: theyAsked ? { theyAsked: true } : {}, priority: 15, dueAt: createdAt, expiresAt: null, attempts: 0, createdAt }) as any;
  const t0 = new Date(Date.now() - 60_000);
  const theirs = cand(true, t0), cues = cand(false, t0);
  const first = await proactiveRegistry.voice_read_ask.draft(cues, person);
  await proactiveRegistry.voice_read_ask.onSent!(cues, person, [C.VOICE_READ_ASK]);
  const second = await proactiveRegistry.voice_read_ask.draft(theirs, person);
  check("14B. Cue's ask and theirs both queued: the question goes once (the second sees it sent and unanswered)", "messages" in first && "skip" in second, { first, second });
  check("14B. the rule: never while sent and unanswered, never when it went after this ask was made", !V.voiceReadTextDue({ askedAt: new Date(), answer: null, answeredAt: null, withdrawnAt: null }, true, env()) && !V.voiceReadTextDue({ askedAt: new Date(), answer: "no", answeredAt: new Date(), withdrawnAt: null }, true, env(), new Date(Date.now() - 1000)) && V.voiceReadTextDue({ askedAt: new Date(Date.now() - 86_400_000), answer: "no", answeredAt: new Date(), withdrawnAt: null }, true, env(), new Date()));
  // C: on a call, when nothing will go, Cue says nothing new about a text.
  const queuedC: any[] = [];
  C.setVoiceReadDepsForTests({ db, enqueue: async (i) => (queuedC.push(i), { queued: true }) });
  const callTools = (createConversationTools({ userId: Bm, phoneNumber: REAL, resolvedContent: "can you read how I sound?", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, onCall: true, ackSent: "👍", lastCoMessage: "hi", sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any) as any).tools;
  const callR = await callTools.voiceRead.execute({ answer: "explain", theirWords: "can you read how I sound?" }, {});
  check("14C. the question already went and is unanswered: no call line, nothing queued, and Cue is told not to promise a text", !callR.say && !callR.line && queuedC.length === 0 && /Don't promise another text/.test(callR.note), callR);
  C.setVoiceReadDepsForTests({ db, enqueue: async (i) => (queuedC.push(i), { queued: false }) });
  const Cn = "15151515-1111-2222-3333-444444444444";
  db.users.set(Cn, { phone_number: REAL, voice_read_ok: false });
  const callTools2 = (createConversationTools({ userId: Cn, phoneNumber: REAL, resolvedContent: "yes read my voice", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, onCall: true, ackSent: "👍", lastCoMessage: "hi", sendCoReply: async () => true, facts: { add: () => {}, text: () => "" } } as any) as any).tools;
  const callR2 = await callTools2.voiceRead.execute({ answer: "yes", theirWords: "yes read my voice" }, {});
  check("14C. the queue says it won't go (already sent under that key): no call line", !callR2.say && queuedC.length === 1, callR2);
  C.setVoiceReadDepsForTests(null);
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);

  // D: a yes already on its way before the question went doesn't count.
  const Dm = "16161616-1111-2222-3333-444444444444";
  db.users.set(Dm, { phone_number: REAL, voice_read_ok: false });
  const sentAt = Date.now();
  await C.noteVoiceReadAsked(Dm, db);
  check("14D. a yes that arrived before the question went: refused", (await C.recordVoiceReadYes(Dm, "yes", db, new Date(sentAt - 5000))).ok === false && !(await C.voiceReadOnFor(Dm, db, env())));
  check("14D. a yes that arrived after: counts", (await C.recordVoiceReadYes(Dm, "yes", db, new Date(Date.now() + 1000))).ok === true);
  const toolsSrc = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("14D. the reply tool passes when their text arrived", /recordVoiceReadYes\(ctx\.userId, theirWords, undefined, ctx\.turnStartedAt \? new Date\(ctx\.turnStartedAt\) : new Date\(\)\)/.test(toolsSrc));

  // E: the call's read log is written only while it's on.
  const writes: any[] = [];
  const summary = { windows: 3 } as any;
  const off = await MB.recordVoiceReadLog("u-e", summary, { allowed: async () => false, write: async (r) => writes.push(r) });
  const on = await MB.recordVoiceReadLog("u-e", summary, { allowed: async () => true, write: async (r) => writes.push(r) });
  check("14E. stopped before the close wait ended: no call.voice_read row; on: one", !off && on && writes.length === 1 && writes[0].decision === "call.voice_read");
  const mbSrc = readFileSync(new URL("../../src/services/mediaStreamBridge.ts", import.meta.url), "utf8");
  check("14E. the bridge's own writer is that one", /record: \(userId, summary\) => \{\s*void recordVoiceReadLog\(userId, summary\)/.test(mbSrc));
}

B.setBridgeDeps(null);
console.error = errLog;
console.log(`voiceReadConsent: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
