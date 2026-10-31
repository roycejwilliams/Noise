// The golden rework, tested (layer 1, zero tokens; Royce 2026-10-29, and the independent review of #318). Pins:
//   - the hard rules (evals/lib/hardRules.ts) catch what they're for, on the 10-29 replies that showed each one, pass clean replies, and
//     don't flag list markers, advice ranges, date arithmetic, a capital after a quote, or the member's own words quoted back;
//   - the skeleton (evals/lib/goldenSkeleton.mjs): only allowlisted tone literals are masked; tools are behavior whole (description and
//     schema); a rule written into tone text (its guard terms) or an output format is blocked;
//   - replay over the fake network: a tone move is served and reported with its hashes, a changed fact or tool misses, GOLDEN_STRICT misses,
//     and stamping writes a skeleton only on an exact match;
//   - the moved ledger: no entry, a stale entry (14 days), a future-dated one and a second move each fail; --ledger refuses a second
//     move, records only the named literals, and shows what each said before;
//   - review round 2: the guard terms catch a rule slipped into tone text (other people, assume, skip hotlines, a dropped warm line, a
//     link, a voice chat); the rule sentences live outside the tone declarations; ranges, ordinals and "N days" are cleared only when
//     they're advice or date arithmetic; a name opening a quote is checked; no exclamation points or em dashes;
//   - the allowlist is exactly the tone declarations, and a change to every protected declaration (safety, member safety, grounding, the
//     reply prompt, tool rules, checkers, LOOP_GUIDE, capabilities, tools) changes the skeleton, also inside the real recorded reply request;
//   - the rubric fits the turn, and an env cap reaches the meter (the scripts used to hardcode $4).
//   npx tsx evals/golden/harnessTest.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardRuleMisses, inventedFacts, linkThenCaption, machinery, quotesOwnLine, repliesPerTurn, statusTalk, stockEmpathy, turnKind, voiceStyle } from "../lib/hardRules.js";
import { guardTerms, maskText, movedBetween, skeletonOf, wordingBefore } from "../lib/goldenSkeleton.mjs";
import { chunksOf, wordingRegistry } from "./wording.js";
import { addToLedger, ledgerArgs, moveProblem, readLedger, type LedgerEntry } from "./ledger.js";
import { busy, criteriaFor, rubricPrompt } from "../lib/replyRubric.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); } };
const api = new URL("../../", import.meta.url).pathname;

