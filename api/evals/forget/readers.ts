// Read-time forgetting on the readers that had no guard (forget-delete-spec.md section 7, step 5; context-across-cue-plan.md 3b).
// Layer 1: a fake database and injected loaders, no model, zero tokens.
//   npx tsx evals/forget/readers.ts
//
// One invented member, Ellis. He told Cue about "the custody hearing in May" and then had Cue forget it (a removal row in
// profile_corrections, as applyKnowledgeChanges writes it). A canary he never removed ("climate founders") sits next to it in every
// store. Each reader below must return nothing that says the hearing, and still return the canary.
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const W = await import("../../src/services/whatCoKnows.js");
const MK = await import("../../src/services/memberKnowledge.js");
const CC = await import("../../src/services/callContext.js");
const F = await import("../../src/services/coFacts.js");
const PM = await import("../../src/services/personModel.js");
const CT = await import("../../src/services/callTools.js");
type Deps = import("../../src/services/memberKnowledge.js").KnowledgeDeps;

let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const U = "00000000-0000-4000-8000-0000000e1115";
const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const GONE = /custody|hearing/i;
const CANARY = /climate founders/i;
// What applyKnowledgeChanges writes for a removal (whatCoKnows.ts): the old text, no new value, an item ref, removed = true.
const REMOVAL = { field: "claim", old_value: "the custody hearing in May", new_value: null, item_ref: "claim:1a2b3c4d", removed: "true" };
const removedRows = () => W.liveGuards([{ field: REMOVAL.field, old: REMOVAL.old_value, now: null, ref: REMOVAL.item_ref, removed: true }]);

// ---------------------------------------------------------------- the fake database (only what these readers ask for)
let corrections: any[] = [REMOVAL];
const db = {
  callRows: [
    { created_at: ago(30), memory_type: "call_transcript", content: "assistant: Hey Ellis, good to hear you.\nuser: The custody hearing is in May, so things are a lot right now.\nuser: Anyway, I really want to meet climate founders in the city.\nassistant: Got it, climate founders it is." },
    { created_at: ago(29.9), memory_type: "text_exchange", content: "[Call] Ellis talked through the custody hearing in May and how heavy it is. He wants to meet climate founders, ideally small dinners rather than big mixers." },
  ],
  loops: [
    { id: 41, title: "Send Ellis notes for the custody hearing in May", status: "open", detail: null, due_date: null, source: "member", changed_at: ago(5), last_confirmed_at: ago(5), decay_asked_at: null },
    { id: 42, title: "Shortlist climate founders dinners", status: "open", detail: "He asked twice; custody hearing in May; small rooms", due_date: null, source: "member", changed_at: ago(4), last_confirmed_at: ago(4), decay_asked_at: null },
  ],
  ledger: [
    { relation: "sent", label: "Family lawyers for the custody hearing in May", url: null, at: ago(10), when: null, when_end: null, source: "reply", provenance: null },
    { relation: "sent", label: "Climate founders supper, Thursday", url: "https://lu.ma/climate-supper", at: ago(9), when: null, when_end: null, source: "reply", provenance: null },
  ],
};
const handle = async (sql: string, p: any[] = []) => {
  if (/FROM profile_corrections pc WHERE pc\.user_id = \$1/.test(sql)) return { rows: p[0] === U ? corrections : [] };
  if (/FROM co_memories/.test(sql) && /call_transcript/.test(sql) && /\[Call\]%/.test(sql)) return { rows: db.callRows };
  if (/FROM open_loops/.test(sql) && /closed_at IS NULL/.test(sql)) return { rows: db.loops };
  if (/FROM co_facts/.test(sql) && /subject = 'co'/.test(sql) && /relation <> 'exited'/.test(sql)) return { rows: db.ledger };
  if (/FROM revealed_offers/.test(sql)) return { rows: [
    { item_key: "o1", item_name: "Family law clinic for the custody hearing in May", kind: "opportunity", url: null, sent_at: ago(6), reaction: null },
    { item_key: "o2", item_name: "Bay Area Climate Founders Breakfast", kind: "event", url: "https://lu.ma/cfb", sent_at: ago(5), reaction: null },
  ] };
  if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ phone_number: "+15550000000", first_name: "Ellis" }] };
  return { rows: [] };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });

