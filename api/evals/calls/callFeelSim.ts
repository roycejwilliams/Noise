// LIVE later-call feel simulation (layer 2, metered; Royce approved about $1-2 on 2026-11-04; NOT in layer 1, never run by the merge gate).
// The five things from his review of his own GPT-Live calls: the same opening every time, no wind-down, a question on almost every turn,
// the wrong register, verdicts stated as fact. Runs the GPT-Live thinking's own prompt (services/gptLive.ts buildLiveCall) through the real
// call brain (services/callLlmProxy.ts runCallLlm, Sonnet 4.6, cached) with Haiku playing the member; run it once from a checkout of
// origin/co-test (base) and once from the branch, then compare the two JSON files. The voice model (GPT-Live) is not simulated: the
// opening is written by the thinking from the background GPT-Live would get, the same on both arms. Fictional members only.
// Works on base: anything the branch adds (thread, notes) is looked up defensively and simply absent there.
//
//   cd api && EVAL_REAL_MODELS=1 EVAL_KEEP_MODEL=1 EVAL_COST_CAP_USD=1 npm run -s eval:live -- evals/calls/callFeelSim.ts --arm base|branch [--repeat 2]
import "dotenv/config";
import "../lib/requireMeter.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
const G: any = await import("../../src/services/gptLive.js");
const P: any = await import("../../src/services/callLlmProxy.js");
const { MODELS } = await import("../../src/models.js");

const args = process.argv.slice(2);
const ARM = args[args.indexOf("--arm") + 1] === "base" ? "base" : "branch";
const REPEAT = Number(args[args.indexOf("--repeat") + 1] || 2) || 2;
const VOICE = readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");

type Persona = { id: string; firstName: string; thread: string | null; context: string; maxCue: number; member: string; opener: string };
const MEMBER = (s: string) => `You are on a phone call with Cue, a companion you already know from earlier calls and texts. Speak like a real person on the phone: short turns, plain words. Never say you're an AI or a test. ${s} Say your next line only.`;
const PERSONAS: Persona[] = [
  { id: "ellis-wrapup", firstName: "Ellis", thread: "Plan the studio launch event", context: "Where things stand now: launching a ceramics studio next month; open: plan the launch event.", maxCue: 8, opener: "Hey, I wanted to run the launch event idea by you.", member: MEMBER("You're Ellis, launching a ceramics studio next month and planning the opening night. You called to run an idea by Cue: a small invite-only evening with 30 guests. Talk it through for two exchanges. Once Cue has given you a view or a plan twice, you're done: reply only 'Yeah, I agree.' and then 'Thanks.' and then only short agreements or 'okay'. Say bye only after Cue says goodbye.") },
  { id: "noor-friend", firstName: "Noor", thread: "Hiring a second engineer for the startup", context: "Where things stand now: hiring a second engineer at the startup.", maxCue: 5, opener: "Hey Cue! I'm at dinner with my friend Dana, I wanted to show her you.", member: MEMBER("You're Noor, at a restaurant with your friend Dana, showing Cue off. Keep it light and fast: say hi, say Dana is next to you, ask Cue to say something fun to Dana or what it can do. If Cue asks you anything deep or reflective, say 'ha, not now, we're at dinner' and move on. You have two minutes.") },
  { id: "jordan-read", firstName: "Jordan", thread: "Decide on the Stripe design role offer", context: "Where things stand now: a design role offer from a payments company; decision due Friday.", maxCue: 5, opener: "Hey. I have to decide on that offer by Friday and I keep going back and forth. Am I being emotional about this?", member: MEMBER("You're Jordan, deciding on a job offer by Friday: the pay is better but you'd leave a team you love. You're torn. Ask Cue for its honest read on whether you're being emotional about it, then react to what it says in a sentence.") },
  { id: "noor-later", firstName: "Noor", thread: "Hiring a second engineer for the startup", context: "Where things stand now: hiring a second engineer at the startup; open: hiring a second engineer.", maxCue: 3, opener: "Hey.", member: MEMBER("You're Noor. You called Cue on a quiet evening with nothing particular planned. Answer in a few words, warm but low energy.") },
];

type Turn = { who: "member" | "cue"; text: string };
async function cueTurn(call: any, turns: Turn[]): Promise<{ text: string; end: boolean }> {
  const req = G.delegationRequest(call, turns.map((t, i) => ({ who: t.who, text: t.text, startMs: i * 1000, endMs: i * 1000 + 900 })));
  // The branch's per-turn facts, exactly as thinkOnCall adds them (none on base).
  const turnNotes: string[] = [];
  if (ARM === "branch") {
    const wind = G.windDownSignal(req);
    if (wind) turnNotes.push(G.WIND_DOWN_NOTE);
    else if (G.agreedBriefly(req)) turnNotes.push(G.AGREED_NOTE);
    else if (G.askedLastTurn(req)) turnNotes.push(G.NO_QUESTION_NOTE);
  }
  let text = "", end = false;
  for await (const c of P.runCallLlm(req, { stream: (r: any) => P.anthropicStream(r), clean: true, turnNotes })) {
    const d: any = c.choices[0].delta;
    if (d.content) text += d.content;
    for (const tc of d.tool_calls ?? []) if (tc.function?.name === "end_call") end = true;
  }
  return { text: text.trim(), end };
}
async function memberTurn(p: Persona, turns: Turn[]): Promise<string> {
  const convo = turns.map((t) => `${t.who === "cue" ? "Cue" : "You"}: ${t.text}`).join("\n");
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 80, prompt: `${p.member}\n\nThe call so far:\n${convo}\n\nYour next line:` });
  return text.trim().replace(/^You:\s*/, "");
}