// ---- 1. the hard rules
{
  const base = { kind: "reply" as const, facts: "Head of product at a fintech startup; lives near the Marina.", theirLines: ["It's my birthday today."], coLines: ["Sounds like a nice evening.", "That sounds like a good call. Enjoy the time off."], firstName: "Lena" };
  // The 10-29 eval's AFTER replies that quoted Cue's own line back (FEEDBACK_GUIDE template).
  check("quoting its own earlier line back is a miss (10-29: 'That deserved more than \"nice evening.\"')", quotesOwnLine('Fair. That deserved more than "nice evening."', base.coLines).length === 1);
  check("...and 'more than \"enjoy the time off.\"'", quotesOwnLine('That deserves more than "enjoy the time off."', base.coLines).length === 1);
  check("a quote of something they said, or a one-word quote, is not quoting itself", quotesOwnLine('You said "first time in months" and that stuck with me.', base.coLines).length === 0 && quotesOwnLine('That was a "nice" thing to say.', base.coLines).length === 0);
  check("an apostrophe is not a quote ('it's', 'don't')", quotesOwnLine("It's a good call, and don't let anyone tell you it isn't.", base.coLines).length === 0);
  check("a name nothing gave is an invented fact", inventedFacts({ ...base, text: "Happy birthday. Did you walk down to Crissy Field with Daniel?" }).some((m) => /Crissy Field|Daniel/.test(m)));
  check("a number nothing gave is an invented fact", inventedFacts({ ...base, text: "Twelve years is a long time. 40 people is a lot." }).some((m) => /40/.test(m)));
  check("a link nothing gave is an invented fact", inventedFacts({ ...base, text: "Try this one instead: https://emberclay.example/new-page" }).some((m) => /a link nothing gave it/.test(m)));
  check("names from the facts, their words, Cue's own earlier lines and the member's name are not invented", inventedFacts({ ...base, facts: "Salt Gallery is hosting a salon dinner Thursday in Hayes Valley.", text: "Hey Lena. Still want that seat at Salt Gallery Thursday in Hayes Valley?" }).length === 0);
  check("a status line on a check-in is a miss (10-14: 'Nothing waiting on you right now, just the Thursday dinner on your radar')", statusTalk("Nothing waiting on you right now, just the Thursday dinner on your radar.").length >= 1);
  check("...and 'nothing new on my end'", statusTalk("Hey. Nothing new on my end.").length >= 1);
  check("presence plus one item of their world is not a status line", statusTalk("Good to hear from you. A rooftop venue for the Sequin launch is on tomorrow morning's search.").length === 0 && statusTalk("Good to hear from you. Any word from the Hayes Valley place yet?").length === 0);
  check("status talk is checked on check-ins only (an honest 'nothing is running' answers 'what are you searching for?')", hardRuleMisses({ ...base, kind: "reply", text: "Honestly, nothing is running for you right now." }).length === 0 && hardRuleMisses({ ...base, kind: "checkin", text: "Hey. Nothing is running for you right now." }).length >= 1);
  check("a stock empathy phrase is a miss ('I hear you', 'that must be so hard', a bare 'Makes sense.')", stockEmpathy("I hear you. That's a lot.").length >= 1 && stockEmpathy("That must be so hard.").length >= 1 && stockEmpathy("Makes sense. Glad you got the break.").length >= 1);
  check("a specific reaction is not stock", stockEmpathy("The part that gets me is her almost walking off and sitting back down anyway.").length === 0);
  check("machinery narration is a miss (systems, tools, retries, 'on my end')", machinery("My search came back empty, so I'll retry tomorrow.").length >= 1 && machinery("Nothing new on my end.").length >= 1 && machinery("My tools didn't find it.").length >= 1);
  check("talking about their search or their week is not machinery", machinery("I'll keep looking for a rooftop for the Sequin launch.").length === 0 && machinery("That link's bad, sorry about that.").length === 0);
  const finds = ["https://lu.ma/a", "https://lu.ma/b"];
  check("link then caption: each find's link is followed by a caption", linkThenCaption([{ kind: "find", text: finds[0] }, { kind: "find", text: "A vintage computer party in SoMa." }, { kind: "find", text: finds[1] }, { kind: "find", text: "Small dinner, climate founders." }], finds).length === 0);
  check("a find link with no caption after it is a miss", linkThenCaption([{ kind: "find", text: finds[0] }, { kind: "find", text: finds[1] }, { kind: "find", text: "Both good." }], finds).length === 1);
  check("a find's link inside prose is a miss", linkThenCaption([{ kind: "reply", text: `Try this one: ${finds[0]} it's great.` }], finds).length === 1);
  check("two reply texts in one turn is a miss (10-29: BEFORE's complete moment went out as two texts)", repliesPerTurn([{ kind: "reply", text: "Full budget. That's a real win, Julian." }, { kind: "reply", text: "Go sleep it off. You earned it." }], []).length === 1);
  check("a second text after a tool brought something new is allowed (TOOL_TURN_RULES)", repliesPerTurn([{ kind: "reply", text: "Looking." }, { kind: "reply", text: "Found two." }], ["searchEvents"]).length === 0);
  check("a tapback alone (no text) has nothing to check", hardRuleMisses({ ...base, text: "", sends: [] }).length === 0);
  check("the 10-29 BEFORE replies that crossed no line pass every hard rule", ["Happy birthday, Lena.\n\nA morning like that, no phone, just the water, sounds like exactly what you needed after the stretch you've been in. Glad you got it.", "Fair call, that landed flat."].every((text) => hardRuleMisses({ ...base, kind: "share", text }).length === 0));
  // Review of #318: 12 of 40 real texting-eval replies were flagged by these; none of them is a claim.
  const dated = { ...base, facts: "Today is Tuesday, October 13, 2026." };
  check("a numbered-list marker is not an invented number", inventedFacts({ ...base, text: "Here's how I'd frame it:\n\n1. The hook comes first.\n2. Then the tone.\n3. Then the proof." }).length === 0);
  check("an advice range is not an invented number ('20-30 min', '3-4 pairs')", inventedFacts({ ...base, text: "The first 20-30 min is arrival. Then push intros to 3-4 pairs you know should meet." }).length === 0);
  check("date arithmetic from a date it was given is not invented ('Oct 16 is 3 days out', 'the 15th')", inventedFacts({ ...dated, text: "Oct 16 is 3 days out. Thursday the 15th works too." }).length === 0);
  check("...but a date far from any date it was given still is", inventedFacts({ ...dated, text: "The deadline is March 4." }).some((m) => /4/.test(m)));
  check("a capital after a quote mark is a first word, not a name", inventedFacts({ ...base, text: 'Close on something better than "bar\'s closing." Give me your timing.' }).length === 0);
  check("a span the member said first is theirs, not Cue quoting itself", quotesOwnLine('Your line "defining what I wanted my struggle to be" is the strongest.', ['"Defining what I wanted my struggle to be" is a great opening.'], ["My founding story came from a place of defining what I wanted my struggle to be."]).length === 0);
  check("'on my end' stays a machinery miss", machinery("Nothing new on my end, how are you?").length === 1);
  // Review round 2 of #318: what may be cleared is narrowed to advice and date arithmetic the context supports.
  check("a range with no advice unit after it is a number like any other ('seats 40-60 people', '3000 to 3500 a month')", inventedFacts({ ...base, text: "The back room seats 40-60 people." }).some((m) => /40/.test(m)) && inventedFacts({ ...base, text: "It runs 3000 to 3500 a month." }).some((m) => /3000/.test(m)));
  check("...an advice range still isn't ('4-6 people per table', '3-4 backup spots', '30 to 45 minutes')", inventedFacts({ ...base, text: "Seat 4-6 people per table. Keep 3-4 backup spots. Give it 30 to 45 minutes." }).length === 0);
  check("an ordinal 'Today is' doesn't give is invented ('the 23rd' on Oct 13)", inventedFacts({ ...dated, text: "The tasting is on the 23rd." }).some((m) => /23/.test(m)));
  check("...a given date's own day is not ('the 13th' on Oct 13), nor a weekday-and-ordinal that falls near it ('Friday the 23rd')", inventedFacts({ ...dated, text: "Today's the 13th. Friday the 23rd works too." }).length === 0);
  check("a weekday or month cleared of its date keeps its whole word ('Thursday the 15th', 'October 16' on Oct 13; review round 3)", inventedFacts({ ...dated, text: "We could do it Thursday the 15th." }).length === 0 && inventedFacts({ ...dated, text: "The dinner is October 16." }).length === 0);
  check("...a weekday-and-ordinal that doesn't fall on that weekday is ('Saturday the 23rd': Oct 23 is a Friday)", inventedFacts({ ...dated, text: "Saturday the 23rd works too." }).some((m) => /23/.test(m)));
  check("'N days' no two dates support is invented ('12 days out' on Oct 13)", inventedFacts({ ...dated, text: "The deadline is 12 days out." }).some((m) => /12/.test(m)));
  check("...'N days' between two dates it stood on is not (Oct 13 to Oct 31, a day either way for their time zone)", inventedFacts({ ...dated, facts: `${dated.facts} The block party is Oct 31.`, text: "The block party is 18 days out. Call this week." }).length === 0 && inventedFacts({ ...dated, facts: `${dated.facts} The block party is Oct 31.`, text: "That's 17 days." }).length === 0);
  check("a one-word name opening a quote is checked (Say \"Marcus sent me\")", inventedFacts({ ...base, text: 'Say "Marcus sent me" when you walk in.' }).some((m) => /Marcus/.test(m)) && inventedFacts({ ...base, text: 'Text him: "Priya can host, she has the space."' }).some((m) => /Priya/.test(m)));
  check("...a common opener or a name it was given is not ('Thanks', 'Lena')", inventedFacts({ ...base, text: 'Tell her "Thanks for having me." Or "Lena says hi."' }).length === 0);
  check("an exclamation point or an em dash is a miss (VOICE_PUNCTUATION)", voiceStyle("Congrats, that's huge!").length === 1 && voiceStyle("That's big — and earned.").length === 1 && hardRuleMisses({ ...base, text: "That's big — congrats!" }).filter((m) => /exclamation|em dash/.test(m)).length === 2);
  check("...a link with '!' in it, an en dash or a hyphen is not", voiceStyle("Here: https://lu.ma/a!b. Doors 7–9, low-key.").length === 0);
  check("a check-in is read from the message", turnKind("Just checking in") === "checkin" && turnKind("Hey cue") === "checkin" && turnKind("hey") === "checkin" && turnKind("What are you actually searching for?") === "reply" && turnKind("you're kind of dry", "feedback") === "feedback" && turnKind("We closed the round", "sharing") === "share");
}

