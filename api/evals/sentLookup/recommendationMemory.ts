// Recommendation memory and link accuracy (Royce, 2026-11-10). Synthetic cases only; zero tokens, fake databases and pages.
//   npx tsx evals/sentLookup/recommendationMemory.ts
// The failure it guards: a residency sent on one day, talked about over the next weeks, came back a month later as "never answered",
// under an X post that was a roundup of several programs, pitched as "distinct from the program already sent". And the overcorrections
// it must not make: two programs from one organization collapsed, a new cohort hidden, a reminder or a requested resurface swallowed,
// unreadable history read as "never discussed".
import { readFileSync } from "node:fs";
import { cohortOf, findSent, hostTerms, matchSent, mentionsThing, namesThing, sameProgram, sameProgramSent, thingSearchTerms, wasSent, type SentRecord } from "../../src/services/knowledge/sent.js";
import { materialChange, repeatRule, type OfferHistory } from "../../src/harness/matchGate.js";
import { mentionsSince, SEND_ECHO_HOURS } from "../../src/services/conversationRecall.js";
import { buildShadowPool, sentHistory } from "../../src/services/sweepShadow.js";
import { selectPrompt } from "../../src/services/sweepSelect.js";
import { recheckFind, roundupOf, type RecheckDeps } from "../../src/services/sendCheck.js";
import { revealItem } from "../../src/agent/eventDiscoverySurfacing.js";
import { againNote, checkComposed, composePrompt, NEW_CLAIM, type ComposeInput } from "../../src/harness/bundleComposer.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
  }
};

// Synthetic programs (invented organizations; the shapes match the reported case, never its content).
const OFFICIAL = "Harbor Point Collective Member Residency";
const SHORT = "HPC Member Residency";
const FELLOWSHIP = "Harbor Point Collective Founder Fellowship";
const at = (iso: string) => new Date(iso);
const rec = (o: Partial<SentRecord> & { name: string }): SentRecord => ({ url: null, eventId: null, ident: { name: o.name }, kind: "opportunity", at: at("2026-09-22T17:00:00Z"), via: ["offer"], reaction: null, ...o });

// ---------------------------------------------------------------- the same opportunity, by what it is
{
  check("same program, acronym vs spelled out: same", sameProgram(SHORT, OFFICIAL) === "same");
  check("same program, either order", sameProgram(OFFICIAL, SHORT) === "same");
  check("two programs from one organization: NOT the same (residency vs fellowship)", sameProgram(OFFICIAL, FELLOWSHIP) === null);
  check("organization alone is not its program", sameProgram("Harbor Point Collective", OFFICIAL) === null);
  // Review of #441 (MED): "same" needs two words of substance in common, or the same host; acronyms only at three letters or more.
  check("'Fellowship' vs 'Fellowship applications open': different", sameProgram("Fellowship", "Fellowship applications open") === null);
  check("...unless both links are on the same host", sameProgram("Fellowship", "Fellowship applications open", { a: "https://lattice.example/f", b: "https://www.lattice.example/apply" }) === "same");
  check("'AI Grant' vs 'Accelerate Innovation Grant': different", sameProgram("AI Grant", "Accelerate Innovation Grant") === null);
  check("the SPC names: same", sameProgram("SPC Member Residency", "South Park Commons Member Residency") === "same" && sameProgram("spc residency", "South Park Commons Residency") === "same");
  check("a new cohort of it: other_cohort", sameProgram(`${OFFICIAL} Spring 2027`, `${OFFICIAL} Fall 2026`) === "other_cohort");
  check("batch codes are cohorts (W27 vs S27)", sameProgram("Northgate Accelerator W27", "Northgate Accelerator S27") === "other_cohort");
  check("one side names no cohort: same", sameProgram(`${OFFICIAL} 2027`, OFFICIAL) === "same");
  check("cohort signature reads a numbered batch", cohortOf("Builders Program Batch 4") === "batch 4");
  check("a changed headline word of substance isn't the same (residency vs residency program for engineers)", sameProgram(OFFICIAL, `${OFFICIAL} for Engineers`) === null);

  const sent = [rec({ name: OFFICIAL, url: "https://harborpoint.example/residency" })];
  check("the X post's name for a program already sent under its official name: already sent", wasSent(sent, { name: SHORT, url: "https://x.com/i/status/1" }));
  check("another program from the same organization: NOT already sent", !wasSent(sent, { name: FELLOWSHIP, url: "https://harborpoint.example/fellowship" }));
  check("a new cohort is not 'already sent' by the lookup (the picker is told it updates the sent one)", !wasSent([rec({ name: `${OFFICIAL} Fall 2026` })], { name: `${OFFICIAL} Spring 2027` }));
  check("an event that says its day keeps the event rules (no program match)", matchSent(rec({ name: "Founder Dinner Series", ident: { name: "Founder Dinner Series", event_date: "2026-10-01" } }), { name: "Founder Dinners Series", ident: { name: "Founder Dinners Series", event_date: "2026-11-01" } }) === null);
  check("sameProgramSent finds the other cohort", sameProgramSent([rec({ name: `${OFFICIAL} Fall 2026` })], `${OFFICIAL} Spring 2027`)?.how === "other_cohort");
}