// ---------------------------------------------------------------- 1. the member-knowledge layer: lessons, loops, promise results, Cue's sent record
const deps = (): Partial<Deps> => ({
  profile: async () => ({ firstName: "Ellis", city: "Oakland", goals: [], intent: [], updatedAt: ago(10) }) as any,
  zone: async () => "America/Los_Angeles",
  linkedNames: async () => [],
  goalStates: async () => [],
  asks: async () => [],
  receipts: async () => [
    { id: 1, userId: U, docKey: "prep", version: 1, title: "Prep notes for the custody hearing in May", kind: "plan", doc: { sections: [] }, contentHash: "x", channel: "text", status: "delivered", line: null, link: "https://docs.example/prep", driveFileId: null, deliveredAt: ago(8) },
    { id: 2, userId: U, docKey: "climate", version: 1, title: "Climate founders dinner plan", kind: "plan", doc: { sections: [] }, contentHash: "y", channel: "text", status: "delivered", line: null, link: "https://docs.example/climate", driveFileId: null, deliveredAt: ago(7) },
  ] as any,
  ledgerSent: async () => [
    { label: "Family lawyers for the custody hearing in May", url: null, kind: "opportunity", at: ago(10) },
    { label: "Climate founders supper, Thursday", url: "https://lu.ma/climate-supper", kind: "event", at: ago(9) },
  ],
  offers: async () => [
    { key: "o1", name: "Family law clinic for the custody hearing in May", kind: "opportunity", url: null, sentAt: ago(6), reaction: null, details: null, postText: null },
    { key: "o2", name: "Bay Area Climate Founders Breakfast", kind: "event", url: "https://lu.ma/cfb", sentAt: ago(5), reaction: null, details: null, postText: null },
    { key: "o3", name: "Weekend legal aid fair", kind: "opportunity", url: null, sentAt: ago(5), reaction: null, details: null, postText: "Free help before the custody hearing in May" },
  ],
  tasks: async () => [],
  briefs: async () => [],
  loops: async () => [
    { id: 41, title: "Send Ellis notes for the custody hearing in May", status: "open", dueDate: null, source: "member", detail: null, changedAt: ago(5), lastConfirmedAt: ago(5) },
    { id: 42, title: "Shortlist climate founders dinners", status: "open", dueDate: null, source: "member", detail: "He asked twice; custody hearing in May; small rooms", changedAt: ago(4), lastConfirmedAt: ago(4) },
  ],
  promiseResults: async () => [
    { at: ago(2), content: "Kept: sent the custody hearing in May checklist" },
    { at: ago(1), content: "Kept: sent the climate founders shortlist" },
  ],
  lessons: async () => [
    { text: "Never joke about the custody hearing in May; keep it light", at: ago(20) },
    { text: "He wants climate founders, small rooms, never mixers", at: ago(19) },
  ],
  corrections: async () => [],
  taste: async () => null,
  roomTaste: async () => [],
  designTaste: async () => [],
  claims: async () => [],
  restraint: async () => null as any,
  exchanges: async () => [],
  person: async () => "",
  limits: async () => null,
});
const all = (k: unknown) => JSON.stringify(k);
{
  const k = await MK.memberKnowledge(U, { now: NOW }, { ...deps(), forgotten: async () => removedRows() });
  check("layer: a lesson with any part saying the removed thing goes whole (no \"keep it light\" left to widen); the other stays", !GONE.test(all(k.lessons)) && k.lessons.length === 1 && k.lessons[0].text === "He wants climate founders, small rooms, never mixers");
  check("layer: a document they have, named by the removed thing, is gone from delivered and carrying; the canary doc stays", !/Prep notes/.test(all(k.delivered)) && !/Prep notes/.test(all(k.carrying)) && /Climate founders dinner plan/.test(all(k.delivered)));
  check("layer: a find Cue sent first, named by it or from a post saying it, is gone; the canary find stays", !/Family law clinic|legal aid fair/.test(all(k.delivered)) && /Climate Founders Breakfast/.test(all(k.delivered)));
  check("layer: a loop titled with the removed thing is gone; the canary loop stays, its detail without that part", !GONE.test(all(k.carrying)) && CANARY.test(all(k.carrying)) && /small rooms/.test(all(k.carrying)));
  check("layer: a promise result saying it is gone; the other stays", !/checklist/.test(all(k.carrying)) && /climate founders shortlist/.test(all(k.carrying)));
  check("layer: Cue's record of what it sent: the removed item is gone, the canary send stays", !GONE.test(all(k.delivered)) && CANARY.test(all(k.delivered)));
  check("layer: nothing anywhere in the record says it", !GONE.test(all(k)));
  // Only lessons asked for: the guards are still read (they used to be read only with exchanges or corrections).
  const only = await MK.memberKnowledge(U, { now: NOW, include: ["lessons"] }, { ...deps(), forgotten: async () => removedRows() });
  check("layer: lessons alone still go through the removals", only.lessons.length === 1 && !GONE.test(all(only.lessons)));
  // No removals: everything as before, word for word.
  const none = await MK.memberKnowledge(U, { now: NOW }, { ...deps(), forgotten: async () => [] });
  check("layer, no removals: both lessons, both loops, both sends, docs and finds, as they were", none.lessons.length === 2 && GONE.test(all(none.lessons)) && GONE.test(all(none.carrying)) && GONE.test(all(none.delivered)) && /Prep notes/.test(all(none.delivered)) && /Family law clinic/.test(all(none.delivered)) && /legal aid fair/.test(all(none.delivered)));
  // A correction (not a removal) never cuts these sources: "Oakland" corrected to "Berkeley" leaves a lesson naming Oakland as it is.
  const corr = await MK.memberKnowledge(U, { now: NOW, include: ["lessons"] }, { ...deps(), lessons: async () => [{ text: "Lives in Oakland, likes small dinners", at: ago(3) }], forgotten: async () => W.liveGuards([{ field: "city", old: "Oakland", now: "Berkeley", ref: "profile:city", removed: false }]) });
  check("layer: a correction leaves a lesson's words as they are (only removals cut)", corr.lessons[0]?.text === "Lives in Oakland, likes small dinners");
}

