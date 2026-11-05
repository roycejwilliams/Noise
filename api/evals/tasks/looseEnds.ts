// Loose ends in what Co promises (2026-10-07):
//   1. a promise of "something" is kept only by something about it (not any document or link sent after it)
//   2. the missed-call text doesn't promise a retry nothing schedules
//   3. research briefs: one at a time, the member hears how it ended (held to their hours, never dropped), and the reply sees them
//   4. follow-ups handed to Co: the decider sees how long ago things were, knows the limits are code's, and the last look decides
// Layer 1: pure helpers, source checks, and the follow-up model scripted inside this process. Zero tokens.
//   npx tsx evals/tasks/looseEnds.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";

// The model, scripted: each Anthropic call takes the next answer; the request bodies are kept to read the tools offered.
type Answer = { tool: string; input: any } | { text: string };
const script: Answer[] = [];
const seen: any[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (!/api\.anthropic\.com/.test(url)) return prior(input, init);
  try { seen.push(JSON.parse(init?.body ?? "{}")); } catch { seen.push({}); }
  const a = script.shift() ?? { text: "Nothing more." };
  const usage = { input_tokens: 0, output_tokens: 0 };
  const content = "tool" in a ? [{ type: "tool_use", id: `toolu_${seen.length}`, name: a.tool, input: a.input }] : [{ type: "text", text: a.text }];
  return new Response(JSON.stringify({ id: `msg_${seen.length}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: "tool" in a ? "tool_use" : "end_turn", stop_sequence: null, usage }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const FT = await import("../../src/services/followThrough.js");
const CG = await import("../../src/harness/callGate.js");
const P = await import("../../src/harness/proactive.js");
const SP = await import("../../src/services/speakable.js");
const CT = await import("../../src/services/coTasks.js");
const RB = await import("../../src/services/researchBrief.js");
const FU = await import("../../src/services/followUps.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

// ---------------------------------------------------------------- 1. the loose "promise kept" rule
{
  const at = new Date("2026-10-07T18:00:00Z");
  const later = new Date("2026-10-07T19:00:00Z");
  const promise = { goal: "Keep your promise: find a rooftop for Maya's birthday dinner", theirWords: "can you find a rooftop for my birthday dinner, 10 people", at };
  const doc = (text: string, forThis = false) => ({ at: later, text, kind: "document" as const, forThis });
  const link = (text: string, forThis = false) => ({ at: later, text, kind: "link" as const, forThis });
  check("the promise is neither a document nor links (kind 'any')", !FT.wantsDocument(promise.goal, promise.theirWords));
  check("an unrelated document after it doesn't keep it", !FT.promiseKeptBy(promise, [doc("a document (PDF): Investor update outline")]).kept);
  check("an unrelated link after it doesn't keep it", !FT.promiseKeptBy(promise, [link("https://lu.ma/founders-supper")]).kept);
  check("a document about the promised thing keeps it", FT.promiseKeptBy(promise, [doc("a document (PDF): Rooftop options for the birthday dinner")]).kept);
  check("a link about it (from their words) keeps it", FT.promiseKeptBy(promise, [link("https://www.peerspace.com/rooftop-terrace-sf")]).kept);
  check("anything the task keeping the promise sent keeps it, whatever its title", FT.promiseKeptBy(promise, [doc("a document (PDF): Saturday shortlist", true)]).kept && FT.promiseKeptBy(promise, [link("https://example.com/x", true)]).kept);
  check("an unrelated document among the sends doesn't win over the related one", FT.promiseKeptBy(promise, [doc("a document (PDF): Investor update outline"), { ...doc("a document (PDF): Rooftop shortlist"), at: new Date("2026-10-07T20:00:00Z") }]).by?.text === "a document (PDF): Rooftop shortlist");
  check("a placeholder for their words ('said on a call') matches nothing", !FT.promiseKeptBy({ ...promise, goal: "Keep your promise: the thing from earlier", theirWords: "(said on a call)" }, [doc("a document (PDF): Said on a call notes")]).kept);
  check("a real text about it still keeps it; a stub doesn't", FT.promiseKeptBy(promise, [{ at: later, text: "Two rooftops that fit ten for the birthday dinner: ...", kind: "text" }]).kept && !FT.promiseKeptBy(promise, [{ at: later, text: "rooftop!", kind: "text" }]).kept);
  check("a document promise and a links promise are unchanged", FT.promiseKeptBy({ goal: "Keep your promise: write up the launch plan as a doc", at }, [doc("a document (PDF): Anything at all")]).kept && FT.promiseKeptBy({ goal: "Keep your promise: send those links", at }, [link("https://lu.ma/x")]).kept);
}

// ---------------------------------------------------------------- 2. the missed-call text
{
  const t = CG.missedCallText("Jordan");
  check("it doesn't promise a retry (nothing schedules one)", !/\btry again\b|\bi'?ll (?:call|try|ring)\b|\bcall(?:ing)? (?:you )?back\b/i.test(t));
  check("it invites them to reply or ask for a call", /reply/i.test(t) && /"call me"/.test(t));
  check("it passes the draft checks (voice, narration, length)", P.checkDraft(t, { maxChars: 320, maxSentences: 2 }).every((c) => c.pass) && SP.narratesInternalState(t) === null);
  check("no first name still reads as a sentence", CG.missedCallText(null).startsWith("I tried calling") && CG.missedCallText("  ").startsWith("I tried calling"));
  const jobs = src("jobs/index.ts");
  check("the cron sends missedCallText, and the old promise is gone", /missedCallText\(row\.first_name\)/.test(jobs) && !/I'll try again soon/.test(jobs));
  check("no scheduled retry exists that would make the old promise true (scheduled_calls are only booked by them)", !/INSERT INTO scheduled_calls/.test(jobs) && !/INSERT INTO scheduled_calls/.test(src("routes/co.ts")));
}

// ---------------------------------------------------------------- 3. research briefs
{
  // (a) one at a time
  check("no open brief: a new one may start", CT.briefAlreadyOpen([]) === null && CT.briefAlreadyOpen([{ status: "done", held: null }, { status: "dropped", held: null }]) === null);
  check("an open brief stops a second one", /already being put together/.test(CT.briefAlreadyOpen([{ status: "open", held: null }]) ?? ""));
  check("a finished brief waiting for their hours stops it too, and hands Cue the line to say now", /Tell them that now/.test(CT.briefAlreadyOpen([{ status: "open", held: { text: "I looked, but couldn't verify any venues that fit.", at: "" } }]) ?? ""));
  const ct = src("services/coTasks.ts");
  const start = ct.slice(ct.indexOf("export async function startResearchBrief"), ct.indexOf("// ---------------------------------------------------------------- research briefs, as the reply sees them"));
  check("the guard reads the open briefs themselves, not openTasks (which is work tasks only)", /briefAlreadyOpen\(await recentBriefs\(input\.userId\)\)/.test(start) && !/open\.some\(\(t\) => t\.kind === "research_brief"\)/.test(start));
  check("the insert re-checks, so two asks at once still make one brief", /WHERE NOT EXISTS \(SELECT 1 FROM co_tasks WHERE user_id = \$1 AND kind = 'research_brief' AND status = 'open'\)/.test(start));
  check("work tasks still read kind = 'work' only (counts, wake-ups)", /status = 'open' AND kind = 'work' ORDER BY/.test(ct) && /AND awaiting_reply AND kind = 'work'/.test(ct));

  // (b) the member hears how it ended
  check("sent (or already sent) = told", RB.briefLineOutcome({ sent: true }, 1) === "told" && RB.briefLineOutcome({ sent: false, reason: "already sent" }, 1) === "told");
  check("outside their hours = held to their morning", RB.briefLineOutcome({ sent: false, reason: "outside local hours" }, 1) === "hold");
  check("held only so long: a line that never fits stops holding", RB.briefLineOutcome({ sent: false, reason: "outside local hours" }, RB.BRIEF_HOLD_MAX_WAKES) === "untold");
  check("paused, opted out or failed = untold", ["proactive outreach is paused", "opted out", "boom"].every((reason) => RB.briefLineOutcome({ sent: false, reason }, 1) === "untold"));
  const rb = src("services/researchBrief.ts");
  check("no closing line goes through a fire-and-forget say() any more", !/await say\(/.test(rb) && (rb.match(/await tellThenClose\(/g) ?? []).length >= 3);
  check("told: closed as planned; held: the task stays open with the line and wakes in their hours; untold: dropped, saying so", /if \(next === "hold"\)[\s\S]{0,700}holdBriefLine\(task\.userId, task\.id, \{ text, messages, status, outcome, \.\.\.\(record\?\.length \? \{ record \} : \{\}\) \}, (?:held \?\? )?nextSendable\(new Date\(\), zone\)\)/.test(rb) && /closeTask\(task\.userId, task\.id, next === "told" \? status : "dropped", next === "told" \? outcome : `\$\{outcome\}; never told them/.test(rb));
  check("a held line is said on the next wake without running the find again", rb.indexOf("if (held?.text)") > 0 && rb.indexOf("if (held?.text)") < rb.indexOf("findVenueOptions(task.userId"));
  check("a brief that found nothing is closed as done only through tellThenClose (never before they're told)", !/closeTask\(task\.userId, task\.id, "done", `no brief/.test(rb));
  check("holdBriefLine only touches an open brief", /WHERE user_id = \$1 AND id = \$2 AND status = 'open' AND kind = 'research_brief'/.test(ct));

  // (c) the reply sees them
  const B = (o: Partial<import("../../src/services/coTasks.js").BriefView>) => ({ id: 7, goal: "Venue options: private dinner for twelve", theirWords: "find me a private dining room for twelve", status: "open" as const, createdAt: "2026-10-07T17:00:00Z", closedAt: null, outcome: null, held: null, ...o });
  const [running, held, done, dropped] = CT.briefFactLines([B({}), B({ held: { text: "I looked, but couldn't verify any venues that fit. Want me to widen the search?", at: "2026-10-08T16:00:00Z" } }), B({ status: "done", closedAt: "2026-10-07T17:20:00Z", outcome: 'sent the brief "Venue options": 1. Spruce; 2. Quince' }), B({ status: "dropped", closedAt: "2026-10-07T17:20:00Z", outcome: "asked them first: missing headcount" })], "America/Los_Angeles");
  check("a running brief reads as work in progress, in their time", /^Cue is putting together research brief #7/.test(running) && /PDT/.test(running));
  check("a held brief says what it came to and when it goes", /hasn't reached them yet/.test(held) && /widen the search/.test(held) && /around /.test(held));
  check("a sent brief carries what went out (numbered options)", /finished/.test(done) && /1\. Spruce; 2\. Quince/.test(done));
  check("a stopped brief says why", /without a brief: asked them first/.test(dropped));
  const tc = src("services/turnContext.ts");
  check("the reply's turn loads briefs next to tasks (tasks stay work-only, so the task tools' count is unchanged)", /recentBriefs\(userId\)\.then\(\(b\) => briefFactLines\(b, zone\)\)/.test(tc) && /openTasks\(userId\)\.then\(\(t\) => taskFactLines\(t, undefined, zone\)\)/.test(tc));
  check("the reply's facts include them: running/held as scheduled, finished as Cue's record", /for \(const line of opts\.turn\?\.briefs \?\? \[\]\) addFact\(rf, \/\^\(\?:Co\|Cue\) is putting together\|hasn't reached them yet\/\.test\(line\) \? "scheduled" : "did_before", line\)/.test(src("harness/replyGrounding.ts")));
  check("open loops carry a brief in progress (it closes by the same task-status read)", /kind IN \('work', 'research_brief'\)/.test(src("services/openLoops.ts")));
}

// ---------------------------------------------------------------- 4. follow-ups handed to Co
{
  const now = new Date("2026-10-07T20:00:00Z");
  check("ago() needs no time zone", FU.ago(new Date(now.getTime() - 60_000), now) === "just now" && FU.ago(new Date(now.getTime() - 40 * 60_000), now) === "40 min ago" && FU.ago(new Date(now.getTime() - 5 * 3_600_000), now) === "5h ago" && FU.ago(new Date(now.getTime() - 3 * 86_400_000), now) === "3d ago");
  check("what it's about comes from the payload", FU.aboutLines({ askText: "a rooftop for ten", eventName: "Supper Club", eventDate: "2026-10-08" }).join(" | ") === 'What they asked for: "a rooftop for ten" | The event: Supper Club (2026-10-08)' && FU.aboutLines(null).length === 0);
  const task = (wakes: number): any => ({ id: 1, userId: "u", goal: "Ask how the pitch went", wakes, createdAt: now.toISOString(), followup: { type: "companion", summary: "Ask how the pitch went", payload: { advice: "Say the ask early." } } });
  const prompt = FU.followUpPrompt({ task: task(1), firstName: "Sam", recent: "[2d ago] User said: pitching Friday", recentSends: "- 3d ago: companion", now: "2026-10-07T20:00", dueSince: "3h ago" });
  check("the prompt says it's due, and how long ago", /It came due 3h ago/.test(prompt));
  check("the prompt names the hours, volume and pause as the send path's job", /their hours, how many texts they've had, and the pause after texts they haven't answered are all enforced when it sends/.test(prompt) && /don't put it off for the time of day/.test(prompt));
  check("later needs a reason in the thread", /- later: only for a reason you can point to in the thread/.test(prompt));
  check("the payload's detail is in the prompt", /What you told them: "Say the ask early\."/.test(prompt));
  const last = FU.followUpPrompt({ task: task(FU.FOLLOWUP_LIMITS.maxWakes), firstName: "Sam", recent: "", recentSends: "", now: "2026-10-07T20:00" });
  check("the last look offers no later", !/- later:/.test(last) && /This is the last look: check in now or skip/.test(last));
  const fu = src("services/followUps.ts");
  check("the thread and the sends carry how long ago (not bare UTC stamps)", /recent: k \? exchangeText\(k\.exchanges, \(at\) => ago\(at, asOf\)\)/.test(fu) && /`\[\$\{stamp\(x\.verifiedAt\)\}\] \$\{l\}`/.test(fu) && /`- \$\{ago\(s\.sent_at, asOf\)\}: \$\{s\.type\}`/.test(fu) && /\[3h ago\] User said: hi/.test(FU.exchangeText([{ from: "member", text: "hi", call: false, verifiedAt: new Date(now.getTime() - 3 * 3_600_000).toISOString() }], (at) => FU.ago(at, now))));
  // Another member's details: stripped inside the layer (services/memberKnowledge.ts, every string; evals/member/knowledge.ts),
  // and a teammate's lines dropped per line.
  check("another member's lines are still stripped, per row", /memberKnowledge\(userId, \{ now: asOf,/.test(fu) && /return stripDeep\(k, strip\);/.test(src("services/memberKnowledge.ts")) && /withoutTeammateLines\(`\$\{head\}\$\{x\.text\}`\)/.test(fu) && !/pool\.query\(`SELECT content[^`]*text_exchange/.test(fu.replace(/export function exchangesAsOf[\s\S]*?\n}\n/, "")));
  check("'now' still goes through the same queue and daily pick (every limit applies)", /enqueueCandidate\(\{ userId, type: f\.type as any, [^}]*fromCo: true \}\)/.test(fu));

  // The tools actually offered, through the real decider with the model scripted.
  let did = "";
  const deps = { firstName: "Sam", recent: "", recentSends: "", now: () => now, checkInNow: async () => { did = "now"; return true; }, later: async () => { did = "later"; }, skip: async () => { did = "skip"; } };
  seen.length = 0;
  script.push({ tool: "checkInNow", input: { why: "it happened and they haven't said" } });
  const r1 = await FU.runFollowUpTurnWith(task(2), deps);
  const tools1 = (seen[0]?.tools ?? []).map((t: any) => t.name).sort().join(",");
  check("an ordinary look offers now, later and skip, and 'now' runs checkInNow", tools1 === "checkInNow,later,skip" && r1.action === "now" && did === "now");
  seen.length = 0;
  script.push({ tool: "skip", input: { why: "they told me how it went" } });
  const r2 = await FU.runFollowUpTurnWith(task(FU.FOLLOWUP_LIMITS.maxWakes), deps);
  const tools2 = (seen[0]?.tools ?? []).map((t: any) => t.name).sort().join(",");
  check("the last look offers only now or skip", tools2 === "checkInNow,skip" && r2.action === "skip" && did === "skip");
}

// ---- 2026-10-08 follow-on: "asked for space" is skip (a brief whose PDF won't send is gone with the document wrapper, 2026-11-04)
{
  const { narratesInternalState } = await import("../../src/services/speakable.js");
  const RB = await import("../../src/services/researchBrief.js");
  const t = (await RB.researchMessages([{ name: "Perbacco", url: "https://www.perbaccosf.com/dining/", checkedAt: "2026-10-08T17:00:00.000Z", reader: "scripted", fields: [] }], { firstName: "Jordan", ask: "a venue", context: [], draft: async ({ items }) => ({ captions: new Map(items.map((it) => [it.url, "A private dining room that fits the size you gave."])) }) })).messages.join("\n");
  check("a research result never narrates Cue's state", narratesInternalState(t) === null);
  const fu = src("services/followUps.ts");
  check("asking for space is skip, never later", /that is skip, never later/.test(fu) && /Never "later" because they asked for space/.test(fu));
}
console.log(`loose ends: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
