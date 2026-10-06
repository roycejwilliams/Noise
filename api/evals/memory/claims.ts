// Claims with a provenance label and a lifetime (services/factLabels.ts, services/claims.ts). Layer 1: fake database, fake model, zero tokens.
//   npx tsx evals/memory/claims.ts
//
// The regression (2026-10-06): "I am pitching investors Friday" (said 9/29, for Friday 10/2) lived on as "preparing to pitch Friday" in
// a recap that REVISED ITS OWN last recap each night, until a 10/6 text stated it back. Here the same note goes through the rebuild.
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const L = await import("../../src/services/factLabels.js");
const C = await import("../../src/services/claims.js");
const S = await import("../../src/harness/proactiveSpecifics.js");
const { default: pool } = await import("../../src/db/db.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const at = (iso: string) => new Date(`${iso}T20:00:00Z`); // noon-ish in San Francisco

// ---- the two labels
check("what someone is building, their city, a cofounder: enduring. A plan, a deadline, a mood, a worry, an exploration, a pending decision: ephemeral", ["identity", "building", "relationship", "city", "role", "preference"].every((k) => (L.KINDS as any)[k].lifetime === "enduring") && ["plan", "deadline", "meeting", "mood", "exploring", "worry", "pending_decision"].every((k) => (L.KINDS as any)[k].lifetime === "ephemeral"));
const NOTE = "I am pitching investors Friday and I keep freezing on the ask. What should I do?";
check("user_said needs a real quote: one that is in what they sent keeps the label", L.checkProvenance("user_said", "I am pitching investors Friday", NOTE).provenance === "user_said");
check("a quote that is not in what they sent downgrades the claim to Co's inference, with no quote", L.checkProvenance("user_said", "I am raising a seed round next month", NOTE).provenance === "co_inferred" && L.checkProvenance("user_said", "I am raising a seed round next month", NOTE).quote === null);
check("a missing or too-short quote can't be user_said", L.checkProvenance("user_said", null, NOTE).provenance === "co_inferred" && L.checkProvenance("user_said", "Friday", NOTE).provenance === "co_inferred");
check("what Co says it concluded stays an inference", L.checkProvenance("co_inferred", NOTE.slice(0, 20), NOTE).provenance === "co_inferred");

// ---- lifetimes, in code
check("'Friday', said on a Tuesday, is the coming Friday", L.resolveDate("pitching investors Friday", "2026-09-29") === "2026-10-02");
check("the same weekday means today; a date resolves; tomorrow resolves; no date is null", L.resolveDate("Friday", "2026-10-02") === "2026-10-02" && L.resolveDate("meeting on Oct 9", "2026-10-06") === "2026-10-09" && L.resolveDate("tomorrow", "2026-10-06") === "2026-10-07" && L.resolveDate("freezing on the ask", "2026-10-06") === null);
const pitch = { kind: "deadline" as const, provenance: "user_said" as const, text: "They are pitching investors Friday.", quote: "I am pitching investors Friday", saidOn: "2026-09-29", confirmedOn: "2026-09-29" };
check("a dated claim ends the day after its date: the 9/29 pitch ends 10/3", L.expiresOn(pitch) === "2026-10-03");
check("it is live on Friday itself and gone the next day", L.isLive({ expiresOn: "2026-10-03" }, at("2026-10-02")) && !L.isLive({ expiresOn: "2026-10-03" }, at("2026-10-03")) && !L.isLive({ expiresOn: "2026-10-03" }, at("2026-10-06")));
const ex = (kind: any, provenance: any = "user_said", text = "x thing here") => L.expiresOn({ kind, provenance, text, quote: null, saidOn: "2026-10-01", confirmedOn: "2026-10-01" });
check("enduring never expires", ex("building") === null && ex("city") === null && ex("relationship") === null);
check("undated ephemeral claims last their kind's days from when they were said: mood 3, plan 7, exploring 10", ex("mood") === "2026-10-04" && ex("plan") === "2026-10-08" && ex("exploring") === "2026-10-11");
check("what Co only inferred decays faster (at most 7 days)", ex("exploring", "co_inferred") === "2026-10-08" && ex("pending_decision", "co_inferred") === "2026-10-08" && ex("pending_decision", "user_said") === "2026-10-15");

// ---- the model proposes, code decides
const sources = [{ at: "2026-09-29", text: NOTE }, { at: "2026-09-29", text: "I need to tell my cofounder I want to change our equity split. How do I start that conversation?" }];
const fin = C.finishClaims([
  { text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: "I am pitching investors Friday", said_on: "2099-01-01" },
  { text: "They have a board meeting Monday.", provenance: "user_said", kind: "meeting", quote: "I have a board meeting Monday" },
  { text: "They seem stretched thin.", provenance: "co_inferred", kind: "mood" },
  { text: "Bogus kind.", provenance: "user_said", kind: "vibes", quote: "I am pitching investors Friday" },
  { text: "", provenance: "user_said", kind: "plan" },
], sources, "2026-10-06");
check("the 9/29 note: user_said, deadline, said on the day of the message that holds the quote (not the model's date), ends 10/3", fin[0].provenance === "user_said" && fin[0].saidOn === "2026-09-29" && fin[0].expiresOn === "2026-10-03" && fin[0].quote === "I am pitching investors Friday");
check("a user_said claim whose quote is made up is downgraded; an unknown kind and an empty claim are dropped", fin[1].provenance === "co_inferred" && fin[1].quote === null && fin.length === 3 && fin[2].text === "They seem stretched thin.");

// ---- said again is re-confirmed; an inference never extends or overwrites what they said
const held = [{ ...pitch, expiresOn: L.expiresOn(pitch) }];
const again = C.finishClaims([{ text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: "pitching investors Friday" }], [{ at: "2026-10-05", text: "still pitching investors Friday, nervous" }], "2026-10-05");
const merged = C.mergeClaims(held, again);
check("saying it again moves the clock (re-confirmed, one claim, not two)", merged.length === 1 && merged[0].confirmedOn === "2026-10-05");
const inferred = { ...pitch, provenance: "co_inferred" as const, quote: null, text: "They are pitching investors Friday.", saidOn: "2026-10-05", confirmedOn: "2026-10-05", expiresOn: "2026-10-10" };
const m2 = C.mergeClaims(held, [inferred]);
check("an inference never extends or relabels what they said", m2.length === 1 && m2[0].provenance === "user_said" && m2[0].confirmedOn === "2026-09-29" && m2[0].expiresOn === "2026-10-03");

// ---- the rendering: only live claims, labelled, and what Co read into it apart
const claims = [
  { ...pitch, expiresOn: "2026-10-03" },
  { text: "They are building Co, a private social club.", provenance: "user_said" as const, kind: "building" as const, quote: "I am building Co", saidOn: "2026-09-20", confirmedOn: "2026-09-20", expiresOn: null },
  { text: "They want an advisor paid in equity.", provenance: "user_said" as const, kind: "plan" as const, quote: "advisor with equity", saidOn: "2026-10-05", confirmedOn: "2026-10-05", expiresOn: "2026-10-12" },
  { text: "They seem to be weighing a raise.", provenance: "co_inferred" as const, kind: "exploring" as const, quote: null, saidOn: "2026-10-05", confirmedOn: "2026-10-05", expiresOn: "2026-10-12" },
];
const recap1 = C.renderRecap(claims, at("2026-10-01"));
const recap6 = C.renderRecap(claims, at("2026-10-06"));
check("on 10/1 the pitch is live, labelled as something they said, with its date", /pitching investors Friday\. \(they said, Sep 29, until Oct 2\)/.test(recap1));
check("on 10/6 the pitch is simply not in the recap (the old recap still had it)", !/pitch|Friday|investor/i.test(recap6) && /advisor paid in equity/.test(recap6));
check("what they said and what Co read into it are in separate, labelled sections", /Who they are \(they said\)/.test(recap6) && /What is going on right now \(they said it/.test(recap6) && /Co's read \(inference: orientation only, never state it back/.test(recap6) && recap6.indexOf("advisor paid in equity") < recap6.indexOf("weighing a raise"));
check("enduring claims stay however old", /building Co/.test(C.renderRecap(claims, at("2027-03-01"))) && !/advisor paid in equity/.test(C.renderRecap(claims, at("2027-03-01"))));

// ---- the nightly refresh, with a fake database and a fake model
const rows: any[] = [];
const memories: any[] = [];
let state: Date | null = null;
const tx: string[] = [];
let failHeldRead = false, failInsertAt = -1, inserts = 0, lastSince: any = null;
const handle = async (sql: string, p: any[] = []) => {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) { tx.push(sql.trim().split(/\s/)[0]); return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(sql)) { tx.push("LOCK"); return { rows: [] }; }
  if (/FROM member_claims_state/.test(sql)) return { rows: state ? [{ refreshed_at: state }] : [] };
  if (/INSERT INTO member_claims_state/.test(sql)) { state = p[1]; return { rows: [] }; }
  if (/FROM co_memories WHERE user_id = \$1 AND memory_type IN \('text_exchange', 'call_transcript'\)/.test(sql)) { lastSince = p[1]; return { rows: memories }; }
  if (/FROM member_claims WHERE user_id/.test(sql) && /^\s*SELECT/.test(sql)) { if (failHeldRead) throw new Error("connection reset"); return { rows: rows.map((r, i) => ({ id: String(i), ...r })) }; }
  if (/DELETE FROM member_claims/.test(sql)) { rows.length = 0; return { rows: [] }; }
  if (/INSERT INTO member_claims/.test(sql)) { if (inserts++ === failInsertAt) throw new Error("insert failed"); rows.push({ text: p[1], provenance: p[2], kind: p[3], quote: p[4], said_on: p[5], confirmed_on: p[6], expires_on: p[7] }); return { rows: [] }; }
  return { rows: [] };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });
memories.push({ content: `User said: ${NOTE}`, created_at: new Date("2026-09-29T19:52:11Z") });
const fakeModel = (give: any[]) => async () => give;
let live = await C.refreshClaims("u1", at("2026-10-01"), { propose: fakeModel([{ text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: "I am pitching investors Friday" }]) });
check("on 10/1 the refresh keeps the 9/29 note, live, labelled user_said", live.length === 1 && live[0].provenance === "user_said" && rows.length === 1);
check("the rewrite is one transaction under a per-member lock", tx.join() === "BEGIN,LOCK,COMMIT");
check("a first run reads back FIRST_RUN_DAYS (120), not 14, so what they said long ago is not lost", Math.round((at("2026-10-01").getTime() - new Date(lastSince).getTime()) / 86400_000) === C.FIRST_RUN_DAYS && C.FIRST_RUN_DAYS >= 90);
check("the next run reads from where the last one stopped", await (async () => { memories.length = 0; await C.refreshClaims("u1", at("2026-10-02"), { propose: fakeModel([]) }); return +new Date(lastSince) === +at("2026-10-01"); })());
// a failed read of what is held must never wipe it
tx.length = 0; failHeldRead = true;
const before = rows.length;
let threw = false;
try { await C.refreshClaims("u1", at("2026-10-03"), { propose: fakeModel([]) }); } catch { threw = true; }
failHeldRead = false;
check("a failed read of the held claims aborts the refresh (rolled back), and nothing is deleted", threw && rows.length === before && tx.includes("ROLLBACK") && !tx.includes("COMMIT"));
// a failed model call must not move the marker or touch the claims
state = at("2026-10-03"); memories.push({ content: "User said: I want a new advisor soon, equity not cash", created_at: new Date("2026-10-04T10:00:00Z") });
tx.length = 0; threw = false;
try { await C.refreshClaims("u1", at("2026-10-05"), { propose: async () => { throw new Error("model down"); } }); } catch { threw = true; }
check("a failed model call rolls back and leaves the marker where it was (the same words are read again tomorrow)", threw && +state! === +at("2026-10-03") && tx.includes("ROLLBACK") && rows.length === before);
// a failure partway through the inserts rolls the delete back too
rows.push({ text: "They are building Co.", provenance: "user_said", kind: "building", quote: "I am building Co", said_on: "2026-09-20", confirmed_on: "2026-09-20", expires_on: null });
tx.length = 0; inserts = 0; failInsertAt = 0; threw = false;
try { await C.refreshClaims("u1", at("2026-10-05"), { propose: fakeModel([]) }); } catch { threw = true; }
failInsertAt = -1;
check("an insert failing partway rolls the whole rewrite back", threw && tx.includes("ROLLBACK") && !tx.includes("COMMIT"));
rows.length = 0;
memories.length = 0;
memories.push({ content: "[Call] Royce wants an advisor with equity.\nassistant: hi\nuser: I want to bring on an advisor with equity instead of just picking their brain.", created_at: new Date("2026-10-06T15:50:00Z") });
live = await C.refreshClaims("u1", at("2026-10-06"), { propose: fakeModel([{ text: "They want an advisor paid in equity.", provenance: "user_said", kind: "plan", quote: "advisor with equity instead of just picking their brain" }]) });
check("on 10/6 the refresh lets the 9/29 pitch go (it expired 10/3) and keeps what they said this morning", live.length === 1 && /advisor/.test(live[0].text) && !rows.some((r) => /pitch/i.test(r.text)));
check("nothing about Co's own lines in a call is taken as what they said", C.theirWordsOf(memories).every((s) => !/hi$/.test(s.text)) && C.theirWordsOf(memories).length === 1);
check("a call that is only their lines still counts", C.theirWordsOf([{ content: "user: I moved to Austin last month and I am building Co.", created_at: new Date() }]).length === 1);
check("their talk with a teammate is never a source", C.theirWordsOf([{ content: "User said: pitching Friday [to Mo]", created_at: new Date() }]).length === 0);
check("a claim Co inferred is dated by the latest words it came from, not today and not the model's word", C.finishClaims([{ text: "They seem to be weighing a raise.", provenance: "co_inferred", kind: "exploring", said_on: "2099-01-01" }], [{ at: "2026-09-29", text: NOTE }], "2026-10-06")[0].saidOn === "2026-09-29");

// ---- dates the parser should and should not find
check("'decide 2 hires' and 'marketing 3 channels' are not dates", L.resolveDate("we need to decide 2 hires", "2026-10-06") === null && L.resolveDate("testing marketing 3 channels", "2026-10-06") === null);
check("real months still parse: 'Oct 9', 'October 9th', 'Dec 2', 'sept 30'", L.resolveDate("Oct 9", "2026-10-06") === "2026-10-09" && L.resolveDate("October 9th", "2026-10-06") === "2026-10-09" && L.resolveDate("Dec 2", "2026-10-06") === "2026-12-02" && L.resolveDate("sept 30", "2026-09-01") === "2026-09-30");
check("a date months behind stays in the past (so the claim ends, not lives a year); a near January date said in December is next year", L.resolveDate("I pitched on Mar 3", "2026-10-06") === "2026-03-03" && L.resolveDate("flying out Jan 5", "2026-12-20") === "2027-01-05");
check("so a plan that mentions a long-past date is not live", !L.isLive({ expiresOn: L.expiresOn({ kind: "plan", provenance: "user_said", text: "Redo the Mar 3 deck", quote: null, saidOn: "2026-10-06", confirmedOn: "2026-10-06" }) }, at("2026-10-06")));

// ---- recaps stop carrying what has expired (even for a member with nothing live), and a recap is never wiped before it is rebuilt
const { EMPTY_RECAP, expireRecaps } = await import("../../src/services/memoryCompaction.js");
let recapRows: Record<string, string> = { u1: "- They are preparing to pitch investors Friday.", u2: "Old prose recap: they live in Austin and build Co." };
let stateRows: Record<string, boolean> = { u1: true, u2: false };
let heldRows: Record<string, any[]> = { u1: [{ text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: "I am pitching investors Friday", said_on: "2026-09-29", confirmed_on: "2026-09-29", expires_on: "2026-10-03" }], u2: [] };
const writes: Record<string, string> = {};
const handle2 = async (sql: string, p: any[] = []) => {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/SELECT DISTINCT user_id FROM co_memories WHERE memory_type = 'recap'/.test(sql)) return { rows: [{ user_id: "u1" }, { user_id: "u2" }] };
  if (/FROM member_claims_state/.test(sql)) return { rows: stateRows[p[0]] ? [{ refreshed_at: new Date("2026-10-05") }] : [] };
  if (/INSERT INTO member_claims_state/.test(sql)) { stateRows[p[0]] = true; return { rows: [] }; }
  if (/memory_type IN \('text_exchange', 'call_transcript'\)/.test(sql)) return { rows: [{ content: "User said: I live in Austin and I am building Co, a private social club.", created_at: new Date("2026-09-20T18:00:00Z") }] };
  if (/FROM member_claims WHERE user_id/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: heldRows[p[0]].map((r, i) => ({ id: String(i), ...r })) };
  if (/DELETE FROM member_claims/.test(sql)) { heldRows[p[0]] = []; return { rows: [] }; }
  if (/INSERT INTO member_claims/.test(sql)) { heldRows[p[0]].push({ text: p[1], provenance: p[2], kind: p[3], quote: p[4], said_on: p[5], confirmed_on: p[6], expires_on: p[7] }); return { rows: [] }; }
  if (/memory_type = 'recap' ORDER BY created_at DESC LIMIT 1/.test(sql)) return { rows: [{ content: writes[p[0]] ?? recapRows[p[0]] ?? "" }] };
  if (/INSERT INTO co_memories/.test(sql)) { writes[p[0]] = String(p[2] ?? p[1]); return { rows: [{ id: "m" }] }; }
  return { rows: [] };
};
(pool as any).query = handle2;
(pool as any).connect = async () => ({ query: handle2, release: () => {} });
const rebuild = (id: string, now: Date) => C.refreshClaims(id, now, { propose: fakeModel([{ text: "They live in Austin and are building Co, a private social club.", provenance: "user_said", kind: "building", quote: "I live in Austin and I am building Co" }]) });
const changed = await expireRecaps(at("2026-10-06"), { refresh: rebuild });
check("expired claims leave the recap with no new talk (no model call); the pitch is gone", /^Nothing current is on record/.test(writes.u1 ?? "") && !/pitch|Friday/i.test(writes.u1 ?? ""));
check("a member whose claims all expired gets a neutral recap written, not the old one left in place", writes.u1 === EMPTY_RECAP);
check("a member never refreshed (first run after this ships) is rebuilt from what they said, not wiped: city and what they are building survive", changed === 2 && /Austin/.test(writes.u2 ?? "") && /building Co/.test(writes.u2 ?? "") && /Who they are \(they said\)/.test(writes.u2 ?? ""));
// when the rebuild fails, their recap stays exactly as it was
for (const k of Object.keys(writes)) delete writes[k];
stateRows = { u1: true, u2: false }; heldRows = { u1: [], u2: [] };
console.log = ((orig) => (...a: any[]) => { if (!/expireRecaps skipped/.test(String(a[0]))) orig(...a); })(console.log);
const errOrig = console.error; console.error = () => {};
const changed2 = await expireRecaps(at("2026-10-06"), { refresh: async () => { throw new Error("model down"); } });
console.error = errOrig;
check("a failed rebuild leaves that member's recap untouched (the other member is still expired)", writes.u2 === undefined && writes.u1 === EMPTY_RECAP && changed2 === 1);