// ---------------------------------------------------------------- 2. past calls in the call summary (registered with ElevenLabs at the start)
{
  const g = CC.guardCallRows(db.callRows, removedRows(), W);
  const t = g.find((r) => r.memory_type === "call_transcript")?.content ?? "";
  const n = g.find((r) => r.memory_type === "text_exchange")?.content ?? "";
  check("call rows: the transcript loses the line that says it, keeps the rest line by line", !GONE.test(t) && CANARY.test(t) && /^assistant: Hey Ellis/.test(t) && t.split("\n").length === 3);
  check("call rows: a [Call] note the guard drops as a whole is dropped whole (not rebuilt from its other sentences)", n === "");
  const multi = CC.guardCallRows([{ created_at: ago(1), memory_type: "text_exchange", content: "[Call] He wants climate founders; he mentioned the custody hearing in May." }], removedRows(), W)[0]?.content ?? "";
  check("call rows: a [Call] note of several parts keeps the parts that don't say it", !GONE.test(multi) && CANARY.test(multi) && multi.startsWith("[Call] "));
  const split = CC.guardCallRows([{ created_at: ago(1), memory_type: "text_exchange", content: "[Call] Ellis has a hearing in May. It's about custody of his kids, and he wants to meet climate founders." }], removedRows(), W);
  check("call rows: the reviewer's split note (the fact across two sentences) is dropped, not half-kept", split.length === 0 || !GONE.test(split[0].content));
  check("call rows: no removals, rows untouched (same objects)", CC.guardCallRows(db.callRows, [], W) === db.callRows);
  check("call rows: a row that is only the removed thing is dropped", CC.guardCallRows([{ created_at: ago(1), memory_type: "text_exchange", content: "[Call] The custody hearing in May." }], removedRows(), W).length === 0);
  const k = await CC.buildCallKnowledge(U);
  check("call summary (what elevenLabsCalls registers): nothing says the removed thing", !GONE.test(k.summary) && !GONE.test(k.facts) && !GONE.test(k.impressions));
  check("call summary: the canary from the same call is still there", CANARY.test(k.summary));
  check("call summary: what Cue sent lately never names the removed find; the canary find is there", !/Family law clinic/.test(k.summary + k.facts) && /Climate Founders Breakfast/.test(k.summary + k.facts));
  corrections = [];
  const before = await CC.buildCallKnowledge(U);
  check("call summary, no removals: the call's words and the find are there (the fixture reaches the summary)", GONE.test(before.summary) && /Family law clinic/.test(before.summary + before.facts));
  corrections = [REMOVAL];
}

