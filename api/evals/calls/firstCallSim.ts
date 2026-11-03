// LIVE first-call simulation (layer 2, metered; Royce approved up to $6 on 2026-11-02 for this, the replay check and 2-3 GPT-Live test
// calls; NOT in layer 1, never run by the merge gate). Base (origin/co-test's call prompt: the four phases) vs branch (the first-call
// guidance, prompts/co-system-prompt.md "YOUR FIRST CONVERSATION"), on the GPT-Live thinking's own prompt (services/gptLive.ts
// buildLiveCall) through the real call brain (services/callLlmProxy.ts runCallLlm, Sonnet 4.6, cached), with Haiku playing the member.
// Fictional members only (Nadia, Sam, Leo, Priya). Nothing is written or sent.
//
// 4 personas x base/branch x REPEAT (default 3) = 24 calls. Per call, code-only numbers: Cue turns, words per turn, turns over 40 words,
// questions, stock lines, the email ask (count), location/availability asked before any read, a person named as a match, whether Cue said
// the double opt-in (nobody is introduced until both say yes; counted, never a pass/fail), and for the
// heavy-news persona any connection talk within two Cue turns after the hard news (fails the call). One Sonnet grade per call (--no-grade
// skips it): did Cue say back one correctable read, did it end on a real next step, did it feel like a form (1-5).
//
// Cost (estimate, 2026-11-03): thinking prompt ~29k chars (~7.5k tokens) cached; ~12 Cue turns a call; Sonnet 4.6 at $3/$15 per M,
// cache read $0.30, write $3.75: ~$0.008 a turn, ~$0.10 a call, plus 8 cache writes (~$0.26, up to ~$0.77 if runs fall outside the
// 5-minute cache window). Haiku member ~$0.002 a call. Grader ~$0.01 a call. Total ~$2.9-3.4 for 24 calls.
// The meter prices a kept claude-sonnet-4-6 at its Sonnet rate ($2/$10), so its printed cost reads about a third low: the cap below
// (meter $2.70) holds the real spend near $4.
//
//   cd api && git fetch origin && \
//   EVAL_REAL_MODELS=1 EVAL_KEEP_MODEL=1 EVAL_COST_CAP_USD=2.70 EVAL_TOKEN_CAP=3000000 \
//     npm run -s eval:live -- evals/calls/firstCallSim.ts [--repeat 3] [--only nadia] [--no-grade]
// Writes the per-call numbers and transcripts to $TMPDIR/first-call-sim-<time>.json and prints the base/branch table.
import "dotenv/config";
import "../lib/requireMeter.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

process.env.DATABASE_URL ||= "postgres://ci:ci@127.0.0.1:1/ci";
const G = await import("../../src/services/gptLive.js");
const P = await import("../../src/services/callLlmProxy.js");
const { MODELS, GRADER_HEADERS } = await import("../../src/models.js");
const { stockReport } = await import("../../src/harness/stockLines.js");

const args = process.argv.slice(2);
const REPEAT = Number(args[args.indexOf("--repeat") + 1] || 3) || 3;
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const GRADE = !args.includes("--no-grade");
const MAX_CUE_TURNS = 20;

const BRANCH_VOICE = (await import("node:fs")).readFileSync(new URL("../../prompts/co-system-prompt.md", import.meta.url), "utf8");
const BASE_VOICE = execFileSync("git", ["show", "origin/co-test:api/prompts/co-system-prompt.md"], { encoding: "utf8" });
// Base also had the old empty-context line in the call context (services/elevenLabsCalls.ts CALL_CONTEXT_BLOCK).
const toBase = (s: string) => s.replace("If that's empty, you have nothing from before:", "If that's empty, this is your first real conversation with them:");

type Persona = { id: string; firstName: string; direction: "inbound" | "outbound"; context: string; texts: string[]; inviter: string | null; member: string; heavyAfter?: RegExp };
const MEMBER = (s: string) => `You are a new member of a private club, on your first phone call with Cue, a companion who gets to know members and connects them. Speak like a real person on the phone: short turns, plain words. Never say you're an AI or a test. ${s} When the call has clearly wrapped up, say a short goodbye.`;
const PERSONAS: Persona[] = [
  { id: "nadia", firstName: "Nadia", direction: "outbound", context: "Their texts: gave notice, last day the 21st, freelance or join a studio?", texts: ["gave notice, last day the 21st, freelance or join a studio?"], inviter: null, member: MEMBER("You're Nadia, a brand designer leaving an agency after six years; your last day is the 21st. Old clients keep pinging you with brand work, but what you'd pick is packaging. You'd miss having a team. You live in Oakland. Your email is nadia.okafor@gmail.com; give it if asked.") },
  { id: "sam", firstName: "Sam", direction: "inbound", context: "", texts: [], inviter: null, member: MEMBER("You're Sam. You called Cue. You're busy and a bit guarded: you have about two minutes. What you'd most want help with this month is hiring a Postgres contractor. Don't volunteer much. You'd rather not give your email.") },
  { id: "leo", firstName: "Leo", direction: "inbound", context: "Their texts: Hi Cue, Dana invited me. Code: 6VGF76VK", texts: ["Hi Cue, Dana invited me. Code: 6VGF76VK"], inviter: "Dana", member: MEMBER("You're Leo. Dana, a friend from your climbing gym, invited you. You just moved to SF to start a job at a climate startup and want to meet people outside work, ideally other climbers or founders. Your email is leo.marsh@hey.com; give it if asked.") },
  { id: "priya", firstName: "Priya", direction: "outbound", context: "Their texts: I'm launching my ceramics studio next month and need help with the opening night", texts: ["I'm launching my ceramics studio next month and need help with the opening night"], inviter: null, heavyAfter: /hospice|dad|father/i, member: MEMBER("You're Priya, launching a ceramics studio next month. Two turns in, tell Cue quietly that your dad went into hospice this week and you're not sure the opening happens. Stay on that if Cue does. Your email is priya.n@fastmail.com; give it if asked.") },
];