// ---- the stale line, in the draft: replay this morning's post-call text with the rebuilt facts
const P = await import("../../src/harness/proactive.js");
const { draftPostCallText } = await import("../../src/jobs/postCallFollowUp.js");
const labelled = L.renderLive(live, at("2026-10-06"));
const CALL = "assistant: Hey Royce, it's Co.\nuser: The angle is scarcity, so Co is worth acquiring.\nuser: I want to bring on an advisor with equity instead of just picking their brain.";
const FAB = "The scarcity angle, building to acquire, bringing on an advisor with equity. That's going to come through Friday even if the ask part feels shaky.";
const ASK = "The scarcity angle and an advisor on equity sound like a real structure. Anything coming up this week I should know about?";
{
  const seen: string[] = [];
  P.setProactiveModelForTests(async (prompt) => { seen.push(prompt); return seen.length === 1 ? FAB : ASK; });
  const r = await draftPostCallText("Royce", CALL, "He's preparing to pitch investors Friday and has been working through freezing on the ask.", [], { theySaid: [...labelled.enduring, ...labelled.theySaid], coInferred: labelled.coInferred });
  check("replay: the post-call draft is handed only live, labelled claims; the stale pitch is in none of them", seen.length === 2 && !/live_things_they_said[^\n]*pitch/i.test(seen[0]) && /live_things_they_said: .*advisor/.test(seen[0]));
  check("replay: the invented Friday is caught and the redraft asks", !!r && r.text === ASK && !/Friday|pitch/.test(r.text));
}
// the inferred label: Co's read can orient, never be stated back as theirs
const F = { live_things_they_said: ["They want an advisor paid in equity. (they said, Oct 5)"], background_co_read_orientation_only_never_say_you_told_me: ["They seem to be weighing a raise."] };
const unb = (t: string, f: any = F) => S.unbackedSpecifics(t, f, { now: at("2026-10-06") }).map((x) => x.why);
check("'you've been weighing a raise' stated as theirs, when only Co inferred it, is caught", unb("You've been weighing a raise lately.").some((w) => /only Co inferred/.test(w)));
check("'you told me you're prepping the investor ask' is caught", unb("You told me you're prepping the investor ask.").length >= 1);
check("what they did say can be stated back: 'you said you want an advisor with equity'", unb("You said you want an advisor with equity.").length === 0);
check("the same inference asked about is fine", unb("Are you weighing a raise right now?").length === 0 && unb("Is a raise something you're weighing?").length === 0);
check("an ordinary line with no attribution is untouched", unb("The advisor idea sounds like a real structure.").length === 0);