// ---------------------------------------------------------------- 3. Cue's ledger (the reply's "what's true right now", the call audit)
{
  const l = await F.ledgerFacts(U, "", "America/Los_Angeles");
  check("ledger: the removed send is gone, the canary send stays", !GONE.test(l.lines.join("\n")) && CANARY.test(l.lines.join("\n")));
  const named = await F.ledgerFacts(U, "did you send the custody hearing lawyers?", "America/Los_Angeles");
  check("ledger: naming it in a message doesn't bring it back", !GONE.test(named.named.join("\n")) && !GONE.test(named.lines.join("\n")));
  corrections = [];
  check("ledger, no removals: both sends", GONE.test((await F.ledgerFacts(U, "", "America/Los_Angeles")).lines.join("\n")));
  corrections = [REMOVAL];
}

// ---------------------------------------------------------------- 4. the person model's loops, and the call tools' loop list
{
  const parts = await PM.personModelParts(U);
  check("person model: the loop that says it is gone, the canary loop stays", !GONE.test(parts.loops) && CANARY.test(parts.loops));
  const m = await CT.loadMemberOnCall(U);
  check("call tools: the loop list has the canary, never the removed loop", !!m.loops && CANARY.test(m.loops) && !GONE.test(m.loops));
  corrections = [];
  check("person model, no removals: both loops", GONE.test((await PM.personModelParts(U)).loops));
  corrections = [REMOVAL];
}

