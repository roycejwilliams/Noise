// The deck judge reads the words that matter (Royce, 2026-10-18, after the A+H re-measure: about half of the judge's 6,000 characters
// were photo descriptions; the facts that backed his lines sat 3,000 to 25,000 characters back; the header's cap dropped the goal the
// deck was about). And old facts (same day): each matched excerpt carries its age; an old match on something that changes is its own
// verdict, never a pass and never "invented"; matching pulls in lines on the same topic (paraphrase candidates); code still
// guards names, numbers and times. The member here is invented (Ellis Hart, a founder).
// Zero tokens: pure functions and stubbed judges.
//   npx tsx evals/files/judgeWords.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import { readFileSync } from "node:fs";
const J = await import("../../src/services/judgeWords.js");
const M = await import("../../src/services/memberRecord.js");
const DC = await import("../../src/services/coPages/deckClaims.js");
const R = await import("../../src/services/checkerRefusals.js");
const { headlineNameProblems } = await import("../../src/services/coPages/grounding.js");
const { checkPage } = await import("../../src/services/coPages/store.js");
const { deckDataFrom } = await import("../../src/agent/deckTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-18T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const box = (prompt: string) => {
  const open = 'What they said (and what was read for this deck, when anything was):\n"""\n';
  const at = prompt.indexOf(open);
  return at < 0 ? "" : prompt.slice(at + open.length, prompt.indexOf('\n"""', at + open.length));
};