// ---------------------------------------------------------------- named in conversation
{
  check("'the HPC residency' names the program", namesThing("did you look at the HPC residency at all?", OFFICIAL));
  check("the spelled-out name names the X post's short name", namesThing("Harbor Point Collective's member residency looked good", SHORT));
  check("for sameness, the organization alone doesn't name the residency", !namesThing("I know someone at Harbor Point Collective", OFFICIAL));
  check("for sameness, the fellowship doesn't name the residency", !namesThing("applied to the HPC founder fellowship", OFFICIAL));
  check("search terms carry the acronym", thingSearchTerms(OFFICIAL).includes("hpc"));
  // Review of #441 (HIGH): for "discussed" only, acronyms in any case and the organization alone count.
  const SPC = "South Park Commons Member Residency";
  check("discussed: lower-case 'spc residency'", mentionsThing("was the spc residency any good?", SPC));
  check("discussed: 'I'm thinking about SPC' (its own host)", mentionsThing("I'm thinking about SPC", SPC, "https://www.southparkcommons.com/r"));
  check("discussed: the organization only ('I applied to South Park Commons last week')", mentionsThing("I applied to South Park Commons last week", SPC, "https://www.southparkcommons.com/r") && mentionsThing("South Park Commons", SPC, "https://www.southparkcommons.com/r"));
  check("discussed: the X post's short name, organization only", mentionsThing("I applied to South Park Commons last week", "SPC Member Residency", "https://spc.example/r") && mentionsThing("thinking about spc", "SPC Member Residency", "https://spc.example/r"));
  check("discussed: another organization isn't a mention", !mentionsThing("I applied to Lattice Fund last week", SPC) && !mentionsThing("a park downtown", SPC));
  check("no two-letter acronyms anywhere (pc, mr)", !thingSearchTerms(SPC).some((t) => t.length < 3) && !hostTerms(SPC).some((t) => t.length < 3));
}

