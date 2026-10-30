// Golden cases for the moments #310 was for (Royce, 2026-10-29: "No case covers a share, a 'you're dry', or a feedback turn"): good news,
// heavy news, "you're kind of dry", a mistake Cue made, the three-turn dry thread, a continuous-thought follow-up and a complete moment.
// One real reply turn each through cases/checkins.ts reply(), with the moment read wired the way the text route wires it (routes/
// sendblue.ts: replyFacts.moment and momentInstruction from the turn read), so the sharing and feedback guides are what's tested.
//
// Recorded 2026-10-30 ($0.87); see PENDING below for which are live.
//
// The situations come from the 10-29 before/after texting eval (~/cue-worktrees/notes/texting-before-after-1029.md), moved to San
// Francisco (the reply helper's member lives there). Invented members only. Code checks what code can (the hard rules run on every
// reply anyway: evals/lib/hardRules.ts); one short judge question asks what only a reader can tell. The quality run grades each reply
// on the full rubric (evals/lib/replyRubric.ts) three times and scores by majority.
import "../../lib/requireMeter.js";
import { result, type GoldenCase, type GoldenStatus } from "../types.js";
import { DAY, NONE, judge, observed, reply, type Kind, type Line, type Reply } from "./checkins.js";

// Recorded 2026-10-30. feedback-cue-mistake and complete-moment passed and are live. The other five are kept pending: their recorded
// replies fail the judge on real quality gaps (restating or paraphrasing the member's news back, asking for news they don't have yet,
// explaining Cue's own tone), the reply quality the context snapshot work is meant to fix, not the prompt wording.
const PENDING: GoldenStatus = { live: false, until: "the reply-quality work (context snapshot) passes them", why: "recorded 2026-10-30; the replies fail the judge on known quality gaps" };
const at = (iso: string) => new Date(iso);
const said = (lines: Line[]) => lines.map((l) => `${l.from === "member" ? "Member" : "Cue"}: "${l.text}"`).join(" / ");

// Slips no reply of any kind makes: a list, a dash, the old name.
function slips(text: string): string[] {
  const m: string[] = [];
  if (!text.trim() || /^ERROR /.test(text)) m.push(`no reply (${text.slice(0, 80)})`);
  if (/^\s*(?:[-*•]|\d+[.)])\s/m.test(text)) m.push("a list");
  if (/[—–]/.test(text)) m.push("an em or en dash");
  if (/\bCo\b|\bMo\b/.test(text)) m.push("calls itself Co (or names Mo)");
  return m;
}
// Explaining its own tone or how it works, which the feedback guide rules out (the 10-29 "I was phoning it in" template).
const EXPLAINS_ITSELF = /\b(?:phoning it in|i was being (?:short|brief|dry|flat)|my (?:tone|responses|replies|texts) (?:have|has|were|was|are|is)|i(?:'ll| will) (?:try to )?(?:be|do) better|i(?:'m| am) (?:working on|trying to be)|thanks for (?:the|that) (?:feedback|note|call ?out)|noted\b)/i;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const done = (misses: string[], r: Reply | Reply[]) => result(misses, (Array.isArray(r) ? r : [r]).map(observed).join("  ||  "));

// The dry thread, as it went on 10-28: two shares Cue answered flat, then "why so dry?".
const LENA_FACTS: [Kind, string][] = [["known", "Head of product at a fintech startup, leads a team of twelve; lives near the Marina."], ["known", "Lately: a long, heavy stretch at work; has said she's been running on empty."]];
const BIRTHDAY = "It's my birthday today. Spent the morning walking along the water with no phone and honestly I feel hopeful and recharged for the first time in months.";
const BREAK = "Also, I'm taking two weeks off starting Monday. I was burning out hard and finally told my team I need a real break.";
const FLAT_1 = "Happy birthday, Lena. Glad you're feeling recharged.";
const FLAT_2 = "That sounds like a good call. Enjoy the time off.";