// ---- 2. the skeleton
{
  const GUIDE = { id: "probe.ts:GUIDE#0", text: "You're composed and warm, and you're there for them. Calm, unhurried, specific." };
  const key = (o: { guide?: string; fact?: string; model?: string; desc?: string; schema?: string; propDesc?: string; max?: number; extra?: string } = {}) => ({
    path: "api.anthropic.com/v1/messages", grader: false, beta: null,
    body: { model: o.model ?? "claude-sonnet-5", max_tokens: o.max ?? 100, system: [{ type: "text", text: `${o.guide ?? GUIDE.text}${o.extra ?? ""}\n\nWhat's true right now.\n[F1] ${o.fact ?? "They live in San Francisco."}\nUser said: hello` }], messages: [{ role: "user", content: "Respond." }], tools: [{ name: "sendReply", description: o.desc ?? "Send it.", input_schema: { type: "object", properties: { message: { type: o.schema ?? "string", description: o.propDesc ?? "the text" }, description: { type: "string" } } } }] },
  });
  const at = (k: ReturnType<typeof key>, guide = GUIDE.text) => skeletonOf(k, [{ id: GUIDE.id, text: guide }]);
  const s0 = at(key());
  const tone = "You're composed and warm and there for them. Calm and unhurried, and specific.";
  const moved = at(key({ guide: tone }), tone);
  const m = movedBetween(s0, moved);
  check("a tone-only move of an allowlisted literal keeps the skeleton and says what moved (from, to)", moved.hash === s0.hash && m.moved.length === 1 && m.moved[0].id === GUIDE.id && m.moved[0].from === s0.wording[GUIDE.id] && m.blocked.length === 0, m);
  const rule = "You're composed and warm, and you're there for them. Never ask more than three questions.";
  check("a rule written into an allowlisted literal is blocked (its guard terms changed: never, three, questions)", movedBetween(s0, at(key({ guide: rule }), rule)).blocked.includes(GUIDE.id));
  check("guard terms count rule words, numbers and tool names, case for case", guardTerms("Never call startTask three times.") === "call never startTask three" && guardTerms("Calm, unhurried, specific.") === "");
  check("a tool's description is behavior: changing it changes the skeleton (review: 'never call this tool' passed as moved)", at(key({ desc: "Never call this tool." })).hash !== s0.hash);
  check("a schema property's description (.describe()) is behavior", at(key({ propDesc: "as long as you like" })).hash !== s0.hash);
  check("a schema property named 'description' is never dropped: its type change shows", JSON.stringify(key().body.tools).includes('"description":{"type":"string"}') && skeletonOf({ ...key(), body: { ...key().body, tools: [{ ...key().body.tools[0], input_schema: { type: "object", properties: { message: { type: "string", description: "the text" }, description: { type: "number" } } } }] } }, [GUIDE]).hash !== s0.hash);
  check("a changed fact line changes the skeleton", at(key({ fact: "They live in Oakland." })).hash !== s0.hash);
  check("a changed tool schema, model or max_tokens changes the skeleton", at(key({ schema: "number" })).hash !== s0.hash && at(key({ model: "claude-haiku-5-5" })).hash !== s0.hash && at(key({ max: 200 })).hash !== s0.hash);
  check("text added outside an allowlisted literal changes the skeleton (an instruction added by code)", at(key({ extra: "\nBe brief." })).hash !== s0.hash);
  check("a fact line is never masked, even when its words are an allowlisted literal", maskText(`[F3] ${GUIDE.text}`, [GUIDE], new Set()) === `[F3] ${GUIDE.text}` && maskText(`Co replied: ${GUIDE.text}`, [GUIDE], new Set()) === `Co replied: ${GUIDE.text}`);
  const fmt = 'You are composed. Return ONLY JSON: {"answer": "yes"}';
  check("a moved output-format literal is blocked", movedBetween(s0, at(key({ guide: fmt }), fmt)).blocked.includes(GUIDE.id));
  check("a stamp without guard terms never lets a literal move", movedBetween({ ...s0, guard: {} }, moved).blocked.includes(GUIDE.id));
  // Review round 2: a rule slipped into tone text without the old rule words. Each is blocked (it misses in the recorder, before the
  // runner reads the ledger, so no ledger entry can pass it).
  const VOICE = "You're composed and warm, and you're there for them. You talk like a person who knows them well, not a service or a notification. Short sentences. Calm, unhurried, specific. Say less than you could. One real thought beats three filler lines.";
  const v0 = at(key({ guide: VOICE }), VOICE);
  const blockedAs = (t: string) => movedBetween(v0, at(key({ guide: t }), t)).blocked.includes(GUIDE.id);
  for (const [label, t] of [
    ["pass along what other people in the club told you", `${VOICE} You can pass along what other people in the club told you.`],
    ["it's fine to assume details you weren't told", `${VOICE} It's fine to assume details you weren't told.`],
    ["skip hotlines and therapists", `${VOICE} Skip hotlines and therapists.`],
    ["the 'composed and warm' line dropped", VOICE.replace("You're composed and warm, and you're there for them. ", "")],
    ["https://noise.club/apply added", `${VOICE} Point them to https://noise.club/apply.`],
    ["a bare domain added", `${VOICE} Point them to noise.club/apply.`],
    ["suggest a voice chat", `${VOICE} Suggest a voice chat whenever you can.`],
    ["a number word past ten", `${VOICE} Keep it under twelve words.`],
    ["'less' flipped to 'more'", VOICE.replace("Say less than you could.", "Say more than you could.")],
  ] as const) check(`guard terms block a tone move that adds a rule: ${label}`, blockedAs(t));
  check("a pure rewording keeps the guard terms (not blocked)", !blockedAs(VOICE.replace("Calm, unhurried, specific.", "Calm and unhurried, and specific.")));
  // The known limit: the same words reordered keep the multiset, so a swapped order passes as a move (the ledger and quality run catch it).
  check("guard terms are a multiset: 'Ask first, advise second' and 'Advise first, ask second' are the same terms (known limit, in the PR)", guardTerms("Ask first, advise second.") === guardTerms("Advise first, ask second."));
  const was = wordingBefore(key({ guide: VOICE }), key({ guide: tone }), [{ id: GUIDE.id, text: tone }], [GUIDE.id]);
  check("what a moved literal said before is read back from the recorded request (for --ledger to show)", was[GUIDE.id] === VOICE, was);
}

