// Research briefs (services/researchBrief.ts): zero tokens.
//   npx tsx evals/docs/researchBrief.ts
const RB = await import("../../src/services/researchBrief.js");
const DS = await import("../../src/services/documentSheet.js");
const DD = await import("../../src/services/documentDelivery.js");
const GD = await import("../../src/services/googleDocs.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };

const at = "2026-10-07T21:13:00.000Z";
const find = (over: Partial<import("../../src/services/researchBrief.js").ResearchFind> = {}) => ({
  name: "Shaws San Francisco",
  url: "https://www.peerspace.com/pages/listings/636c4558d6990c0022346e9d",
  checkedAt: at,
  reader: "scripted" as const,
  fields: RB.peerspaceFields({ hourlyPrice: 125, priceRange: null, minimumHours: 1, capacity: 50, available: "yes", evidence: "" }, { date: "2026-10-22", start: "6:00 pm" }),
  ...over,
});
const brief = (finds: any[], ctx: string[] = []) => RB.buildBrief({ title: "Venue options for the launch", asked: "a launch party for 40", finds, memberContext: ctx, zone: "America/Los_Angeles" });

// ---- a brief refuses an unsourced claim
const good = brief([find()]);
check("a sourced brief passes", RB.researchProblems(good).length === 0, RB.researchProblems(good));
const noUrl = brief([find({ url: "" })]);
check("an option with no source link is refused", RB.researchProblems(noUrl).some((p) => /no source link/.test(p)));
const noTime = brief([find({ checkedAt: "" })]);
check("an option with no check time is refused", RB.researchProblems(noTime).some((p) => /no time it was checked/.test(p)));
const tampered = brief([find()]);
tampered.sections[0].bullets.splice(1, 0, "Great vibe and the best in the city");
check("a line that isn't a sourced field is refused (nothing inferred)", RB.researchProblems(tampered).some((p) => /isn't a sourced field/.test(p)));
const prose = brief([find()]);
prose.sections[0].paragraphs.push("This is probably the best choice.");
check("free text in a researched section is refused", RB.researchProblems(prose).some((p) => /free text/.test(p)));
const stripped = brief([find()]);
stripped.sections[0].bullets.pop();
check("a researched section that doesn't show its source is refused", RB.researchProblems(stripped).some((p) => /doesn't show its source/.test(p)));
check("a brief with nothing researched is refused", RB.researchProblems(brief([])).length > 0);
check("general-reader finds are cleared since round 2 passed (39 right, 0 wrong), and refused whenever the switch is off", RB.SDK_FINDS_ALLOWED === true && RB.researchProblems(brief([find({ reader: "sdk" })])).length === 0 && RB.researchProblems(brief([find({ reader: "sdk" })]), { sdkAllowed: false }).some((p) => /isn't cleared/.test(p)));
check("options are numbered so they can say \"the second one\"", brief([find(), find({ name: "Rick and Roxys" })]).sections[1].heading === "2. Rick and Roxys");

// ---- member context is still held to their words; research is exempt from that rule, not from its own
const withCtx = brief([find()], ["Budget about 1500", "Needs to hold 40 people"]);
check("researched lines aren't held to the member's words", DS.documentProblems(withCtx, { theirs: "budget about 1500, it needs to hold 40 people" }).length === 0, DS.documentProblems(withCtx, { theirs: "budget about 1500, it needs to hold 40 people" }));
// The same words check as every document (services/documentGrounding.ts). Short lines are held to it too (2026-10-07): every word
// in a short line that carries meaning, every number (by value) and every name or place must be theirs.
const invented = brief([find()], ["They need a rooftop terrace with skyline views and catering included"]);
check("a member-context line they never said is refused", DS.documentProblems(invented, { theirs: "budget about 1500" }).length > 0);
const THEIRS = "budget about 1500, it needs to hold 40 people";
for (const line of ["Rooftop needed", "Budget 10k", "Catering included", "Launch in Austin", "60 people"]) {
  const p = DS.documentProblems(brief([find()], ["Budget about 1500", line]), { theirs: THEIRS });
  check(`an invented short member-context line is refused: "${line}"`, p.some((x) => /isn't something they said/.test(x)), p);
}
for (const line of ["Budget about $1,500", "Budget about 1.5k", "40 people", "Holds 40 guests", "Needs to hold 40 people"]) {
  const p = DS.documentProblems(brief([find()], [line]), { theirs: THEIRS });
  check(`their own short line, in another form, passes: "${line}"`, p.length === 0, p);
}
// Researched lines stay exempt even when short and nothing like their words ("Capacity: 50", "$125 an hour", the source link).
const shortResearch = brief([find()], ["Budget about 1500"]);
check("researched lines stay exempt from their words, however short", shortResearch.sections[0].research !== undefined && shortResearch.sections[0].bullets.some((b) => b.split(/\s+/).length <= 4) && DS.documentProblems(shortResearch, { theirs: "budget about 1500" }).length === 0, DS.documentProblems(shortResearch, { theirs: "budget about 1500" }));
check("...and are judged when the same section isn't marked researched (the exemption is the mark, nothing else)", DS.documentProblems({ ...shortResearch, sections: shortResearch.sections.map((s) => ({ ...s, research: undefined })) }, { theirs: "budget about 1500" }).some((x) => /isn't something they said/.test(x)));
check("the sections are marked: researched vs from what they told me", withCtx.sections[0].research !== undefined && withCtx.sections.at(-1)?.heading === "From what you told me" && !withCtx.sections.at(-1)?.research);

// ---- sources and check times render, unknowns show as unknown
const unknownFind = find({ name: "Rick and Roxys", fields: RB.peerspaceFields({ hourlyPrice: null, priceRange: null, minimumHours: 3, capacity: null, available: "unknown", evidence: "" }, { date: "2026-10-22", start: "6:00 pm" }) });
const b2 = brief([find(), unknownFind]);
const html = DS.documentHtml(b2, { firstName: "Jordan", date: "October 7, 2026" });
const gdoc = GD.docsHtml(b2, { firstName: "Jordan", date: "October 7, 2026" });
for (const [name, page] of [["PDF", html], ["Google Doc", gdoc]] as const) {
  check(`${name}: each option shows its source link`, page.includes("peerspace.com/pages/listings/636c4558d6990c0022346e9d"));
  check(`${name}: each option shows when it was checked`, /checked Oct 7, 2:13\s*PM PDT/.test(page), page.match(/checked[^<]{0,40}/)?.[0]);
  check(`${name}: an unknown rate shows as unknown`, /Rate: unknown/.test(page) && /Capacity: unknown/.test(page));
  check(`${name}: an unknown availability shows as unknown`, /Open 2026-10-22 from 6:00 pm: unknown/.test(page));
}
check("a range stays a range, never a single number inside it", RB.peerspaceFields({ hourlyPrice: null, priceRange: [175, 250], minimumHours: 5, capacity: 150, available: "yes", evidence: "" }, null).find((f) => f.label === "Rate")?.value === "$175 to $250 an hour, depending on the day");
check("no date asked: no availability line at all (nothing invented)", !RB.peerspaceFields({ hourlyPrice: 125, priceRange: null, minimumHours: 1, capacity: 50, available: "unknown", evidence: "" }, null).some((f) => /^Open/.test(f.label)));

// ---- routing: PDF by default, the Google Doc only when the shared-artifact gates hold
const T = (o: any) => DD.docTargets({ userId: "11111111-1111-4111-8111-111111111111", kind: b2.kind, saveTo: "google_doc", askedForGoogle: true, env: {} as any, ...o }).targets.join();
check("a brief is a venue brief (a shared kind)", b2.kind === "venue_brief");
check("asked for a Google Doc, gates hold: the Google Doc", T({}) === "google_docs");
check("not asked in their words: the PDF", T({ askedForGoogle: false }) === "pdf_text");
check("not on the narrowing list when it's set: the PDF", T({ env: { GOOGLE_DOCS_TEST_USERS: "22222222-2222-4222-8222-222222222222" } }) === "pdf_text");
check("default delivery (no ask): the PDF", T({ saveTo: "pdf", askedForGoogle: false }) === "pdf_text");

// The brief says what shaped it (Royce, 2026-10-27, wording approved): their own words, and the criteria the search used, on top.
{
  const b = RB.buildBrief({ title: "Venue options", asked: "quiet dinner, Mission, 6", finds: [find()], memberContext: [], zone: "America/Los_Angeles", theirWords: "a quiet dinner spot in the Mission for 6 on Saturday", searched: { date: "2026-10-24", start: "19:30", headcount: 6, budget: "under $60 a head", neighborhood: "Mission", city: "SF" } });
  const top = b.sections[0];
  check("brief: opens with their words, then what was searched", top.heading === null && top.paragraphs[0] === 'What you asked: "a quiet dinner spot in the Mission for 6 on Saturday"' && top.paragraphs[1] === "Searched for: Saturday, Oct 24 at 7:30 PM · 6 people · under $60 a head · Mission, SF", top);
  check("brief: Cue's paraphrase doesn't repeat it in the note", !/^For: /.test(b.note), b.note);
  check("brief: the opening lines never count as an unsourced researched section", RB.researchProblems(b).length === 0, RB.researchProblems(b));
  const only = RB.briefAskedLines({ theirWords: "", searched: { headcount: 1, city: "Oakland" } });
  check("brief: only the criteria it had (no empty slots)", JSON.stringify(only) === JSON.stringify(["Searched for: 1 person · Oakland"]), only);
  const none = RB.buildBrief({ title: "t", asked: "a launch party for 40", finds: [find()], memberContext: [] });
  check("brief: no words and no criteria, the note keeps Cue's paraphrase as before", /^For: a launch party for 40\./.test(none.note) && none.sections[0].heading !== null, none.note);
}

console.log(`research briefs: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
