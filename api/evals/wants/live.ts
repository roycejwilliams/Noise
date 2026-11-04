// LAYER 2 (live, metered): do the real reads keep a member's wants and conditions in their own words, and does the real scorer
// read conditions honestly? (#378 follow-up, approved by Royce 2026-11-03, about $1-2.) Fictional members only; nothing is written
// or sent: the reads and the scorer are called directly and graded with the same code the write path uses (wantCriteria.ts).
//
//   1. capture, 20 cases: the call read (captureIntentPrompt, on the model production pins) and the text read (turnLearningPrompt).
//      Per want: do quotes ground; are conditions said outright kept with the right strength; is anything invented; are time words
//      read as limiting the condition only when they do.
//   2. scoring, 10 cases: the network scorer's prompt (buildStatedAskPrompt with the want's conditions) on fixture candidates. Per
//      condition and candidate: is yes / no / unknown right, and is "yes" ever given without evidence on the line.
//
//   npm run eval:live -- evals/wants/live.ts          (needs ANTHROPIC_API_KEY; EVAL_REAL_MODELS=1 runs production's models)
import "../lib/requireMeter.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
const P = await import("../../src/services/profileExtraction.js");
const TL = await import("../../src/services/turnLearning.js");
const WC = await import("../../src/services/wantCriteria.js");
const M = await import("../../src/services/matching.js");
const { MODELS } = await import("../../src/models.js");
const { PROFILE_JUDGMENT_MODEL } = await import("../../src/harness/profileWrite.js");
const { judgeJson, SCORE_SCHEMA } = await import("../../src/services/structuredJudge.js");
const { parseModelJson } = await import("../../src/services/modelJson.js");

type Strength = "must" | "must_not" | "prefer";
type Want = { strengths: Strength[]; re: RegExp; timed?: boolean };
type CaptureCase = { id: string; via: "call" | "text"; lines: string[]; openItems?: { id: string; text: string; kind: "ask" }[]; want: Want[]; allow?: RegExp[] };

const call = (id: string, said: string[], want: Want[], allow?: RegExp[]): CaptureCase => ({ id, via: "call", lines: said.flatMap((s, i) => [`user: ${s}`, `assistant: ${["Got it.", "That makes sense.", "Okay, noted."][i % 3]}`]), want, allow });
const text = (id: string, msg: string, want: Want[], openItems?: CaptureCase["openItems"], allow?: RegExp[]) => ({ id, via: "text" as const, lines: [`user: ${msg}`], openItems, want, allow });
const COF = [{ id: "a-cof", text: "Looking for a technical cofounder", kind: "ask" as const }];

