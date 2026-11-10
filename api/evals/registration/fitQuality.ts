// QUALITY (layer 2, metered; Royce runs it): the free-form "why it fits" line in a registration ask, generated for real so the lines can
// be read before shipping. Each scenario is a synthetic find (its public page and what the find said) plus a member picture, with invented
// names. For each, the model writes the fit line the way Cue would (the prepareEventRegistration tool's own `fit` guidance), the code check
// (copy.ts fitProblem) accepts or refuses it, and the ask Cue would actually send is printed: with the line when it passes, and with no
// fit sentence (the fallback) when it's refused.
//   npm run evals:registration:fit -- --estimate     free: no model call, prints the forecast and the caps
//   npm run evals:registration:fit                   real calls through the meter (EVAL_REAL_MODELS=1: Sonnet, the reply model)
// Without the meter it refuses to run (evals/lib/requireMeter.ts). Nothing is sent, nothing is written.
import * as C from "../../src/services/eventRegistration/copy.js";
import * as R from "../../src/services/eventRegistration/registration.js";

type Scenario = { id: string; what: string; member: string; find: { name: string; page: string; postText?: string } };
const SCENARIOS: Scenario[] = [
  { id: "clear-match", what: "a clear match", member: "Avery is building a battery startup in Oakland and said: \"I want to meet climate investors who write first checks.\"", find: { name: "Climate Hardware Investor Night", page: "Climate Hardware Investor Night. Thu Nov 20, 6:00 PM, San Francisco. An evening for hardware founders to meet seed investors focused on climate. About 40 guests. Hosted by Grid Collective." } },
  { id: "tangential", what: "a weak, tangential match", member: "Avery makes ceramics and said: \"I'd like to find a studio community.\"", find: { name: "AI Builders Demo Night", page: "AI Builders Demo Night. Fri Nov 21, 7:00 PM, San Francisco. Six teams demo agent products. Free. Hosted by Prompt House." } },
  { id: "missing-detail", what: "the page lacks the detail the member cares about", member: "Avery said: \"Only small rooms, I hate big mixers, twenty people max.\"", find: { name: "Founders Supper", page: "Founders Supper. Tue Nov 25, 7:30 PM, Oakland. Dinner and conversation for early founders. Hosted by Table Seven." } },
  { id: "needs-private", what: "the obvious pitch needs another member's private info", member: "Avery is raising a seed round. (Private, from another member's conversation with Cue: Priya Natarajan, another Noise member, is going to this event and is quietly looking for a cofounder.)", find: { name: "Seed Stage Salon", page: "Seed Stage Salon. Wed Nov 19, 6:30 PM, San Francisco. Founders raising their first round trade notes. Hosted by Northbeam." } },
  { id: "x-post-luma", what: "an X post resolved to its Luma page", member: "Avery wants to meet other first-time founders.", find: { name: "First-Time Founders Coffee", postText: "First-time founders coffee this Saturday, come say hi https://t.co/abc123", page: "First-Time Founders Coffee. Sat Nov 22, 10:00 AM, San Francisco. A relaxed morning for people starting their first company. Hosted by Ellis Okafor." } },
  { id: "sparse", what: "an event with sparse public details", member: "Avery is new to the city and wants to meet people building things.", find: { name: "Night Market", page: "Night Market. Thu Nov 20, 8:00 PM." } },
  { id: "their-words", what: "the member's own stated reason lines up with the page", member: "Avery said: \"I'm trying to get better at pitching, I freeze up in front of investors.\"", find: { name: "Pitch Practice Lab", page: "Pitch Practice Lab. Mon Nov 24, 6:00 PM, Oakland. Founders practice a two-minute pitch and get feedback from operators. Hosted by Harbor Founders." } },
];

