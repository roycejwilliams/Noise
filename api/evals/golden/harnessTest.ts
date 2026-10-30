// The golden rework, tested (layer 1, zero tokens; Royce 2026-10-29). Pins:
//   - the hard rules (evals/lib/hardRules.ts) catch what they're for, on the 10-29 replies that showed each one, and pass clean replies;
//   - the skeleton (evals/lib/goldenSkeleton.mjs) masks wording only: a moved instruction or tool description keeps the skeleton, a
//     changed fact, schema, model or parameter, or a swapped instruction does not;
//   - replay over the fake network: a moved prompt is served and reported, a changed fact misses, GOLDEN_STRICT misses, a moved
//     output-format instruction misses, and stamping writes a skeleton only on an exact match;
//   - the wording registry reads the reply prompt's sections and no file that builds facts;
//   - the rubric fits the turn (no length cap or one-question rule on a share or feedback turn);
//   - an env cap reaches the meter in the record, live and quality scripts (they used to hardcode $4).
//   npx tsx evals/golden/harnessTest.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardRuleMisses, inventedFacts, linkThenCaption, machinery, quotesOwnLine, repliesPerTurn, statusTalk, stockEmpathy, turnKind } from "../lib/hardRules.js";
import { maskText, movedBetween, skeletonOf } from "../lib/goldenSkeleton.mjs";
import { WORDING_FILES, chunksOf, wordingRegistry } from "./wording.js";
import { criteriaFor, rubricPrompt } from "../lib/replyRubric.js";

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
  check("a check-in is read from the message", turnKind("Just checking in") === "checkin" && turnKind("Hey cue") === "checkin" && turnKind("hey") === "checkin" && turnKind("What are you actually searching for?") === "reply" && turnKind("you're kind of dry", "feedback") === "feedback" && turnKind("We closed the round", "sharing") === "share");
}

// ---- 2. the skeleton
{
  const GUIDE = { id: "probe.ts:GUIDE#0", text: "Match the weight of your reply to theirs, and say each thing once." };
  const key = (o: { guide?: string; fact?: string; model?: string; desc?: string; schema?: string; max?: number; extra?: string } = {}) => ({
    path: "api.anthropic.com/v1/messages", grader: false, beta: null,
    body: { model: o.model ?? "claude-sonnet-5", max_tokens: o.max ?? 100, system: [{ type: "text", text: `${o.guide ?? GUIDE.text}${o.extra ?? ""}\n\nWhat's true right now.\n[F1] ${o.fact ?? "They live in San Francisco."}\nUser said: hello` }], messages: [{ role: "user", content: "Respond." }], tools: [{ name: "sendReply", description: o.desc ?? "Send it.", input_schema: { type: "object", properties: { message: { type: o.schema ?? "string", description: "the text" } } } }] },
  });
  const at = (k: ReturnType<typeof key>, guide = GUIDE.text) => skeletonOf(k, [{ id: GUIDE.id, text: guide }]);
  const s0 = at(key());
  const moved = at(key({ guide: "Match your reply's weight to theirs; say each thing only once." }), "Match your reply's weight to theirs; say each thing only once.");
  check("a moved instruction keeps the skeleton, and says which one moved", moved.hash === s0.hash && JSON.stringify(movedBetween(s0, moved)) === JSON.stringify({ moved: [GUIDE.id], blocked: [] }));
  check("a moved tool description keeps the skeleton, reported as 'tool descriptions'", at(key({ desc: "Send the reply text." })).hash === s0.hash && movedBetween(s0, at(key({ desc: "Send the reply text." }))).moved.includes("tool descriptions"));
  check("a changed fact line changes the skeleton", at(key({ fact: "They live in Oakland." })).hash !== s0.hash);
  check("a changed tool schema, model or max_tokens changes the skeleton", at(key({ schema: "number" })).hash !== s0.hash && at(key({ model: "claude-haiku-5-5" })).hash !== s0.hash && at(key({ max: 200 })).hash !== s0.hash);
  check("text added outside a registered literal changes the skeleton (an instruction added by code)", at(key({ extra: "\nBe brief." })).hash !== s0.hash);
  check("a fact line is never masked, even when its words are a registered literal", maskText(`[F3] ${GUIDE.text}`, [GUIDE], new Set()) === `[F3] ${GUIDE.text}` && maskText(`Co replied: ${GUIDE.text}`, [GUIDE], new Set()) === `Co replied: ${GUIDE.text}`);
  check("swapping one instruction for another changes the skeleton (each literal is its own placeholder)", skeletonOf(key({ guide: "Other words entirely, a different instruction here." }), [GUIDE, { id: "probe.ts:OTHER#0", text: "Other words entirely, a different instruction here." }]).hash !== s0.hash);
  const fmt = at(key({ guide: 'Return ONLY JSON: {"answer": "yes"}' }), 'Return ONLY JSON: {"answer": "yes"}');
  check("a moved output-format instruction is blocked (the recorded answer was written for the old format)", fmt.hash === s0.hash && movedBetween(s0, fmt).blocked.includes(GUIDE.id));
}