const CAPTURE: CaptureCase[] = [
  call("c1-cofounder", ["I'm looking for a technical cofounder who's built consumer before.", "And I'm not looking for investors right now."], [{ strengths: ["must"], re: /built consumer/i }, { strengths: ["must_not"], re: /investors/i, timed: true }]),
  call("c2-three-wants", ["I'm looking for a technical cofounder who's built consumer before.", "Honestly I also want to meet people outside tech.", "And I want a room where I can drop my guard."], [{ strengths: ["must"], re: /built consumer/i }]),
  call("c3-ideally", ["I'd love to meet product designers, ideally someone who's worked at an early startup."], [{ strengths: ["prefer"], re: /startup/i }]),
  call("c4-emotional", ["I've been feeling pretty isolated since the move.", "I just want to meet some good people."], []),
  call("c5-no-crypto", ["Looking for angel investors for my climate startup, but no crypto people please."], [{ strengths: ["must_not"], re: /crypto/i }]),
  call("c6-currently-building", ["I want to meet someone currently building in AI."], [], [/building in AI/i]),
  call("c7-for-now-recruiters", ["For now I don't want to meet any recruiters.", "What I'm after is a mentor in fintech."], [{ strengths: ["must_not"], re: /recruiters/i, timed: true }]),
  call("c8-not-competitive", ["Looking for a running group in Oakland, nothing too competitive."], [{ strengths: ["must_not", "prefer"], re: /competitive/i }]),
  call("c9-woman-founder", ["I want to talk to a founder about fundraising, has to be a woman who's raised a seed round."], [{ strengths: ["must"], re: /woman|seed/i }], [/woman|seed|founder/i]),
  call("c10-bait-next-week", ["Looking for a cofounder.", "We should talk next week about the call schedule."], []),
  call("c11-vcs-big-funds", ["I want to meet VCs, but no one from the big funds, and I'd rather they've done pre-seed."], [{ strengths: ["must_not"], re: /big funds/i }, { strengths: ["prefer"], re: /pre-seed/i }]),
  call("c12-fundraising-these-days", ["I want to meet builders, nobody who's fundraising these days."], [{ strengths: ["must_not"], re: /fundraising/i, timed: false }]),
  text("t13-cofounder", "I'm looking for a technical cofounder who's built consumer before", [{ strengths: ["must"], re: /built consumer/i }]),
  text("t14-later-investors", "for the cofounder thing, I'm not looking for investors right now", [{ strengths: ["must_not"], re: /investors/i, timed: true }], COF),
  text("t15-later-taste", "for the cofounder search, taste matters more than seniority", [{ strengths: ["prefer"], re: /taste/i }], COF),
  text("t16-outside-tech", "honestly I just want to meet people outside tech", []),
  text("t17-sf", "I'd rather meet people in SF than down in the South Bay", [{ strengths: ["prefer"], re: /SF/i }], undefined, [/SF|South Bay/i]),
  text("t18-mobile", "can you find me a designer? has to have done mobile apps", [{ strengths: ["must"], re: /mobile/i }]),
  text("t19-drop-guard", "I want a room where I can drop my guard", []),
  text("t20-vcs-moment", "No VCs at the moment, I want to meet other founders", [{ strengths: ["must_not"], re: /VCs/i, timed: true }]),
];

