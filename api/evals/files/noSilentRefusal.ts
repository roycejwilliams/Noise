// No refusal ends in silence (Royce, 2026-10-18). A file Cue made (a deck, a page, a doc, a task's document) that a checker refuses
// gets ONE fix attempt from the refusal; a fix that passes goes as normal; one that still fails ends in exactly one of the three lines
// Royce approved word for word on 2026-10-18 (services/refusalOutcome.ts). The member here is invented (Jordan, hosting a supper
// club in the Mission); the made-up facts are "7:30 PM" (a time they never gave) and "Acme Labs" (a sponsor they never named).
// Zero tokens: the checks are code; the writer, the slot writer and the claims judge are stubs. No database, nothing sent.
//   npx tsx evals/files/noSilentRefusal.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.API_URL = "https://co.example";
import { readFileSync } from "node:fs";
const R = await import("../../src/services/refusalOutcome.js");
const PF = await import("../../src/services/pendingFiles.js");
const C = await import("../../src/services/checkerRefusals.js");
const DD = await import("../../src/services/documentDelivery.js");
const DS = await import("../../src/services/documentSheet.js");
const S = await import("../../src/services/coPages/store.js");
const RT = await import("../../src/agent/refusalTell.js");
const { deckDataFrom, heldInput } = await import("../../src/agent/deckTools.js");
const P = await import("../../src/agent/pageTools.js");
const { memoryReceipts } = await import("../../src/services/deliveryReceipts.js");
const { heldAnswered } = await import("../../src/services/taskTurn.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const MADE_UP = /7:30|7\.30|Acme/i;

// ---------------------------------------------------------------- the stand-ins
let fixes = 0, asks = 0, whats = 0;
let fixAnswer: (prompt: string) => string = () => "{}";
let askAnswer: string = JSON.stringify({ question: "what time does supper start" });
let whatAnswer: string = JSON.stringify({ what: "the sponsorship line" });
R.setRefusalModelsForTests({
  fix: async (p) => { fixes++; return fixAnswer(p); },
  slots: { ask: async () => { asks++; return askAnswer; }, what: async () => { whats++; return whatAnswer; } },
});
const reset = () => { fixes = 0; asks = 0; whats = 0; fixAnswer = () => "{}"; askAnswer = JSON.stringify({ question: "what time does supper start" }); whatAnswer = JSON.stringify({ what: "the sponsorship line" }); };
// Held files: a recording table.
const pendingSql: { sql: string; params: unknown[] }[] = [];
PF.usePendingDb({ query: async (sql: string, params: unknown[] = []) => { pendingSql.push({ sql: sql.replace(/\s+/g, " "), params }); return /INSERT INTO co_tasks/.test(sql) ? { rows: [{ id: 501 }] } : { rows: [], rowCount: 0 }; } });

// ---------------------------------------------------------------- 1. the wording, pinned
{
  check("case 1, the approved example, word for word", R.askLine("deck", "what time does supper start") === "Before I send the deck, there's one thing I want to get right: what time does supper start? Tell me and I'll finish it.");
  check("case 2, the approved example, word for word", R.droppedLine("deck", "the sponsorship line") === "Here's the deck. I left out the sponsorship line because I couldn't confirm it from what you've told me; say the word and I'll add it back.");
  check("case 3, word for word", R.downLine("deck") === "Your deck didn't go through just now, so I haven't sent it. Want me to try again?");
  for (const w of ["page", "doc", "document"] as const) {
    check(`the word swaps for a ${w}, nothing else`, R.askLine(w, "q") === R.askLine("deck", "q").replace("the deck", `the ${w}`) && R.droppedLine(w, "x") === R.droppedLine("deck", "x").replace("the deck", `the ${w}`) && R.downLine(w) === R.downLine("deck").replace("Your deck", `Your ${w}`));
  }
  check("the three lines read as refusal lines; nothing else does", R.isRefusalLine(R.askLine("page", "how many guests are coming")) && R.isRefusalLine(R.droppedLine("doc", "the partner line")) && R.isRefusalLine(R.downLine("document")) && !R.isRefusalLine("Here's the deck.") && !R.isRefusalLine("Updated the page: moved it to 8."));
  // No other member-facing words: the three builders are the only text the flow ever returns to send.
  const ro = src("services/refusalOutcome.ts");
  const built = [...ro.matchAll(/\bline: ([A-Za-z]+)\(/g)].map((m) => m[1]);
  check("the flow's only member-facing text is the three lines", built.length >= 3 && built.every((b) => ["askLine", "droppedLine", "downLine"].includes(b)) && !/\bline: [`"']/.test(ro), built);
}

// ---------------------------------------------------------------- 2. problems, placed and kinded
const THEIRS = "Jordan: I'm hosting a supper club for founders at my place in the Mission. Drinks first, then supper. Seasonal, family style. I want everyone to leave with one new friend.";
const source = { theirs: THEIRS, read: "" };
const deckIn = (slides: { headline: string; bullets: string[] }[]) => ({ title: "Mission supper club", subtitle: "A supper for founders", slides });
const BASE = [
  { headline: "The night", bullets: ["Drinks first, then supper", "Supper at 7:30 PM"] },
  { headline: "The table", bullets: ["Seasonal, family style", "One new friend each"] },
  { headline: "Who it is for", bullets: ["Founders, at my place in the Mission", "Sponsored by Acme Labs"] },
];
// The deck's checks for the flow: the real grounding check (names, numbers, places, times), and a stand-in claims judge.
let judgeDown = false;
let checks = 0;
const deckCheck = async (d: any): Promise<any> => {
  checks++;
  const data: any = await deckDataFrom(d as any, null, new Map(), null, {});
  const c = S.checkPage(data, source);
  if (!c.ok) return { ok: false, problems: R.asProblems(c.problems, C.deckPositions(d)) };
  if (judgeDown) return { ok: false, problems: [R.downProblem()] };
  // The claims judge, stood in for: a sponsor or partner they never named, as deckTools.ts inventedClaims places and kinds it.
  const at = C.deckPositions(d);
  const fails = at.filter((x) => x.where !== "title" && /Acme/.test(x.text));
  if (fails.length) return { ok: false, problems: fails.map((x) => ({ text: `"${x.text}" (a sponsor or partner they never named)`, at: x.where, kind: C.judgedKind("a sponsor or partner they never named") })) };
  return { ok: true, file: d, data };
};
const deckDeps = (o: Partial<Parameters<typeof R.afterRefusal>[2]> = {}) => ({
  word: "deck" as const, theirs: THEIRS, check: deckCheck,
  fix: (f: any, ps: any) => R.fixWith("deck", THEIRS, f, ps, (raw: any) => (raw?.slides ? { ...f, ...raw } : null)),
  drop: (f: any, at: string[]) => R.dropDeckLines(f, at), size: (f: any) => R.deckSize(f), ...o,
});
{
  const d = deckIn(BASE);
  const first = await deckCheck(d);
  const parts = first.ok ? [] : first.problems;
  const time = parts.find((p: any) => /7:30/.test(p.text));
  const sp = await deckCheck(deckIn([BASE[1], BASE[2]]));
  const acme = (sp.ok ? [] : sp.problems).find((p: any) => /Acme/.test(p.text));
  check("an invented time is placed on its bullet and is theirs to give (askable)", time?.at === "slide 2 bullet 2" && time?.kind === "an unbacked time" && R.askable(time), parts);
  check("an invented sponsor is placed on its bullet, isn't asked about, and can come off", acme?.at === "slide 3 bullet 2" && acme?.kind === "a third-party claim" && !R.askable(acme) && R.droppableAt(acme.at), parts);
  check("title, subtitle, places and unplaced problems never come off", ["title", "subtitle", "place", "slide 3 place", "the file", "slide 3", "context"].every((x) => !R.droppableAt(x)) && ["slide 2 bullet 1", "slide 2 headline", "slide 2 notes", "section 1 line 2", "section 2 heading", "section 1 paragraph 1", "section 1 bullet 3", "suggestion 2"].every(R.droppableAt));
  check("a doc's time split into parts by the word check is still one time of theirs", R.asProblems(['"Supper at 7:30 PM" names 7:30 PM, PM, which they never said', '"Supper at 7:30 PM" isn\'t something they said: it has 7, 30, pm, which they never gave. Leave that out (or ask them)']).every((p) => p.kind === "an unbacked time") && R.asProblems(['"Built with Acme and 7pm" names Acme, 7pm, which they never said'])[0].kind !== "an unbacked time");
  check("a check that couldn't run is down, from either checker's wording", R.asProblems(["The check that every line is theirs couldn't run just now"])[0].down === true && R.asProblems(['"Acme leads" opens on Acme, which they never said: if it\'s a name, leave it out or ask them'])[0]?.kind !== "a placeholder");
  const dropped = R.dropDeckLines(d, ["slide 4 bullet 2"])!;
  check("dropping a bullet takes only that bullet", dropped.slides.length === 3 && dropped.slides[2].bullets.join("|") === "Founders, at my place in the Mission");
  check("dropping a headline takes its slide; under two slides is no deck", R.dropDeckLines(d, ["slide 2 headline"])!.slides.length === 2 && R.dropDeckLines(d, ["slide 2 headline", "slide 3 headline"]) === null);
  const page = { title: "T", context: "C", sections: [{ heading: "A", blocks: [{ type: "text", text: "one" }, { type: "bullets", items: [{ text: "two" }, { text: "three" }] }] }, { heading: "B", blocks: [{ type: "comparison", options: [{ name: "x" }, { name: "y" }] }] }] };
  const pd = R.dropPageLines(page as any, ["section 1 line 2", "section 2 line 1"])!;
  check("a page drops the right line (pageLines order) and a comparison left with one option", pd.sections.length === 1 && (pd.sections[0].blocks[1] as any).items.map((i: any) => i.text).join() === "three" && pd.sections[0].blocks[0].type === "text");
  const doc = { title: "T", sections: [{ heading: "H", paragraphs: ["p1"], bullets: ["b1", "b2"] }], suggestions: ["s1", "s2"] };
  const dd = R.dropDocLines(doc, ["section 1 bullet 2", "suggestion 1"])!;
  check("a document drops its bullet and suggestion", dd.sections[0].bullets!.join() === "b1" && dd.suggestions!.join() === "s2" && R.dropDocLines(doc, ["section 1 paragraph 1", "section 1 bullet 1", "section 1 bullet 2"]) === null);
}

// ---------------------------------------------------------------- 3. the slots: their shape, and never a made-up fact
{
  const refused = ['slide 2: "Supper at 7:30 PM" names 7:30pm, which they never said and you never read', 'slide 4: "Sponsored by Acme Labs" names Acme Labs, which they never said and you never read'];
  const tokens = R.factTokens(refused, THEIRS);
  check("the made-up facts are the slots' banned words", tokens.includes("7:30pm") && tokens.includes("acme labs") && tokens.includes("acme"), tokens);
  check("the approved question passes as written", R.cleanQuestion("what time does supper start", tokens, THEIRS) === "what time does supper start" && R.cleanQuestion("what time does supper start?", tokens, THEIRS) === "what time does supper start");
  for (const bad of ["is supper at 7:30", "is supper at 8", "does acme labs sponsor it", "does Acme sponsor it", "What time does supper start", "what time does supper start and how many are coming", "when's supper; who's coming", "tell me the time", "", null, 42]) check(`a question that isn't one plain ask, or leaks a fact, is refused: ${JSON.stringify(bad)}`, R.cleanQuestion(bad, tokens, THEIRS) === null);
  check("a name they gave may ride in the question", R.cleanQuestion("what time does supper start in the Mission", tokens, THEIRS) !== null);
  check("the approved kind of line passes", R.cleanWhat("the sponsorship line", tokens) === "the sponsorship line");
  for (const bad of ["the Acme line", "the acme labs line", "the 7:30 line", "sponsorship", "the sponsorship lines", "the line about who is paying for the whole night", "The sponsorship line"]) check(`a kind of line that leaks or doesn't fit is refused: ${bad}`, R.cleanWhat(bad, tokens) === null);
}

// ---------------------------------------------------------------- 3b. review of #243: every word of a refused line, any place
{
  const T = "I'm hosting a supper club in the Mission for founders. Small tables, good wine.";
  const q = (problems: string[], text: string) => R.cleanQuestion(text, R.factTokens(problems, T), T);
  const w = (problems: string[], text: string) => R.cleanWhat(text, R.factTokens(problems, T), T);
  const twelve = [`"Twelve guests a night" (an unbacked count)`];
  const sequin = [`"Sequin AI is sponsoring the night" (a sponsor they never named)`];
  check("review: a spelled-out count is refused in the question", q(twelve, "are twelve guests coming each night") === null);
  check("review: …and in the kind of line", w(twelve, "the twelve guests line") === null && w(twelve, "the guest count line") === "the guest count line");
  check("review: a name opening the refused line is refused in the kind of line", w(sequin, "the sequin sponsorship line") === null && w(sequin, "the sponsorship line") === "the sponsorship line");
  check("review: …and lowercased in the question", q(sequin, "is sequin still sponsoring the night") === null);
  check("review: a name after \"(\" in the judge's reason is refused", w([`"Backed by a sponsor" (Sequin sponsorship never mentioned)`], "the sequin sponsor line") === null);
  check("review: a code check's name is refused (control)", w([`slide 3 headline: names Sequin, which they never said`], "the sequin line") === null);
  check("review: an old value is never repeated, even said once", q([`"Bootstrapped, pre-seed" (an old fact that may have changed: funding stage may have changed)`], "are you still bootstrapped and pre-seed") === null && q([`"Based in austin" (an old fact that may have changed: city may have changed)`], "are you still based in austin") === null && q([`"Based in austin" (an old fact that may have changed: city may have changed)`], "are you still in the same city") === "are you still in the same city");
  check("review: an old value is never repeated even when it's in their words (they said it once)", R.cleanQuestion("are you still bootstrapped", R.factTokens([`"Bootstrapped, pre-seed" (an old fact that may have changed: funding stage may have changed)`], "We're bootstrapped, pre-seed."), "We're bootstrapped, pre-seed.") === null && R.cleanQuestion("are you still bootstrapped", R.factTokens([`"Bootstrapped, pre-seed" (an unbacked claim)`], "We're bootstrapped, pre-seed."), "We're bootstrapped, pre-seed.") !== null);
  check("review: one fact only, never \"X and Y\" or \"X or Y\"", q([], "what time does supper start and end") === null && q([], "is it monthly or weekly") === null && q([], "what time does supper start") === "what time does supper start");
  check("review: an invented weekday is refused", q([`"Every Thursday at the loft" (an unbacked date)`], "is it every thursday") === null);
  check("review: a number spelled out that's theirs may ride; one that isn't, can't", R.cleanQuestion("are the two tables still free", [], "we have two tables") !== null && R.cleanQuestion("are the two tables still free", [], "we have tables") === null);
}

// ---------------------------------------------------------------- 4. the flow, by path (decks on the real grounding check)
const fixedDeck = (slides: any) => JSON.stringify({ title: "Mission supper club", subtitle: "A supper for founders", slides });
// (a) refused, fixed, passes: sent as normal.
{
  reset(); checks = 0;
  const d = deckIn(BASE.slice(0, 2));
  const first = await deckCheck(d);
  fixAnswer = () => fixedDeck([{ headline: "The night", bullets: ["Drinks first, then supper"] }, BASE[1]]);
  const end: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: refused, one fix, it passes: sent as normal (no line of its own)", end.case === "pass" && fixes === 1 && asks === 0 && !("line" in end) && end.file.slides[0].bullets.join() === "Drinks first, then supper", end);
}
// (b) only their fact is missing, the fix can't place it: case 1, exactly.
{
  reset();
  const d = deckIn(BASE.slice(0, 2));
  const first = await deckCheck(d);
  const end: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: askable only, the fix fails: case 1, the approved line exactly", end.case === "ask" && end.line === "Before I send the deck, there's one thing I want to get right: what time does supper start? Tell me and I'll finish it." && fixes === 1 && asks === 1, end);
  check("…the held file is the deck as written, for their answer to finish", end.file.slides[0].bullets.includes("Supper at 7:30 PM"));
  // A question that leaks the made-up time is never sent: the deck goes without the line instead.
  reset(); askAnswer = JSON.stringify({ question: "is supper at 7:30" }); whatAnswer = JSON.stringify({ what: "the supper time line" });
  const leak: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: a question that would leak the made-up time is dropped; the deck goes without that line (case 2)", leak.case === "dropped" && !MADE_UP.test(leak.line) && !JSON.stringify(leak.file).includes("7:30"), leak);
  // Finishing from their answer never asks again.
  reset(); whatAnswer = JSON.stringify({ what: "the supper time line" });
  const fin: any = await R.afterRefusal(d, first.problems, deckDeps({ noAsk: true }));
  check("deck: finishing from their answer never asks a second question", fin.case !== "ask" && asks === 0, fin);
}
// (c) a sponsor line it can't confirm, most lines pass: dropped, re-checked, case 2.
{
  reset(); checks = 0;
  const d = deckIn([BASE[1], { headline: "Who it is for", bullets: ["Founders, at my place in the Mission", "Sponsored by Acme Labs"] }, { headline: "The feel", bullets: ["Drinks first, then supper", "One new friend each"] }]);
  const first = await deckCheck(d);
  const end: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: droppable, most lines pass: case 2, the approved line exactly", end.case === "dropped" && end.line === "Here's the deck. I left out the sponsorship line because I couldn't confirm it from what you've told me; say the word and I'll add it back.", end);
  check("…the refused line is gone from what goes, and the dropped deck was checked again", !JSON.stringify(end.file).includes("Acme") && !JSON.stringify(end.data).includes("Acme") && checks >= 2 && end.dropped.join() === "slide 3 bullet 2", { checks, end });
}
// (d) the check couldn't run: case 3, no rewrite.
{
  reset(); judgeDown = true;
  const d = deckIn([BASE[1], { headline: "The feel", bullets: ["Drinks first, then supper"] }]);
  const first = await deckCheck(d);
  const end: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: the judge couldn't run: case 3 exactly, and no rewrite on a guess", end.case === "down" && end.line === "Your deck didn't go through just now, so I haven't sent it. Want me to try again?" && fixes === 0 && asks === 0 && whats === 0, end);
  judgeDown = false;
}
// (e) not useful without them, nothing to ask: the minimum that passes still goes with its line; nothing at all: case 3.
{
  reset();
  const d = deckIn([{ headline: "Who it is for", bullets: ["Sponsored by Acme Labs", "Founders, at my place in the Mission"] }, { headline: "The feel", bullets: ["Partnering with Acme Labs", "Drinks first, then supper"] }]);
  const first = await deckCheck(d);
  const end: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: half the lines refused, none askable: the minimum that passes goes, with case 2", end.case === "dropped" && !JSON.stringify(end.file).includes("Acme") && /^Here's the deck\. I left out the sponsorship line/.test(end.line), end);
  reset(); whatAnswer = "not json";
  const noWhat: any = await R.afterRefusal(d, first.problems, deckDeps());
  check("deck: the kind of line can't be written: case 3, never an unapproved line", noWhat.case === "down" && noWhat.line === R.downLine("deck"), noWhat);
  reset();
  const title = { title: "Mission supper club", subtitle: "Sponsored by Acme Labs", slides: BASE.slice(1, 2).concat([{ headline: "The feel", bullets: ["Drinks first, then supper"] }]) };
  const t1 = await deckCheck(title);
  const t: any = await R.afterRefusal(title, t1.ok ? [] : t1.problems, deckDeps());
  check("deck: a refused subtitle can't come off and isn't theirs to answer: case 3", t.case === "down" && t.line === R.downLine("deck"), t);
}

// ---------------------------------------------------------------- 4b. an old fact that may have changed (#251): the one question
{
  const OLD = C.OLD_FACT;
  // The claims judge, stood in for, reading "Every month, 40 founders" as backed only by something they said months ago.
  const oldCheck = async (d: any): Promise<any> => {
    checks++;
    const data: any = await deckDataFrom(d as any, null, new Map(), null, {});
    const at = C.deckPositions(d);
    const stale = at.filter((x) => /every month/i.test(x.text));
    return stale.length ? { ok: false, problems: stale.map((x) => ({ text: `"${x.text}" (an old fact that may have changed: they said it in March)`, at: x.where, kind: OLD })) } : { ok: true, file: d, data };
  };
  const OLD_THEIRS = `${THEIRS} Every month, 40 founders.`;
  const d = deckIn([BASE[1], { headline: "The rhythm", bullets: ["Every month, 40 founders", "Drinks first, then supper"] }, { headline: "The feel", bullets: ["One new friend each", "Seasonal, family style"] }]);
  const first = await oldCheck(d);
  check("an old fact that may have changed is theirs to confirm (askable), placed on its bullet", !first.ok && first.problems[0].kind === "an old fact that may have changed" && R.askable(first.problems[0]) && first.problems[0].at === "slide 3 bullet 1", first);
  reset(); checks = 0;
  let prompt = "";
  R.setRefusalModelsForTests({ fix: async (p) => { fixes++; return fixAnswer(p); }, slots: { ask: async (p) => { asks++; prompt = p; return JSON.stringify({ question: "is the supper still on the same schedule" }); }, what: async () => { whats++; return whatAnswer; } } });
  const end: any = await R.afterRefusal(d, first.problems, deckDeps({ check: oldCheck, theirs: OLD_THEIRS }));
  check("old fact only: case 1 in the approved frame, the question asking whether it's still true", end.case === "ask" && end.line === "Before I send the deck, there's one thing I want to get right: is the supper still on the same schedule? Tell me and I'll finish it.", end);
  check("…no rewrite first (only they know whether it still holds), and the writer of the question is told to ask if it still holds, never the old value", fixes === 0 && asks === 1 && /ask whether it still holds, naming what it's about but never the old value/.test(prompt) && /an old fact that may have changed/.test(prompt), { fixes, prompt: prompt.slice(0, 400) });
  // The same guards as any case-1 question: the refused figure never rides in it.
  const tokens = R.factTokens(first.problems.map((p: any) => p.text), THEIRS);
  check("old fact: a question carrying the old figure, or any word of the old value, is refused, the same guard as case 1", R.cleanQuestion("is it still 40 founders every month", tokens, OLD_THEIRS) === null && R.cleanQuestion("is the supper still every month", tokens, OLD_THEIRS) === null && R.cleanQuestion("is the supper still on the same schedule", tokens, OLD_THEIRS) === "is the supper still on the same schedule");
  reset();
  R.setRefusalModelsForTests({ fix: async (p) => { fixes++; return fixAnswer(p); }, slots: { ask: async () => { asks++; return JSON.stringify({ question: "is it still 40 founders" }); }, what: async () => { whats++; return JSON.stringify({ what: "the monthly line" }); } } });
  const leak: any = await R.afterRefusal(d, first.problems, deckDeps({ check: oldCheck, theirs: OLD_THEIRS }));
  check("old fact: a leaking question never goes; the deck goes without that line instead (case 2), nothing old restated", leak.case === "dropped" && !/40/.test(leak.line) && !JSON.stringify(leak.file).includes("Every month"), leak);
  reset();
  R.setRefusalModelsForTests({ fix: async (p) => { fixes++; return fixAnswer(p); }, slots: { ask: async () => { asks++; return JSON.stringify({ question: "is the supper still on the same schedule" }); }, what: async () => { whats++; return whatAnswer; } } });
  const fin: any = await R.afterRefusal(d, first.problems, deckDeps({ check: oldCheck, theirs: OLD_THEIRS, noAsk: true }));
  check("old fact, finishing from their answer: never a second question", fin.case !== "ask" && asks === 0, fin);
  // Mixed with an invented sponsor: not old-only, so the writer gets its fix first, as any refusal.
  reset();
  R.setRefusalModelsForTests({ fix: async (p) => { fixes++; return "{}"; }, slots: { ask: async () => { asks++; return JSON.stringify({ question: null }); }, what: async () => { whats++; return whatAnswer; } } });
  await R.afterRefusal(d, [...first.problems, { text: '"Sponsored by Acme Labs" (a sponsor they never named)', at: "slide 4 bullet 1", kind: "a third-party claim" }], deckDeps({ check: oldCheck, theirs: OLD_THEIRS }));
  check("old fact mixed with an invented claim: the writer still gets its one fix", fixes === 1);
  // The deck's real judge path carries the kind through (deckTools.ts inventedClaims).
  const dt = src("agent/deckTools.ts");
  check("wired: the deck judge's old-fact verdict reaches the flow as its own kind", /kind: f\.old \? R\.OLD_FACT : R\.judgedKind\(f\.why\)/.test(dt) && /problems: fails\.map\(\(f, i\) => \(\{ text: `"\$\{f\.line\}" \(\$\{f\.old \? `an old fact that may have changed: \$\{f\.why\}` : f\.why\}\)`, at: refused\[i\]\.at, kind: refused\[i\]\.kind \}\)\)/.test(dt));
  R.setRefusalModelsForTests({ fix: async (p) => { fixes++; return fixAnswer(p); }, slots: { ask: async () => { asks++; return askAnswer; }, what: async () => { whats++; return whatAnswer; } } });
  reset();
}

// ---------------------------------------------------------------- 5. a page, end to end through makePage and updatePage
const pageCalls: { sql: string; params: unknown[] }[] = [];
let pageNext: any = { rows: [], rowCount: 1 };
S.useCoPageDb({ query: async (sql: string, params: unknown[] = []) => { pageCalls.push({ sql: sql.replace(/\s+/g, " "), params }); return typeof pageNext === "function" ? pageNext(sql) : pageNext; } });
const pageInput = (bullets: string[]) => ({ title: "Supper club night", context: "At my place in the Mission, for founders", sections: [{ heading: "The night", blocks: [{ type: "bullets" as const, items: bullets.map((t) => ({ text: t })) }] }], sources: [], line: "Here's the supper club night." });
const pageRun = async (input: any, o: { ctx?: any; tool?: "makePage" | "updatePage" } = {}) => {
  const said: string[] = [];
  const facts: string[] = [];
  const ctx: any = { userId: "jordan-1", dryRun: false, resolvedContent: "make me a page for the supper club", facts: { add: (_k: string, t: string) => facts.push(t) }, ...(o.ctx ?? {}) };
  const tools: any = P.pageTools(ctx, { say: async (t) => { said.push(t); return true; }, notDone: () => {}, source: async () => source });
  pendingSql.length = 0;
  const r = await tools[o.tool ?? "makePage"].execute(input, {});
  return { r, said, facts, ctx, tools };
};
{
  // Refused, fixed, passes.
  reset();
  fixAnswer = () => JSON.stringify({ ...pageInput(["Drinks first, then supper", "Seasonal, family style"]) });
  const a = await pageRun(pageInput(["Drinks first, then supper", "Supper at 7:30 PM", "Seasonal, family style"]));
  check("page: refused, one fix, it passes: one text, its own line and the link", a.said.length === 1 && /^Here's the supper club night\.\nhttps:\/\/co\.example\/d\//.test(a.said[0]) && fixes === 1 && !MADE_UP.test(a.said[0]), { said: a.said, r: a.r });
  // Askable: case 1, the line held, the file kept for their answer.
  reset();
  const b = await pageRun(pageInput(["Drinks first, then supper", "Supper at 7:30 PM", "Seasonal, family style"]));
  const ins = pendingSql.find((c) => /INSERT INTO co_tasks/.test(c.sql));
  check("page: askable: exactly one text, case 1 exactly", b.said.length === 1 && b.said[0] === "Before I send the page, there's one thing I want to get right: what time does supper start? Tell me and I'll finish it.", b.said);
  check("…held for their answer: a pending_file row, waiting on their reply, mode answer, the open loop's title says nothing of what's on it", !!ins && /'pending_file'/.test(ins.sql) && /awaiting_reply|true, \$8/.test(ins.sql) && JSON.parse(String(ins.params[6])).pendingFile.mode === "answer" && JSON.parse(String(ins.params[6])).pendingFile.type === "page" && ins.params[1] === "Finish their page once they answer Cue's question about it", ins);
  check("…the turn is answered (no fallback, no second reply about it) and the tool says so", b.r.ok === false && b.r.told === true && /whole reply about the page/.test(b.r.error));
  // The same turn can't send a second line.
  const again = await b.tools.makePage.execute(pageInput(["Supper at 7:30 PM", "Seasonal, family style"]), {});
  check("page: a second refused file in the same turn sends nothing more", again.told === true && b.said.length === 1);
  // Droppable: case 2, the refused line absent.
  reset(); whatAnswer = JSON.stringify({ what: "the venue line" });
  const c = await pageRun(pageInput(["Drinks first, then supper", "Seasonal, family style", "One new friend each", "Hosted at the Acme Labs loft"]));
  check("page: droppable: exactly one text, case 2 exactly, with the link", c.said.length === 1 && c.said[0].startsWith("Here's the page. I left out the venue line because I couldn't confirm it from what you've told me; say the word and I'll add it back.\nhttps://co.example/d/"), c.said);
  const stored = pageCalls.filter((x) => /INSERT INTO co_pages/.test(x.sql)).pop();
  check("…what's stored and linked has no made-up line", !!stored && !MADE_UP.test(String(stored.params[2])), stored?.params[2]);
  // The kind of line can't be written: case 3; their yes tries again (held as retry).
  reset(); whatAnswer = "nope";
  const d = await pageRun(pageInput(["Drinks first, then supper", "Seasonal, family style", "One new friend each", "Hosted at the Acme Labs loft"]));
  const ins2 = pendingSql.find((x) => /INSERT INTO co_tasks/.test(x.sql));
  check("page: nothing that passes can go: case 3 exactly, held for their yes", d.said.length === 1 && d.said[0] === "Your page didn't go through just now, so I haven't sent it. Want me to try again?" && JSON.parse(String(ins2?.params[6] ?? "{}")).pendingFile?.mode === "retry", { said: d.said, ins2 });
  // On a call, in a test run, on a turn where they may not be safe: handed back as before, nothing sent by code.
  for (const [label, extra] of [["a call", { onCall: true }], ["a safety turn", { safetyConcern: true }]] as const) {
    reset();
    const e = await pageRun(pageInput(["Supper at 7:30 PM", "Seasonal, family style"]), { ctx: extra });
    check(`page: on ${label}, no line goes from code: the refusal goes back to the agent as before`, e.said.length === 0 && e.r.ok === false && /Fix these and try once more/.test(e.r.error) && fixes === 0 && asks === 0, e.r);
  }
  // Finishing a held page from their answer: never a second question.
  reset();
  const f = await pageRun(pageInput(["Drinks first, then supper", "Supper at 7:30 PM", "Seasonal, family style"]), { ctx: { finishing: { mode: "answer", taskId: 501 } } });
  check("page: finishing from their answer never asks again (it goes without the line instead)", asks === 0 && f.said.length === 1 && !/^Before I send/.test(f.said[0]) && !MADE_UP.test(f.said[0]), f.said);
  // Finishing on their yes with the check still unable: nothing more is said ("try again?" never twice).
  reset(); whatAnswer = "nope";
  const g = await pageRun(pageInput(["Drinks first, then supper", "Seasonal, family style", "One new friend each", "Hosted at the Acme Labs loft"]), { ctx: { finishing: { mode: "retry", taskId: 502 } } });
  check("page: their yes, still nothing that passes: no second \"try again?\"", g.said.length === 0 && !pendingSql.some((x) => /INSERT INTO co_tasks/.test(x.sql)), g.said);
  // updatePage: the same flow before anything is written.
  reset(); whatAnswer = JSON.stringify({ what: "the venue line" });
  pageNext = (sql: string) => (/SELECT id, data->>'title'/.test(sql) ? { rows: [{ id: "A".repeat(24), title: "Supper club night", updated_at: new Date(), kind: "page" }] } : /UPDATE co_pages SET data/.test(sql) ? { rows: [{ version: 2 }] } : { rows: [], rowCount: 1 });
  const u = await pageRun({ ...pageInput(["Drinks first, then supper", "Seasonal, family style", "One new friend each", "Hosted at the Acme Labs loft"]), page: "supper club", changed: "added the venue" }, { tool: "updatePage" });
  const upd = pageCalls.filter((x) => /UPDATE co_pages SET data/.test(x.sql)).pop();
  check("page change: droppable: one text, case 2, the same link, and nothing made up written", u.said.length === 1 && u.said[0] === `Here's the page. I left out the venue line because I couldn't confirm it from what you've told me; say the word and I'll add it back.\nhttps://co.example/d/${"A".repeat(24)}` && !!upd && !MADE_UP.test(JSON.stringify(upd.params)), { said: u.said, r: u.r });
  pageNext = { rows: [], rowCount: 1 };
}
S.useCoPageDb(null);

// ---------------------------------------------------------------- 6. a doc in a reply (docFlow, the doc's own checks)
const DOC_THEIRS = "Jordan: supper club for founders at my place in the Mission. Drinks first, then supper. Seasonal, family style. I want everyone to leave with one new friend. I'm keeping it small and warm.";
const docIn = (bullets: string[], suggestions: string[] = []) => ({ title: "Supper club plan", sections: [{ heading: "The night", paragraphs: ["Drinks first, then supper, family style."], bullets }], suggestions });
const passJudge = async (prompt: string) => JSON.stringify({ backed: Array.from({ length: 20 }, (_, i) => i + 1), fails: [] });
{
  reset();
  const bad = docIn(["Seasonal, family style", "Supper at 7:30 PM", "One new friend each", "Small and warm"]);
  const first = DS.documentProblems(DS.resolveDocument(bad), { theirs: DOC_THEIRS });
  check("doc: the made-up time is refused by the word check", first.some((p) => /7:30/.test(p)), first);
  const ask: any = await DD.docFlow(bad as any, first, { theirs: DOC_THEIRS, word: "doc", judge: passJudge });
  check("doc: askable: case 1 exactly", ask.case === "ask" && ask.line === "Before I send the doc, there's one thing I want to get right: what time does supper start? Tell me and I'll finish it.", ask);
  reset();
  fixAnswer = () => JSON.stringify(docIn(["Seasonal, family style", "One new friend each", "Small and warm"]));
  const pass: any = await DD.docFlow(bad as any, first, { theirs: DOC_THEIRS, word: "doc", judge: passJudge });
  check("doc: refused, one fix, it passes", pass.case === "pass" && fixes === 1 && !MADE_UP.test(JSON.stringify(pass.data)), pass);
  reset(); askAnswer = JSON.stringify({ question: null }); whatAnswer = JSON.stringify({ what: "the supper time line" });
  const drop: any = await DD.docFlow(bad as any, first, { theirs: DOC_THEIRS, word: "doc", judge: passJudge });
  check("doc: no question that fits: dropped, re-checked, case 2 exactly", drop.case === "dropped" && drop.line === "Here's the doc. I left out the supper time line because I couldn't confirm it from what you've told me; say the word and I'll add it back." && !MADE_UP.test(JSON.stringify(drop.data)) && drop.data.sections[0].bullets.length === 3, drop);
  reset();
  const down: any = await DD.docFlow(bad as any, first, { theirs: DOC_THEIRS, word: "doc", judge: passJudge, firstDown: true });
  check("doc: the judge couldn't run: case 3 exactly, no rewrite", down.case === "down" && down.line === "Your doc didn't go through just now, so I haven't sent it. Want me to try again?" && fixes === 0, down);
}

// ---------------------------------------------------------------- 7. a task's document, end to end (sendDocumentForTask)
const SF = "America/Los_Angeles";
const docRun = async (input: any, o: { blocked?: string | null; safety?: boolean; finishing?: { mode: "answer" | "retry" }; sayOk?: boolean } = {}) => {
  const said: string[] = [];
  const delivered: { doc: any; line: string }[] = [];
  const holds: any[] = [];
  const logs: any[] = [];
  const r = await DD.sendDocumentForTask(input, { userId: "jordan-1", taskId: 77, firstName: "Jordan", phone: "+14155550123", zone: SF, taskTheirWords: DOC_THEIRS, read: "", ...(o.finishing ? { finishing: o.finishing } : {}) }, {
    theirWords: async () => DOC_THEIRS,
    blocked: async () => o.blocked ?? null,
    deliver: async (doc: any, to: any) => { delivered.push({ doc, line: to.line }); return { ok: true, via: "pdf_text", filename: "x.pdf" } as any; },
    record: async () => {},
    now: () => new Date("2026-10-18T19:00:00Z"),
    receipts: memoryReceipts(),
    refusals: { safetyHold: async () => !!o.safety, say: async (x) => { said.push(x.text); return o.sayOk !== false; }, hold: async (h) => { holds.push(h); }, log: async (row) => { logs.push(row); } },
  });
  return { r, said, delivered, holds, logs, messages: said.length + delivered.length };
};
const BAD_DOC = docIn(["Seasonal, family style", "Supper at 7:30 PM", "One new friend each", "Small and warm"]);
{
  reset();
  const a = await docRun(BAD_DOC);
  check("task document: askable: exactly one message, case 1 exactly", a.messages === 1 && a.said[0] === "Before I send the document, there's one thing I want to get right: what time does supper start? Tell me and I'll finish it." && a.r.ok === false && (a.r as any).told === "ask", a);
  check("…held on the task for their answer (mode answer, the document as written)", a.holds.length === 1 && a.holds[0].mode === "answer" && a.holds[0].taskId === 77);
  reset(); askAnswer = JSON.stringify({ question: null }); whatAnswer = JSON.stringify({ what: "the supper time line" });
  const b = await docRun(BAD_DOC);
  check("task document: droppable: exactly one message, the document without the line, case 2 as its caption", b.messages === 1 && b.delivered[0].line === "Here's the document. I left out the supper time line because I couldn't confirm it from what you've told me; say the word and I'll add it back." && !MADE_UP.test(JSON.stringify(b.delivered[0].doc)) && b.r.ok, b);
  reset(); fixAnswer = () => JSON.stringify(docIn(["Seasonal, family style", "One new friend each", "Small and warm"]));
  const c = await docRun(BAD_DOC);
  check("task document: refused, one fix, it passes: one message, its own caption", c.messages === 1 && c.delivered.length === 1 && !R.isRefusalLine(c.delivered[0].line) && c.r.ok, c);
  reset();
  const q = await docRun(BAD_DOC, { blocked: DD.QUIET_HOURS });
  check("task document: their quiet hours hold the question too: nothing sent, the next look at their 8am", q.messages === 0 && (q.r as any).blocked && (q.r as any).nextAt instanceof Date && q.holds.length === 0, q.r);
  reset();
  const s = await docRun(BAD_DOC, { safety: true });
  check("task document: a safety hold: no question is asked; it waits a day", s.messages === 0 && (s.r as any).blocked && /safety hold/.test(s.r.why ?? ""), s.r);
  reset(); whatAnswer = "nope";
  const fr = await docRun(docIn(["Seasonal, family style", "Supper at 7:30 PM"]), { finishing: { mode: "retry" } });
  check("task document: their yes, still nothing that passes: nothing more is said", fr.messages === 0 && fr.holds.length === 0, fr);
  reset();
  const fa = await docRun(BAD_DOC, { finishing: { mode: "answer" } });
  check("task document: finishing from their answer never asks a second question", asks === 0 && fa.messages === 1 && !/^Before I send/.test(fa.said[0] ?? fa.delivered[0]?.line ?? ""), fa);
  reset();
  const ns = await docRun(BAD_DOC, { sayOk: false });
  check("task document: the line didn't send: nothing is held, the task is told plainly", ns.holds.length === 0 && ns.r.ok === false && !(ns.r as any).told, ns.r);
  // Logs: place and kind only.
  reset();
  const lg = await docRun(BAD_DOC);
  const row = JSON.stringify(lg.logs.map((l) => R.outcomeRow(l)));
  check("logs carry places and kinds, never a line, the question or the made-up fact", lg.logs.length === 1 && /slide|section 1 bullet 2/.test(row) && !/7:30|supper|Seasonal|what time/i.test(row), row);
}

// ---------------------------------------------------------------- 8. never silent: every refusal path ends in exactly one message
{
  const paths: { name: string; run: () => Promise<number> }[] = [
    { name: "task: ask", run: async () => { reset(); return (await docRun(BAD_DOC)).messages; } },
    { name: "task: fix passes", run: async () => { reset(); fixAnswer = () => JSON.stringify(docIn(["Seasonal, family style", "One new friend each", "Small and warm"])); return (await docRun(BAD_DOC)).messages; } },
    { name: "task: dropped", run: async () => { reset(); askAnswer = "{}"; whatAnswer = JSON.stringify({ what: "the supper time line" }); return (await docRun(BAD_DOC)).messages; } },
    { name: "task: down (slot unwritable)", run: async () => { reset(); askAnswer = "{}"; whatAnswer = "x"; return (await docRun(BAD_DOC)).messages; } },
    { name: "page: ask", run: async () => { reset(); return (await pageRun(pageInput(["Drinks first, then supper", "Supper at 7:30 PM", "Seasonal, family style"]))).said.length; } },
    { name: "page: dropped", run: async () => { reset(); whatAnswer = JSON.stringify({ what: "the venue line" }); return (await pageRun(pageInput(["Drinks first, then supper", "Seasonal, family style", "One new friend each", "Hosted at the Acme Labs loft"]))).said.length; } },
    { name: "page: down", run: async () => { reset(); whatAnswer = "x"; return (await pageRun(pageInput(["Drinks first, then supper", "Seasonal, family style", "One new friend each", "Hosted at the Acme Labs loft"]))).said.length; } },
    { name: "page: fix passes", run: async () => { reset(); fixAnswer = () => JSON.stringify(pageInput(["Drinks first, then supper", "Seasonal, family style"])); return (await pageRun(pageInput(["Drinks first, then supper", "Supper at 7:30 PM", "Seasonal, family style"]))).said.length; } },
  ];
  S.useCoPageDb({ query: async () => ({ rows: [], rowCount: 1 }) });
  const counts: Record<string, number> = {};
  for (const p of paths) counts[p.name] = await p.run();
  S.useCoPageDb(null);
  check("never silent, never twice: every refusal path sends exactly one message", Object.values(counts).every((n) => n === 1), counts);
}

// ---------------------------------------------------------------- 9. their answer finishes it (services/pendingFiles.ts)
{
  const at = new Date("2026-10-18T19:00:00Z");
  const held = { type: "page" as const, word: "page" as const, mode: "answer" as const, input: {}, at: at.toISOString() };
  const fdeps = (o: { lines?: string[]; hours?: boolean; claimOk?: boolean; now?: Date; person?: any; outcome?: string; safety?: boolean; tellOk?: boolean; paused?: boolean; task?: any } = {}) => {
    const log: { a: string; x: any }[] = []; const runs: string[] = []; const waits: Date[] = []; const closes: string[] = []; const tells: string[] = []; const retries: string[] = []; const releases: number[] = [];
    let running = false;
    return {
      log, runs, waits, closes, tells, retries, releases,
      deps: {
        now: () => o.now ?? new Date(at.getTime() + 3600_000),
        person: o.person === undefined ? { phone: "+14155550123", firstName: "Jordan", zone: SF, optedOut: false, archived: false } : o.person,
        theirLinesSince: async () => o.lines ?? ["8pm, right after drinks"],
        hoursOk: () => o.hours !== false,
        nextOpen: () => new Date(at.getTime() + 12 * 3600_000),
        safetyHold: async () => !!o.safety,
        paused: () => !!o.paused,
        // As claimPending does: marked running, and the try counted on the row.
        claim: async () => { if (running || o.claimOk === false) return false; running = true; if (o.task) o.task.followup.pendingFile.tries = (o.task.followup.pendingFile.tries ?? 0) + 1; return true; },
        release: async () => { running = false; releases.push(1); },
        run: async (_p: any, answer: string) => { runs.push(answer); return { outcome: (o.outcome ?? "sent") as any }; },
        tellDown: async (w: string) => { tells.push(R.downLine(w as any)); return o.tellOk !== false; },
        toRetry: async (w: string) => { retries.push(w); },
        close: async (st: string, why: string) => { closes.push(`${st}:${why}`); return true; },
        wait: async (d: Date) => { waits.push(d); },
        log: async (a: string, x: any) => { log.push({ a, x }); },
      },
    };
  };
  const replied = { id: 501, userId: "jordan-1", createdAt: at.toISOString(), theirReplyAt: new Date(at.getTime() + 600_000).toISOString(), followup: { pendingFile: held } };
  const a = fdeps();
  const ra = await PF.finishPendingFile(replied, a.deps as any);
  check("their answer: claimed (marked running, not closed), the same tool runs once with their answer, then closed done", ra.action === "finished" && a.runs.length === 1 && a.runs[0] === "8pm, right after drinks" && a.closes.length === 1 && a.closes[0].startsWith("done"), { ra, a });
  const twice = await PF.finishPendingFile(replied, a.deps as any);
  check("a second wake while it runs can't run it again", twice.action === "already_settled" && a.runs.length === 1);
  const sf = fdeps({ outcome: "send_failed" });
  const rsf = await PF.finishPendingFile(replied, sf.deps as any);
  check("review: the send wasn't made (paused, held, failed): never closed, kept for a retry in an hour", rsf.action === "send_failed_kept" && sf.closes.length === 0 && sf.releases.length === 1 && sf.waits[0].getTime() === at.getTime() + 3600_000 + PF.RETRY_AFTER_MS && sf.tells.length === 0, sf);
  const te = fdeps({ outcome: "tool_error" });
  const rte = await PF.finishPendingFile(replied, te.deps as any);
  check("review: the tool couldn't make it (deck gone, picture deleted, a change landed): one approved line, case 3, and it waits for their yes", rte.action === "tool_error_told" && te.tells.length === 1 && te.tells[0] === "Your page didn't go through just now, so I haven't sent it. Want me to try again?" && te.retries.join() === "page" && te.closes.length === 0, te);
  const ten = fdeps({ outcome: "tool_error", tellOk: false });
  const rten = await PF.finishPendingFile(replied, ten.deps as any);
  check("…and if that line couldn't go either, the row is kept for a retry, never closed silent", rten.action === "tool_error_kept" && ten.closes.length === 0 && ten.waits.length === 1, ten);
  const retry = { ...replied, followup: { pendingFile: { ...held, mode: "retry" as const } } };
  const ter = fdeps({ outcome: "tool_error", lines: ["yes"] });
  const rter = await PF.finishPendingFile(retry, ter.deps as any);
  check("on their yes, a tool that still can't make it says nothing more (never \"try again?\" twice; listed for Royce)", rter.action === "tool_error_on_yes" && ter.tells.length === 0 && ter.closes[0].startsWith("dropped"), ter);
  const nm = fdeps({ outcome: "nothing_more", lines: ["yes"] });
  check("their yes, the check still down: closed, nothing more sent", (await PF.finishPendingFile(retry, nm.deps as any)).action === "nothing_more" && nm.tells.length === 0);
  const sh = fdeps({ safety: true });
  const rsh = await PF.finishPendingFile(replied, sh.deps as any);
  check("review: a safety hold: nothing runs or goes; it waits a day", rsh.action === "held_safety" && sh.runs.length === 0 && sh.waits[0].getTime() === at.getTime() + 3600_000 + PF.SAFETY_WAIT_MS, sh);
  check("review: the logs carry kinds only, never a tool's error text", [a, sf, te, ter].every((x) => x.log.every((l) => Object.keys(l.x ?? {}).every((k) => k === "type" || k === "mode"))));
  check("review: a run's outcome is read by kind: a tool error never passes as sent", PF.toolOutcome({ ok: false, error: "That deck is gone (taken down or expired)." }, { sent: false, sendFailed: false }) === "tool_error" && PF.toolOutcome({ ok: false, made: "x" }, { sent: false, sendFailed: true }) === "send_failed" && PF.toolOutcome({ ok: false, error: "The check still couldn't run, so nothing was sent." }, { sent: false, sendFailed: false }) === "nothing_more" && PF.toolOutcome({ ok: true }, { sent: true, sendFailed: false }) === "sent");
  check("review: a held doc's outcome too", PF.docOutcome({ ok: true }) === "sent" && PF.docOutcome({ ok: false, told: "down" }) === "sent" && PF.docOutcome({ ok: false, blocked: true }) === "send_failed" && PF.docOutcome({ ok: false, why: "Not sent: the check still couldn't run." }) === "nothing_more" && PF.docOutcome({ ok: false, why: "Not sent: it's not a document." }) === "tool_error");
  // Review 2 of #243: retries after their answer are bounded, by count and by the hold's days, and checked for a pause first.
  {
    const t: any = { ...replied, followup: { pendingFile: { ...held } } };
    const x = fdeps({ outcome: "send_failed", task: t });
    const acts: string[] = [];
    for (let i = 0; i < 50; i++) acts.push((await PF.finishPendingFile(t, { ...x.deps, claim: async () => { t.followup.pendingFile.tries = (t.followup.pendingFile.tries ?? 0) + 1; return true; } } as any)).action);
    check("review 2: sends that keep failing run the tool at most MAX_FINISH_TRIES times, then it closes, wiped, without a message", x.runs.length === PF.MAX_FINISH_TRIES && acts.includes("tries_used") && x.tells.length === 0 && x.closes.some((c) => c.startsWith("expired")), { runs: x.runs.length, acts: [...new Set(acts)] });
    const old = { ...replied, followup: { pendingFile: { ...held, at: new Date(at.getTime() - 40 * 86_400_000).toISOString() } }, theirReplyAt: new Date(at.getTime() - 39 * 86_400_000).toISOString() };
    const y = fdeps({ outcome: "send_failed" });
    const ry = await PF.finishPendingFile(old as any, y.deps as any);
    check("review 2: past its days from the hold, even after their reply: closed and wiped, nothing runs", ry.action === "expired_after_reply" && y.runs.length === 0 && y.closes[0].startsWith("expired"), ry);
    const z = fdeps({ paused: true });
    const rz = await PF.finishPendingFile(replied, z.deps as any);
    check("review 2: paused: checked before the tool runs (nothing stored, no try spent), it waits an hour", rz.action === "held_paused" && z.runs.length === 0 && z.closes.length === 0 && z.waits.length === 1, rz);
    const te2: any = { ...replied, followup: { pendingFile: { ...held } } };
    const w2 = fdeps({ outcome: "tool_error", tellOk: false, task: te2 });
    let n2 = 0;
    for (let i = 0; i < 10; i++) { await PF.finishPendingFile(te2, { ...w2.deps, claim: async () => { te2.followup.pendingFile.tries = (te2.followup.pendingFile.tries ?? 0) + 1; return true; } } as any); }
    n2 = w2.runs.length;
    check("review 2: a tool error whose line can't go either is bounded the same way", n2 === PF.MAX_FINISH_TRIES, n2);
    check("review 2: a deck or page made for a text that didn't go is taken down at once (no orphan left by a retry)", PF.orphanId({ ok: false, made: "the deck", url: `https://co.example/d/${"B".repeat(24)}` }) === "B".repeat(24) && PF.orphanId({ ok: true, url: `https://co.example/d/${"B".repeat(24)}` }) === null && /if \(orphan\) await \(await import\("\.\/coPages\/store\.js"\)\)\.takeDownCoPage\(orphan, task\.userId\)/.test(src("services/pendingFiles.ts")));
    check("review 2: the real finish reads the pause", /paused: \(\) => P\.proactivePaused\(\),/.test(src("services/pendingFiles.ts")) && /'\{pendingFile,tries\}'/.test(src("services/pendingFiles.ts")));
  }
  const b = fdeps();
  const rb = await PF.finishPendingFile({ ...replied, theirReplyAt: null }, b.deps as any);
  check("no answer yet: it waits, to its days' end, nothing sent", rb.action === "waiting" && b.runs.length === 0 && b.waits[0].getTime() === at.getTime() + PF.PENDING_DAYS * 86_400_000);
  const c = fdeps({ now: new Date(at.getTime() + (PF.PENDING_DAYS + 1) * 86_400_000) });
  const rc = await PF.finishPendingFile({ ...replied, theirReplyAt: null }, c.deps as any);
  check("no answer in its days: expired and wiped (forget by default), nothing sent", rc.action === "expired" && c.runs.length === 0 && c.closes[0].startsWith("expired"));
  const d = fdeps({ hours: false });
  const rd = await PF.finishPendingFile(replied, d.deps as any);
  check("their answer at 11pm: held to their 8am, nothing sent now", rd.action === "held_hours" && d.runs.length === 0 && d.waits.length === 1 && d.closes.length === 0);
  const e = fdeps({ lines: ["Yes please"] });
  check("case 3, their yes: tried again once", (await PF.finishPendingFile(retry, e.deps as any)).action === "finished" && e.runs.length === 1);
  const f = fdeps({ lines: ["no, never mind"] });
  check("case 3, not a yes: closed quietly, nothing tried", (await PF.finishPendingFile(retry, f.deps as any)).action === "declined" && f.runs.length === 0);
  const g = fdeps({ person: { phone: "x", firstName: "J", zone: SF, optedOut: true, archived: false } });
  check("opted out: closed, nothing sent", (await PF.finishPendingFile(replied, g.deps as any)).action === "member_gone" && g.runs.length === 0);
  check("a task's own held document: answered only by a reply after the hold", heldAnswered({ theirReplyAt: new Date(at.getTime() + 1000).toISOString(), followup: { pendingFile: held } } as any) && !heldAnswered({ theirReplyAt: new Date(at.getTime() - 1000).toISOString(), followup: { pendingFile: held } } as any) && !heldAnswered({ theirReplyAt: null, followup: { pendingFile: held } } as any));
  check("a held deck keeps no taste (never recorded twice), no brief, no read confirm", (() => { const h: any = heldInput({ taste: { quote: "x" }, readConfirmed: true, brief: "b", audience: "founders", alsoAnswer: "a" }, { title: "T", subtitle: "S", slides: [] }); return !("taste" in h) && !("brief" in h) && !("readConfirmed" in h) && !("alsoAnswer" in h) && h.audience === "founders" && h.title === "T"; })());
  // The held rows: written, settled and wiped by kind; the goal never carries what's on the file.
  pendingSql.length = 0;
  await PF.rememberPending({ userId: "jordan-1", type: "deck", word: "deck", mode: "answer", input: { slides: [{ bullets: ["Supper at 7:30 PM"] }] }, theirWords: "make the deck", now: at });
  check("remembering supersedes an older held file of the same kind, then holds this one, waiting on their reply", /UPDATE co_tasks SET status = \$3/.test(pendingSql[0]?.sql ?? "") && /followup = COALESCE\(followup, '\{\}'::jsonb\) - 'pendingFile'/.test(pendingSql[0]?.sql ?? "") && /'pending_file'/.test(pendingSql[1]?.sql ?? "") && !MADE_UP.test(String(pendingSql[1]?.params[1])) && !MADE_UP.test(String(pendingSql[1]?.params[3])));
  pendingSql.length = 0;
  check("review: a run is claimed by marking it running, never by closing it first", (await PF.claimPending("jordan-1", 501)) === false && /jsonb_set\(followup, '\{pendingFile,runningAt\}'/.test(pendingSql[0]?.sql ?? "") && !/status = 'done'/.test(pendingSql[0]?.sql ?? ""));
  const pf = src("services/pendingFiles.ts");
  check("review: the real finish reads the safety hold, failing closed", /safetyHold: async \(\) => \(await import\("\.\/safety\.js"\)\)\.safetyHoldActive\(task\.userId\)\.catch\(\(\) => true\)/.test(pf));
}

// ---------------------------------------------------------------- 9b. review of #243: one question, ever; forgetting reaches held files
{
  // Their reply to the question, refused again in the reply turn: no second question.
  reset();
  const asked = R.askLine("page", "what time does supper start");
  const r2 = await pageRun(pageInput(["Drinks first, then supper", "Supper at 7:30 PM", "Seasonal, family style"]), { ctx: { lastCoMessage: asked } });
  check("review: Cue's last text was the question for this page: the reply turn never asks another", asks === 0 && r2.said.length === 1 && !/^Before I send/.test(r2.said[0]) && !MADE_UP.test(r2.said[0]), r2.said);
  check("review: …the same rule for decks and docs (the question for another kind of file doesn't count)", RT.askedLast({ lastCoMessage: R.askLine("deck", "q") }, "deck") && !RT.askedLast({ lastCoMessage: R.askLine("deck", "q") }, "page") && !RT.askedLast({ lastCoMessage: "Here's the deck." }, "deck"));
  const dt = src("agent/deckTools.ts");
  check("review: makeDeck, updateDeck, pages and docs all read it", (dt.match(/noAsk: noAskHere\(ctx, "deck"\)/g) ?? []).length === 2 && /noAsk: noAskHere\(ctx, "page"\)/.test(src("agent/pageTools.ts")) && /noAsk: noAskHere\(ctx, "doc"\)/.test(src("agent/loopTools.ts")));
  // Every close wipes a held file.
  check("review: every task close wipes a held file (forget by default)", /ELSE followup END\) - 'pendingFile'/.test(src("services/coTasks.ts")));
  // A removal reaches a held file by its content, not by the row's generic goal.
  const W = await import("../../src/services/whatCoKnows.js");
  const sql: { sql: string; params: unknown[] }[] = [];
  const fake = { query: async (q: string, params: unknown[] = []) => {
    sql.push({ sql: q.replace(/\s+/g, " "), params });
    if (/FROM proactive_candidates/.test(q)) return { rows: [] };
    if (/FROM deferred_sends/.test(q)) return { rows: [] };
    if (/SELECT id, goal, target_key, kind, followup->'pendingFile' AS held FROM co_tasks/.test(q)) return { rows: [{ id: 501, goal: PF.pendingGoal("deck", "answer"), target_key: null, kind: "pending_file", held: { input: { slides: [{ headline: "Who comes", bullets: ["Sponsored by Acme Labs"] }] } } }, { id: 77, goal: "Keep your promise: the supper plan", target_key: null, kind: "work", held: { input: { sections: [{ bullets: ["Acme Labs covers the wine"] }] } } }] };
    return { rows: [{ kind: "x" }], rowCount: 1 };
  } };
  const out = await W.cancelQueued(fake as any, "jordan-1", [{ ref: "claim:9", source: "text" as any, was: "Acme Labs", now: null }]);
  const wipes = sql.filter((x) => /UPDATE co_tasks/.test(x.sql));
  check("review: a removed fact in a held file cancels its row and wipes the file (matched by what it holds)", wipes.some((x) => x.params[0] === 501 && /status = 'dropped'/.test(x.sql) && /- 'pendingFile'/.test(x.sql)) && out.some((o: any) => o.id === "501"), { wipes, out });
  check("review: …a task's held document is wiped and the task goes on", wipes.some((x) => x.params[0] === 77 && /- 'pendingFile'/.test(x.sql) && !/status = 'dropped'/.test(x.sql)), wipes);
  // Review 2: each held line on its own, so a one-word correction reaches it.
  check("review 2: held lines are read one by one", W.heldStrings({ input: { title: "Supper", slides: [{ headline: "Where", bullets: ["A loft in Oakland"] }] } }).includes("A loft in Oakland"));
  sql.length = 0;
  const fake2 = { query: async (q: string, params: unknown[] = []) => {
    sql.push({ sql: q.replace(/\s+/g, " "), params });
    if (/FROM proactive_candidates|FROM deferred_sends/.test(q)) return { rows: [] };
    if (/AS held FROM co_tasks/.test(q)) return { rows: [{ id: 601, goal: PF.pendingGoal("deck", "answer"), target_key: null, kind: "pending_file", held: { input: { title: "Supper", slides: [{ headline: "Where", bullets: ["A loft in Oakland", "Drinks first"] }] } } }] };
    return { rows: [{ kind: "x" }], rowCount: 1 };
  } };
  await W.cancelQueued(fake2 as any, "jordan-1", [{ ref: "profile:city", source: "text" as any, was: "Oakland", now: "Berkeley" }]);
  check("review 2: a one-word correction (Oakland to Berkeley) cancels and wipes the held file that says it", sql.some((x) => /UPDATE co_tasks/.test(x.sql) && x.params[0] === 601 && /- 'pendingFile'/.test(x.sql)), sql.map((x) => x.sql.slice(0, 80)));
  // Review 2: a doc and a document are one kind of file.
  check("review 2: a task's \"Before I send the document\" blocks a reply turn's doc question, and the other way round", RT.noAskHere({ lastCoMessage: R.askLine("document", "how many guests are coming") } as any, "doc") && RT.noAskHere({ lastCoMessage: R.askLine("doc", "how many guests are coming") } as any, "document") && !RT.noAskHere({ lastCoMessage: R.askLine("document", "q") } as any, "deck"));
}

// ---------------------------------------------------------------- 9c. review 2: one retry for a slot whose words were blocked
{
  const T = "I'm hosting a supper club in the Mission for founders. Small tables, good wine.";
  const d0 = deckIn([BASE[1], { headline: "The night", bullets: ["Doors open at 7:30 PM", "Drinks first, then supper"] }, { headline: "The feel", bullets: ["One new friend each", "Seasonal, family style"] }]);
  const ps = [{ text: '"Doors open at 7:30 PM" (an unbacked time)', at: "slide 3 bullet 1", kind: "an unbacked time" }];
  const prompts: string[] = [];
  let k = 0;
  const flow = (answers: string[], whats: string[] = []) => R.afterRefusal(d0, ps as any, { word: "deck", theirs: T, check: async (f: any) => (JSON.stringify(f).includes("7:30") ? { ok: false, problems: ps as any } : { ok: true, file: f, data: f }), fix: null, drop: (f: any, a: string[]) => R.dropDeckLines(f, a), size: (f: any) => R.deckSize(f), slots: { ask: async (p) => { prompts.push(p); return JSON.stringify({ question: answers[k++] ?? null }); }, what: async (p) => { prompts.push(p); return JSON.stringify({ what: whats.shift() ?? null }); } } });
  const e1: any = await flow(["what time do doors open", "what time does it start"]);
  check("review 2: a question blocked only for its words gets one retry naming them, and the retry goes", e1.case === "ask" && e1.line === R.askLine("deck", "what time does it start") && prompts.length === 2 && /These words can't be in it: doors, open/.test(prompts[1]) && !/7:30/.test(e1.line), { e1, p: prompts[1]?.slice(-160) });
  prompts.length = 0; k = 0;
  const e2: any = await flow(["is it at 7:30", "is supper at seven thirty"], ["the doors line", "the start time line"]);
  check("review 2: a retry that still leaks is refused too (only one retry); the file falls through with an approved line", e2.case !== "ask" && !MADE_UP.test(e2.line) && !/seven/.test(e2.line), e2);
  check("review 2: …the kind of line gets the same one retry", e2.case === "dropped" && e2.line === R.droppedLine("deck", "the start time line") && /These words can't be in it: doors/.test(prompts[prompts.length - 1]), { e2, last: prompts[prompts.length - 1]?.slice(-120) });
  // The six leak cases are still refused by the guards themselves.
  const L = (problems: string[], q: string | null, w: string | null) => (q ? R.cleanQuestion(q, R.factTokens(problems, T), T) : R.cleanWhat(w, R.factTokens(problems, T), T));
  check("review 2: the six leaks are still refused", [
    L([`"Twelve guests a night" (an unbacked count)`], "are twelve guests coming each night", null),
    L([`"Twelve guests a night" (an unbacked count)`], null, "the twelve guests line"),
    L([`"Sequin AI is sponsoring the night" (a sponsor they never named)`], null, "the sequin sponsorship line"),
    L([`"Sequin AI is sponsoring the night" (a sponsor they never named)`], "is sequin still sponsoring the night", null),
    L([`"Bootstrapped, pre-seed" (an old fact that may have changed: funding stage may have changed)`], "are you still bootstrapped and pre-seed", null),
    L([`"Based in austin" (an old fact that may have changed: city may have changed)`], "are you still based in austin", null),
  ].every((x) => x === null));
}


// ---------------------------------------------------------------- 10. the wiring
{
  const dt = src("agent/deckTools.ts");
  const mk = dt.slice(dt.indexOf("makeDeck: tool({"), dt.indexOf("updateDeck: tool({"));
  const up = dt.slice(dt.indexOf("updateDeck: tool({"));
  check("makeDeck: a refusal settles through the flow (texts only), else as before", /if \(!settlesHere\(ctx\)\) \{\s*o\.notDone\(c\.notDone\);\s*return \{ ok: false, error: c\.error \};/.test(mk) && /R\.afterRefusal<any, Pass>\(deckIn, c\.problems/.test(mk) && /tellRefusal\(ctx, o, end, \{ type: "deck", word: "deck"/.test(mk) && /dropLine \? \{ text: `\$\{dropLine\}\\n\$\{made\.url\}`/.test(mk));
  check("makeDeck: a deck from a brief keeps its one rewrite as its fix; slides given get the writer's fix", /fix: composing \? null :/.test(mk));
  check("makeDeck: the store's own refusal is case 3 on a text", /deckRefused\(ctx, "deck\.grounding", made\.problems[\s\S]{0,120}if \(settlesHere\(ctx\)\) return tellRefusal\(ctx, o, \(await import\("\.\.\/services\/refusalOutcome\.js"\)\)\.downEnd\("deck"/.test(mk));
  check("updateDeck: the same, before anything is written", /R\.afterRefusal<any, Change>\(input, cc\.problems/.test(up) && /type: "deck_update"/.test(up) && up.indexOf("checkChange(input, attempt)") < up.indexOf("store.updateCoPage("));
  check("a held deck finishing in the background asks nothing about the look", /const finishing = !!finishingOf\(ctx\);\s*if \(!ctx\.dryRun && ds\.pending\.length && !finishing\)/.test(dt) && /!ds\.dontCare && !finishing\) return \{ ask: "taste" \}/.test(dt));
  const lt = src("agent/loopTools.ts");
  const wd = lt.slice(lt.indexOf("writeDocument: tool({"), lt.indexOf("readDocument: tool({"));
  check("writeDocument in a reply: the flow on a text, the old refusal otherwise", /if \(problems\.length && settlesHere\(ctx\)\)/.test(wd) && /docFlow\(input, problems, \{ theirs, read, member, word: "doc"/.test(wd) && /tellRefusal\(ctx, \{ say \}, end, \{ type: "doc", word: "doc"/.test(wd) && /const line = dropLine \?\? \(await captionFor/.test(wd));
  const rt = src("agent/refusalTell.ts");
  check("never on a call, never in a test run, never on a safety turn", /return !ctx\.onCall && !ctx\.dryRun && !ctx\.safetyConcern;/.test(rt));
  check("the line marks the turn answered: no fallback line and no reply about the file after it", /ctx\.onLinkDelivered\?\.\(\);/.test(rt) && rt.indexOf("ctx.onLinkDelivered?.();") > rt.indexOf("const sent = await o.say"));
  const tt = src("services/taskTurn.ts");
  check("a held file wakes into its finisher; a task's held document waits for the reply, then runs as finishing", /t\.kind === "pending_file"\) await import\("\.\/pendingFiles\.js"\)\.then\(\(p\) => p\.realFinish\(t\)\)/.test(tt) && /t\.followup\?\.pendingFile && !heldAnswered\(t\)/.test(tt) && /\.\.\.\(held \? \{ finishing: \{ mode: held\.mode \} \} : \{\}\)/.test(tt));
  const wdLog = tt.slice(tt.indexOf("writeDocument: async (input, { read }) => {"), tt.indexOf("return r;", tt.indexOf("writeDocument: async (input, { read }) => {")));
  check("review: the task's document log keeps #239's kinds and G's finishing call, and carries no input and no quoted lines", /finishing: \{ mode: held\.mode \}/.test(wdLog) && /DS\.refusalKinds\(r\.problems/.test(wdLog) && !/input: /.test(wdLog.slice(wdLog.indexOf("recordDecision"))) && !/r\.problems\.(?:join|slice)/.test(wdLog));
  check("a task told in one text stops there: that text is the wake's message", /if \(!r\.ok && "told" in r && r\.told\) \{\s*if \(r\.line\) texts\.push\(r\.line\);/.test(tt) && /decided = "scheduled";\s*return \{ ok: false, error: r\.why \};/.test(tt));
  check("their reply wakes a held file, and it's an open loop", /AND awaiting_reply AND kind = 'pending_file'/.test(src("services/coTasks.ts")) && /kind IN \('work', 'research_brief', 'pending_file'\)/.test(src("services/openLoops.ts")) && /r\.kind === "pending_file" \? "pending_file"/.test(src("services/coTasks.ts")));
  check("the doc judge that couldn't run is told, so a doc says case 3, never a guess", /if \(!v\) o\.onDown\?\.\(\);/.test(src("services/documentClaims.ts")));
  check("a background finish sends inside their hours, owed, once per key", /respectHours: true/.test(src("services/pendingFiles.ts")) && /targetKey: `pending_file:\$\{task\.id\}:\$\{n\+\+\}`/.test(src("services/pendingFiles.ts")));
}

R.setRefusalModelsForTests(null);
PF.usePendingDb(null);
console.log(`no silent refusal: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
