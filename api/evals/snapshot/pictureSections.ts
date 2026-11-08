// Model-free checks for the picture sections in the member snapshot and the call context (Cue Memory Spec step 6, 2026-11-06):
// services/memberSnapshot.ts (sections 7 to 10) and services/callContext.ts, both rendering services/knowledge/pictureEntries.ts.
// No database, no model.
//   TZ=UTC node evals/runLayer1.mjs evals/snapshot/pictureSections.ts
import fs from "node:fs";
import path from "node:path";
const S = await import("../../src/services/memberSnapshot.js");
const PE = await import("../../src/services/knowledge/pictureEntries.js");
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const CC = await import("../../src/services/callContext.js");
const MK = await import("../../src/services/memberKnowledge.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, JSON.stringify(detail ?? "").slice(0, 600)); } };
const root = new URL("../../src/", import.meta.url).pathname;
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const A = "00000000-0000-4000-8000-0000000000a1";
const at = "2026-10-20T18:00:00.000Z";
const base = (): any => ({
  userId: A, asOf: at, identity: { firstName: "Avery", city: "Oakland", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: at },
  goals: [], asks: [], delivered: [], carrying: [], lessons: [], corrections: [], preferences: [], claims: [], restraint: null, exchanges: [], person: null, limits: null,
  transitions: [], learnedLessons: [], learnedCorrections: [], learnedLimits: { avoid: [], rules: [], availability: null }, events: [], people: [],
});
const knowledge = (): any => ({
  ...base(),
  transitions: [
    { id: "t-open-1", text: "Moving from Boston to Oakland for a new job", quote: "I'm moving to Oakland in March", openedOn: "2026-10-02", closedOn: null, status: "open", source: "said", channel: "text", corrections: [{ at: "2026-10-12T10:00:00.000Z", was: "moving in February", now: "moving in March", quote: "actually March" }], correctionsOmitted: 0, verifiedAt: "2026-10-18T10:00:00.000Z" },
    { id: "t-open-2", text: "Maybe winding down the consulting business", quote: null, openedOn: "2026-10-10", closedOn: null, status: "open", source: "inferred", channel: "call", corrections: [], correctionsOmitted: 0, verifiedAt: "2026-10-15T10:00:00.000Z" },
    { id: "t-closed-1", text: "Finishing the thesis", quote: null, openedOn: "2026-05-01", closedOn: "2026-06-30", status: "resolved", source: "said", channel: "text", corrections: [], correctionsOmitted: 0, verifiedAt: "2026-06-30T10:00:00.000Z" },
  ],
  events: [
    { id: "evt_1", name: "Founders Supper", date: "2026-11-12", when: "upcoming", plan: { source: "planned_events:7", on: "2026-10-18", prov: "said", quote: "I'm going to the founders supper" }, offered: null, attendance: null, outcomes: [], outcomesOmitted: 0, met: null, followedUp: null, verifiedAt: at },
    { id: "evt_2", name: "Jazz Night", date: "2026-10-10", when: "passed", plan: { source: "planned_events:3", on: "2026-10-01", prov: "inferred", quote: null }, offered: { source: "co_memories:sent", on: "2026-10-01", prov: "did" }, attendance: { source: "event_presence:2", on: "2026-10-10", state: "attended", via: "door", prov: "seen", quote: null }, outcomes: [{ source: "suggestion_outcomes:5", on: "2026-10-11", result: "helped", prov: "said", quote: "loved it" }], outcomesOmitted: 0, met: { source: "event_presence:2", on: "2026-10-11", prov: "said", quote: "met someone great" }, followedUp: { source: "co_facts:88", on: "2026-10-12", prov: "did", people: 1 }, verifiedAt: at },
  ],
  people: [
    { id: "pair:abc123:a", how: "matched_at_event", stage: "both_yes", where: "Founders Supper", personName: "Marisol", description: "Cue suggested someone at Founders Supper and both of you said yes.", outcome: null, moreLikeThem: null, quote: null, verifiedAt: "2026-10-19T10:00:00.000Z" },
    { id: "pair:def456:b", how: "matched_at_event", stage: "met", where: "Jazz Night", personName: null, description: "Cue introduced someone at Jazz Night.", outcome: { on: "2026-10-14", quote: "we hit it off", met: "yes", useful: "yes", keptTalking: "yes" }, moreLikeThem: "yes", quote: null, verifiedAt: "2026-10-14T10:00:00.000Z" },
  ],
  learnedLessons: [{ id: "m1", text: "Don't stack questions when they're venting", source: { memoryId: "m1", exchange: "not stored" }, qualifiedBy: null, verifiedAt: "2026-10-05T10:00:00.000Z" }],
  learnedCorrections: [{ id: "c1", field: "city", item: null, was: "Berkeley", now: "Oakland", theirWords: "I live in Oakland now", qualifiedBy: null, verifiedAt: "2026-10-06T10:00:00.000Z" }],
  learnedLimits: { avoid: [{ text: "hackathons", dated: false, verifiedAt: null }], rules: [{ id: "r1", area: "timing", text: "No texts before 9am", basis: "said", expiresAt: null, dated: true, verifiedAt: "2026-10-07T10:00:00.000Z" }], availability: "weeknights after 7" },
});
const sources = (k: any, extra: any = {}): any => ({
  userId: A, zone: "America/Los_Angeles", team: false,
  profile: { firstName: "Avery", city: "Oakland", lifeChapters: [], direction: null, activities: [], blockers: [], availability: null, style: [], updatedAt: new Date(at) },
  knowledge: k, threads: [], coGoals: [], emotions: [], scheduled: [], ledger: [], forgotten: [], names: ["Marisol Vega"], capabilities: ["Cue can search for events near them."], ...extra,
});


// The picture lines of a snapshot (sections 7 to 10) and of a call, as sets of lines.
const picLinesOfSnapshot = (b: { body: string }) => { const out: string[] = []; let on = false; for (const l of b.body.split("\n")) { if (l.startsWith("## ")) on = /^## (7|8|9|10)\./.test(l); else if (on && l.startsWith("- [")) out.push(l); } return out; };
const picLinesOfCall = async (k: any, names: string[] | null) => (await CC.pictureLinesForCall(k, names)).flatMap((b) => b.split("\n")).filter((l) => l.startsWith("- ["));
const NAMES = ["Marisol Vega"];

// ---- each section renders with provenance and date
const built = S.buildSnapshot(sources(knowledge()), { version: 3 });
const body = built.body;
const lines = body.split("\n").filter((l) => l.startsWith("- ["));
const LINE = /^- \[[A-Z][A-Za-z0-9]+ (said|seen|did|inferred)( \d{4}-\d{2}-\d{2})?\] \S/;
check("every line (picture sections too) carries id, provenance, date (undated ones none)", lines.every((l) => LINE.test(l)), lines.filter((l) => !LINE.test(l)));
for (const id of S.PICTURE_SECTION_IDS) check(`section ${id} renders under its title`, body.includes(`## ${S.SECTION_TITLES[id]}`));
check("sections 7 to 10 come after section 6, in order", S.ALL_SECTION_IDS.map((id) => body.indexOf(`## ${S.SECTION_TITLES[id]}`)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
check("transition: said, dated, with their words and its correction", /\[Trtopen1 said 2026-10-18\] Going through \(open\), over text: Moving from Boston to Oakland.*their words: "I'm moving to Oakland in March".*corrected 2026-10-12: was "moving in February", now "moving in March"/.test(body), lines.filter((l) => /Trtopen1/.test(l)));
check("a closed transition is one dated line with its close day", /\[Trtclosed1 said 2026-06-30\] Going through \(resolved 2026-06-30\)/.test(body));
check("event labels are neutral: a plan, an offer, attendance by door, an outcome about the suggestion, 'they said they met', a follow-up", /\[Evevt1p said 2026-10-18\] A plan to go to "Founders Supper", 2026-11-12/.test(body) && /\[Evevt2o did 2026-10-01\] Cue offered "Jazz Night"/.test(body) && /\[Evevt2a seen 2026-10-10\] Attended "Jazz Night", 2026-10-10 \(checked in at the door\)/.test(body) && /\[Evevt2r1 said 2026-10-11\] about the suggestion "Jazz Night": they said it helped/.test(body) && /\[Evevt2m said 2026-10-11\] They said they met someone at "Jazz Night"/.test(body) && /\[Evevt2f did 2026-10-12\] Cue followed up with 1 person after "Jazz Night"/.test(body), lines.filter((l) => /Evevt/.test(l)));
check("a plan whose date has passed is still 'a plan to go to X, date', never a present-tense 'plans to'", !/Plans to go to/.test(body) && /A plan to go to "Jazz Night"|Seems to be a plan to go to "Jazz Night", 2026-10-10/.test(body));
check("an outcome enum is a neutral phrase, never the raw word, and never attendance", !/\bdidnt_help\b|\bhelped\b(?! )/.test(body.replace(/they said it helped/g, "")) && !/Evevt2r1[^\n]*(Attended|Was at)/.test(body));
check("people: third person, one sentence each, no 'you', no run-on 'Where it stands'", (() => { const p = lines.filter((l) => /\[Pe/.test(l)); return p.length === 2 && p.every((l) => !/\byou(r)?\b/i.test(l) && !/Where it stands/.test(l) && /\. Status: [^.]+\./.test(l)); })(), lines.filter((l) => /\[Pe/.test(l)));
check("people: dated, with their side only and their own words", /\[Pepairdef456b said 2026-10-14\] Cue matched them with someone at "?Jazz Night"?\. Status: they met\. They said: met yes, useful yes, kept talking yes\. They want more people like this\. \(their words: "we hit it off"\)/.test(body) || /\[Pepairdef456b said 2026-10-14\] Cue matched them with someone at Jazz Night\. Status: they met\. They said: met yes, useful yes, kept talking yes\. They want more people like this\. \(their words: "we hit it off"\)/.test(body), lines.filter((l) => /Pepairdef/.test(l)));
check("learned: lesson inferred, correction said, avoid/rule/availability said", /\[Lnm1 inferred 2026-10-05\]/.test(body) && /\[Lcc1 said 2026-10-06\] Corrected city: was "Berkeley", now "Oakland"/.test(body) && /\] Not for them: hackathons/.test(body) && /\[Lrr1 said 2026-10-07\] Rule \(timing\): No texts before 9am/.test(body) && /\] Usually free: weeknights after 7/.test(body));

// ---- inferred renders tentative, never settled
const inferredLines = lines.filter((l) => / inferred( |\])/.test(l));
check("inferred entries exist in the picture sections", inferredLines.length >= 3, inferredLines.length);
check("every inferred picture line is tentative (seems / Cue's read)", inferredLines.filter((l) => /\[(Tr|Ev|Pe|Ln|Lc|Lv|Lr|Lf)/.test(l)).every((l) => /Seems|Cue's read/.test(l)), inferredLines);

// ---- unread renders as unread, never as none
const unreadK = knowledge();
unreadK.transitions = []; unreadK.transitionsUnread = true;
unreadK.events = []; unreadK.eventsUnread = true;
unreadK.people = []; unreadK.peopleUnread = true;
unreadK.learnedLessons = []; unreadK.learnedCorrections = []; unreadK.learnedLimits = { avoid: [], rules: [], availability: null }; unreadK.learnedUnread = true;
const ub = S.buildSnapshot(sources(unreadK), { version: 4 });
for (const id of S.PICTURE_SECTION_IDS) {
  const sec = ub.sections.find((x) => x.id === id);
  check(`unread ${id}: renders "couldn't read", not empty and not none`, !!sec && sec.entries.length === 1 && /Couldn't read their .* right now\. That is not the same as there being none/.test(sec.entries[0].text) && sec.entries[0].kind === "unread", sec?.entries);
}
check("unread is not dropped even with no room left", S.fitRanked("people", [{ id: "UnreadPeople", src: "unread:people", date: null, prov: "seen", text: PE.unreadLine("people"), open: true, kind: "unread" }], 0).entries.length === 1);
const guardsK = knowledge(); guardsK.guardsUnread = true; guardsK.transitions = [];
check("a failed guard read makes transitions unread", /Couldn't read their what they're going through/.test(S.buildSnapshot(sources(guardsK), { version: 1 }).body));
check("read and empty renders nothing (not 'none', not unread)", !/## 7\./.test(S.buildSnapshot(sources(base()), { version: 1 }).body));
const baseDeps = (over: any = {}): any => ({ profile: async () => ({ firstName: "Avery", city: null, goals: null, intent: null, updatedAt: null }), zone: async () => null, linkedNames: async () => NAMES, forgotten: async () => [], transitions: async () => [], events: async () => null, people: async () => null, ...over });
const noGuard = await MK.memberKnowledge("u1", { include: ["transitions"] }, baseDeps({ forgotten: undefined }));
check("transitions with no forgotten dependency still say unread (never a quiet empty)", noGuard.transitionsUnread === true && noGuard.transitions!.length === 0);
const callUnread = await picLinesOfCall(unreadK, null);
check("a call whose name lookup failed keeps the unread notes (and no entry that could carry a name)", callUnread.length === 4 && callUnread.every((l) => /Couldn't read their/.test(l)), callUnread);
const callEntriesNoNames = await picLinesOfCall(knowledge(), null);
check("with no name lookup, every entry that could carry a name is left out; only 'couldn't read' notes remain", callEntriesNoNames.every((l) => /Couldn't read their/.test(l)), callEntriesNoNames);

// ---- names: none without consent; the fence still runs; quotes are cleaned on their own, the entry stays
check("no linked name in the body (a double-yes first name is not rendered either)", !/marisol|vega/i.test(body), lines.filter((l) => /marisol|vega/i.test(l)));
const leaky = knowledge();
leaky.learnedLessons[0].text = "Marisol Vega prefers short texts, so keep them short";
const lb = S.buildSnapshot(sources(leaky), { version: 5 });
check("a linked name that slips into a picture line is fenced out", !/marisol|vega/i.test(lb.body) && lb.namesRedacted >= 1, lb.namesRedacted);
check("a linked name in the body still blocks the build (fenceScan)", S.fenceScan({ header: "# h", body: "# h\n- [Pex said 2026-10-01] Marisol is great" }, NAMES, A).nameHits === 1);
const forgot = S.buildSnapshot(sources(knowledge(), { forgotten: [{ field: "lesson", old: "Don't stack questions when they're venting", now: null, ref: "lesson:m1", removed: true }] }), { version: 6 });
check("forgetting guards run over the picture sections", !/stack questions/.test(forgot.body) && forgot.forgotten >= 1, forgot.forgotten);

// ---- the exact follow-on probes, through the real section builders, in the snapshot AND the call
const tRow = (o: any = {}): any => ({ id: "probe-t", text: "splitting up a company", quote: "Marisol and I split up the company. She is moving to Austin to raise a fund with her brother.", openedAt: new Date("2026-10-20T15:00:00Z"), status: "open", closedQuote: null, closedAt: null, lastTouchedAt: new Date("2026-10-25T12:00:00Z"), source: "said", channel: "text", corrections: [{ at: new Date("2026-10-26T12:00:00Z"), was: "splitting", now: "split", quote: "Marisol is leaving. She moved to Austin." }], ...o });
const pRow = (o: any = {}): any => ({ id: "knows:probe", kind: "knows", at: new Date("2026-10-20T20:00:00Z"), eventName: null, firstName: null, doubleYes: false, otherKey: "other-1", mine: null, reached: true, memberAsked: false, introduced: false, ended: null, evidence: {}, outcome: null, note: null, viaNetwork: false, quote: "I already know Marisol. She is going through a divorce and moving to Austin.", ...o });
const probeK = await MK.memberKnowledge("u1", { include: ["transitions", "people"] }, baseDeps({ transitions: async () => [tRow()], people: async () => [pRow()] }));
const probeSnap = S.buildSnapshot(sources(probeK), { version: 10 });
const probeSnapLines = picLinesOfSnapshot(probeSnap);
const probeCallLines = await picLinesOfCall(probeK, NAMES);
for (const [label, ls] of [["snapshot", probeSnapLines], ["call", probeCallLines]] as const) {
  const text = ls.join("\n");
  check(`probe (${label}): the transition quote's follow-on sentences are gone with the name (no Marisol, Austin, fund, brother)`, ls.length >= 2 && !/marisol|austin|raise a fund|brother/i.test(text), ls);
  check(`probe (${label}): the people 'knows' quote's follow-on is gone with the name (no divorce, no Austin)`, !/marisol|divorce|austin/i.test(text), ls);
  check(`probe (${label}): the entries and their ids stay when only a quote is cleaned`, ls.some((l) => /\[Trprobet /.test(l)) && ls.some((l) => /\[Peknowsprobe /.test(l)), ls);
}
check("probe: the call's lines equal the snapshot's lines (one behaviour for both paths)", JSON.stringify(probeCallLines) === JSON.stringify(probeSnapLines), { snap: probeSnapLines, call: probeCallLines });

// ---- no names in either path, for now (a consented name included)
const consented = knowledge();
const snapLines = picLinesOfSnapshot(built);
const callLines = await picLinesOfCall(consented, NAMES);
check("no name in calls either: no 'another member' history line, no Marisol", !callLines.some((l) => /marisol|vega|another member/i.test(l)), callLines);

// ---- one block through both paths: same lines, same order, same dedupe, same budgets, same wording
const dupK = knowledge();
dupK.lessons = [{ text: "Don't stack questions when they're venting", verifiedAt: at }];
dupK.corrections = [{ field: "city", was: "Berkeley", now: "Oakland", verifiedAt: at }];
dupK.limits = { avoid: ["hackathons"], availability: "weeknights after 7", verifiedAt: at };
const dupSnap = picLinesOfSnapshot(S.buildSnapshot(sources(dupK), { version: 7 }));
const dupCall = await picLinesOfCall(dupK, NAMES);
check("an older section's lesson, correction, avoid or availability isn't said twice, in the snapshot and in the call", [dupSnap, dupCall].every((ls) => { const t = ls.join("\n"); return !/Don't stack questions/.test(t) && !/was "Berkeley"/.test(t) && !/hackathons/.test(t) && !/weeknights after 7/.test(t); }), { dupSnap, dupCall });
check("the whole block is the same in both paths (snapshot lines equal call lines, in order)", JSON.stringify(snapLines) === JSON.stringify(callLines) && snapLines.length > 10, { snap: snapLines.length, call: callLines.length });

// ---- the budget holds
const month = (i: number) => String(1 + (i % 12)).padStart(2, "0");
const spread = knowledge();
spread.transitions = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, text: `Going through step ${i}: ${"a long description of a life change ".repeat(3)}`, quote: null, openedOn: "2025-01-01", closedOn: i % 2 ? "2026-10-01" : null, status: i % 2 ? "resolved" : "open", source: "said", channel: "text", corrections: [], correctionsOmitted: 0, verifiedAt: `${i < 100 ? 2025 : 2026}-${month(i)}-15T10:00:00.000Z` }));
const sb = S.buildSnapshot(sources(spread), { version: 8 });
const tr = sb.sections.find((x) => x.id === "transitions")!;
check("200 transitions over 24 months: the section stays within its 900 tokens", tr.tokens <= 900 && tr.budget === 900, { tokens: tr.tokens });
check("the rest is ONE 'Not shown' count line that keeps every id, and counts match", tr.collapsed.length === 1 && /^- \[Not shown /.test(tr.collapsed[0].line) && tr.collapsed[0].entryIds.length === tr.collapsed[0].count && tr.entries.length + tr.collapsed[0].count === 200 && sb.countsMatch, { collapsed: tr.collapsed.length });
check("kept in relevance order: open ones lead", tr.entries[0].open);
const callSpread = await picLinesOfCall(spread, NAMES);
check("a call applies the same per-section budget and the same 'Not shown' wording (lines equal the snapshot's)", JSON.stringify(callSpread) === JSON.stringify(picLinesOfSnapshot(sb)) && callSpread.some((l) => /^- \[Not shown /.test(l)));
const bigPeople = knowledge();
bigPeople.people = Array.from({ length: 60 }, (_, i) => ({ id: `pair:p${i}:a`, how: "matched_at_event", stage: "met", where: "Founders Supper", personName: null, description: "x", outcome: null, moreLikeThem: null, quote: null, verifiedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z` }));
const bigLedger = Array.from({ length: 300 }, (_, i) => ({ id: String(2000 + i), relation: "texted", said: `A long text about number ${i} ${"padding words ".repeat(14)}`, url: null, at: new Date(Date.UTC(2026, 9, 1 + (i % 28))), source: "outbound:x", meta: { ledger: 1, kind: "text" } }));
const cb = S.buildSnapshot(sources(bigPeople, { ledger: bigLedger }), { version: 9 });
check("the picture sections never push the total past the cap", cb.tokens.total <= S.TOTAL_CAP, cb.tokens);
check("core sections are untouched by the picture sections (same text with or without them)", (() => { const w = S.buildSnapshot(sources(knowledge()), { version: 2 }).sections.filter((x) => !S.PICTURE_SECTION_IDS.includes(x.id)); const wo = S.buildSnapshot(sources(base()), { version: 2 }).sections.filter((x) => !S.PICTURE_SECTION_IDS.includes(x.id)); return JSON.stringify(w) === JSON.stringify(wo); })());

// ---- who reads it: this member's own reply and call only (behaviour: every include set, named constants included)
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
const rel = (f: string) => path.relative(root, f);
const files = walk(root);
const OPT_IN = ["transitions", "events", "people", "learned"];
// Every named array of sections in src (a const whose value is a list of section names), by name.
const named = new Map<string, string[]>();
for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:export\s+)?const\s+([A-Z_]+)\s*(?::[^=\n]+)?=\s*(?:\[([^\]]*)\])(?:\s+as const)?\s*;/g)) {
  const items = [...m[2].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  if (items.length && items.every((x) => ["goals", "asks", "delivered", "carrying", "lessons", "corrections", "preferences", "claims", "restraint", "exchanges", "person", "limits", ...OPT_IN].includes(x))) named.set(m[1], items);
}
const resolve = (expr: string): string[] | null => {
  const items: string[] = [];
  for (const part of expr.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (part.startsWith("...")) { const r = named.get(part.slice(3).trim()); if (!r) return null; items.push(...r); } else { const m = part.match(/^"([a-z]+)"$/); if (!m) return null; items.push(m[1]); }
  }
  return items;
};
const includeUses: { file: string; set: string[] }[] = [];
for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/^(?!\s*(?:\/\/|\*)).*?\binclude:\s*(\[[^\]]*\]|[A-Za-z_][\w.]*)/gm)) {
  const expr = m[1];
  const set = expr.startsWith("[") ? resolve(expr.slice(1, -1)) : named.get(expr) ?? null;
  if (set) includeUses.push({ file: rel(f), set });
}
// A memberKnowledge call with no include gets the default set (KNOWLEDGE_SECTIONS): count it as that, so a reader that doesn't name its
// sections is still pinned (services/sweepSelectContext.ts reads the picker's own exchanges this way).
for (const f of files) {
  if (/services\/memberKnowledge\.ts$/.test(f)) continue;
  for (const m of fs.readFileSync(f, "utf8").matchAll(/\bmemberKnowledge\(\s*[A-Za-z_.]+\s*(?:\)|,\s*\{([^}]*)\})/g)) if (!/include/.test(m[1] ?? "")) includeUses.push({ file: rel(f), set: [...MK.KNOWLEDGE_SECTIONS] });
}
const carriers = includeUses.filter((u) => u.set.some((x) => OPT_IN.includes(x)));
check("the include sets that carry a picture section are SNAPSHOT_KNOWLEDGE and CALL_KNOWLEDGE and nothing else (named constants resolved)", carriers.length >= 2 && carriers.every((u) => /services\/(memberSnapshot|callContext|matchPicture)\.ts$|^services\/memberKnowledge\.ts$/.test(u.file)) && [...named].filter(([n, set]) => set.some((x) => OPT_IN.includes(x))).every(([n]) => ["SNAPSHOT_KNOWLEDGE", "CALL_KNOWLEDGE", "OPT_IN_SECTIONS", "PICTURE_SECTION_IDS", "MATCH_SECTIONS"].includes(n)), { carriers, withOptIn: [...named].filter(([, set]) => set.some((x) => OPT_IN.includes(x))).map(([n]) => n) });
check("both carrying sets hold all four sections", OPT_IN.every((x) => (S.SNAPSHOT_KNOWLEDGE as string[]).includes(x) && (CC.CALL_KNOWLEDGE as readonly string[]).includes(x)));
check("the default (no include) never reaches the opt-in sections", OPT_IN.every((x) => !(MK.KNOWLEDGE_SECTIONS as readonly string[]).includes(x)));
const optInRead = await MK.memberKnowledge("u1", {}, baseDeps({ transitions: async () => { throw new Error("must not run"); }, events: async () => { throw new Error("must not run"); }, people: async () => { throw new Error("must not run"); } }));
check("an ordinary read never runs the picture loaders (they are opt-in)", optInRead.transitions!.length === 0 && optInRead.events!.length === 0 && optInRead.people!.length === 0 && !optInRead.transitionsUnread && !optInRead.eventsUnread && !optInRead.peopleUnread);
// The only readers of the snapshot are this member's reply and its fact check; the call reads its own memberKnowledge. The proactive
// check-in call is a call to this member, so it carries the picture too: their own call, which is fine.
const readers = files.filter((f) => /memberSnapshot\.js"|pictureEntries\.js"/.test(fs.readFileSync(f, "utf8")) && !/memberSnapshot\.ts$|pictureEntries\.ts$/.test(f)).map(rel).sort();
const intro = readers.filter((r) => /(matching|intro|sweep|outreach|partner|roomSim|brain\/)/i.test(r));
check("no intro, matching, sweep, outreach or partner file imports the snapshot or the picture renderer", intro.length === 0, intro);


// ---- permitted views: one cleaned source, each reader its own pinned slice (a new reader can't silently widen a view)
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const VIEWS = {
  snapshot: ["goals", "asks", "carrying", "lessons", "corrections", "preferences", "claims", "limits", "transitions", "events", "people", "learned"],
  calls: ["goals", "asks", "corrections", "exchanges", "lessons", "delivered", "carrying", "restraint", "preferences", "limits", "claims", "transitions", "events", "people", "learned"],
};
check("view: the reply snapshot reads exactly its pinned sections", sameSet(S.SNAPSHOT_KNOWLEDGE, VIEWS.snapshot), S.SNAPSHOT_KNOWLEDGE);
check("view: a call reads exactly its pinned sections", sameSet(CC.CALL_KNOWLEDGE, VIEWS.calls), CC.CALL_KNOWLEDGE);
// Matching, sweeps and intro paths: any include set in them is pinned, so a new reader (or a wider set) fails here until the table is
// reviewed. None of them reads the opt-in picture sections or the raw exchanges today; matching reads its own narrow view (#412: the
// member's own goals for fit, and a denylist), never the snapshot, never private conversation as intro copy.
const MATCHING_VIEWS: Record<string, string[]> = {
  "services/goalSweep.ts": ["goals", "asks", "preferences", "limits", "person"],
  "services/sweepFind.ts": ["goals", "asks", "delivered", "lessons", "corrections", "preferences", "claims", "restraint", "person", "limits"],
  // No include: the default set. The sweep picker reads this member's own texts (40 over 14 days) for their own sweep: their own
  // conversation for their own find, not a leak and not an intro input. Pinned so it can't widen.
  "services/sweepSelectContext.ts": ["goals", "asks", "delivered", "carrying", "lessons", "corrections", "preferences", "claims", "restraint", "exchanges", "person", "limits"],
  // #412: matching reads its own narrow view of the same source: the member's own goals for fit, and the denylist that checks intro text
  // (their own private words, so a line the other member reads never quotes them). Pinned: it is the one matching read of the picture
  // sections, and nothing it reads becomes intro copy or the other side's prompt.
  "services/matchPicture.ts": ["goals", "asks", "preferences", "learned", "transitions", "people", "exchanges"],
};
const matchingUses = includeUses.filter((u) => /(sweep|match|intro|outreach|partner|roomSim)/i.test(u.file));
check("view: a memberKnowledge call with no include is the default set, which holds no opt-in picture section", OPT_IN.every((x) => !(MK.KNOWLEDGE_SECTIONS as readonly string[]).includes(x)) && includeUses.some((u) => u.file === "services/sweepSelectContext.ts"));
check("view: every include set in a matching, sweep or intro file is pinned exactly (a new or wider one fails until reviewed)", matchingUses.every((u) => MATCHING_VIEWS[u.file] && sameSet(MATCHING_VIEWS[u.file], u.set)) && Object.keys(MATCHING_VIEWS).every((f) => matchingUses.some((u) => u.file === f)), matchingUses);
check("view: no matching, sweep or intro read takes the conversation itself (exchanges) except the sweep picker's own and matching's denylist (both pinned above), and none takes an opt-in picture section except matching's pinned one", matchingUses.every((u) => (!u.set.includes("exchanges") || u.file === "services/sweepSelectContext.ts" || u.file === "services/matchPicture.ts") && (u.file === "services/matchPicture.ts" || !u.set.some((x) => OPT_IN.includes(x)))), matchingUses);
check("view: every other include set in src is free of the opt-in picture sections", includeUses.filter((u) => !/services\/(memberSnapshot|callContext|matchPicture)\.ts$/.test(u.file) && !/^services\/memberKnowledge\.ts$/.test(u.file)).every((u) => !u.set.some((x) => OPT_IN.includes(x))));

// ---- memory rules, end to end through memberKnowledge, in the snapshot AND the call
const tRows = [tRow({ id: "keep-t", text: "moving to Berkeley for the job", quote: "I'm moving to Berkeley", corrections: [] }), tRow({ id: "gone-t", text: "thinking about leaving the firm", quote: "thinking about leaving", corrections: [] })];
const memK = await MK.memberKnowledge("u1", { include: ["transitions"] }, baseDeps({
  transitions: async () => tRows,
  forgotten: async () => [
    { field: "thread", old: "thinking about leaving the firm", now: null, ref: "thread:gone-t", removed: true },
    { field: "city", old: "Berkeley", now: "Oakland", ref: "profile:city", removed: false },
  ],
}));
const memSnap = picLinesOfSnapshot(S.buildSnapshot(sources(memK, { forgotten: [{ field: "thread", old: "thinking about leaving the firm", now: null, ref: "thread:gone-t", removed: true }, { field: "city", old: "Berkeley", now: "Oakland", ref: "profile:city", removed: false }] }), { version: 11 }));
const memCall = await CC.pictureLinesForCall(memK, NAMES, [{ field: "thread", old: "thinking about leaving the firm", now: null, ref: "thread:gone-t", removed: true }, { field: "city", old: "Berkeley", now: "Oakland", ref: "profile:city", removed: false }]).then((b) => b.flatMap((x) => x.split("\n")).filter((l) => l.startsWith("- [")));
for (const [label, ls] of [["snapshot", memSnap], ["call", memCall]] as const) {
  check(`memory (${label}): what they had Cue forget stays out`, ls.length === 1 && !/leaving the firm/.test(ls.join("\n")), ls);
  check(`memory (${label}): a correction beats the older assumption in the same view (the older wording carries the correction)`, /Berkeley[^\n]*\[since corrected: Oakland\]/.test(ls.join("\n")), ls);
}
check("memory: text and calls get the same permitted facts after the guards", JSON.stringify(memSnap) === JSON.stringify(memCall), { memSnap, memCall });
const callNoGuards = await CC.pictureLinesForCall(memK, NAMES, null);
check("memory (call): if the removals can't be read the entries are left out and the sections say unread, never empty", callNoGuards.join("\n").includes("Couldn't read their") && !/Berkeley/.test(callNoGuards.join("\n")), callNoGuards);
const goalsK = knowledge();
goalsK.goals = [{ text: "find a cofounder", state: "active", reason: null, told: true, onFile: true, hash: "aaaaaaaa11111111", source: "member", verifiedAt: at }, { text: "ship the prototype", state: "done", reason: null, told: true, onFile: true, hash: "bbbbbbbb22222222", source: "member", verifiedAt: at }, { text: "learn Rust", state: "stale", reason: null, told: true, onFile: true, hash: "cccccccc33333333", source: "member", verifiedAt: at }];
const goalBody = S.buildSnapshot(sources(goalsK), { version: 12 }).body;
check("memory (snapshot): a finished or set-aside goal is labelled so, never current", /Goal \(active[^)]*\): find a cofounder/.test(goalBody) && /Goal \(done[^)]*\): ship the prototype/.test(goalBody) && /Goal \(stale[^)]*\): learn Rust/.test(goalBody));
check("memory (call): only the active goals are the member's current goals", JSON.stringify(CC.partsFromKnowledge(goalsK).goals) === JSON.stringify(["find a cofounder"]));

// ---- attendance: saying they were there is evidence; a plan, an offer or an RSVP alone never renders as 'was at'
const EV = await import("../../src/services/knowledge/events.js");
const NOW = new Date("2026-11-06T12:00:00Z");
const evRaw = (o: any) => ({ ...EV.noEvents(), ...o });
const evInfo = (eventId: string, name: string, startAt: string) => ({ eventId, name, startAt: new Date(startAt) });
const evK = (items: any[]) => ({ ...base(), events: items });
const rsvpOnly = EV.eventsOf(evRaw({ info: [evInfo("r1", "Maker Night", "2026-11-12T18:00:00Z"), evInfo("r2", "Past Mixer", "2026-10-20T18:00:00Z")], offers: [{ eventId: "r1", name: "Maker Night", date: "2026-11-12", at: new Date("2026-11-01T10:00:00Z") }, { eventId: "r2", name: "Past Mixer", date: "2026-10-20", at: new Date("2026-10-10T10:00:00Z") }], plans: [{ id: "p1", name: "Maker Night", date: "2026-11-12", provenance: "stated", quote: "I'm going to Maker Night", at: new Date("2026-11-02T10:00:00Z") }, { id: "p2", name: "Past Mixer", date: "2026-10-20", provenance: "stated", quote: "I'm going to Past Mixer", at: new Date("2026-10-11T10:00:00Z") }] }), { now: NOW });
check("attendance: a plan or an offer alone (an RSVP) yields no attendance; a passed one with no evidence is dropped", rsvpOnly.items.length === 1 && rsvpOnly.items[0].attendance === null && rsvpOnly.items[0].name === "Maker Night");
const rsvpBody = PE.pictureEntries(evK(rsvpOnly.items) as any).entries.map((e) => e.text).join("\n");
check("attendance: an RSVP or plan never renders as 'was at' or 'attended'", !/Attended|Was at|was at/.test(rsvpBody) && /A plan to go to "Maker Night"/.test(rsvpBody), rsvpBody);
const textArrival = EV.eventsOf(evRaw({ info: [evInfo("a1", "Text Arrival Night", "2026-10-21T18:00:00Z")], presence: [{ eventId: "a1", arrivedAt: new Date("2026-10-21T18:05:00Z"), arrivedVia: "text", notGoingAt: null, metAt: null, metQuote: null, noshowOutcome: null }] }), { now: NOW });
const saidWent = EV.eventsOf(evRaw({ info: [evInfo("a2", "Supper Club", "2026-10-25T18:00:00Z")], outcomes: [{ key: "event:a2", name: "Supper Club", result: "helped", provenance: "stated", quote: "went last night, it was great", at: new Date("2026-10-26T09:00:00Z") }] }), { now: NOW });
const actedOnly = EV.eventsOf(evRaw({ info: [evInfo("a3", "Salon", "2026-10-22T18:00:00Z")], outcomes: [{ key: "event:a3", name: "Salon", result: "acted", provenance: "stated", quote: "signed up", at: new Date("2026-10-23T09:00:00Z") }] }), { now: NOW });
const attBody = PE.pictureEntries(evK([...textArrival.items, ...saidWent.items, ...actedOnly.items]) as any).entries;
check("attendance: telling Cue they're there (a text arrival) and saying they went (a stated result after the start) are attendance, said, with their words", attBody.some((e) => e.kind === "attended" && e.prov === "said" && /Text Arrival Night.*said by text/.test(e.text)) && attBody.some((e) => e.kind === "attended" && e.prov === "said" && /Supper Club.*said so after it started.*went last night/.test(e.text)), attBody.map((e) => e.text));
check("attendance: 'acted' (signed up or went, can't tell) is not attendance", !attBody.some((e) => /Salon/.test(e.text) && e.kind === "attended"));


// ---- goals at the source: the shared goals section applies the guards, so every reader (snapshot, call, matching, sweeps) gets them
const goalDeps = (forgotten: any) => baseDeps({ profile: async () => ({ firstName: "Avery", city: null, goals: ["find a cofounder in Berkeley", "learn Rust", "run the Oakland half"], intent: null, updatedAt: null }), goalStates: async () => [], forgotten: async () => forgotten });
const goalRows = [
  { field: "goal", old: "learn Rust", now: null, ref: "goal:rust", removed: true },
  { field: "goal", old: "find a cofounder in Berkeley", now: "find a cofounder in Oakland", ref: "goal:cofounder", removed: false },
];
const gk = await MK.memberKnowledge("u1", { include: ["goals"] }, goalDeps(goalRows));
check("goals (source): a forgotten goal is out of the shared goals section", !gk.goals.some((x) => /Rust/.test(x.text)) && gk.goals.length === 2, gk.goals.map((x) => x.text));
check("goals (source): a corrected-away goal carries its correction and is NOT active", gk.goals.some((x) => /find a cofounder in Berkeley \[since corrected: find a cofounder in Oakland\]/.test(x.text) && x.state === "stale"), gk.goals.map((x) => `${x.state} ${x.text}`));
const probeG = await MK.memberKnowledge("u1", { include: ["goals"] }, baseDeps({ profile: async () => ({ firstName: "Avery", city: null, goals: ["move to Austin and open a bakery", "run the Oakland half"], intent: null, updatedAt: null }), goalStates: async () => [{ goalHash: "x", goal: "old plan from goal states", state: "active", reason: "", source: "member", changedAt: new Date("2026-10-01T00:00:00Z"), toldAt: null }], forgotten: async () => [{ field: "goal", old: "move to Austin and open a bakery", now: null, ref: "goal:austin", removed: true }] }));
check("goals (source, probe): a removal row for a goal still in the profile takes it out", !probeG.goals.some((x) => /bakery/.test(x.text)), probeG.goals.map((x) => x.text));
check("goals (source, probe): a goal that exists only in goal_states is never active (onFile false is history)", probeG.goals.filter((x) => x.state === "active").map((x) => x.text).join() === "run the Oakland half" && probeG.goals.some((x) => /old plan/.test(x.text) && x.state === "stale" && !x.onFile), probeG.goals.map((x) => `${x.state} ${x.onFile} ${x.text}`));
const gkCall = CC.partsFromKnowledge(gk as any).goals;
check("goals (call): the call's current goals have no forgotten goal and no corrected-away goal", !gkCall.some((t) => /Rust|Berkeley/.test(t)) && gkCall.includes("run the Oakland half"), gkCall);
const gkSnap = S.buildSnapshot(sources(gk as any), { version: 13 }).body;
check("goals (snapshot): no forgotten goal, and the corrected one carries its correction (once)", !/Rust/.test(gkSnap) && (gkSnap.match(/since corrected: find a cofounder in Oakland/g) ?? []).length === 1, gkSnap.split("\n").filter((l) => /Goal/.test(l)));
const gkUnread = await MK.memberKnowledge("u1", { include: ["goals"] }, goalDeps(null).forgotten ? { ...goalDeps([]), forgotten: async () => { throw new Error("db down"); } } : {});
check("goals (source): if the guards can't be read no goal is shown as current, and guardsUnread says why", gkUnread.goals.length === 0 && gkUnread.guardsUnread === true);


// ---- goals, the delta review: cross-field corrections, unread, the long-term direction
const xDeps = (forgotten: any, extra: any = {}) => baseDeps({ profile: async () => ({ firstName: "Avery", city: "Oakland", goals: ["meet other founders in San Francisco", "get into a design leadership role", "run the Oakland half"], intent: null, updatedAt: null, direction: "build a studio that lasts", ...extra }), goalStates: async () => [], forgotten: async () => forgotten });
const cross = await MK.memberKnowledge("u1", { include: ["goals"] }, xDeps([
  { field: "city", old: "San Francisco", now: "Oakland", ref: "profile:city", removed: false },
  { field: "job", old: "design lead", now: "design director", ref: "profile:job", removed: false },
  { field: "goal", old: "run the Oakland half", now: "run the Oakland full marathon", ref: "goal:half", removed: false },
]));
const st = (t: RegExp) => cross.goals.find((x) => t.test(x.text));
check("goals (cross-field): a city correction annotates a goal but leaves it active", st(/founders in San Francisco/)?.state === "active" && /since corrected: Oakland/.test(st(/founders in San Francisco/)?.text ?? ""), cross.goals.map((x) => `${x.state} ${x.text}`));
check("goals (cross-field): a job correction leaves 'get into a design leadership role' active", st(/design leadership/)?.state === "active", cross.goals.map((x) => `${x.state} ${x.text}`));
check("goals (cross-field): a correction that targets the goal (a goal ref) takes it out of current", st(/Oakland half/)?.state === "stale" && st(/Oakland half/)?.reason === "corrected away", cross.goals.map((x) => `${x.state} ${x.text}`));
check("goals (cross-field): the call's current goals keep the two real goals and drop the corrected-away one", JSON.stringify(CC.partsFromKnowledge(cross as any).goals.map((t) => t.replace(/ \[since.*$/, "")).sort()) === JSON.stringify(["get into a design leadership role", "meet other founders in San Francisco"]), CC.partsFromKnowledge(cross as any).goals);
const dirK = await MK.memberKnowledge("u1", { include: ["goals"] }, baseDeps({ profile: async () => ({ firstName: "Avery", city: null, goals: ["run the Oakland half"], intent: null, updatedAt: null, direction: "build a studio that lasts" }), goalStates: async () => [{ goalHash: (await import("../../src/services/goalEdges.js")).goalHash("build a studio that lasts"), goal: "build a studio that lasts", state: "active", reason: "", source: "member", changedAt: new Date("2026-10-01T00:00:00Z"), toldAt: null }], forgotten: async () => [] }));
check("goals (direction): a long-term direction that has a state row and is still on file stays active and on file", dirK.goals.some((x) => /studio that lasts/.test(x.text) && x.state === "active" && x.onFile), dirK.goals.map((x) => `${x.state} ${x.onFile} ${x.text}`));
const dirGone = await MK.memberKnowledge("u1", { include: ["goals"] }, baseDeps({ profile: async () => ({ firstName: "Avery", city: null, goals: ["run the Oakland half"], intent: null, updatedAt: null, direction: null }), goalStates: async () => [{ goalHash: "h", goal: "build a studio that lasts", state: "active", reason: "", source: "member", changedAt: new Date("2026-10-01T00:00:00Z"), toldAt: null }], forgotten: async () => [] }));
check("goals (direction): a direction that is no longer on file is still history", dirGone.goals.some((x) => /studio that lasts/.test(x.text) && x.state === "stale" && !x.onFile));
const unreadG = await MK.memberKnowledge("u1", { include: ["goals"] }, { ...xDeps([]), forgotten: async () => { throw new Error("db down"); } });
check("goals (unread): guards unread gives no goals AND goalsUnread, so an empty list is never 'no goals'", unreadG.goals.length === 0 && unreadG.goalsUnread === true && unreadG.guardsUnread === true);
check("goals (unread): a good read doesn't set it", cross.goalsUnread === undefined);
const unreadSnap = S.buildSnapshot(sources(unreadG as any), { version: 14 }).body;
check("goals (unread, snapshot): section 2 says it couldn't read their goals", /\[UnreadGoals seen\] Couldn't read their goals right now/.test(unreadSnap), unreadSnap.split("\n").filter((l) => /Goals|goals/.test(l)));
check("goals (unread, call): the call's summary carries the same note instead of an empty goals list", /k\.goalsUnread \? "Couldn't read their goals right now/.test(fs.readFileSync(path.join(root, "services/callContext.ts"), "utf8")));
const GS = await import("../../src/services/goalSweep.js");
check("goals (unread, goalSweep): no plan is made from unread goals", (() => { try { GS.requireGoalsRead(unreadG); return false; } catch { return true; } })() && (() => { try { GS.requireGoalsRead(cross); return true; } catch { return false; } })() && /requireGoalsRead\(k\)/.test(fs.readFileSync(path.join(root, "services/goalSweep.ts"), "utf8")));
const PR = await import("../../src/harness/proactive.js");
check("goals (unread, dispatch): a dispatch skips when goals are unread, and proceeds when they are read", !!PR.goalsUnreadSkip(unreadG) && PR.goalsUnreadSkip(cross) === null && PR.goalsUnreadSkip(null) === null && /goalsUnreadSkip\(known\)/.test(fs.readFileSync(path.join(root, "harness/proactive.ts"), "utf8")));

console.log(`picture sections: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