// ---------------------------------------------------------------- 1. capture
const capStats = { cases: 0, asks: 0, quotesGrounded: 0, expected: 0, found: 0, strengthRight: 0, invented: 0, rawRejected: 0, timedChecked: 0, timedRight: 0, readFailed: 0 };
const capFails: string[] = [];
for (const c of CAPTURE) {
  capStats.cases++;
  const transcript = c.lines.join("\n");
  const message = c.via === "text" ? c.lines[c.lines.length - 1].replace(/^user: /, "") : null;
  let parsed: any = null;
  try {
    if (c.via === "call") {
      const { text: out } = await generateText({ model: anthropic(MODELS.haikuPinned), prompt: P.captureIntentPrompt(transcript, "whole_transcript", c.openItems ? { items: c.openItems, intent: [] } : null) });
      parsed = parseModelJson(out);
    } else {
      const { text: out } = await generateText({
        model: anthropic(PROFILE_JUDGMENT_MODEL),
        maxOutputTokens: 5000,
        providerOptions: { anthropic: { effort: "medium" } },
        prompt: TL.turnLearningPrompt({ transcript: `${transcript}\nassistant: Got it.`, message: message!, today: "2026-11-03", onFile: null, openAsks: c.openItems ?? [], styleNotes: [], coSaidBefore: null, intent: (c.openItems ?? []).map((i) => ({ id: i.id, kind: "ask", status: "active", text: i.text })) }),
      });
      parsed = TL.parseTurnLearning(out)?.intent ?? null;
    }
  } catch (err: any) {
    capStats.readFailed++;
    capFails.push(`${c.id}: the read failed (${String(err?.message ?? err).slice(0, 120)})`);
    continue;
  }
  const ownWords = message ?? WC.theirWordsIn(transcript);
  const asks = P.normalizeCapturedAsks(parsed, c.via === "call" ? "whole_transcript" : "last_user_message");
  const rawConds: any[] = [];
  const kept: { text: string; strength: Strength; quote: string }[] = [];
  for (const a of asks) {
    capStats.asks++;
    if (WC.groundWant(a.quote, ownWords).provenance === "stated") capStats.quotesGrounded++;
    else capFails.push(`${c.id}: quote didn't ground: ${JSON.stringify(a.quote)} for ${JSON.stringify(a.text)}`);
    rawConds.push(...(Array.isArray(a.criteria) ? a.criteria : []));
    kept.push(...WC.groundCriteria(a.criteria, ownWords));
  }
  // Conditions on an open item (criteria_for), grounded the same way.
  const cf = Array.isArray(parsed?.criteria_for) ? parsed.criteria_for : [];
  rawConds.push(...cf.filter((x: any) => x?.strength !== "lifted"));
  if (c.openItems?.length) for (const ch of WC.groundCriteriaFor(cf, c.openItems, c.openItems.map((i) => ({ id: i.id, kind: "ask", status: "active", text: i.text })), ownWords)) kept.push(...ch.added);
  capStats.rawRejected += Math.max(0, rawConds.length - kept.length);
  for (const w of c.want) {
    capStats.expected++;
    const hit = kept.find((k) => w.re.test(k.quote) || w.re.test(k.text));
    if (!hit) { capFails.push(`${c.id}: missed ${w.strengths.join("/")} ${w.re} (model said: ${JSON.stringify(rawConds).slice(0, 220)})`); continue; }
    capStats.found++;
    if (w.strengths.includes(hit.strength)) capStats.strengthRight++;
    else capFails.push(`${c.id}: strength ${hit.strength} for ${JSON.stringify(hit.quote)}, expected ${w.strengths.join("/")}`);
    if (w.timed !== undefined) {
      capStats.timedChecked++;
      if (WC.timeBound(hit.quote) === w.timed) capStats.timedRight++;
      else capFails.push(`${c.id}: time-bound read ${WC.timeBound(hit.quote)} for ${JSON.stringify(hit.quote)}, expected ${w.timed}`);
    }
  }
  for (const k of kept) {
    if (c.want.some((w) => w.re.test(k.quote) || w.re.test(k.text)) || (c.allow ?? []).some((r) => r.test(k.quote) || r.test(k.text))) continue;
    capStats.invented++;
    capFails.push(`${c.id}: kept a condition nobody expected: ${k.strength} ${JSON.stringify(k.text)} from ${JSON.stringify(k.quote)}`);
  }
}

