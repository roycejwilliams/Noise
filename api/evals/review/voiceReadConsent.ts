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
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
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
      if (!r || !r.asked_at) return { rows: [], rowCount: 0 };
      Object.assign(r, { answer: "yes", answered_at: new Date(), yes_quote: String(args[1]), withdrawn_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith("UPDATE voice_read_consents SET withdrawn_at = NOW(), yes_quote = NULL")) { const r = row(); if (r) Object.assign(r, { withdrawn_at: new Date(), yes_quote: null }); return { rows: [], rowCount: r ? 1 : 0 }; }
    if (q.startsWith("INSERT INTO voice_read_consents (user_id, answer, answered_at) VALUES ($1, 'no', NOW())")) { const r = row() ?? blank(); Object.assign(r, { answer: "no", answered_at: new Date(), yes_quote: null }); db.consents.set(id, r); return { rows: [], rowCount: 1 }; }
    if (q.startsWith("DELETE FROM emotion_signals WHERE user_id = $1 AND basis = 'voice'")) { const before = db.signals.length; db.signals = db.signals.filter((s) => !(s.user_id === id && s.basis === "voice")); return { rows: [], rowCount: before - db.signals.length }; }
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
check("4. the queued send reads the state again and skips unless it's still due; it marks asked when sent", /voiceReadAskDue\(await C\.readVoiceReadConsent\(c\.userId\)\)/.test(regEntry) && /return skip\(/.test(regEntry) && /noteVoiceReadAsked\(c\.userId\)/.test(regEntry));
const tools = readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
const toolSrc = tools.slice(tools.indexOf("    voiceRead: tool({"), tools.indexOf("    answerShareAsks: tool({"));
check("4. the reply tool won't put the question to them again after a no or a withdrawal", /answer === "explain" && \(was === "no" \|\| was === "withdrawn"\)\) \{[^}]*return \{ ok: false/.test(toolSrc));
check("4. the reply tool takes only their own words, and a yes counts only after the question", /quoteIsTheirs\(theirWords, ctx\.resolvedContent\)/.test(toolSrc) && /if \(!onFile\?\.askedAt\) \{/.test(toolSrc) && toolSrc.indexOf("if (!onFile?.askedAt)") < toolSrc.indexOf("recordVoiceReadYes"));
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

B.setBridgeDeps(null);
console.error = errLog;
console.log(`voiceReadConsent: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
process.exit(0);