// ---- wiring
const mc = src("services/memoryCompaction.ts");
check("the recap is no longer a model revising its own last recap", !/Your previous recap of them/.test(mc) && /refreshClaims\(userId\)/.test(mc) && /renderRecap\(live, new Date\(\)\)/.test(mc) && !/generateText/.test(mc));
check("expired claims leave the recap daily, even for a quiet member", /await expireRecaps\(\)/.test(src("jobs/index.ts")));
check("only a claim still inside its lifetime is stored", /if \(!isLive\(c, now, ZONE\)\) continue;/.test(src("services/claims.ts")));
check("a call's text and a member's own texts are the only sources (never Co's lines)", src("services/claims.ts").includes("\\[to [A-Za-z]+\\]") && src("services/claims.ts").includes("user\\s*:"));
check("the claim extractor keeps prompts out of the trace store and says a test prompt is not a claim", /recordInputs: false, recordOutputs: false/.test(src("services/claims.ts")) && /A test prompt, a hypothetical/.test(src("services/claims.ts")));
check("the post-call text gets what they said and Co's read as separate, labelled facts", /live_things_they_said/.test(src("jobs/postCallFollowUp.ts")) && /background_co_read_orientation_only_never_say_you_told_me/.test(src("jobs/postCallFollowUp.ts")));

P.setProactiveModelForTests(null);
console.log(`claims, labels and lifetimes: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