const words = (t: string) => t.replace(/[^a-z' ]+/gi, " ").split(/\s+/).filter(Boolean);
const ASSENT = new Set("yeah yes yep ok okay sure right totally exactly true agree agreed i sounds good cool got it fair thanks thank you great fine alright mm hmm perfect bye goodbye".split(" "));
const isSignal = (t: string) => { const w = words(t.toLowerCase()); return w.length >= 1 && w.length <= 3 && w.every((x) => ASSENT.has(x)); };
const VERDICT = /\byou(?:'re| are) (?:not |just |clearly |definitely )?(?:being )?(?:emotional|rushing|acting from|overreacting|reacting|afraid|scared|avoiding|running|ruled by)|\byou(?:'re| are) not (?:rushing|emotional|being emotional|overreacting)\b|\bthis (?:isn't|is not) (?:about )?(?:emotion|fear)|\byou'?re (?:clearly|obviously) /i;
const OPINION = /\b(?:i think|my read|to me|i'd say|i lean|it sounds to me|my take|i'd guess|if it were me|i'd)\b/i;
const DEEP = /\bwhat (?:part|is it about|grabbed|drew|draws)|\bhow (?:does|did) (?:that|it) feel|\bwhat'?s (?:driving|behind|underneath)|\bwhy do you think|\bwhat does that (?:mean|say)/i;
const BAIL = /\bnot now\b|\bgotta go\b/i;
const THREAD_WORDS = /\b(?:launch|studio|event|hiring|engineer|offer|stripe|decide)\b/i;

function score(p: Persona, turns: Turn[]) {
  const cue = turns.filter((t) => t.who === "cue").map((t) => t.text);
  const firstSignal = turns.findIndex((t, i) => t.who === "member" && i > 0 && isSignal(t.text) && turns.slice(0, i).filter((x) => x.who === "member" && isSignal(x.text)).length >= 0 && /yeah, i agree|thanks/i.test(t.text));
  const afterSignal = firstSignal < 0 ? null : turns.slice(firstSignal + 1).filter((t) => t.who === "cue").length;
  const qTurns = cue.filter((t) => /\?/.test(t)).length;
  return {
    cueTurns: cue.length,
    questionTurns: qTurns,
    questionsPerCueTurn: cue.length ? Math.round((qTurns / cue.length) * 100) / 100 : 0,
    opening: cue[0] ?? "",
    openingUsesThread: p.thread ? THREAD_WORDS.test(cue[0] ?? "") : null,
    openingStock: /what'?s on your mind|driving your thoughts|what are you thinking|i'?m here,? i'?m with you/i.test(cue[0] ?? ""),
    // Wind-down persona only: Cue turns after their first closing signal (target 1: the closing line).
    turnsAfterClosingSignal: p.id === "ellis-wrapup" ? afterSignal : null,
    verdicts: cue.filter((t) => VERDICT.test(t)).length,
    opinions: cue.filter((t) => OPINION.test(t)).length,
    deepQuestions: p.id === "noor-friend" ? cue.filter((t) => DEEP.test(t)).length : null,
    bailed: p.id === "noor-friend" ? turns.some((t, i) => i > 1 && t.who === "member" && BAIL.test(t.text)) : null,
  };
}

const results: any[] = [];
for (const p of PERSONAS) {
  for (let r = 0; r < REPEAT; r++) {
    const call = G.buildLiveCall({ userId: `sim-${p.id}`, callSid: null, firstName: p.firstName, direction: "inbound", team: false, voiceLayer: VOICE, contextSummary: p.context, rightNow: "It is Tuesday, 6:40 PM Pacific (their time).", findsNow: "", callReason: "", timeOfDay: "Tuesday evening", first: { firstCall: false }, thread: p.thread });
    const bg = G.openingBackground(call.opening, "inbound");
    const turns: Turn[] = [];
    const note = `(Cue's note, not their words: the call just connected. Open it now in your own words, briefly. ${G.OPEN_NO_STOCK} ${G.OPEN_NO_MIND ?? ""}\nBackground for the opening, never to read out:\n${bg})`;
    turns.push({ who: "cue", text: (await cueTurn(call, [{ who: "member", text: note }])).text });
    turns.push({ who: "member", text: p.opener });
    let closedAt = -1;
    while (turns.filter((t) => t.who === "cue").length < p.maxCue + 1) {
      const c = await cueTurn(call, turns);
      if (c.text) turns.push({ who: "cue", text: c.text });
      if (c.end || /\b(?:bye|goodbye|take care|talk soon|good night)\b/i.test(c.text)) break;
      const m = await memberTurn(p, turns);
      turns.push({ who: "member", text: m });
      if (p.id === "ellis-wrapup" && closedAt < 0 && /yeah, i agree|thanks/i.test(m)) closedAt = turns.length - 1;
      if (closedAt >= 0 && turns.length - closedAt > 6) break;
    }
    const s = score(p, turns);
    results.push({ arm: ARM, persona: p.id, run: r + 1, ...s, turns });
    console.log(`${ARM} ${p.id} #${r + 1}: ${s.cueTurns} cue turns, ${s.questionTurns} with a question, opening: ${s.opening.slice(0, 70)}`);
  }
}
const out = join(tmpdir(), `call-feel-sim-${ARM}-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nper call: ${out}`);
process.exit(0);
