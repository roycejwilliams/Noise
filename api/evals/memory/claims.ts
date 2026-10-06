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
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/SELECT MAX\(created_at\)/.test(sql)) return { rows: [{ at: null }] };
  if (/FROM co_memories WHERE user_id = \$1 AND memory_type IN \('text_exchange', 'call_transcript'\)/.test(sql)) return { rows: memories };
  if (/FROM member_claims WHERE user_id/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: rows.map((r, i) => ({ id: String(i), ...r })) };
  if (/DELETE FROM member_claims/.test(sql)) { rows.length = 0; return { rows: [] }; }
  if (/INSERT INTO member_claims/.test(sql)) { rows.push({ text: p[1], provenance: p[2], kind: p[3], quote: p[4], said_on: p[5], confirmed_on: p[6], expires_on: p[7] }); return { rows: [] }; }
  return { rows: [] };
};
memories.push({ content: `User said: ${NOTE}`, created_at: new Date("2026-09-29T19:52:11Z") });
const fakeModel = (give: any[]) => async () => give;
let live = await C.refreshClaims("u1", at("2026-10-01"), { propose: fakeModel([{ text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: "I am pitching investors Friday" }]) });
check("on 10/1 the refresh keeps the 9/29 note, live, labelled user_said", live.length === 1 && live[0].provenance === "user_said" && rows.length === 1);
memories.length = 0;
memories.push({ content: "[Call] Royce wants an advisor with equity.\nassistant: hi\nuser: I want to bring on an advisor with equity instead of just picking their brain.", created_at: new Date("2026-10-06T15:50:00Z") });
live = await C.refreshClaims("u1", at("2026-10-06"), { propose: fakeModel([{ text: "They want an advisor paid in equity.", provenance: "user_said", kind: "plan", quote: "advisor with equity instead of just picking their brain" }]) });
check("on 10/6 the refresh lets the 9/29 pitch go (it expired 10/3) and keeps what they said this morning", live.length === 1 && /advisor/.test(live[0].text) && !rows.some((r) => /pitch/i.test(r.text)));
check("nothing about Co's own lines in a call is taken as what they said", C.theirWordsOf(memories).every((s) => !/hi$/.test(s.text)) && C.theirWordsOf(memories).length === 1);
check("their talk with a teammate is never a source", C.theirWordsOf([{ content: "User said: pitching Friday [to Mo]", created_at: new Date() }]).length === 0);

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

// ---- recaps stop carrying what has expired
const recapRows: Record<string, string> = { u1: "- They are preparing to pitch investors Friday." };
const writes: string[] = [];
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/SELECT DISTINCT user_id FROM co_memories WHERE memory_type = 'recap'/.test(sql)) return { rows: [{ user_id: "u1" }, { user_id: "u2" }] };
  if (/FROM member_claims WHERE user_id/.test(sql)) return { rows: p[0] === "u1" ? [{ id: "1", text: "They are pitching investors Friday.", provenance: "user_said", kind: "deadline", quote: NOTE.slice(0, 30), said_on: "2026-09-29", confirmed_on: "2026-09-29", expires_on: "2026-10-03" }, { id: "2", text: "They are building Co.", provenance: "user_said", kind: "building", quote: "I am building Co", said_on: "2026-09-20", confirmed_on: "2026-09-20", expires_on: null }] : [] };
  if (/memory_type = 'recap' ORDER BY created_at DESC LIMIT 1/.test(sql)) return { rows: [{ content: recapRows[p[0]] ?? "" }] };
  if (/INSERT INTO co_memories/.test(sql)) { writes.push(String(p[2] ?? p[1])); return { rows: [{ id: "m" }] }; }
  return { rows: [] };
};
const { expireRecaps } = await import("../../src/services/memoryCompaction.js");
const changed = await expireRecaps(at("2026-10-06"));
check("with no new talk at all, an expired claim still leaves the recap (no model call)", changed === 1 && writes.length >= 1 && !writes.some((w) => /pitch/i.test(w)));
check("a member with no claims is left alone", changed === 1);

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