// ---------------------------------------------------------------- the repeat rule
{
  const today = "2026-11-10";
  const now = at("2026-11-10T17:00:00Z");
  const opp = (date: string | null = null) => ({ isEvent: false, date, shortNotice: false });
  const h = (o: Partial<OfferHistory> = {}): OfferHistory => ({ shownAt: [at("2026-09-22T17:00:00Z")], outcome: null, answered: false, ...o });
  check("SPC shape: shown 49 days ago, talked about since (not within a day): NOT resurfaced", repeatRule(h({ discussed: true }), opp(), today, now).action === "blocked");
  check("talked about is its own reason, not 'declined'", /talked about/.test(repeatRule(h({ discussed: true }), opp(), today, now).reason));
  check("unavailable history is never 'never discussed': not resurfaced", repeatRule(h({ discussed: null }), opp(), today, now).action === "blocked");
  check("silence isn't rejection: never answered, never talked about, a month on: comes back once", repeatRule(h({ discussed: false }), opp(), today, now).action === "resurface");
  check("old callers (no discussion read) keep the old rule", repeatRule(h(), opp(), today, now).action === "resurface");
  check("already came back once: not again", repeatRule(h({ discussed: false, shownAt: [at("2026-08-01T00:00:00Z"), at("2026-09-22T00:00:00Z")] }), opp(), today, now).action === "blocked");
  const changed = repeatRule(h({ discussed: true, shownDates: ["2026-10-01"] }), opp("2026-12-15"), today, now);
  check("a material change (a new deadline) since it was shown: comes back once as an update, even after it was talked about", changed.action === "resurface" && /2026-10-01.*2026-12-15/.test(changed.reason), changed);
  check("a change never brings back a no", repeatRule(h({ outcome: "declined", shownDates: ["2026-10-01"] }), opp("2026-12-15"), today, now).action === "blocked");
  check("a change never brings back what they did", repeatRule(h({ outcome: "acted", shownDates: ["2026-10-01"] }), opp("2026-12-15"), today, now).action === "blocked");
  check("same date as shown: no change", materialChange(["2026-12-15"], "2026-12-15", today) === null);
  check("a changed date already past: no change", materialChange(["2026-10-01"], "2026-11-01", today) === null);
  check("an event under the same name with a new date is a recurrence, not a 'change'", repeatRule(h({ discussed: true, shownDates: ["2026-10-01"] }), { isEvent: true, date: "2026-12-15", shortNotice: false }, today, now).action === "blocked");
  // Legitimate reminders still go.
  check("legitimate reminder: interested, deadline in 3 days: still a reminder (discussion doesn't swallow it)", repeatRule(h({ outcome: "interested", discussed: true }), opp("2026-11-13"), today, now).action === "remind");
  check("legitimate reminder: an event within a day, never answered: still a reminder", repeatRule(h({ discussed: true }), { isEvent: true, date: "2026-11-11", shortNotice: true }, today, now).action === "remind");
  // A texted search (they asked) keeps the old rule and reads no conversation: a requested resurface isn't blocked by "discussed".
  const gate = readFileSync(new URL("../../src/harness/matchGate.ts", import.meta.url), "utf8");
  check("review of #441 (LOW): the talked-about read runs only past the gap, shown once, with no outcome or answer", /const pastGap = showings\.length === 1 && Date\.now\(\) - showings\[0\]\.getTime\(\) >= RESURFACE_AFTER_DAYS \* 86_400_000;\s*if \(pastGap && !outcome && !answered\)/.test(gate));
  check("requested resurfacing: a texted search's repeat check doesn't read 'discussed'", /wasAlreadyOffered[\s\S]{0,300}offerHistory\(userId, match, \[\], \{ discussion: false \}\)/.test(gate));
}

// ---------------------------------------------------------------- mentionsSince (a fake database, owner-bound)
{
  const shown = at("2026-09-22T17:00:00Z");
  const rows = [
    { memory_type: "text_exchange", content: `Co replied: ${OFFICIAL}: a residency for founders, applications rolling`, created_at: at("2026-09-22T17:01:00Z") },
    { memory_type: "text_exchange", content: "User said: is the HPC residency only for solo founders?", created_at: at("2026-09-24T18:00:00Z") },
    { memory_type: "text_exchange", content: "Co replied: The HPC member residency takes teams too.", created_at: at("2026-09-24T18:01:00Z") },
    { memory_type: "text_exchange", content: "User said: I talked to someone at Harbor Point Collective", created_at: at("2026-10-02T18:00:00Z") },
    { memory_type: "call_transcript", content: "user: I keep thinking about the Harbor Point Collective residency\nassistant: The member residency?", created_at: at("2026-10-06T18:00:00Z") },
  ];
  const seen: unknown[][] = [];
  const db = { query: async (sql: string, args: unknown[]) => { seen.push(args); return { rows: /co_memories/.test(sql) ? rows : [] }; } };
  const m = await mentionsSince(db, "u1", OFFICIAL, shown, { sends: [shown], url: "https://harborpointcollective.example/residency" });
  check("the member's later lines count (a text, a call, and the organization alone)", m.member.length === 3, m);
  check("Cue's own later answer counts; the offer text itself (within the send window) doesn't", m.cue.length === 1 && m.cue[0].toISOString() === "2026-09-24T18:01:00.000Z", m);
  check("the organization alone is a mention, for discussed", m.member.some((d) => d.toISOString().startsWith("2026-10-02")));
  check("owner-bound: the member is $1", seen.every((a) => a[0] === "u1"));
  check("send echo window is a few hours", SEND_ECHO_HOURS >= 1 && SEND_ECHO_HOURS <= 12);
  const broken = { query: async () => { throw new Error("db down"); } };
  check("unreadable: throws (the caller records unknown, never 'not discussed')", await mentionsSince(broken, "u1", OFFICIAL, shown).then(() => false, () => true));
}