export const CASES: GoldenCase[] = [
  {
    n: 60,
    id: "share-good-news",
    title: "Good news shared (a seed round closed after two years of no's): meets it with something of its own, never their words handed back",
    status: PENDING,
    from: "Royce, 2026-10-29 golden rework: no case covered a share; #310's SHARING_GUIDE (match the depth, contribute, don't mirror)",
    run: async () => {
      const message = "We closed the seed round this morning. Two years of no's and it finally happened.";
      const exchange: Line[] = [
        { at: at("2026-10-12T02:10:00Z"), from: "member", text: "Last partner meeting tomorrow at 10. If this one says no I'm going to take a long walk." },
        { at: at("2026-10-12T02:10:40Z"), from: "co", text: "Then walk either way. You've earned the air." },
      ];
      const r = await reply({ firstName: "Mara", now: DAY, exchange, searching: NONE, facts: [["known", "Founder of a materials startup making low-carbon concrete; has been raising a seed round for two years."]], message, kind: "share", withMoment: true });
      const misses = slips(r.text);
      if (/^\W*(?:so )?(?:you|we) (?:closed|finally)|^\W*two years of no/i.test(r.text)) misses.push("opens by handing their words back");
      const j = await judge(r.text, `The member told Cue: "${message}". Earlier: ${said(exchange)}.`, "Does the text meet the news with real warmth AND something of Cue's own (a specific reaction, an observation or a question that follows from it), WITHOUT opening by restating what they said, generic praise only, or inventing details they didn't give (investors' names, amounts, what happens next)? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 61,
    id: "share-heavy-news",
    title: "Heavy news (dad admitted to hospital) with a venue ask open: stays with them, no pivot to the dinner, no stock comfort",
    status: PENDING,
    from: "10-29 before/after eval, case 8: a toss-up between a presuming opener and a question he'd said he couldn't answer yet",
    run: async () => {
      const message = "My dad was admitted to the hospital last night. They think it's his heart. I'm sitting in the waiting room now, just waiting for the doctor.";
      const exchange: Line[] = [
        { at: at("2026-10-12T18:20:00Z"), from: "member", text: "Can you find me a quiet place for a dinner with two investors next week?" },
        { at: at("2026-10-12T18:20:40Z"), from: "co", text: "On it. I'll send a couple of options by tomorrow." },
      ];
      const r = await reply({ firstName: "Rafael", now: DAY, exchange, searching: { asks: ["a quiet place for a dinner with two investors next week"], goals: [], held: [] }, facts: [["known", "Founder of a logistics software company; his parents live in Sacramento."]], message, kind: "share", withMoment: true });
      const misses = slips(r.text);
      if (/\b(?:venue|dinner|investors?|restaurant|options?|reservation)\b/i.test(r.text)) misses.push("pivots to the dinner while he's in the waiting room");
      const j = await judge(r.text, `The member is in a hospital waiting room; their dad was admitted last night with a suspected heart problem and they're waiting for the doctor. They also have an open ask with Cue for an investor dinner venue.`, "Does the text stay with what they shared (meeting the feeling first, the way a friend who was paying attention would), WITHOUT pivoting to plans or the dinner, presuming how they feel, asking for news they just said they don't have yet, or offering stock comfort that fits anyone? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 62,
    id: "feedback-kinda-dry",
    title: "\"you're kind of dry, you know that?\" after a flat reply to a recital story: owns it in a few words, then gives the reply it deserved",
    status: PENDING,
    from: "10-29 before/after eval, case 6, and the FEEDBACK_GUIDE template it exposed (\"That deserved more than 'nice evening'\": quoting itself back)",
    run: async () => {
      const exchange: Line[] = [
        { at: at("2026-10-13T04:30:00Z"), from: "member", text: "My daughter had her first piano recital tonight. She was so nervous she almost walked off, then she sat down and played the whole thing without a single mistake" },
        { at: at("2026-10-13T04:30:30Z"), from: "co", text: "Sounds like a nice evening." },
      ];
      const message = "you're kind of dry, you know that?";
      const r = await reply({ firstName: "Callum", now: DAY, exchange, searching: NONE, facts: [["known", "Partner at a venture firm; has a seven-year-old daughter who started piano this year."]], message, kind: "feedback", withMoment: true });
      const misses = slips(r.text);
      if (EXPLAINS_ITSELF.test(r.text)) misses.push(`explains its tone or how it works ("${r.text.match(EXPLAINS_ITSELF)![0]}")`);
      if (!/recital|piano|walk(?:ed)? off|nervous|sat (?:back )?down|mistake|played/i.test(r.text)) misses.push("never gets back to the recital");
      const j = await judge(r.text, `Last night the member shared: "${exchange[0].text}". Cue answered only "Sounds like a nice evening." Now they texted "${message}".`, "Does the text own it in a few words at most and then give the reply the recital story deserved, with something of Cue's own about it (not their words handed back), WITHOUT explaining its tone or how it works, apologizing at length, or quoting its own earlier line? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 63,
    id: "feedback-cue-mistake",
    title: "\"that link you sent is dead\" (Cue's mistake): owns it plainly, never invents a replacement link or blames them",
    status: { live: true },
    from: "10-29 before/after eval, case 7: a bare \"I don't have a working one\" with no acknowledgment",
    run: async () => {
      const LINK = "https://emberclaystudio.example/workshops/wheel-intro";
      const exchange: Line[] = [
        { at: at("2026-10-12T17:02:00Z"), from: "member", text: "What was the ceramics studio you mentioned last week? I want to book the wheel class" },
        { at: at("2026-10-12T17:02:40Z"), from: "co", text: LINK },
        { at: at("2026-10-12T17:02:41Z"), from: "co", text: "Ember Clay Studio in the Mission. Their intro wheel class runs Saturday mornings, four weeks." },
      ];
      const message = "that link you sent is dead, it goes to a 404";
      const r = await reply({ firstName: "Marisol", now: DAY, exchange, searching: NONE, facts: [["did_before", `Cue sent them "Ember Clay Studio" (${LINK}) on Mon Oct 12 at 10:02am, with: "Ember Clay Studio in the Mission. Their intro wheel class runs Saturday mornings, four weeks."`]], message, kind: "feedback", withMoment: true });
      const misses = slips(r.text);
      if (/\b(?:on your end|your (?:browser|connection|phone)|try (?:it )?again|refresh)\b/i.test(r.text)) misses.push("puts it on them (their browser, try again)");
      const j = await judge(r.text, `Cue sent the member a link to Ember Clay Studio's wheel class page (${LINK}); the member says it goes to a 404. Cue has no other link on file for it.`, "Does the text own the bad link plainly in a few words AND say what Cue can do now (it may offer to find the right page), WITHOUT inventing a new link or details, blaming their browser, or explaining how Cue works? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 64,
    id: "dry-thread",
    title: "The three-turn dry thread (birthday, burnout break, \"Why are your responses so dry?\"): each share answered for real, then the feedback owned and shown",
    status: PENDING,
    turns: 3,
    from: "Royce's 10-28 complaint, rebuilt in the 10-29 before/after eval (cases 1-3): the earlier Cue turns are the flat ones that drew it",
    run: async () => {
      const t1 = at("2026-10-13T17:05:00Z");
      const t2 = at("2026-10-13T18:40:00Z");
      const thread1: Line[] = [];
      const thread2: Line[] = [{ at: t1, from: "member", text: BIRTHDAY }, { at: new Date(+t1 + 30_000), from: "co", text: FLAT_1 }];
      const thread3: Line[] = [...thread2, { at: t2, from: "member", text: BREAK }, { at: new Date(+t2 + 30_000), from: "co", text: FLAT_2 }];
      const base = { firstName: "Lena", now: DAY, searching: NONE, facts: LENA_FACTS, withMoment: true };
      const r1 = await reply({ ...base, exchange: thread1, message: BIRTHDAY, kind: "share" });
      const r2 = await reply({ ...base, exchange: thread2, message: BREAK, kind: "share" });
      const r3 = await reply({ ...base, exchange: thread3, message: "Why are your responses so dry?", kind: "feedback" });
      const misses = [...slips(r1.text).map((m) => `turn 1: ${m}`), ...slips(r2.text).map((m) => `turn 2: ${m}`), ...slips(r3.text).map((m) => `turn 3: ${m}`)];
      if (EXPLAINS_ITSELF.test(r3.text)) misses.push(`turn 3 explains its tone or how it works ("${r3.text.match(EXPLAINS_ITSELF)![0]}")`);
      if (!/birthday|water|phone|hopeful|recharged|two weeks|break|Monday|team|burn/i.test(r3.text)) misses.push("turn 3 never gets back to what she shared");
      const j = await judge(r3.text, `Today the member shared: "${BIRTHDAY}" Cue answered "${FLAT_1}". Then: "${BREAK}" Cue answered "${FLAT_2}". Now she asked "Why are your responses so dry?"`, "Does the text own it in a few words at most and then give the replies her birthday morning and her two weeks off deserved, with something of Cue's own (not her words recapped back to her), WITHOUT explaining its tone or how it works, quoting its own earlier lines, or inventing details she didn't give? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge (turn 3): ${j.reason}`);
      return done(misses, [r1, r2, r3]);
    },
  },
  {
    n: 65,
    id: "continuous-follow-up",
    title: "His answer to Cue's question (his grandfather's farm in Punjab): builds on it with something of its own, never paraphrases him back",
    status: PENDING,
    from: "10-29 before/after eval, case 10: the case #310's \"questions that build on each other\" was meant to win, and lost to a paraphrase",
    run: async () => {
      const exchange: Line[] = [
        { at: at("2026-10-13T20:40:00Z"), from: "member", text: "I've been thinking about leaving consulting to start something in food supply chains" },
        { at: at("2026-10-13T20:40:40Z"), from: "co", text: "What pulls you toward food supply chains specifically?" },
      ];
      const message = "My grandfather farmed in Punjab and I watched how little he got for what he grew. I've spent ten years making other companies efficient and I want it to matter for people like him.";
      const r = await reply({ firstName: "Omar", now: DAY, exchange, searching: NONE, facts: [["known", "Principal at a strategy consulting firm, ten years in operations work; weighing leaving consulting to start a company."]], message, kind: "share", withMoment: true });
      const misses = slips(r.text);
      const j = await judge(r.text, `Cue asked "What pulls you toward food supply chains specifically?" and the member answered: "${message}"`, "Does the text build on his answer with something of Cue's own (a real observation, a position, or a question that follows from what he just said and moves it forward), WITHOUT paraphrasing his answer back to him, and without filling in what he didn't say (his childhood, what his grandfather felt, which part of the chain)? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
  {
    n: 66,
    id: "complete-moment",
    title: "\"They approved the full budget. I'm going to sleep for twelve hours.\": a short warm close, one text, no question pulled out of him",
    status: { live: true },
    from: "10-29 before/after eval, case 12 (co-test sent two texts for it; #310 sent one): the SHARING_GUIDE's complete moment",
    run: async () => {
      const exchange: Line[] = [
        { at: at("2026-10-13T04:10:00Z"), from: "member", text: "Board meeting tomorrow at 9, pretty nervous about it" },
        { at: at("2026-10-13T04:10:30Z"), from: "co", text: "You know this material cold. Which slide are you least sure of?" },
        { at: at("2026-10-13T04:14:00Z"), from: "member", text: "The pricing one, but I reworked it tonight and I think it holds" },
        { at: at("2026-10-13T04:14:30Z"), from: "co", text: "Then it holds. Go get some sleep." },
      ];
      const message = "It went really well. They approved the full budget. I'm going to sleep for twelve hours.";
      const r = await reply({ firstName: "Julian", now: DAY, exchange, searching: NONE, facts: [["known", "CEO of a Series A healthcare software company; preparing a board meeting to approve next year's budget."]], message, kind: "share", withMoment: true });
      const misses = slips(r.text);
      if (r.text.includes("?")) misses.push("pulls a question out of a complete moment");
      if (words(r.text) > 40) misses.push(`${words(r.text)} words for a moment that's complete`);
      const j = await judge(r.text, `Last night the member was nervous about a board meeting at 9; now: "${message}"`, "Is the text a short, warm close that fits this exact moment (the budget, the pricing slide or the sleep), with no question and nothing asked of him? Answer yes only if all of that holds.");
      if (!j.yes) misses.push(`judge: ${j.reason}`);
      return done(misses, r);
    },
  },
];