type Turn = { who: "member" | "cue"; text: string };
async function cueTurn(call: ReturnType<typeof G.buildLiveCall>, turns: Turn[]): Promise<{ text: string; end: boolean }> {
  const req = G.delegationRequest(call, turns.map((t, i) => ({ who: t.who, text: t.text, startMs: i * 1000, endMs: i * 1000 + 900 })));
  let text = "", end = false;
  for await (const c of P.runCallLlm(req as any, { stream: (r) => P.anthropicStream(r), clean: true })) {
    const d: any = c.choices[0].delta;
    if (d.content) text += d.content;
    for (const tc of d.tool_calls ?? []) if (tc.function?.name === "end_call") end = true;
  }
  return { text: text.trim(), end };
}
async function memberTurn(p: Persona, turns: Turn[]): Promise<string> {
  const convo = turns.map((t) => `${t.who === "cue" ? "Cue" : "You"}: ${t.text}`).join("\n");
  const { text } = await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 120, prompt: `${p.member}\n\nThe call so far:\n${convo}\n\nSay your next line only, nothing else.` });
  return text.trim().replace(/^You:\s*/, "");
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const CONNECT = /\bintroduc\w*|\bconnect you\b|\bsomeone (?:you should|worth) meet|\bpeople (?:to|you should) meet|\bmatch\b/i;
// Cue said the double opt-in out loud: nobody is introduced until both say yes (review of the onboarding branch, finding 8: counted only).
const DOUBLE_OPT_IN = /\bdouble opt-?in\b|\bboth (?:of you |sides )?(?:say|said|want|agree|opt|are up for)\b|\bonly (?:if|when) (?:you(?:'re| are)? both|both of you|they(?:'re| are)? (?:up for|into) it too)\b|\b(?:ask|check with) them first\b|\bif they(?:'re| are) up for it too\b|\bnobody(?:'s| is) (?:named|introduced) until\b/i;
const LOGISTICS = /\bwhere (?:are you|do you live|are you based)|\bwhat (?:city|neighborhood)|\bwhen are you (?:free|around)|\bavailab/i;
function score(p: Persona, turns: Turn[]) {
  const cue = turns.filter((t) => t.who === "cue").map((t) => t.text);
  const firstRead = cue.findIndex((t) => /\bmy read\b|\bhere'?s (?:what|my)\b|\bit sounds like\b|\bisn'?t (?:really )?\w+ versus\b|\bclose\?/i.test(t));
  let heavyFail = false;
  if (p.heavyAfter) {
    const at = turns.findIndex((t) => t.who === "member" && p.heavyAfter!.test(t.text));
    if (at >= 0) heavyFail = turns.slice(at + 1).filter((t) => t.who === "cue").slice(0, 2).some((t) => CONNECT.test(t.text));
  }
  const stock = stockReport(cue);
  return {
    cueTurns: cue.length,
    wordsPerTurn: cue.length ? Math.round((cue.reduce((a, t) => a + words(t), 0) / cue.length) * 10) / 10 : 0,
    over40: cue.filter((t) => words(t) > 40).length,
    questions: cue.reduce((a, t) => a + (t.match(/\?/g)?.length ?? 0), 0),
    stock: stock.stock.length + stock.repeated.length,
    emailAsks: cue.filter((t) => /\be-?mail\b/i.test(t)).length,
    logisticsBeforeRead: cue.slice(0, firstRead < 0 ? cue.length : firstRead).filter((t) => LOGISTICS.test(t)).length,
    namedAPerson: cue.some((t) => /\b(?:meet|introduce you to|connect you with) [A-Z][a-z]+\b/.test(t)),
    inviterNamed: p.inviter ? cue.some((t) => t.includes(p.inviter!)) : null,
    doubleOptInSaid: cue.some((t) => DOUBLE_OPT_IN.test(t)),
    heavyFail,
  };
}
async function grade(turns: Turn[]): Promise<{ read: boolean; nextStep: boolean; formLike: number } | null> {
  if (!GRADE) return null;
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    headers: GRADER_HEADERS,
    maxOutputTokens: 200,
    prompt: `A first phone call between Cue (a companion that connects members) and a new member. Answer as strict JSON {"read": boolean, "nextStep": boolean, "formLike": 1-5}.\nread: Cue once said back one thing the member didn't say outright, as a read they could correct (not a recap).\nnextStep: the call ends on a real next step (what Cue will do, or one thing worth doing this week), never promising a specific person.\nformLike: 1 = a natural conversation, 5 = felt like filling in a form.\n\n${turns.map((t) => `${t.who === "cue" ? "Cue" : "Member"}: ${t.text}`).join("\n")}`,
  }).catch(() => ({ text: "" }));
  try { const j = JSON.parse(text.replace(/^[^{]*/, "").replace(/[^}]*$/, "")); return { read: !!j.read, nextStep: !!j.nextStep, formLike: Number(j.formLike) || 0 }; } catch { return null; }
}

