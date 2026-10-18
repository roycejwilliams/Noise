// A+H: the checkers know the member (Royce, 2026-10-18: "the checkers see my goals and name. The judge needs my goals as context for
// checking facts, so lines like 'partnering with Sequin AI' and 'Bootstrapped, pre-seed' can pass. A name from a goal still doesn't
// clear a name check. Third-party claims stay refused. Put the name and goals first in what the judge reads, since it only reads the
// first 6,000 characters. Test that order." And: "log a short reason for every refusal").
// The member here is invented (Ellis Hart, a founder; his company Fieldhouse; his goal names Lumen Labs), standing in for the real
// case (a founder whose goal names the partner company, refused for "Partnering with ...", "Our November launch party with ...",
// "Bootstrapped, pre-seed" and "Built by <his name>").
// Zero tokens: the checks are code; the judges are stubs that record the prompt they were given.
//   npx tsx evals/files/checkersKnowMember.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const M = await import("../../src/services/memberRecord.js");
const DC = await import("../../src/services/coPages/deckClaims.js");
const DJ = await import("../../src/services/documentClaims.js");
const DS = await import("../../src/services/documentSheet.js");
const R = await import("../../src/services/checkerRefusals.js");
const { headlineNameProblems } = await import("../../src/services/coPages/grounding.js");
const { checkPage } = await import("../../src/services/coPages/store.js");
const { deckDataFrom, deckCheckWords } = await import("../../src/agent/deckTools.js");
const PT = await import("../../src/agent/pageTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the two-member fake store
const GOAL_A = "partnering with Lumen Labs for a November launch party";
const GOAL_A2 = "raise a pre-seed round";
const GOAL_A_DONE = "find a cofounder";
const GOAL_A_LINKED = "grab coffee with Noor about her gallery";
const GOAL_B = "open a second gallery in Oakland with Parallel Arts";
const USERS: Record<string, { first: string; last: string }> = { a1: { first: "Ellis", last: "Hart" }, b2: { first: "Noor", last: "Haddad" } };
const PROFILES: Record<string, { goals: string[]; intent: unknown[] }> = {
  a1: { goals: [GOAL_A, GOAL_A2, GOAL_A_LINKED], intent: [{ kind: "goal", text: GOAL_A_DONE, status: "resolved" }] },
  b2: { goals: [GOAL_B], intent: [] },
};
// Ellis was introduced to Noor: her name is one member knowledge strips from his record.
const LINKED: Record<string, string[]> = { a1: ["Noor"], b2: ["Ellis"] };
const knowledgeDeps = (o: { namesFail?: boolean } = {}) => ({
  profile: async (id: string) => (PROFILES[id] ? { firstName: USERS[id]?.first ?? null, city: "San Francisco", goals: PROFILES[id].goals, intent: PROFILES[id].intent, updatedAt: new Date("2026-10-10T00:00:00Z") } : null),
  zone: async () => "America/Los_Angeles",
  linkedNames: async (id: string) => {
    if (o.namesFail) throw new Error("names read failed");
    return LINKED[id] ?? [];
  },
  goalStates: async () => [],
});
const fakeDeps = (o: { namesFail?: boolean } = {}): import("../../src/services/memberRecord.js").RecordDeps => ({
  names: async (id) => (USERS[id] ? { firstName: USERS[id].first, lastName: USERS[id].last } : null),
  goals: (id) => M.knowledgeGoals(id, knowledgeDeps(o) as any),
});

// ---------------------------------------------------------------- 1. source: their own goals and name, never another member's
const A = await M.loadMemberRecord("a1", fakeDeps());
const B = await M.loadMemberRecord("b2", fakeDeps());
const hA = M.memberHeader(A);
const hB = M.memberHeader(B);
check("source: their name, first and last, from their own record", !!A && A.firstName === "Ellis" && A.lastName === "Hart" && hA.includes("Their name: Ellis Hart"), { A, hA });
check("source: their active goals, quoted", hA.includes(`"${GOAL_A}"`) && hA.includes(`"${GOAL_A2}"`), hA);
check("source: a goal they closed is not in it", !hA.includes(GOAL_A_DONE), hA);
check("source: another member's goals never appear (two members, one store)", !hA.includes(GOAL_B) && !hA.includes("Parallel Arts") && !hB.includes(GOAL_A) && !hB.includes("Lumen"), { hA, hB });
check("source: another member's name never appears (a goal naming a linked member is stripped by member knowledge, then left out)", !/Noor|Haddad/.test(hA) && !/Ellis|Hart/.test(hB), { hA, hB });
check("source: each member gets their own name only", hB.includes("Their name: Noor Haddad") && !hA.includes("Noor"), { hA, hB });
{
  const failedNames = await M.loadMemberRecord("a1", fakeDeps({ namesFail: true }));
  check("source: when the other members' names can't be read, no goals at all (fails closed), their name still", !!failedNames && failedNames.goals.length === 0 && failedNames.firstName === "Ellis", failedNames);
  check("source: nothing on file, no record", (await M.loadMemberRecord("zz", fakeDeps())) === null || M.memberHeader(await M.loadMemberRecord("zz", fakeDeps())) === "");
  const r = src("services/memberRecord.ts");
  check("source: the real read is their own row only (users WHERE id = $1) and member knowledge for goals", /SELECT first_name, last_name FROM users WHERE id = \$1`, \[userId\]/.test(r) && /memberKnowledge\(userId, \{ include: \["goals"\] \}, deps\)/.test(r));
  check("source: goals are the active ones on file, as they wrote them (a goal the strip rewrote is left out)", /g\.state === "active" && g\.onFile && hash\(g\.text\) === g\.hash/.test(r));
  check("source: no company line (no company field on the record)", !/company/i.test(hA));
}

// ---------------------------------------------------------------- 2. order: header first, inside the judge's window, capped
const LONG = Array.from({ length: 800 }, (_, i) => `text ${i}: we're bootstrapped, pre-seed, no outside funding yet and the launch is soon`).join("\n");
const box = (prompt: string, open: string) => {
  const at = prompt.indexOf(`${open}\n"""\n`);
  if (at < 0) return "";
  const start = at + open.length + 5;
  return prompt.slice(start, prompt.indexOf('\n"""', start));
};
{
  const p = DC.claimsPrompt(["Partnering with Lumen Labs"], LONG, "", "", hA);
  const b = box(p, "What they said (and what was read for this deck, when anything was):");
  check("order (deck judge): what the judge reads opens with the header", b.startsWith(M.HEADER_TITLE), b.slice(0, 120));
  check("order (deck judge): the whole header is read with 60k characters of their words, and their words keep their own 6,000", b.startsWith(hA) && b.length <= hA.length + 2 + DC.JUDGE_WORDS_CHARS && b.length - hA.length - 2 >= DC.JUDGE_WORDS_CHARS - 1, { len: b.length, words: LONG.length });
  check("order (deck judge): their words follow the header, newest kept", b.indexOf("text 0:") > b.indexOf(GOAL_A2), b.slice(0, 300));
  check("order (deck judge): the cut is the one the judge reads (6,000 of their words)", DC.JUDGE_WORDS_CHARS === 6000 && /\$\{judgeBox\(header, theirWords, read\)\}/.test(src("services/coPages/deckClaims.ts")));
  // Review of #241: with 14 days of their words, a page Cue read fell past the 6,000 cut. It has its own block, after the header.
  const words14 = Array.from({ length: 120 }, (_, i) => `text ${i}: some long message about the dinner plans and who is coming and the menu`).join("\n");
  const page = "PAGE READ: The Battery, 717 Battery St, private dining room seats 40, $150 per head";
  const pr = DC.claimsPrompt(["The Battery seats 40"], words14, "", "", hA, page);
  const pb = box(pr, "What they said (and what was read for this deck, when anything was):");
  check("order (deck judge): a page Cue read is in the prompt with 120 long texts of their words", pr.includes(page) && words14.length > DC.JUDGE_WORDS_CHARS, { words: words14.length });
  check("order (deck judge): header, then what Cue read, then their words", pb.startsWith(hA) && pb.indexOf(DC.READ_TITLE) > pb.indexOf(hA) && pb.indexOf("text 0:") > pb.indexOf(page), pb.slice(0, 400));
  check("order (deck judge): what Cue read is capped (4,000) and their words keep their 6,000", DC.JUDGE_READ_CHARS === 4000 && !box(DC.claimsPrompt(["x"], words14, "", "", "", "r".repeat(9000)), "What they said (and what was read for this deck, when anything was):").includes("r".repeat(4001)) && box(DC.claimsPrompt(["x"], words14, "", "", "", "r".repeat(9000)), "What they said (and what was read for this deck, when anything was):").includes(words14.slice(0, 5990)));
  check("order (deck tool): what Cue read goes in its own block, not after their words", /C\.inventedLines\(lines, words, undefined, self, source\.thread \?\? "", header, source\.read\)/.test(src("agent/deckTools.ts")));
  const many = M.memberHeader({ firstName: "Ellis", lastName: "Hart", goals: Array.from({ length: 30 }, (_, i) => `goal ${i} ${"word ".repeat(120)}`) });
  // The cap (1,600 characters, 12 goals, 200 a goal; raised after the A+H re-measure), pinned as numbers so a looser constant fails.
  check("cap: the header is at most 1,600 characters, 12 goals, 200 characters a goal", M.HEADER_LIMITS.chars === 1600 && M.HEADER_LIMITS.goals === 12 && M.HEADER_LIMITS.goalChars === 200 && many.length <= 1600 && (many.match(/^ {2}- "/gm) ?? []).length <= 12 && many.split("\n").every((l) => l.length <= 208), { len: many.length, goals: (many.match(/^ {2}- "/gm) ?? []).length });
  check("cap: a capped header leaves their words their whole 6,000", (() => {
    const b2 = box(DC.claimsPrompt(["x"], LONG, "", "", many), "What they said (and what was read for this deck, when anything was):");
    return b2.startsWith(M.HEADER_TITLE) && b2.length - many.length >= DC.JUDGE_WORDS_CHARS - 2;
  })());
  const dp = DJ.documentClaimsPrompt(["x"], LONG, hA);
  const db = box(dp, "What they said:");
  check("order (document judge): opens with the header, then the newest of their words (it reads the last 9,000)", db.startsWith(hA) && db.includes("text 799:") && !db.includes("text 0:") && db.length <= DJ.JUDGE_WORDS_CHARS + hA.length + 2, { len: db.length });
  // The deck's check words: this message first, then 14 days of texts and calls newest first; the 12-hour rows are all still in.
  const w = deckCheckWords(["make the deck now", ""], ["texted an hour ago"], ["said 10 days ago", "call line 3 days ago", "texted an hour ago"]);
  check("order (deck source): this message, then their 14 days newest first", w === "make the deck now\ntexted an hour ago\ncall line 3 days ago\nsaid 10 days ago", w);
  check("order (deck source): every text the 12-hour window had stays in", deckCheckWords([], ["a", "b"], ["b"]).split("\n").includes("a"));
}

// ---------------------------------------------------------------- 3. the judge prompts: the rules, pinned
{
  const R0 = M.MEMBER_RECORD_RULES;
  check("rules: name and goals are what they told Cue", /their name and their goals, from their own record\. Read them as things they told Cue/.test(R0));
  check("rules: their own name and company are not a third party, and back no fact about them", /their own name, and their own company or project, are theirs, not a third party; a line naming them still needs their words for any fact it states about them/.test(R0));
  check("rules: a line restating their own goal or plan is backed", /a line restating their own goal or plan, as an aim or a plan, is backed \("Partnering with X" when a goal of theirs is partnering with X\)/.test(R0));
  check("rules: a third party's act or role (did, agreed, confirmed, funded, sponsored, partner, customer) needs their words or goal", /a claim that another person or organization did something, agreed to, confirmed, funded or sponsored something, or is a partner or customer, is backed ONLY if their own words or their goal say so/.test(R0));
  check("rules: a goal is an aim, never a result", /a goal is an aim, not a result: a line stating it as done \("X confirmed", "Signed with X", "X is sponsoring"\) is not backed by a goal of partnering with X/.test(R0));
  check("rules: an invented detail beyond the goal is not backed", /a detail beyond the goal \(a dollar figure, a date, "confirmed", "signed", a count\) is not backed by the goal/.test(R0));
  const p = DC.claimsPrompt(["a"], "w", "", "", hA);
  check("rules: the deck judge reads them, before their words", p.includes(R0) && p.indexOf(R0) < p.indexOf(hA), null);
  const d = DJ.documentClaimsPrompt(["a"], "w", hA);
  check("rules: the document judge reads them, before their words", d.includes(R0) && d.indexOf(R0) < d.indexOf(hA), null);
  check("rules: with nothing on file, both prompts are as they were (no rules, no header)", DC.claimsPrompt(["a"], "w") === DC.claimsPrompt(["a"], "w", "", "", "", "") && !DC.claimsPrompt(["a"], "w").includes("On file for them") && !DJ.documentClaimsPrompt(["a"], "w").includes(R0));
}

// ---------------------------------------------------------------- 4. the code checks: own first name passes; a goal's name doesn't
const WORDS = "We're bootstrapped, pre-seed, no outside funding yet. I need capital for the launch. Fieldhouse is my company. I host the launch dinner at the fieldhouse in November, on a saturday.";
{
  const h = (headline: string, member: typeof A) => headlineNameProblems(headline, WORDS, "slide 2 headline", M.ownName(member));
  check('code: "Built by Ellis" passes the headline name check with their record', h("Built by Ellis", A) === null, h("Built by Ellis", A));
  check('code: "Built by Ellis" was refused without it (their name never in their words)', h("Built by Ellis", null) !== null);
  check('code: their own company in their words passes ("Hosted by Fieldhouse")', h("Hosted by Fieldhouse", A) === null, h("Hosted by Fieldhouse", A));
  check('code: a name only in their goal is still refused ("Partnering with Lumen Labs")', /Lumen Labs/.test(h("Partnering with Lumen Labs", A) ?? ""), h("Partnering with Lumen Labs", A));
  check('code: their last name is not cleared (first name only, ruling iii): "Built by Ellis Hart"', /Ellis Hart/.test(h("Built by Ellis Hart", A) ?? ""), h("Built by Ellis Hart", A));
  check('code: an invented third party is still refused ("Sponsored by Acme Ventures")', /Acme Ventures/.test(h("Sponsored by Acme Ventures", A) ?? ""));
  // Review of #241: their name added to their words let a made-up name pass whose words each appear there ("capital" is theirs).
  check('code: a made-up name built on their first name is refused ("Backed by Ellis Capital")', /Ellis Capital/.test(h("Backed by Ellis Capital", A) ?? ""), h("Backed by Ellis Capital", A));
  check("code: their possessive is theirs (\"Ellis's launch dinner\")", h("Ellis's launch dinner", A) === null && h("The launch with Ellis's team", A) === null, h("The launch with Ellis's team", A));
  const fullFirst = { firstName: "Ellis Hart", lastName: null, goals: [] };
  check('code: a whole name stored as first_name clears only its first word ("Built by Ellis Hart" refused)', M.ownName(fullFirst) === "ellis" && /Ellis Hart/.test(h("Built by Ellis Hart", fullFirst) ?? ""), h("Built by Ellis Hart", fullFirst));

  const deck = async (bullets: string[], member: typeof A) => {
    const data = await deckDataFrom({ title: "Fieldhouse", subtitle: "A launch dinner for founders", slides: [{ headline: "The launch", bullets }, { headline: "The dinner", bullets: ["We're bootstrapped, pre-seed"] }] } as any, null, new Map(), null, { theirWords: WORDS });
    const c = checkPage(data, { theirs: WORDS, read: "", member });
    return c.ok ? [] : c.problems;
  };
  check('code (deck line): "The launch dinner is hosted by Ellis" passes with their record', (await deck(["The launch dinner is hosted by Ellis"], A)).length === 0, await deck(["The launch dinner is hosted by Ellis"], A));
  check('code (deck line): and was refused without it', (await deck(["The launch dinner is hosted by Ellis"], null)).some((p) => /Ellis/.test(p)));
  check('code (deck line): a goal-only name is still refused ("Our November launch party with Lumen Labs")', (await deck(["Our November launch party with Lumen Labs"], A)).some((p) => /Lumen Labs/.test(p)), await deck(["Our November launch party with Lumen Labs"], A));
  check('code (deck line): an invented partner on an event line is still refused ("Launch dinner co-hosted with Acme Ventures")', (await deck(["Launch dinner co-hosted with Acme Ventures"], A)).some((p) => /Acme Ventures/.test(p)));
  check('code (deck line): a made-up name built on their first name is refused ("The launch dinner is backed by Ellis Capital")', (await deck(["The launch dinner is backed by Ellis Capital"], A)).some((p) => /Ellis Capital/.test(p)), await deck(["The launch dinner is backed by Ellis Capital"], A));

  const page = async (text: string, member: typeof A) => {
    const input = { why: "They asked for a page for the launch dinner.", line: "Here's the launch dinner.", title: "Fieldhouse Launch Dinner", context: "The launch dinner at the fieldhouse", sections: [{ heading: "The night", blocks: [{ type: "bullets", items: [{ text }] }] }], designContext: "professional" };
    const words = await PT.pageWords(input as any, WORDS);
    const c = checkPage(PT.pageDataFrom(words as any, { style: null, assets: new Map() }), { theirs: WORDS, read: "", member });
    return c.ok ? [] : c.problems;
  };
  check('code (page): "The launch dinner at the Fieldhouse is hosted by Ellis" passes with their record', (await page("The launch dinner at the Fieldhouse is hosted by Ellis", A)).length === 0, await page("The launch dinner at the Fieldhouse is hosted by Ellis", A));
  check("code (page): and was refused without it", (await page("The launch dinner at the Fieldhouse is hosted by Ellis", null)).some((p) => /Ellis/.test(p)));
  check('code (page): a made-up name built on their first name is refused ("The launch dinner at the Fieldhouse is backed by Ellis Capital")', (await page("The launch dinner at the Fieldhouse is backed by Ellis Capital", A)).some((p) => /Ellis Capital|capital/i.test(p)), await page("The launch dinner at the Fieldhouse is backed by Ellis Capital", A));
  check('code (page): a goal-only name is still refused ("The launch dinner at the Fieldhouse is with Lumen Labs")', (await page("The launch dinner at the Fieldhouse is with Lumen Labs", A)).some((p) => /Lumen/.test(p)), await page("The launch dinner at the Fieldhouse is with Lumen Labs", A));

  const doc = (bullet: string) => DS.resolveDocument({ title: "Launch dinner plan", note: "What you told me.", sections: [{ heading: "The dinner", bullets: [bullet, "We're bootstrapped, pre-seed, no outside funding yet."] }] });
  const dp = (bullet: string, member: typeof A) => DS.documentProblems(doc(bullet), { theirs: WORDS, member });
  check('code (doc): "The launch dinner at the Fieldhouse is hosted by Ellis." passes with their record', !dp("The launch dinner at the Fieldhouse is hosted by Ellis.", A).some((p) => /Ellis/.test(p)), dp("The launch dinner at the Fieldhouse is hosted by Ellis.", A));
  check("code (doc): and was refused without it", dp("The launch dinner at the Fieldhouse is hosted by Ellis.", null).some((p) => /Ellis|ellis/.test(p)));
  check('code (doc): a goal-only name is still refused ("The November launch party is with Lumen Labs.")', dp("The November launch party is with Lumen Labs.", A).some((p) => /Lumen|lumen/.test(p)), dp("The November launch party is with Lumen Labs.", A));
  check('code (doc): a made-up name built on their first name is refused ("The launch dinner is backed by Ellis Capital.")', dp("The launch dinner is backed by Ellis Capital.", A).some((p) => /capital/i.test(p)), dp("The launch dinner is backed by Ellis Capital.", A));
  check("code: only the exact first name clears, never a goal, the last name or a longer name", M.ownName(A) === "ellis" && M.isOwnName("Ellis", "ellis") && M.isOwnName("Ellis's", "ellis") && !M.isOwnName("Ellis Capital", "ellis") && !M.isOwnName("Ellis Hart", "ellis") && !M.isOwnName("Lumen Labs", "ellis") && M.ownName(null) === null);
  check("code: their name is never added to the words the checks read", !/export function withOwnName/.test(src("services/memberRecord.ts")) && ![src("services/coPages/grounding.ts"), src("services/documentSheet.ts"), src("services/documentClaims.ts"), src("agent/deckTools.ts")].some((t) => /withOwnName/.test(t)));
  // Unicode: a cut never splits a character (review of #241).
  const uni = M.memberHeader({ firstName: "Zoë", lastName: "Ñúñez", goals: ["🚀".repeat(150), ...Array.from({ length: 8 }, (_, i) => `ゴール ${i} ` + "長い🎉".repeat(80))] });
  check("header: cuts never split a character, and the cap holds", !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(uni) && uni.length <= 1600 && uni.includes("Their name: Zoë Ñúñez"), uni.length);
  check("header: a whole name in first_name isn't said twice", M.memberHeader({ firstName: "Ellis Hart", lastName: "Hart", goals: [] }).includes("Their name: Ellis Hart\n") || M.memberHeader({ firstName: "Ellis Hart", lastName: "Hart", goals: [] }).endsWith("Their name: Ellis Hart"));
}

// ---------------------------------------------------------------- 5. stubbed judges: their verdicts pass through as they are
{
  const lines = ["Partnering with Lumen Labs", "Lumen Labs confirmed as launch partner", "Built by Ellis, $50k raised", "Bootstrapped, pre-seed, no outside funding yet"];
  let seen = "";
  const judge = (answer: string) => async (prompt: string) => {
    seen = prompt;
    return answer;
  };
  const out = await DC.inventedLines(lines, WORDS, judge(JSON.stringify({ fails: [{ n: 2, why: "a goal, not done: confirmed" }, { n: 3, why: "$50k they never gave" }] })), "", "", hA);
  check("stub (deck): the judge read the header first", box(seen, "What they said (and what was read for this deck, when anything was):").startsWith(hA), seen.slice(0, 200));
  check("stub (deck): the judge's fails come back exactly, nothing cleared in code", JSON.stringify(out) === JSON.stringify([{ line: lines[1], why: "a goal, not done: confirmed" }, { line: lines[2], why: "$50k they never gave" }]), out);
  const none = await DC.inventedLines(lines, WORDS, judge(JSON.stringify({ fails: [] })), "", "", hA);
  check("stub (deck): a judge that passes every line passes every line (code adds no refusal)", Array.isArray(none) && none.length === 0, none);
  const all = await DC.inventedLines(lines, WORDS, judge(JSON.stringify({ fails: lines.map((_, i) => ({ n: i + 1, why: "x" })) })), "", "", hA);
  check("stub (deck): a judge that fails the member's own name and goal lines fails them (no code clearing from the record)", all?.length === 4, all);
  check("stub (deck): the call passes the header through (deckTools inventedClaims)", /const header = M\.memberHeader\(source\.member, lines\);/.test(src("agent/deckTools.ts")) && /C\.inventedLines\(lines, words, undefined, self, source\.thread \?\? "", header, source\.read\)/.test(src("agent/deckTools.ts")));

  // The document judge: a line the word check can't place goes to it; its verdict stands, and a goal's name is still refused in code.
  const docOf = (bullets: string[]) => DS.resolveDocument({ title: "Launch dinner plan", note: "What you told me.", sections: [{ heading: "The dinner", bullets }] });
  const soft = "Fieldhouse runs lean until the round closes.";
  let dseen = "";
  const dj = (backed: number[], fails: { n: number; why: string }[]) => async (prompt: string) => {
    dseen = prompt;
    return JSON.stringify({ backed, fails });
  };
  const d1 = docOf(["We're bootstrapped, pre-seed, no outside funding yet.", soft]);
  const passed = await DJ.judgedDocumentProblems(d1, { theirs: WORDS, member: A }, undefined, dj([1], []));
  check("stub (doc): the document judge read the header first", box(dseen, "What they said:").startsWith(M.HEADER_TITLE) && box(dseen, "What they said:").includes("Their name: Ellis Hart"), dseen.slice(0, 200));
  check("stub (doc): a line the judge backs passes", !passed.some((p) => p.includes(soft.slice(0, 30))), passed);
  const refused = await DJ.judgedDocumentProblems(d1, { theirs: WORDS, member: A }, undefined, dj([], [{ n: 1, why: "adds a closing round" }]));
  check("stub (doc): a line the judge doesn't back stays refused", refused.some((p) => p.includes(soft.slice(0, 30))), refused);
  const goalName = docOf(["The November launch party is with Lumen Labs."]);
  const hard = await DJ.judgedDocumentProblems(goalName, { theirs: WORDS, member: A }, undefined, async () => JSON.stringify({ backed: [1], fails: [] }));
  check("stub (doc): a name only in their goal is refused in code whatever the judge says", hard.some((p) => /Lumen|lumen/.test(p)), hard);
}

// ---------------------------------------------------------------- 6. every refusal logged with a short reason, and no member text
// Forget by default (coordinator, 2026-10-18): a removal deletes their raw lines, so the log never keeps a copy. A row names each
// refused line by its place and the kind of problem; the writer's refusal can still quote it.
{
  // Real refusals from the checks above, as each tool logs them.
  const deckIn = { title: "Fieldhouse", subtitle: "A launch dinner for founders", slides: [{ headline: "Partnering with Lumen Labs", bullets: ["Our November launch party with Lumen Labs", "Dinner at 9pm sharp"] }, { headline: "The dinner", bullets: ["We're bootstrapped, pre-seed"] }] } as any;
  const deckData = await deckDataFrom(deckIn, null, new Map(), null, { theirWords: WORDS });
  const deckC = checkPage(deckData, { theirs: WORDS, read: "", member: A });
  const deckProblems = deckC.ok ? [] : deckC.problems;
  const named = headlineNameProblems("Partnering with Lumen Labs", WORDS, "slide 2 headline", M.ownName(A));
  const docIn = DS.resolveDocument({ title: "Lumen Labs launch plan", note: "What you told me.", sections: [{ heading: "The dinner", bullets: ["We're bootstrapped, pre-seed, no outside funding yet.", "The November launch party is with Lumen Labs and 40 guests."] }], suggestions: ["Ask Parallel Arts to co-host the dinner"] });
  const docProblems = DS.documentProblems(docIn, { theirs: WORDS, member: A });
  const rows = [
    R.refusalRow({ checker: "deck.grounding", userId: "a1", problems: deckProblems, lines: R.deckPositions(deckData), member: A, extra: { event: "make" } }),
    R.refusalRow({ checker: "deck.names", userId: "a1", problems: [named ?? ""], lines: R.deckPositions(deckIn), member: A }),
    R.refusalRow({ checker: "doc.grounding", userId: "a1", problems: docProblems, lines: R.docPositions(docIn), member: A }),
  ];
  check("log: the fixtures were refused (so the rows below are real refusals)", deckProblems.length > 0 && !!named && docProblems.length > 0, { deckProblems, named, docProblems });
  // Every word of theirs that could identify a line: none may be in any row.
  const MEMBER_TEXT = ["Lumen", "Fieldhouse", "Partnering", "launch party", "bootstrapped", "9pm", "40 guests", "Parallel", "co-host", "Ellis", "Hart", GOAL_A, "founders"];
  for (const row of rows) {
    const j = JSON.stringify(row);
    check(`log (${row.decision}): no member text in the row (no quoted line, fragment, title or goal)`, !MEMBER_TEXT.some((t) => j.toLowerCase().includes(t.toLowerCase())) && !/"[^"]*\\"/.test(j), j);
    check(`log (${row.decision}): one row, refused, a one-line reason`, row.outcome === "skip" && row.action === "refused" && !/\n/.test(String(row.reason)) && /^\d+ problems?: /.test(String(row.reason)), row.reason);
  }
  check('log: a headline is named by its place and kind ("slide 2 headline: a name not in their words")', rows[1].reason === "1 problem: slide 2 headline: a name not in their words", rows[1].reason);
  check("log: a deck bullet is placed by its slide and bullet, with its kind", /slide 2 bullet 1: a name not in their words/.test(String(rows[0].reason)) && /slide 2 bullet 2: an unbacked time/.test(String(rows[0].reason)), rows[0].reason);
  check("log: a document line is placed by its section and bullet, its kinds named", /section 1 bullet 2: /.test(String(rows[2].reason)) && /suggestion 1: a name not in their words/.test(String(rows[2].reason)), rows[2].reason);
  check("log: the row stores positions and kinds, never the problems' text", Array.isArray((rows[0].proposal as any).refused) && (rows[0].proposal as any).problems === undefined && (rows[0].proposal as any).refused.every((x: any) => Object.keys(x).join() === "at,kind"), rows[0].proposal);
  check("log: what was on file, as counts only (never the goals)", JSON.stringify((rows[0].proposal as any).saw) === JSON.stringify({ name: true, goals: 2 }), rows[0].proposal);
  check("log: the deck judge's reason is read for its kind, never kept", R.judgedKind("Lumen Labs confirming the partnership") === "a third-party claim" && R.judgedKind("$50k raised") === "an unbacked number" && R.judgedKind("our November launch date") === "an unbacked date");
  const many = R.refusalReason(Array.from({ length: 40 }, (_, i) => ({ at: `slide ${i} bullet 1`, kind: "a name not in their words" })));
  check("log: a long refusal is still one capped line", many.length <= R.REASON_CHARS && !/\n/.test(many));
  const got: unknown[] = [];
  await R.logRefusal({ checker: "page.grounding", userId: "a1", problems: ["p"] }, async (d) => got.push(d));
  let threw = false;
  try {
    await R.logRefusal({ checker: "page.grounding", userId: "a1", problems: ["p"] }, async () => { throw new Error("db down"); });
  } catch {
    threw = true;
  }
  check("log: written through the decision log; a failed write never throws", got.length === 1 && !threw);
  const deckT = src("agent/deckTools.ts"), pageT = src("agent/pageTools.ts"), loopT = src("agent/loopTools.ts"), brief = src("services/researchBrief.ts");
  check("log sites: deck headline names and deck grounding (make, store, change), each with the deck's places", (deckT.match(/deckRefused\(ctx, "deck\.names"/g) ?? []).length === 2 && (deckT.match(/deckRefused\(ctx, "deck\.grounding"/g) ?? []).length === 3 && /lines: R\.deckPositions\(deck\)/.test(deckT));
  check("log sites: the deck claims judge's rows carry places and kinds only", /proposal: \{ refused, saw \}/.test(deckT) && /kind: (?:f\.old \? R\.OLD_FACT : )?R\.judgedKind\(f\.why\)/.test(deckT) && !/proposal: \{ fails/.test(deckT) && /action: "check_unavailable", reason: /.test(deckT));
  check("log sites: pages (make, store, change), with the page's places", (pageT.match(/await refused\(/g) ?? []).length === 3 && /checker: "page\.grounding", userId: ctx\.userId, problems, lines,/.test(pageT));
  check("log sites: documents and documents from a file, with the document's places", (loopT.match(/lines: docPositions\(doc\)/g) ?? []).length === 2 && /checker: "doc\.grounding"/.test(loopT) && /checker: "doc\.fromFile"/.test(loopT));
  check("log sites: a research brief, with its places", /checker: "task\.brief", layer: 7, userId: task\.userId, problems, lines: R\.docPositions\(doc\)/.test(brief));
  check("log sites: no title or other member text passed as extra", ![deckT, pageT, loopT, brief].some((t) => /extra: \{[^}]*title/.test(t) || /, \{ title: String\(/.test(t)));
}

// ---------------------------------------------------------------- 7. every checker reads the one source, from the member's own record
{
  const deckT = src("agent/deckTools.ts"), loopT = src("agent/loopTools.ts"), brief = src("services/researchBrief.ts"), del = src("services/documentDelivery.ts");
  check("wired (deck): 14 days of texts and calls (loadTheirLines) and their own record, for the checks", /loadTheirLines\(ctx\.userId\)/.test(deckT) && /loadMemberRecord\(ctx\.userId\)/.test(deckT) && /const theirs = \[judged, deck\?\.lines \?\? ""\]/.test(deckT));
  check("wired (deck): the writer, casing and image numbers keep the 12-hour window (nothing it writes changes)", (deckT.match(/source\.forWriting/g) ?? []).length === 7 && !/compose<any>\(C\.(?:new|change)DeckPrompt\([^)]*source\.theirs/.test(deckT));
  check("wired (deck): headline names read their first name", (deckT.match(/headlineNames\([^;]*source\.member\)/g) ?? []).length === 2);
  check("wired (page): their own record with their words", /loadMemberRecord\(ctx\.userId\)[\s\S]{0,300}return \{ theirs, read, member \};/.test(loopT));
  check("wired (document): their own record with their words", /const source = \{ theirs, read, member \};/.test(loopT) && /documentProblems\(doc, \{ theirs: `\$\{theirs\}\\n\$\{file\.text\}`, member \}\)/.test(loopT));
  check("wired (task documents): the research brief and a task's document", /loadMemberRecord\(task\.userId\)/.test(brief) && /judgedDocumentProblems\(doc, \{ theirs, member \}\)/.test(brief) && /deps\.member\(o\.userId\)/.test(del) && /member: async \(userId\) => \(await import\("\.\/memberRecord\.js"\)\)\.loadMemberRecord\(userId\)/.test(del));
  check("wired: the document judge gets the header, its word checks the exact first name", /judgeLines\(lines, source\.theirs, judge, memberHeader\(source\.member, lines\)\)/.test(src("services/documentClaims.ts")) && (src("services/documentClaims.ts").match(/\{ strict: true, own \}/g) ?? []).length === 2 && /unknownOpeners\(parts, theirs, own\)/.test(src("services/documentClaims.ts")));
  check("wired: the page, deck and document code checks clear only the exact first name", (src("services/coPages/grounding.ts").match(/\.filter\(notOwnName\(own\)\)/g) ?? []).length === 2 && /unbackedClaims\(claims\.map[^\n]*corpus, \{ own \}\)/.test(src("services/coPages/grounding.ts")) && /\.filter\(\(m\) => !isOwnName\(m\.text, own\)\)/.test(src("services/coPages/grounding.ts")) && /\{ strict: true, own \}/.test(src("services/documentSheet.ts")) && /headlineNameProblems\(s\.headline, `\$\{theirs\}\\n\$\{read\}`, `slide \$\{i \+ 2\} headline`, ownName\(member\)\)/.test(src("agent/deckTools.ts")));
}

console.log(`checkers know the member: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