// ---------------------------------------------------------------- 2. scoring
type Holds = "yes" | "no" | "unknown";
type Cand = { name: string; asks?: string[]; offers?: string[]; goals?: string[]; likes?: string[] };
type ScoreCase = { id: string; ask: string; conds: { text: string; strength: Strength; quote: string }[]; cands: { c: Cand; ok: Holds[][] }[] };
const cand = (c: Cand, i: number) => ({
  user_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  goals: c.goals ?? [],
  activity_preferences: c.likes ?? [],
  intent: [...(c.asks ?? []).map((t, j) => ({ id: `s${i}-${j}`, text: t, type: "seeking", status: "active", kind: "ask", shareable: true })), ...(c.offers ?? []).map((t, j) => ({ id: `o${i}-${j}`, text: t, type: "offering", status: "active", kind: "ask", shareable: true }))],
});
const Y: Holds[] = ["yes"], N: Holds[] = ["no"], U: Holds[] = ["unknown"], NU: Holds[] = ["no", "unknown"], YU: Holds[] = ["yes", "unknown"];
const SCORE: ScoreCase[] = [
  { id: "s1-cofounder", ask: "a technical cofounder who's built consumer before", conds: [{ text: "investors", strength: "must_not", quote: "I'm not looking for investors right now" }, { text: "has built a consumer product", strength: "must", quote: "who's built consumer before" }], cands: [
    { c: { name: "Noor", offers: ["angel checks for consumer founders"], goals: ["invest in early consumer startups"] }, ok: [Y, NU] },
    { c: { name: "Sam", asks: ["a cofounder for my next consumer app"], goals: ["ship my second consumer app"] }, ok: [NU, Y] },
    { c: { name: "Ellis", asks: ["a cofounder to build with"], goals: ["learn backend engineering"] }, ok: [NU, U] },
  ] },
  { id: "s2-designer-mobile", ask: "a product designer", conds: [{ text: "has done mobile apps", strength: "must", quote: "has to have done mobile apps" }], cands: [
    { c: { name: "Avery", offers: ["product design for iOS and Android apps"] }, ok: [Y] },
    { c: { name: "Rowan", offers: ["brand identity and print design"] }, ok: [NU] },
    { c: { name: "Jules", asks: ["a design mentor"] }, ok: [U] },
  ] },
  { id: "s3-no-crypto", ask: "angel investors for a climate startup", conds: [{ text: "crypto people", strength: "must_not", quote: "no crypto people please" }], cands: [
    { c: { name: "Kai", offers: ["angel checks for web3 and crypto founders"] }, ok: [Y] },
    { c: { name: "Mira", offers: ["angel checks for climate hardware"] }, ok: [NU] },
    { c: { name: "Theo", goals: ["back more founders this year"] }, ok: [U] },
  ] },
  { id: "s4-woman-founder", ask: "a founder to talk to about fundraising", conds: [{ text: "a woman founder", strength: "must", quote: "has to be a woman founder" }], cands: [
    { c: { name: "Priya", asks: ["other women founders to trade notes with"], goals: ["raise a seed round for my company"] }, ok: [Y] },
    { c: { name: "Dana", goals: ["raise a seed round"] }, ok: [U] },
    { c: { name: "Marcus", asks: ["a cofounder"] }, ok: [U] },
  ] },
  { id: "s5-taste", ask: "a cofounder", conds: [{ text: "taste over seniority", strength: "prefer", quote: "taste matters more than seniority" }], cands: [
    { c: { name: "Lena", offers: ["design-led product building, obsessed with craft"] }, ok: [YU] },
    { c: { name: "Omar", goals: ["become a VP of engineering"] }, ok: [U] },
  ] },
  { id: "s6-no-recruiters", ask: "a mentor in fintech", conds: [{ text: "recruiters", strength: "must_not", quote: "For now I don't want to meet any recruiters" }], cands: [
    { c: { name: "Gwen", offers: ["recruiting for fintech startups"] }, ok: [Y] },
    { c: { name: "Hugo", offers: ["mentoring early fintech founders"], goals: ["give back to new founders"] }, ok: [NU] },
    { c: { name: "Iris", likes: ["climbing", "jazz"] }, ok: [U] },
  ] },
  { id: "s7-pre-seed", ask: "VCs", conds: [{ text: "big funds", strength: "must_not", quote: "no one from the big funds" }, { text: "has done pre-seed", strength: "prefer", quote: "I'd rather they've done pre-seed" }], cands: [
    { c: { name: "Felix", offers: ["pre-seed checks from a small solo fund"] }, ok: [NU, Y] },
    { c: { name: "Zoe", goals: ["make partner at a large growth fund"] }, ok: [YU, U] },
    { c: { name: "Ari", likes: ["running"] }, ok: [U, U] },
  ] },
  { id: "s8-oakland", ask: "a running group", conds: [{ text: "too competitive", strength: "must_not", quote: "nothing too competitive" }], cands: [
    { c: { name: "Bea", offers: ["a casual Sunday run club, all paces welcome"] }, ok: [NU] },
    { c: { name: "Cal", asks: ["people to train for a sub-3 marathon with"] }, ok: [YU] },
  ] },
  { id: "s9-sf", ask: "people to meet", conds: [{ text: "in SF", strength: "prefer", quote: "I'd rather meet people in SF" }], cands: [
    { c: { name: "Remy", goals: ["host more dinners in San Francisco"] }, ok: [Y] },
    { c: { name: "Tess", goals: ["grow my Austin community"] }, ok: [NU] },
    { c: { name: "Uma", likes: ["pottery"] }, ok: [U] },
  ] },
  { id: "s10-builders", ask: "builders to meet", conds: [{ text: "fundraising", strength: "must_not", quote: "nobody who's fundraising these days" }], cands: [
    { c: { name: "Vic", goals: ["raise our Series A this quarter"] }, ok: [Y] },
    { c: { name: "Wes", asks: ["other builders to jam with"], goals: ["ship v2 of my app"] }, ok: [NU] },
    { c: { name: "Xan", likes: ["chess"] }, ok: [U] },
  ] },
];
const scStats = { cases: 0, judgments: 0, right: 0, yesWithoutEvidence: 0, noWithoutEvidence: 0, missing: 0, failed: 0 };
const scFails: string[] = [];
for (const s of SCORE) {
  scStats.cases++;
  const cands = s.cands.map((x, i) => cand(x.c, i));
  const lines = M.candidateLinesWithLabels(cands, undefined, undefined, { withHidden: false });
  const digest = lines.map((l, i) => `${i}. ${l.line}`).join("\n");
  const wants = M.askWants([{ text: s.ask, type: "seeking", criteria: s.conds.map((c) => ({ ...c, at: new Date().toISOString() })) } as any]);
  let out: any;
  try {
    out = (await judgeJson(SCORE_SCHEMA, { model: anthropic(MODELS.sonnet), prompt: M.buildStatedAskPrompt(s.ask, digest, undefined, wants) })).output;
  } catch (err: any) {
    scStats.failed++;
    scFails.push(`${s.id}: scorer failed (${String(err?.message ?? err).slice(0, 120)})`);
    continue;
  }
  s.cands.forEach((x, i) => {
    const r = (out?.results ?? []).find((y: any) => y.index === i);
    s.conds.forEach((cd, k) => {
      scStats.judgments++;
      const got = (r?.conditions ?? []).find((y: any) => String(y.label).toUpperCase() === `C${k + 1}`)?.holds as Holds | undefined;
      const ok = x.ok[k];
      if (!got) { scStats.missing++; scFails.push(`${s.id}: ${x.c.name} C${k + 1} not answered`); return; }
      if (ok.includes(got)) { scStats.right++; return; }
      if (got === "yes") scStats.yesWithoutEvidence++;
      if (got === "no" && !ok.includes("no")) scStats.noWithoutEvidence++;
      scFails.push(`${s.id}: ${x.c.name} C${k + 1} ("${cd.quote}") said ${got}, expected ${ok.join("/")} | line: ${lines[i].line.slice(0, 160)}`);
    });
  });
}

const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "n/a");
console.log("\n=== capture (20 cases: 12 call read, 8 text read) ===");
console.log(`reads failed: ${capStats.readFailed}`);
console.log(`quotes grounded: ${pct(capStats.quotesGrounded, capStats.asks)}`);
console.log(`expected conditions kept: ${pct(capStats.found, capStats.expected)}`);
console.log(`strength right (of kept): ${pct(capStats.strengthRight, capStats.found)}`);
console.log(`time-bound read right: ${pct(capStats.timedRight, capStats.timedChecked)}`);
console.log(`invented conditions kept (after grounding): ${capStats.invented}`);
console.log(`model conditions the grounding rejected: ${capStats.rawRejected}`);
console.log("\n=== scoring (10 cases) ===");
console.log(`scorer calls failed: ${scStats.failed}`);
console.log(`judgments right: ${pct(scStats.right, scStats.judgments)}`);
console.log(`"yes" without evidence: ${scStats.yesWithoutEvidence}`);
console.log(`"no" without evidence: ${scStats.noWithoutEvidence}`);
console.log(`not answered: ${scStats.missing}`);
console.log("\n=== misses (fictional data) ===");
for (const f of [...capFails, ...scFails]) console.log(`- ${f}`);
