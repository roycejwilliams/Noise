// Every member on GPT-Live (Royce, 2026-10-31): the processor line in what Cue knows (approved wording, fixed), and no call placed or
// answered through ElevenLabs. Inbound and outbound for a member not on the team are tested in evals/calls/gptLive.ts §7 and §9 and
// evals/calls/gptLiveOutbound.ts §2 and §3; this holds the line and the reachability.
// Layer 1: no network, no tokens.
//   TZ=UTC node evals/runLayer1.mjs evals/calls/gptLiveEveryone.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

const W = await import("../../src/services/whatCoKnows.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };

// ---------------------------------------------------------------- the processor line, in what Cue knows
{
  const APPROVED = "Cue's phone calls run on OpenAI's voice model, so OpenAI processes the call audio and what Cue knows to help on it. OpenAI doesn't train on it and keeps it at most 30 days for safety checks.";
  check("the line is the approved wording, exactly", W.CALLS_PROCESSOR_LINE === APPROVED);
  const view = W.groupKnown([{ group: "where" as any, text: "moving to Oakland in March", ref: "r1", theirWords: null, canCorrect: true } as any]);
  const empty = W.groupKnown([]);
  check("the what-Cue-knows view carries it, with something known and with nothing yet", view.calls === APPROVED && empty.calls === APPROVED);
  check("...and the reply's fact line from the view says it word for word, both ways", view.groups.length === 1 && W.knownFact(view).includes("moving to Oakland") && W.knownFact(view).includes(APPROVED) && W.knownFact(empty).includes(APPROVED) && W.knownFact(empty).startsWith("What Cue knows about them: nothing yet"));
  check("...and the whatCoKnows tool returns it with the groups", /calls: got\.view\.calls,/.test(src("agent/conversationTools.ts")));
  check("no message goes out about it: nothing but the view reads it", (() => {
    const users = ["agent/conversationTools.ts", "services/whatCoKnows.ts"];
    const all = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    return all.filter((f) => !users.includes(f)).every((f) => !src(f).includes("CALLS_PROCESSOR_LINE") && !src(f).includes("OpenAI's voice model"));
  })());
}

// ---------------------------------------------------------------- the processor line goes out by code, not by the model (review of #337)
{
  process.env.OPENAI_API_KEY ||= "unused-in-tests";
  process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
  const APPROVED = W.CALLS_PROCESSOR_LINE;
  check("withProcessorLine: the line is the last paragraph, word for word, said once even if the draft had it", W.withProcessorLine("Here's what I hold.\n\nYou're moving to Oakland in March.") === `Here's what I hold.\n\nYou're moving to Oakland in March.\n\n${APPROVED}` && W.withProcessorLine(`Here's what I hold. ${APPROVED}`).split(APPROVED).length === 2 && W.withProcessorLine(`Here's what I hold. ${APPROVED}`).endsWith(`\n\n${APPROVED}`));
  check("...a copy inside a paragraph leaves one space, not two", W.withProcessorLine(`Oakland in March. ${APPROVED} Anything to change?`) === `Oakland in March. Anything to change?\n\n${APPROVED}` && W.withProcessorLine(`${APPROVED} Oakland in March.`) === `Oakland in March.\n\n${APPROVED}`);
  check("...and the fact line tells the model code adds it (so it doesn't write its own)", /code adds this line, word for word, as the last paragraph of your reply/.test(W.knownFact(W.groupKnown([]))));
  const { default: pool } = await import("../../src/db/db.js");
  const realQuery = pool.query.bind(pool), realConnect = (pool as any).connect;
  let claims: any[] = [];
  const handle = async (sql: string, p: any[] = []) => {
    if (/FROM member_claims WHERE user_id = \$1 ORDER BY said_on/.test(sql)) return { rows: claims };
    if (/UPDATE member_claims SET text = \$3/.test(sql)) { const c = claims.find((x) => x.id === p[0]); if (c) c.text = p[2]; return { rows: [], rowCount: c ? 1 : 0 }; }
    if (/INSERT INTO profile_corrections/.test(sql)) return { rows: [{ id: "1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  (pool as any).query = handle;
  (pool as any).connect = async () => ({ query: handle, release: () => {} });
  (await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  const turn = (message: string) => {
    const sent: string[] = [];
    const t = createConversationTools({ userId: "00000000-0000-4000-8000-00000000e337", phoneNumber: "+15550000337", resolvedContent: message, isVoice: true, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false, sendCoReply: async (o: any) => (sent.push(o.message), true), facts: { add: () => {}, text: () => "" } } as any);
    return { tools: t.tools as any, sent };
  };
  const reset = () => { claims = [{ id: "c2", text: "Jordan is moving to Oakland in March.", provenance: "user_said", kind: "city", quote: "moving to Oakland", expires_on: null }]; };
  reset();
  const ask = turn("what do you know about me?");
  const shown = await ask.tools.whatCoKnows.execute({}, {});
  await ask.tools.sendReply.execute({ message: "Here's what I hold: you're moving to Oakland in March." }, {});
  check("a \"what do you know about me\" turn: the reply ends with the processor line, word for word, added by code", shown?.ok === true && ask.sent.length === 1 && ask.sent[0].endsWith(`\n\n${APPROVED}`) && ask.sent[0].split(APPROVED).length === 2, ask.sent);
  reset();
  const fix = turn("actually I moved to Berkeley, not Oakland");
  await fix.tools.whatCoKnows.execute({}, {});
  const changed = await fix.tools.correctWhatCoKnows.execute({ changes: [{ refs: ["claim:c2"], action: "correct", now: "Berkeley" }], theirYes: "actually I moved to Berkeley, not Oakland", why: "they moved" }, {});
  await fix.tools.sendReply.execute({ message: "Got it, Berkeley it is. Fixed everywhere I use it." }, {});
  check("a correction turn (read the view to find it, then corrected): no processor line", changed?.ok === true && fix.sent.length === 1 && !fix.sent[0].includes(APPROVED) && !fix.sent[0].includes("OpenAI"), { changed, sent: fix.sent });
  // A correction asked for but not applied (a ref that isn't on file) is still a correction turn: no line.
  reset();
  const tried = turn("no, I never said Oakland");
  await tried.tools.whatCoKnows.execute({}, {});
  const refused = await tried.tools.correctWhatCoKnows.execute({ changes: [{ refs: ["claim:nope"], action: "remove" }], theirYes: "no, I never said Oakland", why: "they denied it" }, {});
  await tried.tools.sendReply.execute({ message: "I couldn't find that one to take out. Which line was it?" }, {});
  check("a correction turn whose change didn't apply: still no processor line", refused?.ok !== true && tried.sent.length === 1 && !tried.sent[0].includes(APPROVED), { refused, sent: tried.sent });
  (pool as any).query = realQuery;
  (pool as any).connect = realConnect;
}

// ---------------------------------------------------------------- ElevenLabs out of the call path
{
  const co = src("routes/co.ts");
  const trigger = src("services/callTrigger.ts");
  const calls = (fn: string) => (co.match(new RegExp(`\\b${fn}\\(`, "g")) ?? []).length;
  check("registerElevenLabsCall is called only inside the two old ElevenLabs answers", (co.match(/registerElevenLabsCall\(\{/g) ?? []).length === 2 && co.indexOf("registerElevenLabsCall({") > co.indexOf("async function elevenLabsInboundTwiml(") && co.lastIndexOf("registerElevenLabsCall({") > co.indexOf("async function elevenLabsOutboundTwiml("));
  check("...and nothing calls those answers (kept for the deletion PR)", calls("elevenLabsInboundTwiml") === 1 && calls("elevenLabsOutboundTwiml") === 1);
  check("the main number answers only through GPT-Live", (() => { const h = co.slice(co.indexOf('"/incoming-call"'), co.indexOf("async function elevenLabsInboundTwiml(")); return /const live = await gptLiveAnswer\(/.test(h) && /return res\.type\("text\/xml"\)\.send\(await gptLiveRefusalTwiml\(/.test(h); })());
  check("every dial is checked for GPT-Live, gets AMD, and its TwiML route answers only through GPT-Live", /if \(!live\.ok\) return gptLiveNotPlaced\(/.test(trigger) && /\.\.\.amdDialOptions\(process\.env\.API_URL\),/.test(trigger) && (() => { const h = co.slice(co.indexOf('router.post("/el/outbound-twiml"'), co.indexOf("async function elevenLabsOutboundTwiml(")); return /gptLiveAnswer\(/.test(h) && !/registerElevenLabsCall/.test(h); })());
  check("no team gate left on the call path (team only shapes the prompt)", !/refused: "not_team"/.test(co) && !/isTeamMember\(id\)/.test(src("services/gptLive.ts")));
  const elsewhere = fs.readdirSync(new URL("../../src/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts") && f !== "services/elevenLabsCalls.ts" && f !== "routes/co.ts");
  check("nothing else in the code places or registers an ElevenLabs call (no outbound-call API, no register-call)", elsewhere.every((f) => !/registerElevenLabsCall\(|conversationalAi\.twilio\.(registerCall|outboundCall)|outbound[-_]call/i.test(src(f))), elsewhere.filter((f) => /registerElevenLabsCall\(|conversationalAi\.twilio\.(registerCall|outboundCall)|outbound[-_]call/i.test(src(f))));
}

console.log(`everyone on gpt-live: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