// ---- 3. replay over the fake network
{
  const dir = mkdtempSync(join(tmpdir(), "golden-moved-"));
  const A = "Match the weight of your reply to theirs, and say each thing once.";
  const B = "Match your reply's weight to theirs; say each thing only once, never twice.";
  const run = (mode: string, extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = { ...process.env, GOLDEN_MODE: mode, GOLDEN_RECORDINGS: join(dir, "rec"), FAKE_SEEN: join(dir, "seen.jsonl"), EVAL_LEDGER: join(dir, `ledger-${mode}-${Math.random()}.jsonl`), EVAL_TOKEN_CAP: "100000", EVAL_COST_CAP_USD: "5", PROBE_GUIDE: A, PROBE_FACT: "They live in San Francisco.", ANTHROPIC_API_KEY: mode === "record" ? "probe" : "golden-replay", GOLDEN_STRICT: "", GOLDEN_STAMP: "", ...extra };
    const r = spawnSync("node", ["--import", join(api, "evals/lib/fixtures/fakeAnthropic.mjs"), "--import", join(api, "evals/lib/meter.mjs"), "--import", join(api, "evals/lib/goldenReplay.mjs"), join(api, "evals/lib/fixtures/goldenMovedProbe.mjs")], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
    return JSON.parse((r.stdout.match(/GOLDEN (\{.*)/) ?? [])[1] ?? "{}") as { reply?: string; misses?: string[]; moved?: { moved: string[] }[]; served?: number; stats?: { stamped: number } };
  };
  const rec = run("record");
  const files = existsSync(join(dir, "rec/moved-case")) ? readdirSync(join(dir, "rec/moved-case")) : [];
  const recorded = files.length === 1 ? JSON.parse(readFileSync(join(dir, "rec/moved-case", files[0]), "utf8")) : null;
  check("a recording is stamped with its skeleton when it is recorded", rec.reply === "ok" && recorded?.structure?.v === "probe-signature" && !!recorded?.structure?.hash && recorded.structure.wording?.["probe.ts:GUIDE#0"], recorded?.structure);
  const same = run("replay");
  check("an unchanged request replays exactly, nothing moved", same.reply === "ok" && same.served === 1 && same.moved?.length === 0 && same.misses?.length === 0, same);
  const moved = run("replay", { PROBE_GUIDE: B });
  check("a moved instruction is served from its recording and reported as moved, naming what moved", moved.reply === "ok" && moved.misses?.length === 0 && moved.moved?.[0]?.moved?.includes("probe.ts:GUIDE#0") === true, moved);
  const fact = run("replay", { PROBE_GUIDE: B, PROBE_FACT: "They live in Oakland." });
  check("a changed fact misses (and says it isn't a wording-only change)", /^threw: GOLDEN REPLAY/.test(fact.reply ?? "") && /not a wording-only change/.test(fact.misses?.[0] ?? ""), fact);
  const strict = run("replay", { PROBE_GUIDE: B, GOLDEN_STRICT: "1" });
  check("GOLDEN_STRICT=1 turns a moved prompt into a miss", /^threw: GOLDEN REPLAY/.test(strict.reply ?? "") && /GOLDEN_STRICT/.test(strict.misses?.[0] ?? ""), strict);
  const desc = run("replay", { PROBE_TOOL_DESC: "Send the reply text to them." });
  check("a moved tool description is served and reported", desc.reply === "ok" && desc.moved?.[0]?.moved?.includes("tool descriptions") === true, desc);
  const format = run("replay", { PROBE_GUIDE: 'Return ONLY JSON: {"answer": "yes" | "no"}' });
  check("a moved output-format instruction misses", /^threw: GOLDEN REPLAY/.test(format.reply ?? "") && /output-format/.test(format.misses?.[0] ?? ""), format);
  // A recording from before the stamps: no skeleton, so a moved prompt can't be told apart and misses, until it is stamped.
  const path = join(dir, "rec/moved-case", files[0] ?? "x.json");
  if (recorded) { const { structure: _drop, ...bare } = recorded; writeFileSync(path, JSON.stringify(bare, null, 2) + "\n"); }
  const unstamped = run("replay", { PROBE_GUIDE: B });
  check("an unstamped recording never serves a moved prompt (it says to stamp)", /^threw: GOLDEN REPLAY/.test(unstamped.reply ?? "") && /no skeleton stamp/.test(unstamped.misses?.[0] ?? ""), unstamped);
  const missStamp = run("replay", { PROBE_GUIDE: B, GOLDEN_STAMP: "1" });
  check("stamping never stamps from a request that missed", !JSON.parse(readFileSync(path, "utf8")).structure && missStamp.stats?.stamped === 0);
  const stamp = run("replay", { GOLDEN_STAMP: "1" });
  check("stamping writes the skeleton on an exact match", stamp.stats?.stamped === 1 && JSON.parse(readFileSync(path, "utf8")).structure?.hash === recorded?.structure?.hash);
  check("...after which the moved prompt is served", run("replay", { PROBE_GUIDE: B }).reply === "ok");
}

// ---- 4. the wording registry
{
  const r = wordingRegistry();
  check("every wording file exists and has prompt text", WORDING_FILES.every((f) => existsSync(join(api, f)) && chunksOf(f).length > 0));
  check("chunk ids are unique", new Set(r.chunks.map((c) => c.id)).size === r.chunks.length);
  check("the reply prompt's rules are wording (How to reply, the phone rules, the sharing and feedback guides, the iMessage line)", ["How to reply:", "How it looks on a phone:", "They're telling you something about their life.", "They're telling you how you're coming across.", "You're writing an iMessage."].every((t) => r.chunks.some((c) => c.text.includes(t))));
  check("no file that builds facts, tool schemas or member-facing lines is wording (facts are behavior)", !WORDING_FILES.some((f) => /replyGrounding|capabilities|conversationTools|memberWorld|whatsAhead|coTasks|statusCheck/.test(f)));
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

console.log(`golden rework: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