// ---------------------------------------------------------------- the picker sees what was sent
{
  const sent = [rec({ name: OFFICIAL, url: "https://harborpoint.example/residency" })];
  const again = sentHistory({ name: SHORT, date: null, reminder: false, again: true, againWhy: "shown 49 days ago, never answered or talked about since, still open", ident: { name: SHORT, url: "https://x.com/i/status/1" } }, sent);
  check("a resend is labelled ALREADY SENT with the send's day and its other name", !!again && /ALREADY SENT on 2026-09-22/.test(again) && again.includes(`"${OFFICIAL}"`), again);
  check("a resend says it isn't new", /never pitch it as a discovery/.test(again ?? ""));
  const cohort = sentHistory({ name: `${OFFICIAL} Spring 2027`, date: null, reminder: false, again: false, ident: { name: `${OFFICIAL} Spring 2027` } }, [rec({ name: `${OFFICIAL} Fall 2026` })]);
  check("a changed cohort is an update to what was sent, not hidden and not new", !!cohort && /newer cohort/.test(cohort), cohort);
  check("another program from the same organization carries no history", sentHistory({ name: FELLOWSHIP, date: null, reminder: false, again: false, ident: { name: FELLOWSHIP } }, sent) === null);
  const pool = buildShadowPool([{ name: SHORT, date: null, tier: 3, askId: "a1", fromProfile: false, reminder: false, again: true, againWhy: "shown 49 days ago, never answered or talked about since, still open", details: null, ident: { name: SHORT, url: "https://x.com/i/status/1" } }], "2026-11-10", new Map([["a1", "A1"]]), new Set(), new Set(), new Set(), [], sent);
  check("the pool item carries the history", /ALREADY SENT/.test(pool[0]?.history ?? ""), pool);
  const prompt = selectPrompt({ firstName: "Jordan", city: null, today: "2026-11-10", weekday: "Tuesday", zone: null, discoveryLeft: 3, feeling: null, asks: [{ id: "A1", since: "2026-11-01", text: "find another engineer to build with" }], texts: [], sent: [], outcomes: [], pool } as any);
  check("the picker's prompt shows it", /ALREADY SENT on 2026-09-22/.test(prompt));
  const sys = readFileSync(new URL("../../src/services/sweepSelect.ts", import.meta.url), "utf8");
  check("the picker is told: audience alone isn't a reason; adjacent leads explained honestly", /Who it's for \("it's for founders"\) or a general networking benefit is not a reason on its own/.test(sys) && /An adjacent lead can still be worth sending/.test(sys));
}

// ---------------------------------------------------------------- a roundup is not the thing
{
  const roundup = `Five places to look for founder support this winter:\n1. ${SHORT}: https://hpcollective.example/residency\n2. Lattice Fund fellowship\n3. Northgate Accelerator\n4. Openbench grants\n5. Quarry Labs`;
  const r = roundupOf(roundup, SHORT);
  check("an X roundup naming it among others is a roundup", !!r && r.links[0] === "https://hpcollective.example/residency", r);
  check("review of #441 (MED): pcmag.com and mrbeast.com links never resolve as its page", roundupOf(`Five places to look for founder support:\n1. South Park Commons Member Residency https://www.pcmag.com/picks\n2. Lattice Fund fellowship https://mrbeast.com/x\n3. Northgate Accelerator\n4. Openbench grants`, "South Park Commons Member Residency")?.links.length === 0);
  check("a Medium write-up or a shortened link on its own line never resolves as its page", roundupOf(`Five places to look:\n1. ${SHORT} https://medium.com/@someone/hpc-review https://bit.ly/hpc1\n2. Lattice Fund fellowship\n3. Northgate Accelerator`, SHORT)?.links.length === 0);
  check("review of #441 (LOW): a first line naming the program is not a roundup", roundupOf(`${SHORT} is open: here's what you get\n- a desk\n- dinners\n- demo day\n1. Lattice Fund\n2. Northgate`, SHORT) === null);
  check("an announcement about only this program is not a roundup", roundupOf(`${SHORT} applications are open now. Apply by Dec 15: https://hpcollective.example/residency`, SHORT) === null);
  check("its own page with benefit bullets is not a roundup", roundupOf(`${OFFICIAL}\n- $50K\n- a desk for six months\n- weekly dinners\nApply now`, OFFICIAL, { page: true }) === null);
  check("an article headlined as a list is a roundup", !!roundupOf(`7 residencies for technical founders\nOur picks this season.\n${OFFICIAL} is a six-month residency.`, OFFICIAL, { page: true }));

  const pages: Record<string, { text: string | null; gone: boolean }> = {
    "https://hpcollective.example/residency": { text: `${OFFICIAL}\nA six-month residency for builders. Applications open until 2026-12-15.`, gone: false },
  };
  const deps: RecheckDeps = { luma: async () => null, page: async (u) => pages[u] ?? { text: null, gone: false } };
  const now = at("2026-11-10T17:00:00Z");
  const match: any = { tier: 3, kind: "opportunity", name: SHORT, url: "https://x.com/i/status/1", reason: "", source: "x", opportunity: { postText: roundup } };
  const ok = await recheckFind(match, { now, zone: null, deps });
  check("resolved to its official page: that link goes, read and verified", ok.ok && (ok as any).match.url === "https://hpcollective.example/residency" && (ok as any).verified === true, ok);
  check("the roundup is kept as where it was found, never as its page", ok.ok && (ok as any).match.roundupUrl === "https://x.com/i/status/1" && /listed as/.test((ok as any).match.foundInRoundup), ok);
  check("described from its own page", ok.ok && /six-month residency/.test((ok as any).match.pageNow ?? ""));
  const noLink = { ...match, opportunity: { postText: roundup.replace(/: https:\S+/, "") } };
  const held = await recheckFind(noLink, { now, zone: null, deps });
  check("no official page to read: held and read again, never sent as the post", !held.ok && held.exit === false && /listing several things/.test(held.why), held);
  const deadDeps: RecheckDeps = { luma: async () => null, page: async () => ({ text: null, gone: false }) };
  const unread = await recheckFind(match, { now, zone: null, deps: deadDeps });
  check("official page unreadable now: held, never old details as current", !unread.ok && unread.exit === false, unread);
  const plain: any = { tier: 3, kind: "opportunity", name: SHORT, url: "https://x.com/i/status/2", reason: "", source: "x", opportunity: { postText: `${SHORT} is open, apply by Dec 15` } };
  const asIs = await recheckFind(plain, { now, zone: null, deps });
  check("a post that is about only this thing goes as before (unverified)", asIs.ok && (asIs as any).verified === false && (asIs as any).match.url === plain.url);

  const item = revealItem("find another engineer to build with", false, { ...(ok as any).match });
  check("the text's facts label the roundup and carry no roundup text as its description", !("source_post" in item.facts) && /not this thing's page/.test(String(item.facts.where_it_was_found)) && /six-month/.test(String(item.facts.its_own_page_read_at_send)), item.facts);
  check("its link is its own page", item.url === "https://hpcollective.example/residency");
}

// ---------------------------------------------------------------- the text says a resend is a resend
{
  check("an unanswered resend is framed as circling back, never new", /never as new/.test(againNote("shown 49 days ago, never answered or talked about since, still open")));
  check("a changed one leads with the change", /lead with what changed/.test(againNote("changed since it was shown: its date was 2026-10-01, now 2026-12-15")));
  check("'came across' / 'distinct from' are new-claims", NEW_CLAIM.test("Came across the HPC residency") && NEW_CLAIM.test("distinct from the one I sent"));
  check("a plain circle-back isn't a new-claim", !NEW_CLAIM.test("Circling back on the HPC residency: still open through Dec 15."));
  const item = revealItem("find another engineer to build with", false, { tier: 3, kind: "opportunity", name: OFFICIAL, url: "https://hpcollective.example/residency", reason: "" } as any);
  const input: ComposeInput = { firstName: "Jordan", items: [{ candidate: { id: "c1" } as any, item, pick: null, again: true, againWhy: "shown 49 days ago" }], set: null, leadWhy: null, memberBlock: null, feeling: null, thread: "", recent: "", threadLive: false } as any;
  check("the composer is told it was sent before", /you sent this before/.test(composePrompt(input)));
  const c = checkComposed({ opening: null, items: [{ n: 1, caption: `Just came across the ${OFFICIAL}: open through mid-December.` }], closing: "Worth a look?", connects: null }, input);
  check("a resend captioned as a new find gets a rewrite", c.problems.some((p) => /sent to them before/.test(p.why)), c.problems);
}

// ---------------------------------------------------------------- feedback at the scope they said it
{
  const OTHER = "Lattice Fund Builder Residency";
  check("an item-level no (to this residency) never matches a different residency", sameProgram(OFFICIAL, OTHER) === null && !wasSent([rec({ name: OFFICIAL })], { name: OTHER }));
  const today = "2026-11-10";
  const now = at("2026-11-10T17:00:00Z");
  check("a different residency with no outcome of its own is new", repeatRule({ shownAt: [], outcome: null, answered: false }, { isEvent: false, date: null, shortNotice: false }, today, now).action === "new");
  check("silence leaves the item unrejected (it may come back once)", repeatRule({ shownAt: [at("2026-09-22T17:00:00Z")], outcome: null, answered: false, discussed: false }, { isEvent: false, date: null, shortNotice: false }, today, now).action === "resurface");
  const gate = readFileSync(new URL("../../src/harness/matchGate.ts", import.meta.url), "utf8");
  check("a no to the program under another name (the X post's) counts for the program", /programTwins\.map\(\(t\) => `name:\$\{t\.name\.toLowerCase\(\)\}`\)/.test(gate));
  const sys = readFileSync(new URL("../../src/services/sweepSelect.ts", import.meta.url), "utf8");
  check("the picker rules out a kind only when their words name the kind; no reply is not a no", /a no to one thing \("not this one", "pass"\) rules out that thing only, never its kind/.test(sys) && /No reply is not a no/.test(sys));
}

// ---------------------------------------------------------------- goal changes close only on their word
{
  const A = await import("../../src/services/askLifecycle.js");
  const ask = { n: "A1", row: { id: "i1", ask_id: "a1", ask_text: "find another engineer to build with", created_at: at("2026-11-01T00:00:00Z") } };
  const convo = (text: string) => [{ at: at("2026-11-08T00:00:00Z"), side: "member" as const, text }];
  check("'I found an engineer' closes the search on their word", A.verifyClosures([{ ask: "A1", how: "moved_on", quote: "I found an engineer, we start Monday" }], [ask as any], convo("I found an engineer, we start Monday")).length === 1);
  check("'I'm tired of looking' does NOT close it", A.verifyClosures([{ ask: "A1", how: "moved_on", quote: "honestly I'm tired of looking for now" }], [ask as any], convo("honestly I'm tired of looking for now")).length === 0);
  check("an explicit pause does NOT close it", A.verifyClosures([{ ask: "A1", how: "moved_on", quote: "let's pause the engineer search for two weeks" }], [ask as any], convo("let's pause the engineer search for two weeks")).length === 0);
  check("tired AND done closes it (their word that it's over)", A.verifyClosures([{ ask: "A1", how: "moved_on", quote: "I'm tired of it, we hired someone, stop looking" }], [ask as any], convo("I'm tired of it, we hired someone, stop looking")).length === 1);
  // Review of #441 (MED): a pause wins over the finished words; "done" or "found" alone never closes.
  const closes = (q: string) => A.verifyClosures([{ ask: "A1", how: "moved_on", quote: q }], [ask as any], convo(q)).length === 1;
  check("'I'm done looking for now, too tired': not closed", !closes("I'm done looking for now, too tired"));
  check("'I found it draining, taking a break': not closed", !closes("I found it draining, taking a break"));
  check("'I'm done with this search, frustrated': not closed", !closes("I'm done with this search, frustrated"));
  check("'we hired someone, stop looking': closed", closes("we hired someone, stop looking"));
  check("a closed ask's queued finds leave (existing: servesClosedAsk)", A.servesClosedAsk({ askId: "a1", reminder: false }, new Set(["a1"])) && !A.servesClosedAsk({ askId: "a1", reminder: true }, new Set(["a1"])));
}

// ---------------------------------------------------------------- re-review of #441
{
  const HX = "The Hacker Exchange Residency";
  check("'the' is never an acronym: 'see you at the park tonight' doesn't name The Hacker Exchange", !namesThing("see you at the park tonight", HX) && !mentionsThing("see you at the park tonight", HX, "https://thehackerexchange.example"));
  const best = `The best places to look for founder support:\n1. ${HX}\n2. Lattice Fund fellowship\n3. Northgate Accelerator\n4. Openbench grants`;
  check("a roundup headed 'The best places to look...' is still a roundup", !!roundupOf(best, HX), roundupOf(best, HX));
  const SPC = "South Park Commons Member Residency";
  const SPC_URL = "https://www.southparkcommons.com/residency";
  check("'spc residency' and 'what about spc' are still discussed (its own host carries the organization)", mentionsThing("spc residency", SPC, SPC_URL) && mentionsThing("what about spc", SPC, SPC_URL));
  check("the organization-only mention is discussed on its own host", mentionsThing("I applied to South Park Commons last week", SPC, SPC_URL));
  check("a topic isn't an organization: 'any ai builders events this week?' doesn't discuss AI Builders Residency on another host", !mentionsThing("any ai builders events this week?", "AI Builders Residency", "https://lu.ma/some-residency"));
  check("no link known: only the name itself counts", !mentionsThing("I applied to South Park Commons last week", SPC) && mentionsThing("the spc residency", SPC));

  const A = await import("../../src/services/askLifecycle.js");
  const ask = { n: "A1", row: { id: "i1", ask_id: "a1", ask_text: "find another engineer to build with", created_at: at("2026-11-01T00:00:00Z") } };
  const closes = (q: string) => A.verifyClosures([{ ask: "A1", how: "moved_on", quote: q }], [ask as any], [{ at: at("2026-11-08T00:00:00Z"), side: "member" as const, text: q }]).length === 1;
  for (const q of ["found one! talk later", "we hired someone, thanks, I'll circle back later", "we found a cofounder, so for now we're set"]) check(`found or hired wins over a pause word: closes "${q}"`, closes(q));
  for (const q of ["I'm done looking for now, too tired", "I found it draining, taking a break"]) check(`still open: "${q}"`, !closes(q));

  for (const [host, label] of [["https://beondeck.com/fellowship", "On Deck"], ["https://www.joinef.com/apply", "EF"], ["https://neo.com/scholars", "Neo"], ["https://hf0.com/residency", "HF0"], ["https://aigrant.org", "AI Grant"], ["https://www.mercatus.org/emergent-ventures", "Emergent Ventures"]] as const) {
    const r = roundupOf(`Five places to look for founder support:\n1. ${label} Fellowship ${host}\n2. Lattice Fund fellowship\n3. Northgate Accelerator\n4. Openbench grants`, `${label} Fellowship`);
    check(`an official site on its own line is a candidate again: ${host}`, !!r && r.links.includes(host), r);
  }
  const excluded = roundupOf(`Five places to look for founder support:\n1. On Deck Fellowship https://www.pcmag.com/x https://medium.com/@a/b\n2. Lattice Fund fellowship https://mrbeast.com/x\n3. Northgate Accelerator\n4. Openbench grants`, "On Deck Fellowship");
  check("pcmag, Medium and mrbeast are still excluded", !!excluded && excluded.links.length === 0, excluded);
}

console.log(`\nrecommendation memory: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