// ---------------------------------------------------------------- 1. photo descriptions: one short line each
const PHOTO = '[sent a photo showing: Website homepage for "Bou" (brand company). Navigation bar includes: Work, Services, Clients, About, Careers, Bou & Co., and Contact. Background is a full-bleed photo of a gray Polestar 3 shot in a dark studio with long reflections across the floor.\n\nTwo office location cards:\n- Helsinki: photo of a brick office near a bridge.] (saved as their image #3)';
const WITH = 'This type of vibe [They also sent a photo. It shows: Portfolio grid showing six case study cards from an agency website, Hay Day, Kuva Space, PolyAI, Merge Mansion, Polestar and Rovio, each with tags. Saved as their image #2]';
{
  const a = J.shortPhotos(PHOTO);
  check("photo: a photo on its own becomes one short line", a.startsWith("[sent a photo: Website homepage for") && !a.includes("\n") && a.replace(/ \(saved as their image #\d+\)$/, "").length <= J.PHOTO_LINE_CHARS + 17 && a.endsWith("(saved as their image #3)") && !a.includes("Helsinki"), a);
  const b = J.shortPhotos(WITH);
  check("photo: a photo sent with text becomes one short line, their text kept", b.startsWith("This type of vibe [They also sent a photo: Portfolio grid") && b.includes("Saved as their image #2]") && !b.includes("Rovio"), b);
  const words = [PHOTO, WITH, "we're bootstrapped and launching in november"].join("\n");
  const w = J.judgeWords(["Bootstrapped"], words, [], NOW);
  check("photo: what the judge reads carries the short line, not the description", !w.includes("Helsinki") && !w.includes("Rovio") && w.includes("[sent a photo: Website homepage") && w.includes("we're bootstrapped"), w.slice(0, 300));
}

// ---------------------------------------------------------------- 2. matched excerpts from their whole history, with their age
const FILLER = Array.from({ length: 400 }, (_, i) => ({ at: ago(140 - i * 0.3), text: `talking about the menu and the room and the music, note ${i}` }));
const HISTORY = [
  { at: ago(125), text: "Quick context for the pitch. We're bootstrapped, pre-seed, no outside funding yet. Jacqueline is leading logistics and partnerships." },
  { at: ago(150), text: "honestly it's all our own money right now, no investors at all" },
  ...FILLER,
  { at: ago(3), text: "We're partnering with Sequin AI for a November launch party." },
];
const NEWEST = Array.from({ length: 300 }, (_, i) => `newest text ${i}: some long message about the dinner plans, who is coming and the playlist`).join("\n");
{
  const lines = ["Bootstrapped, pre-seed, no outside funding yet", "Built by Ellis, with Jacqueline leading logistics and partnerships", "Our November launch party with Sequin AI"];
  const w = J.judgeWords(lines, NEWEST, HISTORY, NOW);
  const p = DC.claimsPrompt(lines, w, "", "", "");
  const b = box(p);
  check("history: a fact said 4 months ago is in the judge's input (with 30k of newer words in front of it)", b.includes("bootstrapped, pre-seed, no outside funding yet") && NEWEST.length > 20000, b.slice(0, 600));
  check("history: each excerpt carries its age", /\[said 4 months ago\] [^\n]*bootstrapped/i.test(b) && /\[said 3 days ago\] [^\n]*Sequin AI/.test(b), b.slice(0, 800));
  check("history: matched excerpts first, then their newest words", b.startsWith(J.EXCERPTS_TITLE) && b.indexOf(J.NEWEST_TITLE) > b.indexOf("bootstrapped") && b.indexOf("newest text 0:") > b.indexOf(J.NEWEST_TITLE), b.slice(0, 200));
  check("history: within the judge's 6,000, excerpts within their 3,000", w.length <= 6000 && w.indexOf(J.NEWEST_TITLE) <= J.JUDGE_WORDS.excerpts + J.EXCERPTS_TITLE.length + 4, { len: w.length, at: w.indexOf(J.NEWEST_TITLE) });
  check("history: unrelated filler isn't matched", !/note \d+/.test(b.slice(0, b.indexOf(J.NEWEST_TITLE))));
  const para = J.judgeWords(["Bootstrapped"], NEWEST, HISTORY, NOW);
  check('paraphrase: a line and words with no word in common are matched by topic ("Bootstrapped" and "no investors at all")', /\[said 5 months ago\] [^\n]*no investors at all/.test(para), para.slice(0, 500));
  check("paraphrase: how candidates are picked (names, numbers, topic words, changeable-topic clusters)", J.lineKeys("Bootstrapped").clusters.includes("funding stage or raise") && J.relevance("no investors at all", J.lineKeys("Bootstrapped")) >= J.JUDGE_WORDS.minScore);
  // A rare word finds its row among many on the same topic (Royce's real case: "bootstrapped" in one call among dozens about funding).
  const crowd = [{ at: ago(30), text: "honestly we're bootstrapped right now and that's fine" }, ...Array.from({ length: 30 }, (_, i) => ({ at: ago(20 - i * 0.1), text: `still thinking about funding and investors, maybe a grant, note ${i}` }))];
  const rareW = J.judgeWords(["Bootstrapped, no outside funding yet"], "hi", crowd, NOW);
  check("paraphrase: a topic word matches its other forms (\"bootstrapping\", \"unfunded\" for a \"Bootstrapped\" line)", J.lineKeys("Bootstrapped").clusters.includes("funding stage or raise") && J.relevance("kinda bootstrapping this, we're unfunded", J.lineKeys("Bootstrapped")) >= 3 && J.relevance("we're unfunded", J.lineKeys("Bootstrapped")) >= 3);
  check("history: a rare word finds its row among many rows on the same topic", rareW.includes("we're bootstrapped right now"), rareW.slice(0, 400));
  // 25 lines with weak matches first, the strong one last: it still gets in.
  const many = [...Array.from({ length: 24 }, (_, i) => `The menu at Fieldhouse for night ${i}`), "Bootstrapped, no outside funding yet"];
  const weak = Array.from({ length: 60 }, (_, i) => ({ at: ago(10 - i * 0.1), text: `the menu at Fieldhouse was great and the music was loud that night, number ${i} of the series of nights we have hosted there with friends, neighbours, guests and a few new faces who came along to see the place for the first time` }));
  const strong = J.judgeWords(many, "hi", [{ at: ago(40), text: "we're unfunded and kinda bootstrapping this whole thing ourselves for now, which honestly means every dollar we spend on the dinners comes out of our own pockets and we are careful with it, week to week, until we decide what comes next" }, ...weak], NOW);
  const call = { at: ago(12), text: "Uh, hey. Funding is something we talk about a lot, investors and all that, every single week with everyone we meet at every event in the city, and it never stops. But honestly, we're kind of bootstrapping it, so we don't have any investors. Anyway the event is next month and the venue is set." };
  const callW = J.judgeWords(["Bootstrapped, no outside funding yet"], "hi", [call, ...Array.from({ length: 30 }, (_, i) => ({ at: ago(11 - i * 0.1), text: `funding and investors talk again, note ${i}` }))], NOW);
  check("history: a long row shows the sentence with the line's rare word", /we're kind of bootstrapping it/.test(callW), callW.slice(0, 500));
  check("history: the strongest matches go first, whatever the line order", strong.includes("kinda bootstrapping this whole thing"), strong.slice(0, 300));
  check("history: with nothing matched, the judge reads their newest words as before", J.judgeWords(["Zzyzx"], "hello there", HISTORY, NOW) === "hello there");
  check("age: under 90 days in days, then months", J.ageOf(ago(3), NOW) === "said 3 days ago" && J.ageOf(ago(61), NOW) === "said 61 days ago" && J.ageOf(ago(125), NOW) === "said 4 months ago" && J.ageOf(ago(0.2), NOW) === "said today");
}

// ---------------------------------------------------------------- 3. the judge's rules for old facts and meaning
{
  const R0 = DC.EXCERPT_RULES;
  check("rules: no paraphrase instruction (Royce: dropped until a miss shows it's needed)", !/meaning, not wording|in other words is backed/.test(R0));
  check("rules: recent backs a line", /A line backed by something they said in the last 60 days, or in their newest words, is backed\./.test(R0) && J.OLD_FACT_DAYS === 60);
  check("rules: an old fact on something that changes is its own verdict, not a fail and not a pass", /more than 60 days ago, about something that changes \(funding stage or raise; job or title; company; city; relationship status; team size or headcount; revenue, customers or users; a partnership or deal in progress\), is neither backed nor invented: put it under "stale", with what may have changed\. It is not a fail\./.test(R0), R0);
  const w = J.judgeWords(["Bootstrapped"], "hi", HISTORY, NOW);
  const p = DC.claimsPrompt(["Bootstrapped"], w);
  check('rules: with excerpts, the judge gets them and the "stale" answer', p.includes(R0) && /"stale": \[\{"n": <line number>, "why": "<what may have changed since they said it, in a few words>"\}\]/.test(p) && p.indexOf(R0) < p.indexOf(J.EXCERPTS_TITLE));
  const q = DC.claimsPrompt(["Bootstrapped"], "hi");
  check("rules: without excerpts, the prompt is as it was", !q.includes(R0) && !q.includes('"stale"') && /Return ONLY JSON: \{"fails": \[\{"n": <line number>, "why": "<the hard fact they didn't give, in a few words>"\}\]\}\. Empty list when every line passes\./.test(q));
}

// ---------------------------------------------------------------- 4. the stale verdict: its own kind, end to end in code
{
  check("parse: stale entries come back marked old", JSON.stringify(DC.parseClaimFails('{"fails":[{"n":1,"why":"$2M"}],"stale":[{"n":2,"why":"the raise may have closed"}]}', 3)) === JSON.stringify([{ n: 1, why: "$2M" }, { n: 2, why: "the raise may have closed", old: true }]));
  check("parse: no stale list is fine; a bad one is no answer", DC.parseClaimFails('{"fails":[]}', 2)?.length === 0 && DC.parseClaimFails('{"fails":[],"stale":"x"}', 2) === null && DC.parseClaimFails('{"fails":[],"stale":[{"n":9}]}', 2) === null);
  check("parse: a line in both lists is a fail", JSON.stringify(DC.parseClaimFails('{"fails":[{"n":1,"why":"x"}],"stale":[{"n":1,"why":"y"}]}', 2)) === JSON.stringify([{ n: 1, why: "x" }]));
  const lines = ["Bootstrapped, pre-seed", "Partnering with Sequin AI", "Our November launch party"];
  const stub = async () => '{"fails":[],"stale":[{"n":1,"why":"funding stage said 4 months ago"}]}';
  const out = await DC.inventedLines(lines, "w", stub);
  check("stale: an old fact is neither a pass nor dropped: it comes back, marked old", JSON.stringify(out) === JSON.stringify([{ line: lines[0], why: "funding stage said 4 months ago", old: true }]), out);
  const recentStub = async () => '{"fails":[],"stale":[]}';
  check("recent: a line the judge backs passes (code adds nothing)", (await DC.inventedLines(lines, "w", recentStub))?.length === 0);
  check("log: an old fact is logged as its own kind (place and kind only)", R.OLD_FACT === "an old fact that may have changed" && /kind: f\.old \? R\.OLD_FACT : R\.judgedKind\(f\.why\)/.test(src("agent/deckTools.ts")));
  check("hand-off: the writer is told it's an old fact that may have changed (G turns this into its question)", /f\.old \? `an old fact that may have changed: \$\{f\.why\}` : f\.why/.test(src("agent/deckTools.ts")));
}

// ---------------------------------------------------------------- 5. goals by relevance to the deck's lines, the higher cap
{
  const goals = ["Plan out the event and take lead", "Seeking genuine friendships with dependable, intelligent people", "seeking to use Cue to drive a guest list", "Help lead the partnership strategy", "Seeking guidance on city adoption", "have Cue draft planning docs for branding", "secure pre-seed investment funding", "apply to an accelerator", "build a new company with Jacqueline", "attend a festival", "partnering with Lumen Labs for a November launch party"];
  const h = M.memberHeader({ firstName: "Ellis", lastName: "Hart", goals }, ["Our November launch party with Lumen Labs", "Partnering with Lumen Labs"]);
  const first = h.split("\n").find((l) => l.startsWith('  - "')) ?? "";
  check("goals: the goal that shares most with the deck's lines comes first", first.includes("partnering with Lumen Labs for a November launch party"), h);
  check("goals: all 11 fit the raised cap (12 goals, 1,600 characters)", (h.match(/^ {2}- "/gm) ?? []).length === 11 && h.length <= 1600, h.length);
  check("goals: without lines, stored order", M.memberHeader({ firstName: "Ellis", lastName: null, goals }).split("\n")[3].includes("Plan out the event"));
  check("goals: ties keep stored order", JSON.stringify(J.byRelevance(["a one", "b two"], ["zzz"])) === JSON.stringify(["a one", "b two"]));
  check("wired: the deck judge's header orders by its lines; its words are the matched ones", /const header = M\.memberHeader\(source\.member, lines\);/.test(src("agent/deckTools.ts")) && /const words = J\.judgeWords\(lines, source\.judged, source\.history \?\? \[\], new Date\(\)\);/.test(src("agent/deckTools.ts")) && /C\.inventedLines\(lines, words, undefined, self, source\.thread \?\? "", header, source\.read\)/.test(src("agent/deckTools.ts")));
}

// ---------------------------------------------------------------- 6. code still guards names, numbers and times (history never backs them)
{
  const WORDS = "We're launching in November. Fieldhouse is my company.";
  check("guard: a name only in their history is still refused by the headline check", /Sequoia/.test(headlineNameProblems("Backed by Sequoia", WORDS, "slide 2 headline", "ellis") ?? ""));
  const data = await deckDataFrom({ title: "Fieldhouse", subtitle: "A launch dinner", slides: [{ headline: "The launch", bullets: ["Doors at 9pm for the launch dinner"] }, { headline: "The dinner", bullets: ["We're launching in November"] }] } as any, null, new Map(), null, { theirWords: WORDS });
  const c = checkPage(data, { theirs: WORDS, read: "" });
  check("guard: a time they never gave is still refused in code", !c.ok && c.problems.some((p) => /9pm/.test(p)), c);
  const d = src("agent/deckTools.ts");
  check("guard: the code checks' words don't include the history", /const theirs = \[judged, deck\?\.lines \?\? ""\]/.test(d) && !/const theirs = [^\n]*history/.test(d));
}

// ---------------------------------------------------------------- 7. the history is theirs: their texts and calls, any age, their id only
{
  const del = src("services/documentDelivery.ts");
  const fn = del.slice(del.indexOf("export async function loadTheirHistory"), del.indexOf("export async function loadTheirHistory") + 1600);
  check("history: their user id only, their texts and their side of calls, no age limit, teammate texts out", /WHERE user_id = \$1 AND \(memory_type = 'call_transcript' OR \(memory_type = 'text_exchange' AND content LIKE 'User said:%' AND \$\{notToTeammate\(\)\}\)\)/.test(fn) && !/INTERVAL/.test(fn) && /LIMIT \$2`,\s*\[userId, HISTORY_LIMIT\]/.test(fn) && /text: theirLine\(\{ \.\.\.r, content \}\)/.test(fn), fn.slice(0, 400));
  check("history: reference images taken out, like their 14 days", /const history = history0\.map\(\(h\) => \(\{ at: h\.at, text: withoutReferenceText\(h\.text, refs\) \}\)\);/.test(src("agent/deckTools.ts")) && /loadTheirHistory\(ctx\.userId\)/.test(src("agent/deckTools.ts")));
}

// ---------------------------------------------------------------- 8. forgetting holds: a removed fact never reaches the judge
{
  const DD = await import("../../src/services/documentDelivery.js");
  const mem = [
    { memory_type: "text_exchange", content: "User said: We're bootstrapped, no outside funding yet", created_at: ago(40) },
    { memory_type: "text_exchange", content: "User said: honestly going through a divorce with Sam right now, it's rough", created_at: ago(50) },
  ];
  const removal = [{ field: "claim", old_value: "going through a divorce with Sam", new_value: null, item_ref: "claim:7", removed: "true" }];
  const fakeQ = (corr: unknown[] | "fail") => ({ query: async (sql: string) => { if (/profile_corrections/.test(sql)) { if (corr === "fail") throw new Error("down"); return { rows: corr }; } return { rows: mem }; } });
  const hist = await DD.loadTheirHistory("a1", fakeQ(removal) as any);
  const w = J.judgeWords(["Bootstrapped, no outside funding yet", "Going through a divorce with Sam"], "hi", hist, NOW);
  check("forget: a fact they removed never reaches the judge's input", !/divorce/i.test(w) && !hist.some((h) => /divorce/i.test(h.text)), { w: w.slice(0, 300), hist });
  check("forget: a fact they kept still does", /bootstrapped, no outside funding yet/.test(w), w.slice(0, 300));
  check("forget: with no removals, both are read", (await DD.loadTheirHistory("a1", fakeQ([]) as any)).length === 2);
  check("forget: when the removals can't be read, no history at all (fails closed)", (await DD.loadTheirHistory("a1", fakeQ("fail") as any)).length === 0);
  const del = src("services/documentDelivery.ts");
  check("forget: their 14 days go through the same guard", /const rows = await \(await import\("\.\/whatCoKnows\.js"\)\)\.guardRows\(userId, raw\);/.test(del));
  check("forget: the deck's 12-hour rows go through the same guard", /guardRows\(ctx\.userId, r\.rows\)/.test(src("agent/deckTools.ts")));
}

console.log(`judge words: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