// ---------------------------------------------------------------- 4b. the loop decay job and the loop_check draft (they can text a member)
{
  const OL = await import("../../src/services/openLoops.js");
  const R = await import("../../src/harness/proactiveRegistry.js");
  const P = await import("../../src/harness/proactive.js");
  const day = (iso: string) => new Date(`${iso}T18:00:00Z`);
  const stale = { status: "open", dueDate: null, source: "member", closedAt: null, closedReason: null, decayAskedAt: null, lastConfirmedAt: day("2026-10-11"), changedAt: day("2026-10-11"), userId: U, zone: "America/Los_Angeles" };
  const loopsNow = [
    { id: 71, title: "Send Ellis notes for the custody hearing in May", detail: null, ...stale },
    { id: 72, title: "Shortlist climate founders dinners", detail: null, ...stale },
  ] as any[];
  const closed: { id: number; reason: string }[] = [];
  const asked: number[] = [];
  const deps = { live: async () => loopsNow, close: async (id: number, reason: any) => { closed.push({ id, reason }); }, expire: async () => {}, ask: async (l: any) => { asked.push(l.id); return true; } };
  const out = await OL.runLoopDecay(day("2026-10-19"), { ...deps, removals: async () => removedRows() });
  check("decay: a stale loop whose subject they removed is closed as removed, never asked about; the canary loop is asked", closed.some((c) => c.id === 71 && c.reason === "removed") && !asked.includes(71) && asked.includes(72) && out.removed === 1);
  closed.length = 0; asked.length = 0;
  await OL.runLoopDecay(day("2026-10-19"), { ...deps, removals: async () => null });
  check("decay: when their removals can't be read, nothing is asked (fails closed) and nothing is closed as removed", asked.length === 0 && !closed.some((c) => c.reason === "removed"));
  closed.length = 0; asked.length = 0;
  await OL.runLoopDecay(day("2026-10-19"), { ...deps, removals: async () => [] });
  check("decay, no removals: both loops asked about as before", asked.includes(71) && asked.includes(72) && closed.length === 0);
  check("decay: a loop closed as removed is a tombstone the sync keeps closed", /closed_reason IN \('co', 'expired', 'date_passed', 'answered', 'removed'\)/.test(src("services/openLoops.ts")));
  check("decay: the real job reads the removals", /removals: \(userId\) => loopRemovals\(userId\)/.test(src("services/openLoops.ts")));

  // The loop_check draft: the loop row and the payload it drafts from, both checked.
  let loopRow: any = { closed_at: null, last_confirmed_at: day("2026-09-01"), title: "Send Ellis notes for the custody hearing in May", detail: null };
  let failGuards = false;
  const updates: string[] = [];
  const prevQuery = (pool as any).query;
  (pool as any).query = async (sql: string, p: any[] = []) => {
    if (/SELECT closed_at, last_confirmed_at, title, detail FROM open_loops/.test(sql)) return { rows: [loopRow] };
    if (/FROM profile_corrections pc WHERE pc\.user_id = \$1/.test(sql)) { if (failGuards) throw new Error("guard read failed"); return { rows: corrections }; }
    if (/^\s*UPDATE open_loops SET status = 'dropped'/.test(sql)) { updates.push(`${sql.match(/closed_reason = '([a-z_]+)'/)?.[1]}:${p[0]}`); return { rows: [], rowCount: 1 }; }
    return prevQuery(sql, p);
  };
  let drafted = 0;
  P.setProactiveModelForTests(async () => { drafted++; return "Is the climate dinners shortlist still on your plate?"; });
  const cand = (title: string, note?: string) => ({ userId: U, type: "loop_check", payload: { loopId: 71, title, ...(note ? { note } : {}) } }) as any;
  const person = { firstName: "Ellis" } as any;
  // The queued payload's title is clean (renamed since), the loop row itself says it: the row is checked too.
  const d1: any = await (R.proactiveRegistry as any).loop_check.draft(cand("Notes Ellis asked for"), person);
  check("loop_check: a loop whose subject they removed (in its row) is not drafted, and is closed as removed (no text)", drafted === 0 && !d1?.messages && updates.includes("removed:71"));
  updates.length = 0;
  loopRow = { ...loopRow, title: "Shortlist climate founders dinners" };
  const d2: any = await (R.proactiveRegistry as any).loop_check.draft(cand("Shortlist climate founders dinners", "Prep for the custody hearing in May first"), person);
  check("loop_check: the payload's note saying it also stops the draft", drafted === 0 && !d2?.messages && updates.includes("removed:71"));
  updates.length = 0;
  failGuards = true;
  const d3: any = await (R.proactiveRegistry as any).loop_check.draft(cand("Shortlist climate founders dinners"), person);
  check("loop_check: removals unreadable, nothing drafted (fails closed), the loop left open", drafted === 0 && !d3?.messages && updates.length === 0);
  failGuards = false;
  const d4: any = await (R.proactiveRegistry as any).loop_check.draft(cand("Shortlist climate founders dinners"), person);
  check("loop_check: the canary loop is still drafted", drafted === 1 && Array.isArray(d4?.messages) && updates.length === 0);
  P.setProactiveModelForTests(null as any);
  (pool as any).query = prevQuery;
}

// ---------------------------------------------------------------- 5. the wiring (each reader reads the guards; a mutation that drops it fails above)
check("wiring: memberKnowledge reads the guards for lessons, carrying and delivered too", /\["exchanges", "corrections", "lessons", "carrying", "delivered"\]/.test(src("services/memberKnowledge.ts")));
check("wiring: the reply's sent list goes through withoutRemovedSent", /M\.withoutRemovedSent\(items, await W\.forgottenRows\(userId\), W\)/.test(src("services/turnContext.ts")));
{
  const MKs = MK.withoutRemovedSent([{ name: "Family law clinic for the custody hearing in May", postText: null }, { name: "Climate founders supper", postText: null }], removedRows(), W);
  check("withoutRemovedSent: the removed find goes, the canary stays; no removals is the same list", MKs.length === 1 && CANARY.test(MKs[0].name) && MK.withoutRemovedSent(db.ledger as any, [], W) === (db.ledger as any));
}
check("wiring: buildCallKnowledge guards the past calls before pairing them", /guardCallRows\(rows, await W\.forgottenRows\(userId\)/.test(src("services/callContext.ts")));

console.log(`forget readers: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