// The fit guidance Cue's tool carries (agent/registrationTools.ts prepareEventRegistration `fit`; capabilities.ts prepare_registration).
const FIT_GUIDANCE = (await import("../../src/agent/registrationTools.js")).FIT_DESCRIBE;
const prompt = (s: Scenario) => `You are Cue, a texting companion that helps a member meet the right people. You're about to ask Avery whether to register them for an event Cue found and sent. Write the optional "why it fits" sentence that goes first in that ask.

${FIT_GUIDANCE}

What Cue knows about Avery:
${s.member}

The event's own public page says:
${s.find.page}
${s.find.postText ? `\nThe X post Cue found it through says:\n${s.find.postText}\n` : ""}
Return ONLY JSON: {"fit": "the sentence" or null}`;

const MAX_OUT = 150;
const estimateOnly = process.argv.includes("--estimate");
if (estimateOnly) {
  // Characters to tokens at about 3.5 a token; the output at its cap. Sonnet's list price (evals/lib/meter.mjs PRICE.sonnet), the dearer case.
  const inTok = SCENARIOS.reduce((a, s) => a + Math.ceil(prompt(s).length / 3.5), 0);
  const outTok = SCENARIOS.length * MAX_OUT;
  const sonnet = (inTok * 2 + outTok * 10) / 1e6;
  const haiku = (inTok * 0.1 + outTok * 0.5) / 1e6;
  console.log(`registration fit quality estimate: ${SCENARIOS.length} scenarios x 1 call = ${SCENARIOS.length} calls, ~${inTok.toLocaleString()} input + ${outTok.toLocaleString()} output tokens at most`);
  console.log(`  on Sonnet (EVAL_REAL_MODELS=1, the reply model): $${sonnet.toFixed(4)} | on Haiku: $${haiku.toFixed(4)}`);
  console.log(`  caps (npm script defaults): EVAL_TOKEN_CAP=${process.env.EVAL_TOKEN_CAP ?? "200000"} tokens, EVAL_COST_CAP_USD=${process.env.EVAL_COST_CAP_USD ?? "0.25"}`);
  process.exit(0);
}

await import("../lib/requireMeter.js");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const { MODELS } = await import("../../src/models.js");
const client = new Anthropic();
const form = (s: Scenario): R.FormRead => ({ url: "https://luma.com/example", eventName: s.find.name, when: "Thu Nov 20, 6:00 PM", action: "register", tickets: [], priceText: "Free", gate: "none", readAt: new Date().toISOString(), fields: [{ id: "name", label: "Name", kind: "name", required: true }, { id: "email", label: "Email", kind: "email", required: true }] });
const facts: R.MemberFacts = { first_name: { value: "Avery", source: "account" }, last_name: { value: "Lin", source: "account" }, email: { value: "avery@example.com", source: "account" } };

for (const s of SCENARIOS) {
  const out: any = await client.messages.create({ model: MODELS.sonnet, max_tokens: MAX_OUT, messages: [{ role: "user", content: prompt(s) }] } as any);
  const text = (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  let fit: string | null = null;
  try { fit = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()).fit ?? null; } catch { fit = text.trim() || null; }
  // What the tool checks the line against: the event's page, the find's post, and the find's name (never the member picture).
  const verified = [s.find.name, s.find.page, s.find.postText].filter(Boolean).join("\n");
  const why = fit ? C.fitProblem(fit, verified) : null;
  const f = form(s);
  const plan = R.planFill(f, facts);
  const ctx: C.Ctx = { eventName: s.find.name, when: f.when, email: "avery@example.com", link: "https://luma.com/example" };
  const sends = C.submitAsk(ctx, plan, R.scopeOf(f, plan), fit && !why ? fit : null);
  console.log(`\n=== ${s.id}: ${s.what}`);
  console.log(`generated fit: ${fit ? `"${fit}"` : "(none: the model left it out)"}`);
  console.log(`fitProblem: ${!fit ? "nothing to check" : why ? `REFUSED: ${why}` : "accepted"}`);
  console.log(`${fit && why ? "Cue would send instead (the fallback: the ask with no fit sentence)" : "Cue would send"}:\n  ${sends}`);
}
