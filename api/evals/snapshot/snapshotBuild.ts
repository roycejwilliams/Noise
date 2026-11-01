// The member snapshot's pure parts (services/memberSnapshot.ts; snapshot design step 2, shadow), no database:
//   - the size policy: the oldest closed entries collapse into dated count lines that keep their ids, within the budget; open items
//     never collapse (a section of open items alone overflows and says so); section 6 is never collapsed; deterministic; nothing lost
//   - the build: every line has its id, provenance and date; their linked members' names are out of every line; what they removed is
//     out, what they corrected carries the correction; the header carries no clock
//   - the fence: a planted linked name or another member's user id in the body is a block; the header's own first name isn't
//   - who reads it: only the text reply (step 3, through replySnapshot); the read and check lanes don't yet (source shape)
//   TZ=UTC node evals/runLayer1.mjs evals/snapshot/snapshotBuild.ts
import fs from "node:fs";
import path from "node:path";
const S = await import("../../src/services/memberSnapshot.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, JSON.stringify(detail ?? "").slice(0, 600)); } };
type Entry = import("../../src/services/memberSnapshot.js").Entry;

// ---- size policy
const day = (n: number) => new Date(Date.UTC(2026, 9, 30) - n * 86_400_000).toISOString().slice(0, 10);
const ledger = (n: number, open = false): Entry => ({ id: `L${1000 + n}`, src: `co_facts:${1000 + n}`, date: day(Math.floor(n / 3)), prov: "did", text: `texted: "Found you a jazz trio for Friday, and a gallery opening on Saturday, number ${n}"`, open, kind: open ? "promised" : n % 4 ? "texted" : "sent" });
const many = Array.from({ length: 400 }, (_, i) => ledger(i));
const fit = S.fitSection("ledger", [...many, ledger(900, true), ledger(901, true)], 3000);
const collapsedN = fit.collapsed.reduce((n, c) => n + c.count, 0);
check("over budget: the section fits its budget after collapsing", fit.tokens <= 3000 && collapsedN > 0 && !fit.overBudget, { tokens: fit.tokens, collapsedN });
check("open entries are never collapsed", fit.entries.filter((e) => e.open).length === 2 && fit.collapsed.every((c) => !c.ids.some((id) => /co_facts:190[01]$/.test(id))));
const keptDates = fit.entries.filter((e) => !e.open).map((e) => e.date!);
const colDates = fit.collapsed.flatMap((c) => [c.from!, c.to!]);
check("the OLDEST closed entries are the ones collapsed (every kept one is at least as new)", Math.min(...keptDates.map((d) => Date.parse(d))) >= Math.max(...colDates.map((d) => Date.parse(d))), { oldestKept: keptDates.sort()[0], newestCollapsed: colDates.sort().pop() });
check("nothing lost: kept + collapsed = every entry, and each collapse line keeps its source ids", fit.entries.length + collapsedN === 402 && fit.collapsed.every((c) => c.ids.length === c.count && c.ids.every((id) => /^co_facts:\d+$/.test(id))), { kept: fit.entries.length, collapsedN });
check("a collapse line is dated and counts by kind, one per month", fit.collapsed.every((c) => /^- \[Earlier \d{4}-\d{2}-\d{2}(–\d{4}-\d{2}-\d{2})?\] (\d+ \w+(, )?)+ \[L\d+…L\d+, \d+ entries\]$/.test(c.line)) && new Set(fit.collapsed.map((c) => c.from!.slice(0, 7))).size === fit.collapsed.length, fit.collapsed.map((c) => c.line));
check("it keeps as many as fit: the section is packed to within about one line of its budget", 3000 - fit.tokens < 80, fit.tokens);
check("deterministic: the same entries give the same section", JSON.stringify(S.fitSection("ledger", [...many].reverse(), 3000)) === JSON.stringify(S.fitSection("ledger", many, 3000)));
const under = S.fitSection("ledger", many.slice(0, 5), 3000);
check("under budget: nothing collapsed", under.collapsed.length === 0 && under.entries.length === 5);
const openOnly = S.fitSection("middle", Array.from({ length: 80 }, (_, i) => ({ ...ledger(i, true), kind: "ask" })), 500);
check("open items alone over budget: nothing collapsed, the section overflows and says so", openOnly.collapsed.length === 0 && openOnly.entries.length === 80 && openOnly.overBudget, { tokens: openOnly.tokens });
const can = S.fitSection("can", Array.from({ length: 60 }, (_, i) => ({ id: `X${i + 1}`, src: "capabilities", date: null, prov: "seen" as const, text: "Cue can search for events, communities and openings near them and send the best few with their links.", open: false, kind: "capability" })), 300);
check("section 6 (what Cue can do) is never collapsed; past its budget it overflows", can.collapsed.length === 0 && can.entries.length === 60 && can.overBudget && can.entries[0].id === "X1");

// ---- the build
const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2";
const at = "2026-10-20T18:00:00.000Z";
const knowledge: any = {
  userId: A, asOf: at, identity: { firstName: "Avery", city: "Oakland", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: at },
  goals: [{ text: "find a cofounder", state: "active", reason: null, told: true, onFile: true, hash: "abcdef1234567890", source: "member", verifiedAt: at }],
  asks: [{ id: "ask-1", text: "jazz nights near Oakland", kind: "find", verifiedAt: at }],
  delivered: [],
  carrying: [
    { what: "a venue for the launch", kind: "task", state: "due", told: true, theyHaveIt: false, dueAt: "2026-10-22T23:59:00.000Z", ref: "task #12", status: null, detail: null, verifiedAt: at },
    { what: "the RSVP for Saturday", kind: "loop", state: "outstanding", told: false, theyHaveIt: false, dueAt: null, ref: "loop 31", status: "waiting_on_them", detail: null, verifiedAt: at },
  ],
  lessons: [{ text: "Don't pile on questions when they're venting", verifiedAt: at }],
  corrections: [{ field: "city", was: "Berkeley", now: "Oakland", verifiedAt: at }],
  preferences: [{ text: "small rooms over big mixers", source: "stated", verifiedAt: at }],
  claims: [
    { text: "Had coffee with Marisol Vega about her gallery", provenance: "user_said", kind: "event", quote: "coffee with Marisol Vega was great", expiresOn: null, saidOn: "2026-10-19", verifiedAt: at },
    { text: "Learning salsa for my birthday", provenance: "user_said", kind: "plan", quote: null, expiresOn: null, saidOn: "2026-10-18", verifiedAt: at },
    { text: "Wants to live in Berkeley near the lab", provenance: "user_said", kind: "plan", quote: null, expiresOn: null, saidOn: "2026-10-17", verifiedAt: at },
    { text: "Probably burned out at work", provenance: "co_inferred", kind: "mood", quote: null, expiresOn: null, saidOn: "2026-10-18", verifiedAt: at },
  ],
  restraint: null, exchanges: [], person: null,
  limits: { avoid: ["hackathons"], availability: "weeknights after 7", verifiedAt: at },
};
const src: any = {
  userId: A, zone: "America/Los_Angeles", team: false,
  profile: { firstName: "Avery", city: "Oakland", lifeChapters: ["new to the Bay"], direction: "start a company", activities: ["running"], blockers: [], availability: null, style: ["short, lowercase texts"], updatedAt: new Date(at) },
  knowledge,
  threads: [{ id: "11111111-2222-4333-8444-555555555555", text: "Learning salsa for my birthday", quote: "learning salsa for my birthday", status: "open", openedAt: new Date(at), dueDate: null, kind: "thread", tone: null, touchedAt: new Date(at) },
    { id: "22222222-2222-4333-8444-555555555555", text: "Training for the Oakland half", quote: "doing the half in March", status: "open", openedAt: new Date(at), dueDate: "2027-03-14", kind: "thread", tone: "excited", touchedAt: new Date(at) }],
  coGoals: [],
  emotions: [{ id: "77", felt: "nervous", strength: "medium", about: "the pitch", quote: "so nervous about Thursday", source: "text", at: new Date(at) }],
  scheduled: [{ id: "99999999-2222-4333-8444-555555555555", text: "call me Friday", at: new Date("2026-10-24T17:00:00Z"), status: "pending" }],
  ledger: [
    { id: "4711", relation: "texted", said: "I introduced you to Marisol, she runs a gallery", url: null, at: new Date(at), source: "outbound:h1", meta: { ledger: 1, kind: "text" } },
    { id: "4712", relation: "not_done", said: "used writeDocument", url: null, at: new Date(at), source: "tool.writeDocument", meta: { ledger: 1, kind: "tool", receipt: "not_done" } },
    { id: "4713", relation: "sent", said: "Friday Jazz Trio", url: "https://lu.ma/jazz", at: new Date(at), source: "memory:x", meta: { ledger: 1, kind: "offer", offer_state: "interested" } },
  ],
  forgotten: [
    { field: "claim", old: "Learning salsa for my birthday", now: null, ref: "claim:k1", removed: true },
    { field: "city", old: "Berkeley", now: "Oakland", ref: "profile:city", removed: false },
  ],
  names: ["Marisol Vega"],
  capabilities: ["Cue can search for events near them.", "Cue never shares what they've told it with other members."],
};
const built = S.buildSnapshot(src, { version: 7 });
const body = built.body;
const lines = body.split("\n").filter((l) => l.startsWith("- ["));
check("every line carries its id, provenance and date (capabilities: no date)", lines.every((l) => /^- \[[A-Z][A-Za-z0-9]+ (said|seen|did|inferred)( \d{4}-\d{2}-\d{2})?\] \S/.test(l)), lines.filter((l) => !/^- \[[A-Z][A-Za-z0-9]+ (said|seen|did|inferred)( \d{4}-\d{2}-\d{2})?\] /.test(l)));
check("ids name their source row: a ledger row is L + its co_facts id; a thread, H + its id", /\[L4711 did 2026-10-20\] texted: /.test(body) && /\[H22222222 said 2026-10-20\] Thread \(open, by 2027-03-14, feeling excited\): Training for the Oakland half \(their words: "doing the half in March"\)/.test(body) && /\[Q99999999 did 2026-10-24\]/.test(body) && /\[Wtask12 did/.test(body) && /\[O31 said/.test(body));
check("the header has the version and zone, and no clock", built.header === "# Cue's snapshot of Avery · v7 · zone America/Los_Angeles" && !/\d{1,2}:\d{2}/.test(built.header));
check("a linked member's full name is out of every line (their own quote and Cue's ledger): neither first nor last name is left", !/marisol|vega/i.test(body) && built.namesRedacted >= 2, lines.filter((l) => /another member/i.test(l)));
check("a sentence naming them becomes a details-free history line; Cue's intro stays as nameless history", /\] event: Another member came up here; their details aren't kept\./.test(body) && /texted: Cue introduced them to another member\./.test(body) && !/gallery/.test(body), lines.filter((l) => /another member/i.test(l)));
check("what they removed is out (claim and thread), counted", !/salsa/i.test(body) && built.forgotten === 2, built.forgotten);
check("what they corrected carries the correction inline; the correction itself stays as said", /live in Berkeley near the lab \[since corrected: Oakland\]/.test(body) && /Corrected city: was "Berkeley", now "Oakland"/.test(body), lines.filter((l) => /Berkeley/.test(l)));
check("Cue's read is marked inferred, never said", /\[K[0-9a-f]{8} inferred 2026-10-18\] mood: Probably burned out/.test(body) && /\[K[0-9a-f]{8} said 2026-10-19\] event:/.test(body));
check("open items are marked open in the stored sections: the ask, the goal, the task, the loop, the scheduled call", ["A", "G", "Wtask12", "O31", "Q"].every((p) => built.sections.some((s) => s.entries.some((e) => e.id.startsWith(p) && e.open))));
check("not done is said as not done (a not_done receipt never reads as done)", /\[L4712 did 2026-10-20\] not_done tool: used writeDocument \(receipt not_done\)/.test(body));
check("an offer carries its link and its state", /sent offer: Friday Jazz Trio <https:\/\/lu\.ma\/jazz> \(offer interested\)/.test(body));
check("the counts match and nothing is over budget for an ordinary member", built.countsMatch && built.overBudget.length === 0 && built.tokens.total < 2000, { tokens: built.tokens, over: built.overBudget });
check("the sections render in order 1 to 6", S.SECTION_IDS.map((id) => body.indexOf(`## ${S.SECTION_TITLES[id]}`)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
check("the build is deterministic", S.buildSnapshot(src, { version: 7 }).body === body);

// ---- names out
const hits = (n: string[]) => S.strictNameMatcher(S.nameTokens(n));
const f = (t: string, n = ["Marisol Vega"]) => S.fenceLine(t, hits(n)).text;
check("a full-name line: the whole sentence goes, never \"another member Vega\"", f("Had coffee with Marisol Vega about her gallery.") === "Another member came up here; their details aren't kept." && f("Marisol, another member, came up here; their details aren't kept for this conversation.") === "Another member came up here; their details aren't kept.");
check("a details line by the last name alone: details-free, the other sentences kept", f("Vega is building grid storage and left Tesla. They want a cofounder.") === "Another member came up here; their details aren't kept. They want a cofounder.");
check("history kinds follow safeMemory's: an intro, a suggestion", f("I introduced you to Marisol at the dinner.") === "Cue introduced them to another member." && f("Suggested Marisol as worth meeting.") === "Cue suggested another member as someone to meet.");
check("a list item naming them goes on its own; a lead-in label without a name stays", f("Wants: a cofounder; coffee with marisol; jazz") === "Wants: a cofounder; Another member came up here; their details aren't kept.; jazz" || f("Wants: a cofounder; coffee with marisol; jazz").startsWith("Wants: a cofounder; Another member came up here"), f("Wants: a cofounder; coffee with marisol; jazz"));
check("strict match: any case, accents folded, whole words; an everyday-word name only with its capital", hits(["Zoë Young"])("coffee with zoe") && hits(["Zoë Young"])("met Young") && !hits(["Zoë Young"])("a young crowd") && hits(["May Lin"])("see May") && !hits(["May Lin"])("you may like it") && !hits(["Marisol"])("Marisolville"));

// The live finder too (memberSafeMemories nameFinder): an everyday-word name written lowercase where it stands for a person.
const everyday = ["Rose Park", "May Chen", "Max Ortiz"];
const lower = ["coffee with rose about her divorce", "rose said she's leaving her job", "may is moving to Austin after her breakup", "max said he can't make it"];
check("lowercase everyday names that stand for a person are caught by the rewrite (details-free lines)", lower.every((t) => S.fenceLine(t, S.linkedNameMatcher(everyday)).text === "Another member came up here; their details aren't kept."), lower.map((t) => S.fenceLine(t, S.linkedNameMatcher(everyday)).text));
check("and by the fence's check", lower.every((t) => S.fenceScan({ header: "", body: `\n- [L1 did 2026-10-20] texted: ${t}` }, everyday, A).nameHits === 1));
check("known limit, on the safe side: an everyday word that isn't the person still counts (\"in May\" with a linked May)", S.linkedNameMatcher(["May Chen"])("training for the half in May") && !S.linkedNameMatcher(["May Chen"])("you may like it"));


const lookupNone = async () => [] as string[];
const planted = { header: built.header, body: `${built.body}\n- [L9 did 2026-10-20] texted: "say hi to Marisol"` };
check("the fence blocks a planted linked name", (await S.fenceCheck(planted, ["Marisol Vega"], A, lookupNone)).ok === false && S.fenceScan(planted, ["Marisol Vega"], A).nameHits === 1);
const lastOnly = { header: built.header, body: `${built.body}\n- [L9 did 2026-10-20] texted: "another member Vega"` };
check("the fence blocks a planted last name alone (checked on every word of the full name, apart from how lines were made)", S.fenceScan(lastOnly, ["Marisol Vega"], A).nameHits === 1);
const res = await S.fenceCheck(planted, ["Marisol Vega"], A, lookupNone);
check("a name block says what kind and how many, never the name", !res.ok && res.kind === "name" && res.hits === 1 && !JSON.stringify(res).includes("Marisol"));
check("the clean build passes the fence", (await S.fenceCheck(built, ["Marisol Vega"], A, lookupNone)).ok === true);
const own = { header: "# Cue's snapshot of Sarah · v1 · zone x", body: "# Cue's snapshot of Sarah · v1 · zone x\n\n## 1. In their own words\n- [P1 said 2026-10-20] Lives in: Oakland" };
check("the header's own first name isn't a hit, even when a linked member shares it", (await S.fenceCheck(own, ["Sarah"], A, lookupNone)).ok === true);
const withId = { header: built.header, body: `${built.body}\n- [L10 did 2026-10-20] did: matched with ${B}` };
check("another member's user id in the body is a block; the lookup is asked only about ids that aren't theirs", (await S.fenceCheck(withId, [], A, async (ids) => ids.filter((x) => x === B))).ok === false && S.fenceScan({ header: "", body: `${A} ${B}` }, [], A).ids.join() === B);
check("an id that isn't a user (a thread's own id) isn't a block", (await S.fenceCheck({ header: "", body: "- [H1] 11111111-2222-4333-8444-555555555555" }, [], A, async () => [])).ok === true);

// ---- shadow: nothing reads it (source shape)
const root = new URL("../../src/", import.meta.url).pathname;
const files: string[] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|mts)$/.test(f.name)) files.push(p); } };
walk(root);
const rel = (p: string) => path.relative(root, p);
const readers = files.filter((f) => !/services\/memberSnapshot\.ts$/.test(f) && /\breadSnapshot\b/.test(fs.readFileSync(f, "utf8")));
check("nothing in src calls readSnapshot directly (a reply reads it through replySnapshot)", readers.length === 0, readers.map(rel));
// Type-only imports (the reply's input, the facts) load nothing.
const importers = files.filter((f) => !/services\/memberSnapshot(Schema)?\.ts$/.test(f) && fs.readFileSync(f, "utf8").split("\n").some((l) => /memberSnapshot\.js/.test(l) && !/^import type /.test(l))).map(rel).sort();
check("only the text reply and LEARN's rebuild (sendblue), the upkeep job and the shadow script load the builder", JSON.stringify(importers) === JSON.stringify(["jobs/index.ts", "routes/sendblue.ts", "scripts/snapshotShadow.ts"]), importers);
const replyReaders = files.filter((f) => /\breplySnapshot\(/.test(fs.readFileSync(f, "utf8")) && !/services\/memberSnapshot\.ts$/.test(f)).map(rel);
check("only the text reply reads it; the read and check lanes don't yet (steps 4 and 5)", JSON.stringify(replyReaders) === JSON.stringify(["routes/sendblue.ts"]), replyReaders);
const sb = fs.readFileSync(path.join(root, "routes/sendblue.ts"), "utf8");
const uses = [...sb.matchAll(/memberSnapshot\.js"\)\.then\(\(S\) => S\.(\w+)\(/g)].map((m) => m[1]);
check("the reply path's two uses: the reply's read, and LEARN's rebuild chained after the turn's learning writes", uses.join() === "replySnapshot,rebuildSnapshot" && /learnFromTextTurn\(\{[\s\S]{0,400}\}\)\.catch\([^\n]*\n[\s\S]{0,300}\.then\(\(\) => import\("\.\.\/services\/memberSnapshot\.js"\)\.then\(\(S\) => S\.rebuildSnapshot\(user\.id, "learn"\)\)\)\s*\.catch\(\(\) => \{\}\);/.test(sb), uses);
const jobs = fs.readFileSync(path.join(root, "jobs/index.ts"), "utf8");
check("the job only runs the upkeep", [...jobs.matchAll(/\{ (\w+) \} = await import\("\.\.\/services\/memberSnapshot\.js"\)/g)].map((m) => m[1]).join() === "snapshotUpkeep");
const sql = files.filter((f) => !/services\/memberSnapshot(Schema)?\.ts$|scripts\/forgetResidueAudit\.ts$/.test(f) && /member_snapshots?\b/.test(fs.readFileSync(f, "utf8"))).map(rel);
check("no other src file reads the table", sql.length === 0, sql);
const prompts = new URL("../../prompts/", import.meta.url).pathname;
const promptHits = fs.existsSync(prompts) ? fs.readdirSync(prompts).filter((f) => /member_snapshot|readSnapshot|memberSnapshot/.test(fs.readFileSync(path.join(prompts, f), "utf8"))) : [];
check("no prompt names it", promptHits.length === 0, promptHits);

console.log(`snapshot build: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