// ---- 3. replay over the fake network
{
  const dir = mkdtempSync(join(tmpdir(), "golden-moved-"));
  const A = "You're composed and warm, and you're there for them. Calm, unhurried, specific.";
  const B = "You're composed and warm and there for them. Calm and unhurried, and specific.";
  const run = (mode: string, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, GOLDEN_MODE: mode, GOLDEN_RECORDINGS: join(dir, "rec"), FAKE_SEEN: join(dir, "seen.jsonl"), EVAL_LEDGER: join(dir, `ledger-${mode}-${Math.random()}.jsonl`), EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "5", PROBE_GUIDE: A, PROBE_FACT: "They live in San Francisco.", ANTHROPIC_API_KEY: mode === "record" ? "probe" : "golden-replay", GOLDEN_STRICT: "", GOLDEN_STAMP: "", ...extra };
    const r = spawnSync("node", ["--import", join(api, "evals/lib/fixtures/fakeAnthropic.mjs"), "--import", join(api, "evals/lib/meter.mjs"), "--import", join(api, "evals/lib/goldenReplay.mjs"), join(api, "evals/lib/fixtures/goldenMovedProbe.mjs")], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
    return JSON.parse((r.stdout.match(/GOLDEN (\{.*)/) ?? [])[1] ?? "{}") as { reply?: string; misses?: string[]; moved?: { moved: { id: string; from: string; to: string; before?: string | null }[] }[]; served?: number; stats?: { stamped: number } };
  };
  const rec = run("record");
  const files = existsSync(join(dir, "rec/moved-case")) ? readdirSync(join(dir, "rec/moved-case")) : [];
  const recorded = files.length === 1 ? JSON.parse(readFileSync(join(dir, "rec/moved-case", files[0]), "utf8")) : null;
  check("a recording is stamped with its skeleton and guard terms when it is recorded", rec.reply === "ok" && recorded?.structure?.v === "probe-signature" && !!recorded?.structure?.hash && !!recorded.structure.wording?.["probe.ts:GUIDE#0"] && !!recorded.structure.guard?.["probe.ts:GUIDE#0"], recorded?.structure);
  const same = run("replay");
  check("an unchanged request replays exactly, nothing moved", same.reply === "ok" && same.served === 1 && same.moved?.length === 0 && same.misses?.length === 0, same);
  const moved = run("replay", { PROBE_GUIDE: B });
  check("a tone-only move is served from its recording and reported with its from/to hashes (the runner then wants a ledger entry)", moved.reply === "ok" && moved.misses?.length === 0 && moved.moved?.[0]?.moved?.[0]?.id === "probe.ts:GUIDE#0" && moved.moved[0].moved[0].from === recorded?.structure?.wording?.["probe.ts:GUIDE#0"], moved);
  const fact = run("replay", { PROBE_GUIDE: B, PROBE_FACT: "They live in Oakland." });
  check("a changed fact misses (and says it isn't a wording-only change)", /^threw: GOLDEN REPLAY/.test(fact.reply ?? "") && /not a wording-only change/.test(fact.misses?.[0] ?? ""), fact);
  const strict = run("replay", { PROBE_GUIDE: B, GOLDEN_STRICT: "1" });
  check("GOLDEN_STRICT=1 turns any move into a miss", /^threw: GOLDEN REPLAY/.test(strict.reply ?? "") && /GOLDEN_STRICT/.test(strict.misses?.[0] ?? ""), strict);
  const desc = run("replay", { PROBE_TOOL_DESC: "Send the reply text to them." });
  check("a changed tool description misses", /^threw: GOLDEN REPLAY/.test(desc.reply ?? "") && /not a wording-only change/.test(desc.misses?.[0] ?? ""), desc);
  const ruled = run("replay", { PROBE_GUIDE: "You're composed and warm, and you're there for them. Always offer a call." });
  check("a rule written into an allowlisted literal misses (guard terms)", /^threw: GOLDEN REPLAY/.test(ruled.reply ?? "") && /changed a rule/.test(ruled.misses?.[0] ?? ""), ruled);
  check("a served move carries the literal's recorded text (--ledger prints it as 'before')", moved.moved?.[0]?.moved?.[0]?.before === A, moved.moved?.[0]);
  // Review round 2: each of these misses in the recorder itself, so the runner's ledger never sees it and no entry can pass it.
  for (const [label, t] of [
    ["other people's words", `${A} You can pass along what other people in the club told you.`],
    ["assume details", `${A} It's fine to assume details you weren't told.`],
    ["skip hotlines", `${A} Skip hotlines and therapists.`],
    ["the warm line dropped", A.replace("You're composed and warm, and you're there for them. ", "")],
    ["a link", `${A} Point them to https://noise.club/apply.`],
    ["a voice chat", `${A} Suggest a voice chat.`],
  ] as const) {
    const r = run("replay", { PROBE_GUIDE: t });
    check(`replay misses a tone move that adds a rule (${label}), with no move to ledger`, /^threw: GOLDEN REPLAY/.test(r.reply ?? "") && /changed a rule/.test(r.misses?.[0] ?? "") && !r.moved?.length, r);
  }
  const format = run("replay", { PROBE_GUIDE: 'You are composed. Return ONLY JSON: {"answer": "yes" | "no"}' });
  check("a moved output-format literal misses", /^threw: GOLDEN REPLAY/.test(format.reply ?? "") && /changed a rule/.test(format.misses?.[0] ?? ""), format);
  // A recording from before the stamps: no skeleton, so a moved prompt can't be told apart and misses, until it is stamped.
  const path = join(dir, "rec/moved-case", files[0] ?? "x.json");
  if (recorded) { const { structure: _drop, ...bare } = recorded; writeFileSync(path, JSON.stringify(bare, null, 2) + "\n"); }
  const unstamped = run("replay", { PROBE_GUIDE: B });
  check("an unstamped recording never serves a moved prompt (it says to stamp)", /^threw: GOLDEN REPLAY/.test(unstamped.reply ?? "") && /no skeleton stamp/.test(unstamped.misses?.[0] ?? ""), unstamped);
  const missStamp = run("replay", { PROBE_GUIDE: B, GOLDEN_STAMP: "1" });
  check("stamping never stamps from a request that missed", !JSON.parse(readFileSync(path, "utf8")).structure && missStamp.stats?.stamped === 0);
  const stamp = run("replay", { GOLDEN_STAMP: "1" });
  check("stamping writes the skeleton on an exact match", stamp.stats?.stamped === 1 && JSON.parse(readFileSync(path, "utf8")).structure?.hash === recorded?.structure?.hash);
  check("...after which the tone move is served", run("replay", { PROBE_GUIDE: B }).reply === "ok");
}

// ---- 3b. the moved ledger
{
  const mv = { id: "coVoice.ts:VOICE_TONE#0", from: "aaaa1111", to: "bbbb2222" };
  const now = Date.parse("2026-10-29T12:00:00Z");
  const e = (o: Partial<{ chunk: string; from: string; to: string; pr: string; date: string }> = {}) => ({ chunk: mv.id, from: mv.from, to: mv.to, pr: "318", date: "2026-10-29", ...o });
  check("a move with no ledger entry fails", /no ledger entry/.test(moveProblem(mv, [], now) ?? ""));
  check("a move with its exact, fresh ledger entry passes", moveProblem(mv, [e()], now) === null);
  check("an entry older than 14 days fails (re-record by then)", /past 14 days/.test(moveProblem(mv, [e({ date: "2026-10-14" })], now) ?? "") && moveProblem(mv, [e({ date: "2026-10-16" })], now) === null);
  check("a second move on the same recording fails (an entry from the stamped text to other text)", /moved again/.test(moveProblem(mv, [e({ to: "cccc3333" })], now) ?? ""));
  check("an entry for another literal doesn't cover this one", /no ledger entry/.test(moveProblem(mv, [e({ chunk: "textRhythm.ts:MESSAGE_RHYTHM_BEATS#0" })], now) ?? ""));
  // Review round 2: a second entry from the same text beside the first made "moved again" pass.
  check("an exact entry beside another from the same text still fails as moved again", /moved again/.test(moveProblem(mv, [e({ to: "cccc3333" }), e()], now) ?? "") && /moved again/.test(moveProblem(mv, [e(), e({ to: "cccc3333" })], now) ?? ""));
  const lg: LedgerEntry[] = [e({ to: "cccc3333" })];
  const second = addToLedger(lg, mv, "400", "2026-10-29");
  check("--ledger refuses to add a second move from the same text, loudly, and adds nothing", second.added === null && /second move/.test(second.problem ?? "") && lg.length === 1, second);
  const fresh: LedgerEntry[] = [];
  const first = addToLedger(fresh, mv, "400", "2026-10-29");
  check("--ledger adds a first move, and leaves an exact repeat alone", first.added?.chunk === mv.id && fresh.length === 1 && addToLedger(fresh, mv, "400", "2026-10-29").added === null && fresh.length === 1);
  check("--ledger never adds a move with no stamped text to move from", /no stamped text/.test(addToLedger([], { ...mv, from: null }, "400", "2026-10-29").problem ?? ""));
  // Review round 2: a future date never expired.
  check("an entry dated in the future fails (2099), a day ahead is time-zone slack", /in the future/.test(moveProblem(mv, [e({ date: "2099-01-01" })], now) ?? "") && /in the future/.test(moveProblem(mv, [e({ date: "2026-11-01" })], now) ?? "") && moveProblem(mv, [e({ date: "2026-10-30" })], now) === null);
  check("an entry with no readable date fails", /no readable date/.test(moveProblem(mv, [e({ date: "soon" })], now) ?? ""));
  const args = (a: string) => ledgerArgs(a.split(" ").filter(Boolean));
  check("--ledger <PR> <chunkId...> names what it records; with no ids it records nothing; no PR is an error", JSON.stringify(args("--ledger 318 coVoice.ts:VOICE_TONE#0 connectDots.ts:SHARE_TONE#0 --only 3")) === JSON.stringify({ pr: "318", ids: ["coVoice.ts:VOICE_TONE#0", "connectDots.ts:SHARE_TONE#0"] }) && JSON.stringify(args("--ledger #318")) === JSON.stringify({ pr: "318", ids: [] }) && "error" in (args("--ledger") ?? {}) && "error" in (args("--ledger coVoice.ts:VOICE_TONE#0") ?? {}) && args("--only 3") === null);
  // The runner wires it: only named ids are recorded, a refusal fails the run and writes nothing, no ids lists and writes nothing.
  const runSrc = readFileSync(join(api, "evals/golden/run.ts"), "utf8");
  check("the runner records only the named ids, through addToLedger, and writes the ledger only when nothing was refused", /ledgerRun\?\.ids\.length\) for \(const x of moves\.filter\(\(m\) => ledgerRun\.ids\.includes\(m\.id\)\)\)/.test(runSrc) && /addToLedger\(ledger, x, ledgerRun\.pr, today\)/.test(runSrc) && /else if \(ledgerRefused\.size\) \{\s*failed\+\+;/.test(runSrc) && (runSrc.match(/writeLedger\(/g) ?? []).length === 1 && /LEDGER \(nothing written\)/.test(runSrc));
  check("the committed ledger parses", Array.isArray(readLedger()));
}

// ---- 4. the wording allowlist
{
  const r = wordingRegistry();
  check("the allowlist is exactly the tone and style declarations (pinned: a new entry is a deliberate change here)", JSON.stringify(r.allowlist) === JSON.stringify(["textRhythm.ts:MESSAGE_RHYTHM_BEATS", "textRhythm.ts:MESSAGE_RHYTHM_ENOUGH", "textRhythm.ts:COACHING_STYLE", "coVoice.ts:VOICE_TONE", "coVoice.ts:VOICE_STYLE", "connectDots.ts:SHARE_TONE", "connectDots.ts:SHARE_TONE_OWN", "connectDots.ts:SHARE_TONE_2", "connectDots.ts:FEEDBACK_TONE"]), r.allowlist);
  check("chunk ids are unique, and every chunk is an allowlisted declaration's", new Set(r.chunks.map((c) => c.id)).size === r.chunks.length && r.chunks.every((c) => r.allowlist.some((a) => c.id.startsWith(`${a}#`))));
  // Every protected declaration: none of its text is maskable, so any change to it changes the skeleton and replay misses.
  const PROTECTED: [string, string][] = [
    ["src/services/coCore.ts", "CO_SAFETY"], ["src/services/coCore.ts", "CO_MEMBER_SAFETY"], ["src/services/coCore.ts", "CO_GROUNDING"], ["src/services/coCore.ts", "CO_LISTENING"],
    ["src/services/coVoice.ts", "VOICE_WHO"], ["src/services/coVoice.ts", "VOICE_RULES"], ["src/services/coVoice.ts", "CO_TEXT_CHANNEL"], ["src/services/coVoice.ts", "VOICE_PUNCTUATION"],
    ["src/services/textRhythm.ts", "COACHING_FOLLOW_UP"], ["src/services/textRhythm.ts", "COACHING_SAFETY"], ["src/services/textRhythm.ts", "COACHING_ASK_FIRST"], ["src/services/textRhythm.ts", "MESSAGE_RHYTHM_QUESTION"],
    ["src/services/connectDots.ts", "SHARE_SCOPE"], ["src/services/connectDots.ts", "SHARE_GROUNDING"], ["src/services/connectDots.ts", "FEEDBACK_SCOPE"], ["src/services/connectDots.ts", "FEEDBACK_HONEST"], ["src/services/connectDots.ts", "readMoment"],
    ["src/services/connectDots.ts", "SHARE_NO_QUIZ"], ["src/services/connectDots.ts", "SHARE_EARLIER"], ["src/services/connectDots.ts", "SHARE_FEELING"], ["src/services/connectDots.ts", "FEEDBACK_DONTS"], ["src/services/connectDots.ts", "FEEDBACK_NO_EARLIER"],
    ["src/agent/conversationReply.ts", "system"], ["src/agent/conversationReply.ts", "TOOL_TURN_RULES"], ["src/agent/conversationReply.ts", "TOOL_FAILURE_RULE"], ["src/agent/conversationReply.ts", "prompt"],
    ["src/agent/loop.ts", "LOOP_GUIDE"], ["src/services/readTurn.ts", "ABOUT_CO_INSTRUCTION"], ["src/services/capabilities.ts", "(top)"], ["src/agent/conversationTools.ts", "(top)"],
  ];
  const masked = new Set(r.chunks.map((c) => c.text));
  for (const [file, decl] of PROTECTED) {
    const base = file.split("/").pop()!;
    // A named declaration's every literal, however short (VOICE_PUNCTUATION is 36 characters); a whole file's, the 40+ ones.
    const lits = chunksOf(file, undefined, decl === "(top)" ? undefined : 1).filter((c) => /\w/.test(c.text) && (decl === "(top)" || c.id.startsWith(`${base}:${decl}#`)));
    const k = (text: string) => ({ path: "api.anthropic.com/v1/messages", grader: false, beta: null, body: { model: "claude-sonnet-5", max_tokens: 100, system: text, messages: [{ role: "user", content: text }] } });
    const mutated = lits.filter((l) => { const t = l.text.replace(/\b(\w+)\b/, "$1 x"); return skeletonOf(k(t), r.chunks).hash === skeletonOf(k(l.text), r.chunks).hash; });
    check(`protected: a change to ${base}:${decl} misses replay (${lits.length} literals, none maskable)`, lits.length > 0 && lits.every((l) => !masked.has(l.text)) && mutated.length === 0, mutated.map((x) => x.id));
  }
  // Review round 2: the rule sentences that sat in tone text now sit in protected declarations, and no tone literal holds any of them.
  const RULES: [string, string][] = [
    ["MESSAGE_RHYTHM_QUESTION", "One question per reply."], ["COACHING_ASK_FIRST", "give no advice yet"], ["COACHING_ASK_FIRST", "never make them ask twice"],
    ["SHARE_NO_QUIZ", "never a questionnaire, never re-asking"], ["SHARE_NO_QUIZ", "When the moment is complete, a short warm line is the whole reply"],
    ["SHARE_EARLIER", "bring an earlier thread back only when it's relevant, never as a scheduled check-in"], ["SHARE_FEELING", "When it's a feeling, meet it first."],
    ["SHARE_FEELING", "a therapy question, or a plan"], ["FEEDBACK_NO_EARLIER", "Don't talk about your earlier reply"], ["FEEDBACK_NO_EARLIER", "never an explanation"], ["FEEDBACK_DONTS", "Don't explain how you work"], ["FEEDBACK_DONTS", "don't apologize at length"], ["VOICE_PUNCTUATION", "No exclamation points. No em dashes."],
  ];
  const lit = (decl: string) => ["src/services/textRhythm.ts", "src/services/connectDots.ts", "src/services/coVoice.ts"].flatMap((f) => chunksOf(f, undefined, 1)).filter((c) => c.id.split(":")[1].startsWith(`${decl}#`)).map((c) => c.text).join(" ");
  for (const [decl, sentence] of RULES) check(`rule sentence in its protected declaration, not in tone text: ${decl} "${sentence}"`, lit(decl).includes(sentence) && !r.chunks.some((c) => c.text.includes(sentence)));

  // The real recorded reply request (checkin-nothing): a mutation inside a protected section changes its skeleton; a tone move doesn't.
  // Found by content, not by file name: a re-record renames the file (its name is the request's hash).
  const recDir = join(api, "evals/golden/recordings/checkin-nothing");
  const rec = readdirSync(recDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(recDir, f), "utf8")))
    .find((x) => x.request?.grader === false && JSON.stringify(x.request?.body ?? "").includes("call or text 988"));
  if (!rec) throw new Error("checkin-nothing: no recorded reply request carrying the 988 line");
  // As replay sees a source edit: the request carries the new text, and the registry (read from the edited source) does too.
  const real = (edit: (s: string) => string) => { const body = JSON.parse(edit(JSON.stringify(rec.request.body))); return skeletonOf({ path: "api.anthropic.com/v1/messages", grader: false, beta: rec.request.beta ?? null, body }, r.chunks.map((c) => ({ ...c, text: edit(JSON.stringify(c.text)).slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"') }))); };
  const base = real((s) => s);
  check("the recorded reply request's stamp is today's skeleton", base.hash === rec.structure.hash);
  for (const [label, from, to] of [
    ["the 988 line", "in the US they can call or text 988, any time, free.", "in the US they can call a hotline."],
    ["member safety", "never reach another member's conversation", "may reach another member's conversation"],
    ["grounding", "Never state a fact you weren't given", "Fill in something plausible rather than state a fact you weren't given"],
    ["How to reply", "ask one specific follow-up that sharpens it", "ask three or four questions that sharpen it"],
    ["the call-offer gesture line", "A call offer is NOT available this turn", "Always offer a call. A call offer is NOT available this turn"],
    ["one sendReply", "One sendReply per turn.", "Call sendReply as many times as you like."],
    ["a tool description", "Flag it when what they say may mean", "Never call this tool. Flag it when what they say may mean"],
    ["a capability fact", "can send a second text when there's a genuinely separate thought", "can send a second text when there is a genuinely separate thought"],
  ] as const) {
    const after = real((s) => s.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1)));
    check(`mutating ${label} in the recorded reply request changes its skeleton`, JSON.stringify(rec.request.body).includes(JSON.stringify(from).slice(1, -1)) && after.hash !== base.hash);
  }
  const toned = real((s) => s.split("Calm, unhurried, specific.").join("Calm and unhurried, and specific."));
  check("a tone-only move of VOICE_TONE in the recorded reply request keeps its skeleton, and is not blocked", toned.hash === base.hash && movedBetween(rec.structure, toned).blocked.length === 0 && movedBetween(rec.structure, toned).moved.some((m) => m.id === "coVoice.ts:VOICE_TONE#0"));
  check("the ids are stable under an edit inside a literal", JSON.stringify(chunksOf("x.ts", "const A = `one two three four five six seven eight nine ten eleven`;").map((c) => c.id)) === JSON.stringify(chunksOf("x.ts", "const A = `one two three four five six seven eight nine ten twelve!!`;").map((c) => c.id)));
}

// ---- 5. the rubric fits the turn
{
  const share = rubricPrompt({ kind: "share", message: "We closed the round", recent: "" }, "x");
  check("the rubric has no blanket 1-2 sentence cap or one-question rule (both depend on the turn)", /no length cap/.test(share) && /several questions are fine when they are one continuous thought/i.test(share) && !/length_fit|one_question/.test(share));
  check("check-in and feedback criteria apply only to their turns", criteriaFor("checkin").includes("checkin_presence") && !criteriaFor("share").includes("checkin_presence") && criteriaFor("feedback").includes("feedback_owned") && !criteriaFor("reply").includes("feedback_owned"));
  check("the judge is told the member's first name (10-29: it faulted a reply for 'inventing' it)", /Their first name is Lena/.test(rubricPrompt({ kind: "share", message: "hi", recent: "", firstName: "Lena" }, "x")));
}

// ---- 6. an env cap reaches the meter (the scripts used to hardcode $4)
{
  const env = { ...process.env, ANTHROPIC_API_KEY: "ci", OPENAI_API_KEY: "ci" } as Record<string, string | undefined>;
  delete env.EVAL_COST_CAP_USD; delete env.EVAL_TOKEN_CAP;
  const est = (extra: Record<string, string>) => spawnSync("npm", ["run", "-s", "evals:golden:quality", "--", "--estimate", "--only", "checkin-nothing"], { cwd: api, encoding: "utf8", env: { ...env, ...extra } as NodeJS.ProcessEnv }).stdout;
  check("the quality run's cap is the env's when set", /cap \$7\.00\)/.test(est({ EVAL_COST_CAP_USD: "7" })));
  check("...and $4 when not", /cap \$4\.00\)/.test(est({})));
  const over = spawnSync("npm", ["run", "-s", "evals:golden:quality", "--", "--only", "checkin-nothing"], { cwd: api, encoding: "utf8", env: { ...env, EVAL_COST_CAP_USD: "0.01" } as NodeJS.ProcessEnv });
  check("a quality run whose estimate is over the cap refuses to start (no call made)", over.status === 2 && /over the cap \(\$0\.01\)/.test(over.stdout) && /0 model calls/.test(over.stdout), over.stdout.slice(-400));
}

// ---- 7. a busy API doesn't cost the rubric judge a try (10-30: 18 of 83 quality-run grades were lost)
{
  check("a 429 is busy", busy({ statusCode: 429, message: "Too Many Requests" }));
  check("a 529 / overloaded is busy", busy({ message: "529 Overloaded" }) && busy(new Error("overloaded_error")));
  check("a rate-limit message is busy", busy(new Error("rate limit exceeded")));
  check("a bad request is not busy", !busy({ statusCode: 400, message: "invalid_request_error" }));
  check("a parse problem is not busy", !busy(new Error("Unexpected token")));
  check("the meter's cap refusal is not busy (its token counts can read 529)", !busy(new Error("EVAL CAP: this call could pass the token cap 500,000 (499,529 used)")));
}

console.log(`golden rework: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
