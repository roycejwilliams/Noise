// The text reply reads the member snapshot (snapshot design 2026-10-29 §2 and §6, rollout step 3), no database, no model:
//   - the pin: the reply's prefix stays byte-for-byte the same across a member's turns while only additions happen (they go in a "Since
//     then" block); it moves on a removal, a correction or any changed line, past the cache's life, and when "Since then" grows too big.
//     A new version alone never moves it.
//   - fail closed: a read that fails or is fenced gives no snapshot and drops the member's pin (the turn runs on its tail and rules).
//   - the fact check reads the entries under their own ids: Cue's read and an act that didn't happen back nothing; Cue's acts back
//     what it did; what Cue can do is a capability. The reply's tail never repeats them.
//   - the reply path no longer retrieves memories, filters them with a model, or builds the context summary (source shape).
//   TZ=UTC node evals/runLayer1.mjs evals/snapshot/replyRead.ts
import fs from "node:fs";
const S = await import("../../src/services/memberSnapshot.js");
const G = await import("../../src/harness/replyGrounding.js");
const { capabilitySheet, perTurnSheet } = await import("../../src/services/capabilities.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, JSON.stringify(detail ?? "").slice(0, 600)); } };

const A = "00000000-0000-4000-8000-0000000000a1";
const at = "2026-10-20T18:00:00.000Z";
const knowledge = (claims: any[] = []): any => ({
  userId: A, asOf: at, identity: { firstName: "Avery", city: "Oakland", zone: "America/Los_Angeles" }, goals: [], asks: [{ id: "ask-1", text: "jazz nights near Oakland", kind: "find", verifiedAt: at }], delivered: [],
  carrying: [{ what: "a venue for the launch", kind: "task", state: "due", told: true, theyHaveIt: false, dueAt: null, ref: "task #12", status: null, detail: null, verifiedAt: at },
    { what: "the Friday plan", kind: "document", state: "done", told: true, theyHaveIt: true, dueAt: null, ref: "doc #3", status: null, detail: null, verifiedAt: at }],
  lessons: [], corrections: [], preferences: [], claims, restraint: null, exchanges: [], person: null, limits: null,
});
const claim = (text: string, provenance = "user_said") => ({ text, provenance, kind: "plan", quote: null, expiresOn: null, saidOn: "2026-10-18", verifiedAt: at });
const sources = (o: { claims?: any[]; ledger?: any[] } = {}): any => ({
  userId: A, zone: "America/Los_Angeles", team: false,
  profile: { firstName: "Avery", city: "Oakland", lifeChapters: [], direction: null, activities: [], blockers: [], availability: null, style: [], updatedAt: new Date(at) },
  knowledge: knowledge(o.claims ?? [claim("Learning salsa for my birthday"), claim("Probably burned out at work", "co_inferred")]),
  threads: [], coGoals: [], emotions: [], scheduled: [],
  ledger: o.ledger ?? [
    { id: "4711", relation: "sent", said: "Friday Jazz Trio", url: "https://lu.ma/jazz", at: new Date(at), source: "memory:x", meta: { ledger: 1, kind: "offer" } },
    { id: "4712", relation: "not_done", said: "used writeDocument", url: null, at: new Date(at), source: "tool.writeDocument", meta: { ledger: 1, kind: "tool", receipt: "not_done" } },
    { id: "4713", relation: "did", said: "saved for the team", url: null, at: new Date(at), source: "tool.saveFeedbackForTeam", meta: { ledger: 1, kind: "tool", receipt: "limited" } },
  ],
  forgotten: [], names: [], capabilities: capabilitySheet({}),
});
const build = (src: any, version: number) => S.buildSnapshot(src, { version });

// ---- entries
const v1 = build(sources(), 1);
const entries = S.parseEntries(v1.body);
const byId = (id: string) => entries.find((e) => e.id === id || e.id.startsWith(id));
check("every rendered entry is read back with its section, provenance and words", entries.length === v1.sections.reduce((n, s) => n + s.entries.length, 0) && byId("Pcity")?.section === "words" && byId("L4711")?.section === "ledger" && byId("X1")?.section === "can", entries.map((e) => `${e.section}:${e.id}`));
check("an item in their world is open until its line says done", byId("Wtask12")?.open === true && byId("Wdoc3")?.open === false, [byId("Wtask12"), byId("Wdoc3")]);
check("section 6 is the whole sheet, in order", JSON.stringify(entries.filter((e) => e.section === "can").map((e) => e.text)) === JSON.stringify(capabilitySheet({})));

// ---- the pin
const t0 = Date.parse(at);
const p1 = S.pinStep(null, v1, t0);
check("the first read pins", p1.repinned === "none" && p1.pin.body === v1.body && p1.since.length === 0);
const v2 = build(sources(), 2);
const p2 = S.pinStep(p1.pin, v2, t0 + 60_000);
check("a new version with the same lines keeps the pin (the header's version alone never moves it)", p2.repinned === null && p2.pin.body === v1.body && p2.since.length === 0);
const added = sources();
added.ledger = [{ id: "4800", relation: "texted", said: "Want the jazz trio link again?", url: null, at: new Date(at), source: "outbound:h2", meta: { ledger: 1, kind: "text" } }, ...added.ledger];
const v3 = build(added, 3);
const p3 = S.pinStep(p2.pin, v3, t0 + 120_000);
check("an addition keeps the prefix byte for byte and goes in Since then", p3.repinned === null && p3.pin.body === v1.body && p3.since.length === 1 && /^- \[L4800 did /.test(p3.since[0]), p3.since);
const removed = sources({ claims: [claim("Probably burned out at work", "co_inferred")] });
const v4 = build(removed, 4);
const p4 = S.pinStep(p3.pin, v4, t0 + 180_000);
check("a removal re-pins: what they had Cue forget never stays in the prefix", p4.repinned === "changed" && p4.pin.body === v4.body && !/salsa/i.test(p4.pin.body) && p4.since.length === 0);
const corrected = sources({ claims: [claim("Learning bachata for my birthday"), claim("Probably burned out at work", "co_inferred")] });
const p5 = S.pinStep(S.pinStep(null, v1, t0).pin, build(corrected, 5), t0 + 60_000);
check("a correction (a changed line) re-pins", p5.repinned === "changed" && !/salsa/i.test(p5.pin.body));
const p6 = S.pinStep(p1.pin, v3, t0 + S.PIN_TTL_MS + 1);
check("past the cache's life the pin moves to the current version", p6.repinned === "ttl" && p6.pin.body === v3.body && p6.since.length === 0);
const flood = sources();
flood.ledger = Array.from({ length: 80 }, (_, i) => ({ id: String(5000 + i), relation: "texted", said: `A long text Cue sent them about the jazz trio, the gallery opening and the run club, number ${i}`, url: null, at: new Date(at), source: `outbound:f${i}`, meta: { ledger: 1, kind: "text" } }));
const p7 = S.pinStep(p1.pin, build({ ...flood, ledger: [...flood.ledger, ...sources().ledger] }, 6), t0 + 60_000);
check("a Since then block past its cap re-pins", p7.repinned === "since_full" && p7.since.length === 0);

// ---- the read: fail closed, and the pin survives turns
S.clearPinsForTests();
const logs: any[] = [];
const log = async (d: any) => void logs.push(d);
const read = (body: string | null, state: any = "fresh", version = 1) => async () => ({ snapshot: body === null ? null : { userId: A, version, builtAt: new Date(at), body, sections: [], tokens: {}, blocked: null, dirtyAt: null }, state, waitedMs: 0, buildMs: null });
const r1 = await S.replySnapshot(A, { read: read(v1.body), now: () => t0, log });
const r2 = await S.replySnapshot(A, { read: read(v3.body, "rebuilt", 3), now: () => t0 + 60_000, log });
check("two turns: the same prefix, the addition in Since then, every current entry for the check", !!r1 && !!r2 && r2.prefix === r1.prefix && r2.since.length === 1 && r2.entries.some((e) => e.id === "L4800") && r2.pinnedVersion === 1 && r2.version === 3);
const blocked = await S.replySnapshot(A, { read: read(null, "blocked"), now: () => t0 + 90_000, log });
check("a fenced read gives no snapshot", blocked === null && logs.at(-1)?.decision === "snapshot.reply" && logs.at(-1)?.action === "blocked");
const r3 = await S.replySnapshot(A, { read: read(v3.body, "fresh", 3), now: () => t0 + 100_000, log });
check("a failed or fenced read drops the pin: the next read pins afresh, never the older prefix", r3?.repinned === "none" && r3.prefix === v3.body);
const thrown = await S.replySnapshot(A, { read: async () => { throw new Error("db down"); }, now: () => t0 + 110_000, log });
check("a read that throws gives no snapshot", thrown === null && logs.at(-1)?.action === "failed");
check("the turn's log carries counts only, never a line of it", logs.every((d) => !/Oakland|jazz|salsa/i.test(JSON.stringify(d))), logs);

// ---- the fact check reads the entries
const rf = G.baseReplyFacts(undefined, { entries: r2!.entries });
const kind = (id: string) => rf.facts.find((f) => f.id === id || f.id.startsWith(id))?.kind;
check("what they said is known; Cue's read is a hint (never support)", kind("Pcity") === "known" && rf.facts.filter((f) => f.snap && /burned out/.test(f.text)).every((f) => f.kind === "hint"));
check("Cue's acts back what it did; one that didn't happen (not_done, a receipt other than done) backs nothing", kind("L4711") === "did_before" && kind("L4800") === "did_before" && kind("L4712") === "hint" && kind("L4713") === "hint");
check("an open item in their world is scheduled work; a closed one is what Cue did; the sheet is capabilities", kind("Wtask12") === "scheduled" && kind("Wdoc3") === "did_before" && kind("X1") === "capability");
check("with a snapshot, the tail carries no copy of the sheet; without one, the whole sheet goes in the tail", rf.facts.filter((f) => f.kind === "capability" && !f.snap).length === 0 && G.baseReplyFacts().facts.filter((f) => f.kind === "capability").length === capabilitySheet({}).length);
check("the walk-in ask (known only per turn) goes in the tail when it's due", (() => { const w = G.baseReplyFacts({ kit: false, tasks: false, eventToday: true, walkin: true }, { entries: r2!.entries }); return perTurnSheet({ kit: false, tasks: false, eventToday: true, walkin: true }).every((l) => w.facts.some((f) => !f.snap && f.text === l)) && perTurnSheet({ kit: false, tasks: false, eventToday: true, walkin: true }).length === 1; })());
G.addFact(rf, "known", "Today is Tuesday.");
check("the tail's own facts are numbered F1.. whatever the snapshot holds", rf.facts.find((f) => f.text === "Today is Tuesday.")?.id === "F1");
check("the reply's tail leaves the snapshot out; every other reader gets it", !G.renderReplyFacts(rf, { tail: true }).includes("Lives in: Oakland") && G.renderReplyFacts(rf, { tail: true }).includes("[F1] Today is Tuesday.") && G.renderReplyFacts(rf).includes("Lives in: Oakland"));
const src = { message: "did you send me the jazz thing?", recentConversation: "" };
const cl = (text: string, type: any, factId: string | null, quote: string | null = null) => ({ text, type, supported: true, factId, quote });
const [sentOk, didntOk, readOk, canOk] = G.claimChecks([cl("I sent you the Friday Jazz Trio", "past_action", "L4711"), cl("I wrote that document", "past_action", "L4712"), cl("you're burned out", "member_life", rf.facts.find((f) => /burned out/.test(f.text))!.id), cl("I can look up events", "capability", "X3")], rf, src);
check("the check: a sent item backs 'I sent it', a not_done receipt doesn't, Cue's read doesn't, a sheet line backs a capability", sentOk.pass && !didntOk.pass && !readOk.pass && canOk.pass, [sentOk, didntOk, readOk, canOk].map((c) => c.reason));

// ---- source shape: the reply path
const read2 = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const sb = read2("routes/sendblue.ts"), cr = read2("agent/conversationReply.ts"), rg = read2("harness/replyGrounding.ts");
check("the text reply no longer retrieves memories, filters them with a model, or builds the context summary", !/filterRelevantMemories|recentMemoriesP|content_embedding <=>|buildContextSummary\(/.test(sb) && !/filterRelevantMemories|contextSummary|recentMemories/.test(cr));
check("the text reply reads the snapshot once and hands it to the facts and the reply", /replySnapshot\(user\.id\)/.test(sb) && /snapshot: replySnapshot,\n\s+turn: turn/.test(sb) && /snapshot: replySnapshot,\n\s+personaPrompt/.test(sb));
check("the snapshot is its own cached system block, between Cue's core and this turn", /content: sharedSystem, providerOptions: \{ anthropic: \{ cacheControl[\s\S]{0,120}content: input\.snapshot\.prefix, providerOptions: \{ anthropic: \{ cacheControl[\s\S]{0,80}content: system \}/.test(cr));
check("the reply's tail renders the facts without the snapshot", /renderReplyFacts\(input\.facts, \{ tail: true \}\)/.test(cr));
check("gatherReplyFacts no longer reads what the snapshot carries (sent texts, search notes, the person summary, the ledger lines, follow-ups)", !/recentlySent\(|recentSearchNotes\(|getPersonSnapshot|renderSnapshot|followup_context|ledgerFacts\(|ledger\.lines/.test(rg));

console.log(`snapshot reply read: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
