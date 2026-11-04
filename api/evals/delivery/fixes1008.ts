// The 2026-10-08 delivery review fixes (F1 to F6, F10/B2, B7, B5). Zero tokens: an in-memory receipt store, stubbed renders and
// sends, a pinned clock, and source checks only where the behavior lives in a tool that needs a live turn.
//   F1  a research brief's start backs "I'll text you the brief once it's ready"
//   F2  a brief goes through the receipts: its line, its version, one retry path for a failed PDF, never a text twice
//   F3  a plan is recorded like any document (text and email), so readDocument works on it
//   F4/F5 one resend rule everywhere: asked again, the same version; a change, the next; never on Co's own
//   F6  the limits say what a task can do
//   F10/B2 the document tool owns its one line; no second bubble
//   B7  a short hold line while the PDF is made, unless ✍️ already went
//   B5  yesterday's finds carried into today's turn, re-read when stale, only this member's
//   npx tsx evals/delivery/fixes1008.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const R = await import("../../src/services/deliveryReceipts.js");
const DD = await import("../../src/services/documentDelivery.js");
const DS = await import("../../src/services/documentSheet.js");
const RB = await import("../../src/services/researchBrief.js");
const MT = await import("../../src/services/memberTime.js");
const Cap = await import("../../src/services/capabilities.js");
const LT = await import("../../src/agent/loopTools.js");
const { STARTED_WORK } = await import("../../src/services/promises.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const SF = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);

// The real PDF sender with its I/O stubbed: every message that leaves is in `wire`.
function wired(o: { render?: "ok" | "fail"; sendFails?: boolean } = {}) {
  const wire: { number: string; content: string; media_url?: string }[] = [];
  let mode = o.render ?? "ok";
  let sendFails = !!o.sendFails;
  const deps: any = { render: async () => (mode === "ok" ? Buffer.from("%PDF") : null), cache: (_b: Buffer, name?: string) => `https://files.test/${name}`, send: async (m: any) => { if (sendFails) throw new Error("down"); wire.push(m); }, from: "+10000000000" };
  const deliver = (doc: any, to: any, target: any) => DD.deliverDocument(doc, to, target, deps);
  return { wire, deliver, receipts: R.memoryReceipts(), setRender: (m: "ok" | "fail") => { mode = m; }, setSendFails: (b: boolean) => { sendFails = b; } };
}

// ---------------------------------------------------------------- F1
{
  const lt = src("agent/loopTools.ts");
  check("F1: researchBrief's fact starts \"Started task #<id>:\"", lt.includes('ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: researching venues for them in the background') && !lt.includes("`Started researching a venue brief"));
  const filled = `Started task #412: researching venues for them in the background ("launch dinner for 40"). They come as finds by text when it's ready; nothing about options, prices or availability is known yet.`;
  check("F1: ...which is the shape that backs a promise (promises.ts STARTED_WORK)", STARTED_WORK.test(filled), filled.slice(0, 80));
  const { createReplyFacts, addFact, unbackedFollowup } = await import("../../src/harness/replyGrounding.js");
  const rf = createReplyFacts();
  addFact(rf, "did_this_turn", filled);
  check("F1: \"I'll text you the brief once it's ready\" stands on it", unbackedFollowup("On it. I'll text you the brief once it's ready.", rf) === null);
  check("F1: ...and without it, the same promise is unbacked", unbackedFollowup("On it. I'll text you the brief once it's ready.", createReplyFacts()) !== null);
}

const person = { firstName: "Jordan", phone: "+14155550123" };

// ---------------------------------------------------------------- F4/F5: one resend rule
{
  for (const m of ["can you send that plan again? I can't find it", "redo it", "regenerate it please", "send me that again", "can I get that again", "I lost it", "resend the plan please", "send it again"]) check(`F4: a re-ask: "${m}"`, DD.asksToResend(m));
  for (const m of ["can you update the plan with the budget", "redo it with the budget in", "send it again but add the dinner", "regenerate it without the second venue", "what does the budget section say?", "I can't make it tonight", "make it shorter"]) check(`F4: not a re-ask (a change, or not about it): "${m}"`, !DD.asksToResend(m));
  const doc = DS.resolveDocument({ title: "Cue Presence Plan: After the launch", kind: "partnership_plan", sections: [{ heading: "What you want", bullets: ["People still thinking about Cue a week later", "Not a one night thing"] }, { heading: "Budget", bullets: ["Split with the host 50/50"] }] });
  const h = wired();
  const send = (d: any, now: Date, o: any = {}) => DD.deliverAndRecord(d, { userId: "u1", firstName: "Jordan", phone: person.phone, zone: SF, now, line: "Here's the presence plan." }, { askedForGoogle: false, source: "reply", ...o }, { deliver: h.deliver, receipts: h.receipts, now: () => now });
  await send(doc, at("2026-10-08T17:00:00Z"));
  const refused = await send(doc, at("2026-10-08T18:00:00Z"));
  check("F5: the same artifact on Cue's own initiative: refused, and the refusal states the rule", !!refused.duplicate && /it goes again only when they ask for it again, never on your own/.test((refused.results[0] as any).why) && /readDocument/.test((refused.results[0] as any).why));
  const rewritten = { ...doc, note: "A slightly different line Cue wrote this time." };
  const again = await send(rewritten, at("2026-10-08T18:05:00Z"), { resend: true });
  check("F5: asked for it again, a rewrite of it isn't a new version: the version they have goes again, as is", again.sentOk.length === 1 && again.version === 1 && h.receipts.all[1].contentHash === h.receipts.all[0].contentHash && h.receipts.all[1].doc.note === doc.note);
  const v2 = await send({ ...doc, sections: [...doc.sections, { heading: "Dinner", paragraphs: [], bullets: ["Cue covers the dinner"] }] }, at("2026-10-08T19:00:00Z"), { revises: 1, changed: "added the dinner" });
  check("F5: a change is the next version, with its change line as the caption", v2.version === 2 && h.wire[h.wire.length - 1].content === "Added the dinner.");
  const lines = R.receiptLines(h.receipts.all, SF, at("2026-10-08T20:00:00Z"));
  check("F5: receipt lines carry the same rule (or ask for it again)", lines.length === 1 && lines[0].includes(R.RESEND_RULE) && /only when they ask for it again/.test(R.RESEND_RULE) && /never on your own/.test(R.RESEND_RULE));
  const w = Cap.ABILITIES.find((a) => a.id === "write_document")!;
  check("F5: the registry says the same rule, and no longer 'as many times as they ask' or 'never say it was already sent'", /asked for it again, the same version goes again; asked for a change, the next version/.test(w.can) && !/as many times as they ask/.test(w.can) && !/never say it was already sent/.test(w.use ?? "") && /Never send a document again on your own initiative/.test(w.use ?? ""));
  check("F5: a 4th explicit ask in a day isn't refused by the count (perDay above 3; the receipts stop repeats)", (w.limits?.perDay ?? 0) >= 4);
}

// ---------------------------------------------------------------- F6
{
  const L = Cap.LIMITS.join("\n");
  check("F6: 'can't chase down later' is scoped to outside a task", /Outside a task, Cue can't go chase down a specific link, detail, or answer later/.test(L) && /startTask, a research brief, or a promise it keeps/.test(L) && !/Beyond that, Cue can't go chase down/.test(L));
  check("F6: 'no specific time' is scoped to companion check-ins", /never promises a specific time for a companion check-in/.test(L) && /for work it took on as a task, it can truthfully say when it'll get back to them/.test(L) && !Cap.LIMITS.includes("Cue never promises a specific time for a check-in."));
}

// ---------------------------------------------------------------- F10/B2: the tool owns its one line
{
  const now = at("2026-10-08T17:00:00Z");
  const fresh = { title: "Cue Presence Plan: After the launch", kind: "partnership_plan", sendAt: now, zone: SF };
  check("F10: Cue's own line is the caption", (await DD.captionFor({ ...fresh, line: "Here's the presence plan, built around the dinner" })) === "Here's the presence plan, built around the dinner.");
  check("F10: no dashes, no exclamation points", (await DD.captionFor({ ...fresh, line: "Here's the plan — ready when you are!" })) === "Here's the plan, ready when you are.");
  check("F10: no line: the plain line", (await DD.captionFor(fresh)) === "Here's the Cue Presence Plan.");
  check("F10: a line that runs on is replaced by the plain one", (await DD.captionFor({ ...fresh, line: "Here it is. It covers the dinner. And the budget. And the follow up." })) === "Here's the Cue Presence Plan.");
  const late = { ...fresh, askedAt: at("2026-10-08T05:30:00Z"), sendAt: at("2026-10-08T15:00:00Z") }; // asked 10:30pm, sent 8am
  check("F10: a later delivery: no stale \"Got it\", and it must say when they asked", (await DD.captionFor({ ...late, line: "Got it, here's the presence plan." })) === "Here's the Cue Presence Plan you asked for last night.");
  check("F10: ...Co's own line kept when it says when", (await DD.captionFor({ ...late, line: "Here's the presence plan you asked for last night, with the dinner up front." })) === "Here's the presence plan you asked for last night, with the dinner up front.");
  check("F10: the input carries the line, shared by a reply and a task", "line" in DS.WRITE_DOCUMENT_INPUT.shape);
  // A task's document uses Co's line through the same rules.
  const THEIRS = "After the launch I want the people we meet to remember us. Not a one night thing. Split with the host 50/50.";
  const input = { title: "Cue Presence Plan: After the launch", kind: "partnership_plan" as const, sections: [{ heading: "What you want", bullets: ["People we meet remember us", "Not a one night thing"] }, { heading: "Budget", bullets: ["Split with the host 50/50"] }], line: "Here's the presence plan you asked for last night." };
  const h = wired();
  const o = { userId: "u1", taskId: 9, firstName: "Jordan", phone: person.phone, zone: SF, taskTheirWords: THEIRS, read: "", askedAt: at("2026-10-08T05:30:00Z") };
  const r = await DD.sendDocumentForTask(input as any, o, { theirWords: async () => THEIRS, blocked: async () => null, deliver: h.deliver, record: async () => {}, now: () => at("2026-10-08T15:00:00Z"), receipts: h.receipts });
  check("F10: a task's document goes with Cue's line, one send", r.ok && h.wire.length === 1 && h.wire[0].content === "Here's the presence plan you asked for last night.", { r, wire: h.wire });
  const lt = src("agent/loopTools.ts");
  const wd = lt.slice(lt.indexOf("writeDocument: tool({"), lt.indexOf("readDocument: tool({"));
  check("F10: the document tool ends with \"Delivered with its line; send nothing more about it unless you have a question for them.\"", LT.DELIVERED_NOTE === "Delivered with its line; send nothing more about it unless you have a question for them." && /DELIVERED_NOTE/.test(wd) && !/Say in one line what it covers/.test(lt) && !/Say in one line where it is; don't list the steps again/.test(lt));
  check("F10: both tools pass Cue's line through captionFor", /captionFor\(\{ line: input\.line/.test(wd));
  check("F10: the registry tells Cue the line is the whole delivery", /Give line: the one sentence that goes with the attachment/.test(Cap.ABILITIES.find((a) => a.id === "write_document")!.use ?? ""));
}

// ---------------------------------------------------------------- B7: a hold line while the PDF is made
{
  const lt = src("agent/loopTools.ts");
  const wd = lt.slice(lt.indexOf("writeDocument: tool({"), lt.indexOf("readDocument: tool({"));
  check("B7: the hold skips when ✍️ already went on their text this turn", /const holdWhileWriting = async \(line\?: string\) => \{\s*if \(ctx\.ackSent === "✍️"\) return;\s*await hold\(line\);/.test(lt));
  check("B7: writeDocument takes whileWriting and hold before the render", /whileWriting: z\.string\(\)\.optional\(\)/.test(wd) && wd.indexOf("holdWhileWriting(input.whileWriting)") > 0 && wd.indexOf("holdWhileWriting(input.whileWriting)") < wd.indexOf("deliverAndRecord(doc, to"));
}

// ---------------------------------------------------------------- B5: yesterday's finds in today's turn
{
  const now = at("2026-10-09T18:00:00Z").getTime();
  const loop = LT.newLoopState(now);
  loop.found.set("https://lu.ma/today", { name: "Found this turn", url: "https://lu.ma/today", facts: "fresh", match: null, blocked: null });
  const n = LT.seedFound(loop, [
    { name: "Old copy", url: "https://lu.ma/today", facts: "old", checkedAt: "2026-10-08T18:00:00Z", freshUntil: now - 1 },
    { name: "Rooftop Salon", url: "https://lu.ma/salon", facts: "Rooftop Salon on 2026-10-10", checkedAt: "2026-10-08T17:00:00Z", freshUntil: at("2026-10-09T17:00:00Z").getTime() },
    { name: "Nopa Private Events", url: "https://nopasf.com/private-events", facts: "Capacity: 40 people; Rate: $200 an hour", checkedAt: "2026-10-09T10:00:00Z", freshUntil: at("2026-10-10T10:00:00Z").getTime() },
    { name: "Shortlisted", url: "https://x.example/s", facts: "note", checkedAt: null, freshUntil: null },
  ]);
  check("B5: yesterday's finds are seeded; what this turn found wins", n === 3 && loop.found.get("https://lu.ma/today")?.facts === "fresh" && loop.found.get("https://lu.ma/salon")?.stored === true);
  const salon = loop.found.get("https://lu.ma/salon")!;
  const nopa = loop.found.get("https://nopasf.com/private-events")!;
  check("B5: past its window (or never dated) a find backs nothing; inside it, it does", LT.staleFind(salon, now) && LT.usableFacts(salon, now) === "" && !LT.staleFind(nopa, now) && /\$200 an hour/.test(LT.usableFacts(nopa, now)) && LT.staleFind(loop.found.get("https://x.example/s")!, now));
  const nopaAfter = loop.found.get("https://nopasf.com/private-events")!;
  LT.refreshFound(nopaAfter, "Capacity: 40 people; Rate: $250 an hour", now);
  check("B5: a page read again replaces what it said then and is fresh from now", /\$250/.test(nopaAfter.facts) && !/\$200/.test(nopaAfter.facts) && !LT.staleFind(nopaAfter, now) && nopaAfter.checkedAt === new Date(now).toISOString());
  const lt = src("agent/loopTools.ts");
  const sf = lt.slice(lt.indexOf("export async function storedFinds"), lt.indexOf("export function loopTools"));
  check("B5: every stored read is this member's own (user_id), nothing else's", /recentResearchFinds\(userId\)/.test(sf) && /recentShownFinds\(userId\)/.test(sf) && /WHERE owner_user_id = \$1 AND subject = 'co' AND relation = 'sent'/.test(sf) && /\[userId, SENT_EVENT_DAYS\]/.test(sf) && /loadBrief\(userId\)/.test(sf) && (sf.match(/pool\s*\.query\(/g) ?? []).length === 1);
  check("B5: the turn seeds once, on first use (never in tests), and the tools that cite a find wait for it", /const seeded = \(\): Promise<unknown> => \(seeding \?\?= ctx\.dryRun \|\| ctx\.stubSearch \? Promise\.resolve\(\) : storedFinds\(ctx\.userId\)/.test(lt) && (lt.match(/await seeded\(\);/g) ?? []).length >= 3);
  check("B5: documents and captions cite only fresh facts", /\$\{f\.name\} \$\{usableFacts\(f\)\}`\)\]\.join/.test(lt) && /captionProblems\(it\.caption, `\$\{f\.name\} \$\{usableFacts\(f\)\}`/.test(lt));
}

console.log(`delivery fixes 10-08: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