const results: any[] = [];
for (const p of PERSONAS.filter((x) => !ONLY || x.id === ONLY)) {
  for (const arm of ["base", "branch"] as const) {
    for (let r = 0; r < REPEAT; r++) {
      const first = arm === "branch" ? { firstCall: true, theirWords: p.texts.length ? p.texts[0] : null, inviter: p.inviter, emailOnFile: false, emailAsked: false } : undefined;
      let call = G.buildLiveCall({ userId: `sim-${p.id}`, callSid: null, firstName: p.firstName, direction: p.direction, team: false, voiceLayer: arm === "branch" ? BRANCH_VOICE : BASE_VOICE, contextSummary: p.context, rightNow: "It is Tuesday, 2:10 PM Pacific (their time).", findsNow: "", callReason: p.direction === "outbound" ? "This is their first conversation with Cue: Cue called to get to know them, their life and what they're after. Nothing of Cue's to report." : "", timeOfDay: "Tuesday afternoon", first });
      if (arm === "base") call = { ...call, backendSystem: toBase(call.backendSystem) };
      // GPT-Live opens on its own from its instructions; here the thinking writes the opening from the same background, so both arms
      // open from what their GPT-Live would have.
      const bg = [G.openingBackground(call.opening, "inbound"), call.opening.reason ? G.reasonNote(call.opening.reason) : ""].filter(Boolean).join("\n");
      const turns: Turn[] = [];
      const open = await cueTurn(call, [{ who: "member", text: `(Cue's note, not their words: the call just connected${p.direction === "outbound" ? " and they picked up" : ""}. Open it now in your own words, briefly. Background for the opening, never to read out:\n${bg})` }]);
      turns.push({ who: "cue", text: open.text });
      while (turns.filter((t) => t.who === "cue").length < MAX_CUE_TURNS) {
        turns.push({ who: "member", text: await memberTurn(p, turns) });
        const c = await cueTurn(call, turns);
        if (c.text) turns.push({ who: "cue", text: c.text });
        if (c.end) break;
      }
      const s = score(p, turns);
      results.push({ persona: p.id, arm, run: r + 1, ...s, grade: await grade(turns), turns });
      console.log(`${p.id} ${arm} #${r + 1}: ${s.cueTurns} turns, ${s.wordsPerTurn} w/turn, ${s.over40} over 40, ${s.emailAsks} email asks${s.heavyFail ? ", HEAVY-NEWS FAIL" : ""}`);
    }
  }
}
const out = join(tmpdir(), `first-call-sim-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
for (const arm of ["base", "branch"]) {
  const rs = results.filter((x) => x.arm === arm);
  const g = rs.map((x) => x.grade).filter(Boolean);
  console.log(`\n${arm.toUpperCase()} (${rs.length} calls): turns ${avg(rs.map((x) => x.cueTurns))} | words/turn ${avg(rs.map((x) => x.wordsPerTurn))} | over 40 words ${avg(rs.map((x) => x.over40))} | questions ${avg(rs.map((x) => x.questions))} | stock ${avg(rs.map((x) => x.stock))} | email asks ${avg(rs.map((x) => x.emailAsks))} | logistics before the read ${avg(rs.map((x) => x.logisticsBeforeRead))} | named a person ${rs.filter((x) => x.namedAPerson).length} | double opt-in said ${rs.filter((x) => x.doubleOptInSaid).length}/${rs.length} | heavy-news fails ${rs.filter((x) => x.heavyFail).length}${g.length ? ` | read ${g.filter((x: any) => x.read).length}/${g.length} | next step ${g.filter((x: any) => x.nextStep).length}/${g.length} | form-like ${avg(g.map((x: any) => x.formLike))}` : ""}`);
}
console.log(`\nper call: ${out}\nTargets (proposal 1102): 12-14 turns, <=2 sentences a turn, read said once, next step, email asked at most once, no connection talk after hard news; the outside call's base was 25 turns, 34 words a turn.`);
process.exit(0);
