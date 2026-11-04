// Preserve what the member actually wants, and let corrections change only that want (Royce's spec, 2026-11-02, sections 1, 5, 6).
// Through the REAL capture write path (profileExtraction.ts persistIntentFrom -> persistCapturedIntent) on a fake store, with the
// read's answer as a fixture, and what-Cue-knows' real item list and removal. Zero tokens; invented people.
//   1. three free-form wants stay three asks, each with their own words, where it was said, and whether the words are theirs
//   2. a condition is kept only in their own words; one the read made up is dropped (nothing invented)
//   3. a condition said later about one want lands on that want only (text and call); a lift takes back only that condition
//   4. a want they dropped at their word isn't re-opened by the same conversation's earlier words (the call capture after the
//      call's own retire read), but a request said after the close re-opens it
//   5. a save worded by Cue (the saveAsk tool's "user: <Cue's sentence>") is never quoted as theirs
//   6. what-Cue-knows shows each want with their words and each condition as its own removable line; removing one changes that one
//   npx tsx evals/asks/wantWords.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- outside calls: a fixed answer for every model read, and embeddings
// far apart per text (so three different wants never look like one restated).
let seq = 0;
const vecs = new Map<string, number[]>();
const vec = (t: string) => {
  if (!vecs.has(t)) { const v = new Array(1536).fill(0); v[seq++ % 1536] = 1; vecs.set(t, v); }
  return vecs.get(t)!;
};
const text = (t: string) => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input));
  if (url.host === "api.openai.com") {
    const b = JSON.parse(init?.body ?? "{}");
    const inputs = Array.isArray(b.input) ? b.input : [b.input ?? ""];
    return new Response(JSON.stringify({ object: "list", data: inputs.map((t: string, index: number) => ({ object: "embedding", index, embedding: vec(String(t)) })), usage: { prompt_tokens: 0, total_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.host === "api.anthropic.com") return text('{"kind": "ask", "same": false}');
  throw new Error(`wantWords: refused outside call to ${url.host}`);
}) as typeof fetch;

// The clients read fetch when they're made: the fake goes in before any source module loads.
const { default: pool } = await import("../../src/db/db.js");
const P = await import("../../src/services/profileExtraction.js");
const WC = await import("../../src/services/wantCriteria.js");
const K = await import("../../src/services/whatCoKnows.js");
const TL = await import("../../src/services/turnLearning.js");
(await import("../../src/services/embeddings.js")).setEmbeddingsClientForTests({ embeddings: { create: async ({ input }: any) => ({ data: (Array.isArray(input) ? input : [input]).map((t: string, index: number) => ({ index, embedding: vec(String(t)) })) }) } } as any);

// ---------------------------------------------------------------- the fake store: the statements the capture path runs
const U = "member-jordan";
type Row = Record<string, any>;
const w = { intent: [] as Row[], asks: [] as Row[], decisions: [] as Row[] };
const reset = () => { w.intent = []; w.asks = []; w.decisions = []; };
const q = async (raw: string, a: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
  const sql = raw.replace(/\s+/g, " ").trim();
  const r = (rows: any[], n = rows.length) => ({ rows, rowCount: n });
  if (/^INSERT INTO harness_decisions/.test(sql)) { w.decisions.push({ decision: a[1], action: a[4], proposal: a[5] }); return r([]); }
  if (/^SELECT intent FROM co_profiles WHERE user_id = \$1$/.test(sql)) return r([{ intent: JSON.parse(JSON.stringify(w.intent)) }]);
  if (/^UPDATE co_profiles SET intent = \$2::jsonb/.test(sql)) { w.intent = JSON.parse(a[1]); return r([], 1); }
  if (/^INSERT INTO co_profiles \(user_id, intent, updated_at\)/.test(sql)) { w.intent = [...w.intent, ...JSON.parse(a[1])]; return r([], 1); }
  if (/^SELECT ask_id, ask_text FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL$/.test(sql)) return r(w.asks.filter((x) => !x.resolved_at));
  if (/^SELECT ask_id, ask_text, intent FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NULL/.test(sql)) return r(w.asks.filter((x) => !x.resolved_at).map((x) => ({ ...x, intent: null })));
  if (/^SELECT ask_id, ask_text, closed_reason, closed_evidence FROM ask_checkins WHERE user_id = \$1 AND resolved_at IS NOT NULL/.test(sql)) return r(w.asks.filter((x) => x.resolved_at));
  if (/^INSERT INTO ask_checkins \(user_id, ask_id, ask_text, expires_at, kind/.test(sql)) {
    if (w.asks.some((x) => !x.resolved_at && x.ask_text.toLowerCase().trim() === String(a[2]).toLowerCase().trim())) return r([], 0);
    w.asks.push({ ask_id: a[1], ask_text: a[2], resolved_at: null, closed_reason: null, closed_evidence: null }); return r([], 1);
  }
  if (/^INSERT INTO co_memories/.test(sql)) return r([{ id: "m1" }], 1);
  return r([], 0);
};
(pool as any).query = q;
(pool as any).connect = async () => ({ query: q, release: () => {} });
const settle = () => new Promise((res) => setTimeout(res, 40));
const entries = () => w.intent.filter((e) => e.kind === "ask" && e.status === "active");
const entry = (t: string) => w.intent.find((e) => e.text === t);

const A_COF = "Looking for a technical cofounder who has built consumer products before";
const A_OUT = "Wants to meet people outside tech";
const A_ROOM = "Wants a room where they can drop their guard";
const SAID_COF = "I'm looking for a technical cofounder who's built consumer before";
const SAID_OUT = "honestly I want to meet people outside tech";
const SAID_ROOM = "I want a room where I can drop my guard";
const callTranscript = [`user: ${SAID_COF}.`, "assistant: Got it, someone technical who has shipped consumer.", `user: And ${SAID_OUT}, everyone I know is in tech.`, "assistant: That makes sense.", `user: ${SAID_ROOM}, somewhere small.`, "assistant: I'll keep that in mind."].join("\n");

// ================================================================ 1-2. three wants, their words, nothing invented
{
  reset();
  const answer = {
    asks: [
      { text: A_COF, type: "seeking", quote: SAID_COF, criteria: [{ text: "has built a consumer product", strength: "must", quote: "who's built consumer before" }, { text: "based in SF", strength: "must", quote: "must be in SF" }] },
      { text: A_OUT, type: "seeking", quote: SAID_OUT, criteria: [] },
      { text: A_ROOM, type: "seeking", quote: SAID_ROOM, criteria: [{ text: "under 20 people", strength: "prefer", quote: "a small room under 20" }] },
    ],
    concrete_preferences: [], wants: [], availability: null,
  };
  await P.persistIntentFrom(U, answer as any, callTranscript, "whole_transcript", null, { via: "call" });
  await settle();
  const e = entries();
  check("before: one call, three different wants; after: three asks, three check-in rows, never one 'networking' ask", e.length === 3 && w.asks.length === 3 && [A_COF, A_OUT, A_ROOM].every((t) => !!entry(t)), e.map((x) => x.text));
  check("each keeps their own words, checked against their lines, and where it was said", entry(A_COF)?.quote === SAID_COF && entry(A_OUT)?.quote === SAID_OUT && entry(A_ROOM)?.quote === SAID_ROOM && e.every((x) => x.provenance === "stated" && x.via === "call"), e.map((x) => [x.quote, x.provenance, x.via]));
  check("a condition said outright is kept on its own want, in their words", JSON.stringify(entry(A_COF)?.criteria?.map((c: any) => [c.text, c.strength, c.quote])) === JSON.stringify([["has built a consumer product", "must", "who's built consumer before"]]), entry(A_COF)?.criteria);
  check("a condition the read made up (no quote of theirs: 'must be in SF', 'under 20') is dropped: no invented requirement", !entry(A_COF)?.criteria?.some((c: any) => /SF/.test(c.text)) && !entry(A_ROOM)?.criteria, [entry(A_COF)?.criteria, entry(A_ROOM)?.criteria]);
  const rej = w.decisions.find((d) => d.action === "want_criteria_rejected");
  check("the condition the read made up is logged as rejected, with its reason and none of their words", !!rej && /no_quote_of_theirs/.test(JSON.stringify(rej.proposal)) && !/SF|under 20/.test(JSON.stringify(rej)), rej);
  check("an emotional want with no conditions stays a want, not a task with made-up details", entry(A_ROOM)?.kind === "ask" && !entry(A_ROOM)?.criteria);
  // Pure grounding, the same rule both reads use.
  check("groundWant: a quote that isn't in their lines is never kept as theirs", WC.groundWant("I need a CTO by Friday", "I'm looking for a cofounder").provenance === "inferred" && WC.groundWant("looking for a cofounder", "I'm looking for a cofounder").provenance === "stated");
  // Review of #378 item 2: one word, a paraphrase, an exclusion with no words that exclude, or a preference stored as a must.
  const said = "I'm meeting investors Thursday. Not investors for the cofounder though. I'd rather someone with taste than a big title.";
  check("groundCriteria: 'investors' lifted from 'I'm meeting investors Thursday' never grounds as an exclusion", WC.groundCriteria([{ text: "no investors at all", strength: "must_not", quote: "investors" }, { text: "no investors at all", strength: "must_not", quote: "meeting investors Thursday" }], said).length === 0);
  check("groundCriteria: 'not investors' never grounds as 'no one in finance' (Cue's reading off their words)", WC.groundCriteria([{ text: "no one in finance", strength: "must_not", quote: "Not investors" }], said).length === 0 && WC.groundCriteria([{ text: "investors", strength: "must_not", quote: "Not investors" }], said).length === 1);
  // Round 2 of the review: short words (SF, VCs, NYC, AI, B2B) carry a reading; a synonym still doesn't.
  const said2 = "I would rather someone in SF. I don't want VCs. Also no one from big tech.";
  const sf = WC.groundCriteria([{ text: "in SF", strength: "prefer", quote: "would rather someone in SF" }], said2);
  check("'would rather someone in SF' read as 'in SF' keeps a preference", sf.length === 1 && sf[0].strength === "prefer", sf);
  const vcs = WC.groundCriteria([{ text: "not VCs", strength: "must_not", quote: "I don't want VCs" }], said2);
  check("'don't want VCs' read as 'not VCs' keeps an exclusion", vcs.length === 1 && vcs[0].strength === "must_not", vcs);
  const bt = WC.groundCriteria([{ text: "no one from big tech", strength: "must_not", quote: "no one from big tech" }], said2);
  check("'no one from big tech' (the reading all in their words) keeps an exclusion", bt.length === 1 && bt[0].strength === "must_not", bt);
  check("a synonym is still off their words: 'no FAANG' from 'big tech' is dropped", WC.groundCriteria([{ text: "no FAANG", strength: "must_not", quote: "no one from big tech" }], said2).length === 0);
  check("short words and places count: NYC, AI, B2B, LA, Austin", WC.readingOnTheirWords("NYC", "founders in NYC please") && WC.readingOnTheirWords("AI", "someone doing AI") && WC.readingOnTheirWords("B2B", "not B2B people") && WC.readingOnTheirWords("in LA", "would rather someone in LA") && WC.readingOnTheirWords("based in Austin", "has to be in Austin"));
  // Round 3: two words of the reading in their quote (all when it has fewer), a longer list of words that never count, and a short
  // word must be the same word.
  check("'good engineer' never grounds from 'good energy'", !WC.readingOnTheirWords("good engineer", "someone with good energy") && WC.groundCriteria([{ text: "good engineer", strength: "prefer", quote: "I'd rather someone with good energy" }], "I'd rather someone with good energy").length === 0);
  check("a capitalized word only counts as itself: 'Good engineer' and 'Founder' still don't ground", !WC.readingOnTheirWords("Good engineer", "someone with good energy") && !WC.readingOnTheirWords("Founder", "I found my people"));
  check("'founder' never grounds from 'found'", !WC.readingOnTheirWords("founder", "I found my people") && !WC.readingOnTheirWords("a founder", "not until I found the space"));
  check("a reading resting on one word of three is off their words; two of three is on them", !WC.readingOnTheirWords("strong product taste", "taste matters more than seniority") && WC.readingOnTheirWords("has built a consumer product", "who's built consumer before"));
  check("stems still match for long words: engineer/engineering, investor/investors", WC.readingOnTheirWords("engineering", "an engineer") && WC.readingOnTheirWords("investor", "no investors"));
  const whys: string[] = [];
  WC.groundCriteria([{ text: "no one in finance", strength: "must_not", quote: "Not investors" }, { text: "x", strength: "must_not", quote: "investors" }, { text: "investors", strength: "must_not", quote: "meeting investors Thursday" }], said, undefined, (w) => whys.push(w));
  check("each rejection gives its reason (never their words)", JSON.stringify(whys) === JSON.stringify(["reading_off_their_words", "quote_too_short", "exclusion_without_negation"]), whys);
  const pr = WC.groundCriteria([{ text: "taste over a big title", strength: "must", quote: "I'd rather someone with taste than a big title" }], said);
  check("groundCriteria: words of preference are stored as a preference, never a must", pr.length === 1 && pr[0].strength === "prefer", pr);
  check("the scorer is shown their words, with Cue's reading as context only", /"I'm not looking for investors right now" \(reading: investors\)/.test(WC.conditionsPromptBlock([{ label: "W1", text: "x", criteria: [{ text: "investors", strength: "must_not", quote: "I'm not looking for investors right now", at: "" }] }])) && /judge their words/.test(WC.conditionsPromptBlock([{ label: "W1", text: "x", criteria: [{ text: "investors", strength: "must_not", quote: "I'm not looking for investors right now", at: "" }] }])));
  check("groundCriteria: bad strength, no quote, or Cue's words are all dropped", WC.groundCriteria([{ text: "x", strength: "urgent", quote: "looking" }, { text: "y", strength: "must" }, { text: "z", strength: "must", quote: "Got it, someone technical" }], WC.theirWordsIn(callTranscript)).length === 0);
}

// ================================================================ 3. a later condition lands on one want only (text turn and call)
{
  // The numbered items as the text turn's read shows them (goalJourney.openErrandsAndGoals order: the ask rows).
  const items = w.asks.map((x) => ({ id: x.ask_id, text: x.ask_text, kind: "ask" as const }));
  const iCof = items.findIndex((x) => x.text === A_COF);
  const iOut = items.findIndex((x) => x.text === A_OUT);
  const MSG = "for the cofounder thing, I'm not looking for investors right now, and taste matters more than seniority";
  const before = JSON.stringify(entry(A_OUT));
  await P.persistIntentFrom(U, { asks: [], concrete_preferences: [], wants: [], availability: null, criteria_for: [
    { index: iCof, text: "investors", strength: "must_not", quote: "I'm not looking for investors right now" },
    { index: iCof, text: "taste over seniority", strength: "prefer", quote: "taste matters more than seniority" },
    { index: iOut, text: "no founders", strength: "must_not", quote: "no founders please" },
  ] } as any, `user: ${MSG}\nassistant: Noted.`, "last_user_message", MSG, { via: "text", openItems: items });
  const c = entry(A_COF)?.criteria ?? [];
  check("'not investors right now' and the taste preference land on the cofounder want, with their words", c.some((x: any) => x.text === "investors" && x.strength === "must_not") && c.some((x: any) => x.strength === "prefer" && x.quote === "taste matters more than seniority"), c);
  check("... the other want is untouched (a condition belongs to its want; one they didn't say is never added)", JSON.stringify(entry(A_OUT)) === before, [before, entry(A_OUT)]);
  const LIFT = "actually investors are fine now";
  await P.persistIntentFrom(U, { asks: [], concrete_preferences: [], wants: [], availability: null, criteria_for: [{ index: iCof, text: "investors", strength: "lifted", quote: LIFT }] } as any, `user: ${LIFT}`, "last_user_message", LIFT, { via: "text", openItems: items });
  const c2 = entry(A_COF)?.criteria ?? [];
  check("a lift takes back only that condition; the requirement and the preference stay", !c2.some((x: any) => x.text === "investors") && c2.some((x: any) => x.strength === "must") && c2.some((x: any) => x.strength === "prefer"), c2);
  check("the turn prompt and the call prompt both carry the same want-words rule, criteria_for and the on-file conditions", (() => {
    const t = TL.turnLearningPrompt({ transcript: "user: hi", message: "hi", today: "2026-11-03", onFile: null, openAsks: items, styleNotes: [], coSaidBefore: null, intent: w.intent });
    const k = P.captureIntentPrompt(callTranscript, "whole_transcript", { items, intent: w.intent });
    return [t, k].every((p) => p.includes(WC.WANT_WORDS_RULE) && p.includes(WC.CRITERIA_FOR_RULE) && /Conditions already on file/.test(p) && /would rather: "taste over seniority"/.test(p));
  })());
  check("the call prompt: an ask they dropped later in the same call is not captured (their word), anything else still is", /is not captured/.test(P.captureIntentPrompt(callTranscript, "whole_transcript")) && /What they happened to say LAST never cancels an ask/.test(P.captureIntentPrompt(callTranscript, "whole_transcript")));
  check("the call path loads the numbered list for the read and hands it to the write (call parity with the text turn)", /const onFile = await loadOpenForCriteria\(user_id\)/.test(src("services/profileExtraction.ts")) && /openItems: onFile\?\.items/.test(src("services/profileExtraction.ts")) && /openItems: openAsks/.test(src("services/turnLearning.ts")));
}

// ================================================================ 4. a dropped want isn't re-opened by the words before the drop
{
  const cof = w.asks.find((x) => x.ask_text === A_COF)!;
  const DROP = "I'm not pursuing the cofounder search anymore";
  Object.assign(cof, { resolved_at: new Date(), closed_reason: "member", closed_evidence: DROP });
  w.intent = w.intent.map((e) => (e.text === A_COF ? { ...e, status: "resolved" } : e));
  const call = `user: ${SAID_COF}.\nassistant: Got it.\nuser: Actually, ${DROP}.\nassistant: Understood.`;
  await P.persistIntentFrom(U, { asks: [{ text: A_COF, type: "seeking", quote: SAID_COF }], concrete_preferences: [], wants: [], availability: null } as any, call, "whole_transcript", null, { via: "call" });
  check("call: the capture after the call's own retire read doesn't re-open the want they dropped later in that call", entries().every((e) => e.text !== A_COF) && w.asks.filter((x) => x.ask_text === A_COF && !x.resolved_at).length === 0 && w.decisions.some((d) => d.action === "closed_want_held"), { open: entries().map((e) => e.text), decisions: w.decisions.map((d) => d.action) });
  check("pure, call: closing words after the want's words hold; the want said after the close, or a close not in this call, don't", P.heldByClose(call, SAID_COF, DROP) && !P.heldByClose(`user: ${DROP}\nassistant: ok\nuser: ${SAID_COF} again after all`, `${SAID_COF} again after all`, DROP) && !P.heldByClose(`user: ${SAID_COF}`, SAID_COF, DROP));
  check("pure, call: no grounded words for the want, held only when the close is in this same call", P.heldByClose(call, null, DROP) && !P.heldByClose(`user: ${SAID_COF}`, null, DROP));
  // Review of #378 item 1: on a text turn only the newest message decides. "drop the cofounder search" earlier, then a new request whose
  // quote didn't ground (a paraphrase): it goes. The message that drops it is held, quoted or not.
  const AGAIN = "ok actually I want a technical cofounder again";
  check("pure, text: a newer message without the closing words is never held, even with no grounded quote", !P.heldByClose(`user: ${DROP}\nassistant: ok\nuser: ${AGAIN}`, null, DROP, AGAIN) && !P.heldByClose(`user: ${AGAIN}`, AGAIN, DROP, AGAIN));
  check("pure, text: the message that holds the closing words is held", P.heldByClose(`user: ${DROP}, found one`, null, DROP, `${DROP}, found one`));
  check("the retire read (text turn and call alike) keeps their closing words on the ask it closes, which is what the hold reads", /closed_evidence = COALESCE\(closed_evidence, \(\$3::text\[\]\)\[array_position\(\$2::text\[\], ask_id\)\]\)/.test(src("services/profileExtraction.ts")) && /asks\.map\(\(id\) => \(quote\(id\) \?\? ""\)\.slice\(0, 300\) \|\| null\)/.test(src("services/profileExtraction.ts")));
  // The review's case end to end: an earlier drop, then a new request on a text turn whose quote is Cue's paraphrase (doesn't ground).
  const before = w.asks.filter((x) => x.ask_text === A_COF && !x.resolved_at).length;
  await P.persistIntentFrom(U, { asks: [{ text: A_COF, type: "seeking", quote: "Wants a technical cofounder again" }], concrete_preferences: [], wants: [], availability: null } as any, `user: ${DROP}\nassistant: Understood.\nuser: ${AGAIN}`, "last_user_message", AGAIN, { via: "text" });
  check("text: after an earlier drop, 'ok actually I want a technical cofounder again' re-opens it though its quote didn't ground", before === 0 && w.asks.some((x) => x.ask_text === A_COF && !x.resolved_at) && entries().some((e) => e.text === A_COF && e.provenance === "inferred"), { before, open: entries().map((e) => [e.text, e.provenance]) });
  // Close it again for the next case.
  for (const x of w.asks.filter((x) => x.ask_text === A_COF && !x.resolved_at)) Object.assign(x, { resolved_at: new Date(), closed_reason: "member", closed_evidence: DROP });
  w.intent = w.intent.map((e) => (e.text === A_COF ? { ...e, status: "resolved" } : e));
  const BACK = "ok I'm back on it, I'm looking for a technical cofounder who's built consumer before";
  await P.persistIntentFrom(U, { asks: [{ text: A_COF, type: "seeking", quote: BACK }], concrete_preferences: [], wants: [], availability: null } as any, `user: ${BACK}`, "last_user_message", BACK, { via: "text" });
  check("text: a request said after the close (their drop isn't in it) re-opens it as a new want", entries().some((e) => e.text === A_COF && e.quote === BACK) && w.asks.some((x) => x.ask_text === A_COF && !x.resolved_at));
}

// ================================================================ 5. Cue's wording is never their words
{
  reset();
  await P.persistIntentFrom(U, { asks: [{ text: "Find founder dinners in SF", type: "seeking", quote: "Find founder dinners in SF" }], concrete_preferences: [], wants: [], availability: null } as any, "user: Find founder dinners in SF", "last_user_message", null, { ownWords: null });
  check("a save worded by Cue (the saveAsk tool) is kept as Cue's read: inferred, no quote", entries()[0]?.provenance === "inferred" && entries()[0]?.quote === null, entries()[0]);
  check("the text and call save tools pass no words of theirs, or only the words they asked in", /captureIntentForTurn\(ctx\.userId, `user: \$\{what\}`, \{ timeoutMs: 6000, ownWords: null, via: ctx\.onCall \? "call" : "text" \}\)/.test(src("agent/conversationTools.ts")) && /ownWords: p\.asked/.test(src("harness/callGrounding.ts")));
}

// ================================================================ 6. what-Cue-knows: visible, in their words, removable one by one
{
  const intent = [
    { id: "a1", kind: "ask", status: "active", text: A_COF, quote: SAID_COF, provenance: "stated", criteria: [{ text: "investors", strength: "must_not", quote: "I'm not looking for investors right now", at: "x" }, { text: "has built a consumer product", strength: "must", quote: "who's built consumer before", at: "x" }] },
    { id: "a2", kind: "ask", status: "active", text: A_OUT, quote: null, provenance: "inferred" },
  ];
  const raw: any = { profile: { city: "Oakland", long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent }, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [{ id: "a1", text: A_COF }, { id: "a2", text: A_OUT }], files: [] };
  const items = K.knownItems(raw);
  const ask1 = items.find((i) => i.ref === "ask:a1");
  const conds = items.filter((i) => i.source === "cond");
  check("each want shows with their own words when Cue has them (none shown as theirs when it's Cue's read)", ask1?.theirWords === SAID_COF && items.find((i) => i.ref === "ask:a2")?.theirWords === null);
  check("each condition is its own line, in their words, under its want, removal only", conds.length === 2 && conds.every((c) => c.text.startsWith(`for "${A_COF}", you said: "`) && !c.canCorrect) && conds.some((c) => c.theirWords === "I'm not looking for investors right now"), conds);
  let saved: any = null;
  const db = { query: async (sql: string, args: any[] = []) => { if (/UPDATE co_profiles SET intent/.test(sql)) { saved = JSON.parse(args[1]); return { rows: [], rowCount: 1 }; } return { rows: [], rowCount: 0 }; } };
  const inv = conds.find((c) => /investors/.test(c.text))!;
  const out: any = await K.applyOne(db, U, raw, inv, "remove", null, "drop the investor thing");
  const a1 = saved?.find((e: any) => e.id === "a1");
  check("removing 'not investors' takes only that condition off that want; the want, its other condition and the other want stay", out?.source === "cond" && a1?.status === "active" && a1.criteria.length === 1 && a1.criteria[0].strength === "must" && JSON.stringify(saved.find((e: any) => e.id === "a2")) === JSON.stringify(intent[1]), { out, saved });
  check("logged under its own plain kind", K.logKind(inv.ref) === "a condition they put on one of their wants");
}

// ================================================================ 7. conditions said with a time limit expire (Royce, 2026-11-03)
{
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const timed = (d: number) => ({ text: "investors", strength: "must_not", quote: "I'm not looking for investors right now", at: ago(d) });
  check("a time-worded condition expires 60 days after it was last said, not before", WC.conditionExpired(timed(61), now) && !WC.conditionExpired(timed(59), now));
  check("every time word counts: for now, at the moment, this month, this year, currently, these days", ["for now", "at the moment", "this month", "this year", "currently", "these days"].every((t) => WC.conditionExpired({ quote: `no investors ${t}`, at: ago(61) }, now)));
  check("a condition with no time words lasts as long as the want", !WC.conditionExpired({ quote: "who's built consumer before", at: ago(400) }, now));
  check("no readable time it was said: no basis to expire", !WC.conditionExpired({ quote: "not investors right now", at: "x" }, now));
  const entry = { id: "a1", kind: "ask", status: "active", text: A_COF, criteria: [timed(61), { text: "has built a consumer product", strength: "must", quote: "who's built consumer before", at: ago(400) }] };
  check("an expired one stops applying at once (criteriaOf), the enduring one stays", JSON.stringify(WC.criteriaOf(entry, now).map((c) => c.strength)) === JSON.stringify(["must"]));
  const again = WC.mergeCriteria([timed(59)], [{ ...timed(0), text: "no investors" }]);
  check("saying it again starts its clock over (the same words replace the older one)", again.length === 1 && !WC.conditionExpired(again[0], new Date(now.getTime() + 59 * 86_400_000)) && again[0].text === "no investors", again);
  const raw: any = { profile: { city: null, long_term_direction: null, availability_pattern: null, goals: [], life_chapters: [], blockers: [], activity_preferences: [], avoid: [], intent: [entry] }, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [{ id: "a1", text: A_COF }], files: [] };
  const conds = K.knownItems(raw).filter((i) => i.source === "cond");
  check("an expired condition drops from what-Cue-knows; the enduring one still shows", conds.length === 1 && /who's built consumer before/.test(conds[0].text), conds);
  // The daily prune (askExpiry.ts expireTimeBoundCriteria, run in the expiry job) takes it off the record and logs ids and counts only.
  reset();
  w.intent = [entry, { id: "a2", kind: "ask", status: "active", text: A_OUT, criteria: [{ text: "no founders", strength: "must_not", quote: "no founders for now", at: ago(10) }] }];
  const prof = { user_id: U, intent: JSON.parse(JSON.stringify(w.intent)) };
  const orig = (pool as any).query;
  (pool as any).query = async (sql: string, a: any[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT user_id, intent FROM co_profiles WHERE intent::text LIKE/.test(flat)) return { rows: [prof], rowCount: 1 };
    if (/^UPDATE co_profiles SET intent = \$2::jsonb, updated_at = NOW\(\) WHERE user_id = \$1 AND intent = \$3::jsonb/.test(flat)) { w.intent = JSON.parse(a[1]); return { rows: [], rowCount: 1 }; }
    return orig(sql, a);
  };
  const n = await (await import("../../src/services/askExpiry.js")).expireTimeBoundCriteria(now);
  (pool as any).query = orig;
  const log = w.decisions.find((d) => d.decision === "want_criteria.expired");
  check("the prune takes off only the expired one, on its own want; the other want's recent time-worded one stays", n === 1 && w.intent[0].criteria.length === 1 && w.intent[0].criteria[0].strength === "must" && w.intent[1].criteria.length === 1, w.intent.map((e: any) => e.criteria));
  check("the expiry is logged with want ids and counts, none of their words", !!log && JSON.stringify(typeof log.proposal === "string" ? JSON.parse(log.proposal) : log.proposal) === JSON.stringify({ wants: [{ id: "a1", n: 1 }] }) && !/investors|right now/.test(JSON.stringify(log)), log);
  check("the expiry runs in the existing expiry job", /await expireTimeBoundCriteria\(\)/.test(src("services/askExpiry.ts")) && /expireStaleAsks\(\)/.test(src("jobs/index.ts")));
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
