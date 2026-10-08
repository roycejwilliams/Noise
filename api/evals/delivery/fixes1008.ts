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
const PE = await import("../../src/services/planEmail.js");
const PS = await import("../../src/services/planSheet.js");
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
  check("F1: researchBrief's fact starts \"Started task #<id>:\"", lt.includes('ctx.facts?.add("did_this_turn", `Started task #${r.task.id}: researching a venue brief for them in the background') && !lt.includes("`Started researching a venue brief"));
  const filled = `Started task #412: researching a venue brief for them in the background ("launch dinner for 40"). It comes as a document when it's ready; nothing about options, prices or availability is known yet.`;
  check("F1: ...which is the shape that backs a promise (promises.ts STARTED_WORK)", STARTED_WORK.test(filled), filled.slice(0, 80));
  const { createReplyFacts, addFact, unbackedFollowup } = await import("../../src/harness/replyGrounding.js");
  const rf = createReplyFacts();
  addFact(rf, "did_this_turn", filled);
  check("F1: \"I'll text you the brief once it's ready\" stands on it", unbackedFollowup("On it. I'll text you the brief once it's ready.", rf) === null);
  check("F1: ...and without it, the same promise is unbacked", unbackedFollowup("On it. I'll text you the brief once it's ready.", createReplyFacts()) !== null);
}

// ---------------------------------------------------------------- F2: briefs through the receipts
const opt = (name: string, url: string, checkedAt = "2026-10-08T17:00:00.000Z") => ({ name, url, checkedAt, reader: "scripted" as const, fields: RB.peerspaceFields({ hourlyPrice: 125, priceRange: null, minimumHours: 2, capacity: 50, available: "yes", evidence: "" }, { date: "2026-10-22", start: "6:00 pm" }, checkedAt) });
const BRIEF = RB.buildBrief({ title: "Venue options: launch dinner for 40", asked: "launch dinner for 40", finds: [opt("Shaws", "https://www.peerspace.com/pages/listings/636c4558d6990c0022346e9d"), opt("Copra", "https://www.peerspace.com/pages/listings/636c4558d6990c0022346e9e")], memberContext: [], zone: SF });
const task = { id: 412, userId: "u1", createdAt: "2026-10-08T16:00:00.000Z", theirWords: "find venues for my launch dinner for 40" }; // 9am SF
const person = { firstName: "Jordan", phone: "+14155550123" };
const openHours = async (_u: string, zone: string | null, now: Date, o: { immediate?: boolean } = {}) => (!o.immediate && !MT.deliverableAt(now, zone) ? DD.QUIET_HOURS : null);
const briefDeps = (h: ReturnType<typeof wired>, now: Date, extra: any = {}) => ({ deliver: h.deliver, receipts: h.receipts, now: () => now, blocked: openHours, record: async () => {}, log: async () => {}, ...extra });
{
  const h = wired();
  const noon = at("2026-10-08T19:00:00Z"); // noon SF, three hours after they asked
  const r = await RB.deliverBrief(BRIEF, { task, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h, noon));
  const rec = h.receipts.all[0];
  check("F2: a brief goes with its one line, saying when they asked", r.sent && h.wire.length === 1 && !!h.wire[0].media_url && h.wire[0].content === "Here's the venue brief you asked for earlier today.", h.wire);
  check("F2: ...and is recorded: a receipt with the task, its source, a key from what it's for", !!rec && rec.taskId === 412 && rec.source === "task:412" && rec.docKey === "venue-brief-launch-dinner-for-40" && rec.version === 1 && rec.status === "delivered", rec);
  check("F2: it shows under the documents delivered", /^Delivered "Venue options: launch dinner for 40" \(doc #1, version 1\)/.test(R.receiptLines(h.receipts.all, SF, noon)[0] ?? ""));
}
{
  // The render fails: the text goes now with "PDF follows", the receipt is pdf_pending, the brief counts as sent (no pendingDoc), and
  // the receipt retry is the one path that sends the PDF. The text never goes twice.
  const h = wired({ render: "fail" });
  const noon = at("2026-10-08T19:00:00Z");
  const r = await RB.deliverBrief(BRIEF, { task, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h, noon));
  check("F2: a failed render: the brief as text now, its line first, saying the PDF follows", r.sent && (r as any).pdfPending === true && h.wire.length === 1 && !h.wire[0].media_url && h.wire[0].content.startsWith("Here's the venue brief you asked for earlier today.") && /The PDF version will follow\.$/.test(h.wire[0].content), h.wire);
  check("F2: ...recorded as pdf_pending with a retry set (the one retry path for it)", h.receipts.all.length === 1 && h.receipts.all[0].status === "pdf_pending" && !!h.receipts.all[0].nextRetryAt);
  h.setRender("ok");
  const deps = { receipts: h.receipts, deliver: h.deliver, person: async () => ({ firstName: "Jordan", phone: person.phone, zone: SF }), blocked: async () => null, log: async () => {} };
  const due = new Date(h.receipts.all[0].nextRetryAt!.getTime() + 1000);
  const fixed = await DD.retryPendingPdfs(due, deps);
  const again = await DD.retryPendingPdfs(new Date(due.getTime() + 3_600_000), deps);
  check("F2: the PDF follows once from the receipt, with its own line; the text never again", fixed.sent === 1 && again.sent === 0 && h.wire.length === 2 && !!h.wire[1].media_url && h.wire[1].content === "Here's the PDF version of the venue brief." && h.wire.filter((m) => /The PDF version will follow/.test(m.content)).length === 1, h.wire);
  const rb = src("services/researchBrief.ts");
  const run = rb.slice(rb.indexOf("export async function runResearchBriefTask"));
  check("F2: the task closes on a sent brief (pdfPending included) and keeps pendingDoc only when nothing reached them", /if \(!delivered\.sent\) \{[\s\S]{0,500}holdBriefDoc\(/.test(run) && /const sent = delivered\.sent;/.test(run) && /if \(r\.sent\) \{\s*await closeTask/.test(run));
  check("F2: no brief path calls deliverDocument directly any more (every send is deliverAndRecord)", !/deliverDocument\(/.test(run) && /D\.deliverAndRecord\(/.test(rb));
}
{
  // Nothing reached them (render and text both failed): no receipt, so no receipt retry; the brief's own pendingDoc is the one path.
  const h = wired({ render: "fail", sendFails: true });
  const r = await RB.deliverBrief(BRIEF, { task, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h, at("2026-10-08T19:00:00Z")));
  check("F2: nothing reached them: not sent, no receipt, nothing for the receipt retry", !r.sent && h.receipts.all.length === 0 && (await h.receipts.duePdfRetries(at("2026-10-09T19:00:00Z"))).length === 0, r);
}
{
  // Their quiet hours: held to 8am, not sent at night; asked for it right away, it goes.
  const h = wired();
  const twoAm = at("2026-10-09T09:00:00Z");
  const r = await RB.deliverBrief(BRIEF, { task, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h, twoAm));
  check("F2: a brief ready at 2am waits for their 8am, nothing sent at night", !r.sent && (r as any).quietUntil?.toISOString() === "2026-10-09T15:00:00.000Z" && h.wire.length === 0, r);
  const h2 = wired();
  const r2 = await RB.deliverBrief(BRIEF, { task: { ...task, theirWords: `${task.theirWords}, send it right away` }, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h2, twoAm));
  check("F2: ...unless they asked for it right away", r2.sent && h2.wire.length === 1);
  const r3 = await RB.deliverBrief(BRIEF, { task, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h, at("2026-10-09T15:00:00Z")));
  check("F2: at 8am it goes, saying when they asked", r3.sent && h.wire[0]?.content === "Here's the venue brief you asked for yesterday.", h.wire);
  check("F2: a pause on proactive outreach doesn't hold a brief they asked for; their opt-out does (documentSendBlocked asked)", /if \(!o\.asked && proactivePaused\(\)\)/.test(src("services/documentDelivery.ts")) && /asked: true/.test(src("services/researchBrief.ts")));
}
{
  // Asked again: unchanged, the same version again; re-checked and changed, the next version with its change line.
  const h = wired();
  const t0 = at("2026-10-08T19:00:00Z");
  await RB.deliverBrief(BRIEF, { task, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: false, rechecked: 0 }, briefDeps(h, t0));
  const same = await RB.deliverBrief(BRIEF, { task: { ...task, id: 413 }, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: true, rechecked: 0 }, briefDeps(h, at("2026-10-08T20:00:00Z")));
  check("F2: the same brief asked again: the same version goes again", same.sent && h.wire.length === 2 && h.receipts.all[1].version === 1);
  const changed = { ...BRIEF, sections: BRIEF.sections.slice(1) };
  const v2 = await RB.deliverBrief(changed, { task: { ...task, id: 414 }, person, zone: SF, wantsGoogle: false, what: "launch dinner for 40", again: true, rechecked: 2 }, briefDeps(h, at("2026-10-08T21:00:00Z")));
  check("F2: re-checked and changed: version 2, its one line says what changed", v2.sent && h.receipts.all[2].version === 2 && h.wire[2].content === "Updated the venue brief: rechecked 2 options against their own pages.", h.wire[2]);
  const other = await RB.deliverBrief({ ...BRIEF, title: "Venue options: rooftop party" }, { task: { ...task, id: 415 }, person, zone: SF, wantsGoogle: false, what: "rooftop party", again: false, rechecked: 0 }, briefDeps(h, at("2026-10-08T21:30:00Z")));
  check("F2: a brief for something else is its own document, not a version of the last", other.sent && h.receipts.all[3].version === 1 && h.receipts.all[3].docKey === "venue-brief-rooftop-party");
}

// ---------------------------------------------------------------- F3: plans recorded
{
  const plan = PS.resolvePlan({ title: "Saturday in Sonoma", note: "A slow day, the way you described it.", steps: [{ what: "Tasting at the winery", when: "2026-10-10T13:00", until: "2026-10-10T15:00", where: "Sonoma Plaza" }, { what: "Dinner", when: "2026-10-10T19:00" }], notes: ["Bring a jacket"] }, SF, () => null);
  const doc = PE.planAsDoc(plan);
  check("F3: a plan becomes a document: its steps and notes as sections", doc.title === "Saturday in Sonoma" && doc.sections[0].heading === "The plan" && /^Sat Oct 10, 1 pm to 3 pm: Tasting at the winery, Sonoma Plaza$/.test(doc.sections[0].bullets[0]) && doc.sections[1].bullets[0] === "Bring a jacket", doc.sections);
  const h = wired();
  const t = at("2026-10-08T19:00:00Z");
  const sheet = Buffer.from("%PDF plan sheet");
  let rendered: Buffer | null = null;
  const deliver = (d: any, to: any, target: any) => DD.deliverDocument(d, to, target, { render: async () => sheet, cache: (b: Buffer, name?: string) => { rendered = b; return `https://files.test/${name}`; }, send: async (m: any) => { h.wire.push(m); }, from: "+1" } as any);
  const rd = await DD.deliverAndRecord(doc, { userId: "u1", firstName: "Jordan", phone: person.phone, zone: SF, now: t, line: "Here's the plan for Saturday." }, { askedForGoogle: false, source: "reply:plan" }, { deliver, receipts: h.receipts, now: () => t });
  check("F3: the plan's own sheet is the attachment, with its line, and a receipt", rd.sentOk.length === 1 && rendered === sheet && h.wire[0].content === "Here's the plan for Saturday." && h.receipts.all[0].source === "reply:plan", h.wire);
  await DD.recordSent(doc, { userId: "u1", channel: "email", line: null, source: "reply:plan", now: at("2026-10-08T19:01:00Z") }, h.receipts);
  check("F3: the email is recorded too, as the same version", h.receipts.all.length === 2 && h.receipts.all[1].channel === "email" && h.receipts.all[1].version === 1);
  check("F3: the plan shows under the documents delivered (newest: to their email)", /^Delivered "Saturday in Sonoma" \(doc #2, version 1\) to their email/.test(R.receiptLines(h.receipts.all, SF, t)[0] ?? ""), R.receiptLines(h.receipts.all, SF, t));
  check("F3: readDocument can answer from it (the section found, verbatim)", R.findSection(h.receipts.all[0].doc, "what time is the winery tasting?")?.text.includes("Tasting at the winery") === true);
  const dup = await DD.deliverAndRecord(doc, { userId: "u1", firstName: "Jordan", phone: person.phone, zone: SF, now: t }, { askedForGoogle: false, source: "reply:plan" }, { deliver, receipts: h.receipts, now: () => t });
  check("F3: the same plan again on Co's own: refused", !!dup.duplicate && h.wire.length === 1);
  check("F3: the table takes 'email' (the check widened on tables made before)", /channel IN \('pdf_text','google_docs','text_fallback','email'\)/.test(src("db/migrations.ts")) && /DROP CONSTRAINT IF EXISTS document_deliveries_channel_check/.test(src("db/migrations.ts")));
  const lt = src("agent/loopTools.ts");
  const ep = lt.slice(lt.indexOf("emailPlan: tool({"), lt.indexOf("researchBrief: tool({"));
  check("F3: emailPlan sends by text through deliverAndRecord and records the email with recordSent", /D\.deliverAndRecord\(doc,/.test(ep) && /D\.recordSent\(doc, \{ userId: ctx\.userId, channel: "email"/.test(ep) && /resend: D\.asksToResend\(theirWords\(\)\)/.test(ep));
}

// ---------------------------------------------------------------- F4/F5: one resend rule
{
  for (const m of ["can you send that plan again? I can't find it", "redo it", "regenerate it please", "send me that again", "can I get that again", "I lost it", "resend the plan please", "send it again"]) check(`F4: a re-ask: "${m}"`, DD.asksToResend(m));
  for (const m of ["can you update the plan with the budget", "redo it with the budget in", "send it again but add the dinner", "regenerate it without the second venue", "what does the budget section say?", "I can't make it tonight", "make it shorter"]) check(`F4: not a re-ask (a change, or not about it): "${m}"`, !DD.asksToResend(m));
  const doc = DS.resolveDocument({ title: "Co Presence Plan: After the launch", kind: "partnership_plan", sections: [{ heading: "What you want", bullets: ["People still thinking about Co a week later", "Not a one night thing"] }, { heading: "Budget", bullets: ["Split with the host 50/50"] }] });
  const h = wired();
  const send = (d: any, now: Date, o: any = {}) => DD.deliverAndRecord(d, { userId: "u1", firstName: "Jordan", phone: person.phone, zone: SF, now, line: "Here's the presence plan." }, { askedForGoogle: false, source: "reply", ...o }, { deliver: h.deliver, receipts: h.receipts, now: () => now });
  await send(doc, at("2026-10-08T17:00:00Z"));
  const refused = await send(doc, at("2026-10-08T18:00:00Z"));
  check("F5: the same artifact on Co's own initiative: refused, and the refusal states the rule", !!refused.duplicate && /it goes again only when they ask for it again, never on your own/.test((refused.results[0] as any).why) && /readDocument/.test((refused.results[0] as any).why));
  const rewritten = { ...doc, note: "A slightly different line Co wrote this time." };
  const again = await send(rewritten, at("2026-10-08T18:05:00Z"), { resend: true });
  check("F5: asked for it again, a rewrite of it isn't a new version: the version they have goes again, as is", again.sentOk.length === 1 && again.version === 1 && h.receipts.all[1].contentHash === h.receipts.all[0].contentHash && h.receipts.all[1].doc.note === doc.note);
  const v2 = await send({ ...doc, sections: [...doc.sections, { heading: "Dinner", paragraphs: [], bullets: ["Co covers the dinner"] }] }, at("2026-10-08T19:00:00Z"), { revises: 1, changed: "added the dinner" });
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
  check("F6: 'can't chase down later' is scoped to outside a task", /Outside a task, Co can't go chase down a specific link, detail, or answer later/.test(L) && /startTask, a research brief, or a promise it keeps/.test(L) && !/Beyond that, Co can't go chase down/.test(L));
  check("F6: 'no specific time' is scoped to companion check-ins", /never promises a specific time for a companion check-in/.test(L) && /for work it took on as a task, it can truthfully say when it'll get back to them/.test(L) && !Cap.LIMITS.includes("Co never promises a specific time for a check-in."));
}

// ---------------------------------------------------------------- F10/B2: the tool owns its one line
{
  const now = at("2026-10-08T17:00:00Z");
  const fresh = { title: "Co Presence Plan: After the launch", kind: "partnership_plan", sendAt: now, zone: SF };
  check("F10: Co's own line is the caption", (await DD.captionFor({ ...fresh, line: "Here's the presence plan, built around the dinner" })) === "Here's the presence plan, built around the dinner.");
  check("F10: no dashes, no exclamation points", (await DD.captionFor({ ...fresh, line: "Here's the plan — ready when you are!" })) === "Here's the plan, ready when you are.");
  check("F10: no line: the plain line", (await DD.captionFor(fresh)) === "Here's the Co Presence Plan.");
  check("F10: a line that runs on is replaced by the plain one", (await DD.captionFor({ ...fresh, line: "Here it is. It covers the dinner. And the budget. And the follow up." })) === "Here's the Co Presence Plan.");
  const late = { ...fresh, askedAt: at("2026-10-08T05:30:00Z"), sendAt: at("2026-10-08T15:00:00Z") }; // asked 10:30pm, sent 8am
  check("F10: a later delivery: no stale \"Got it\", and it must say when they asked", (await DD.captionFor({ ...late, line: "Got it, here's the presence plan." })) === "Here's the Co Presence Plan you asked for last night.");
  check("F10: ...Co's own line kept when it says when", (await DD.captionFor({ ...late, line: "Here's the presence plan you asked for last night, with the dinner up front." })) === "Here's the presence plan you asked for last night, with the dinner up front.");
  check("F10: the input carries the line, shared by a reply and a task", "line" in DS.WRITE_DOCUMENT_INPUT.shape);
  // A task's document uses Co's line through the same rules.
  const THEIRS = "After the launch I want the people we meet to remember us. Not a one night thing. Split with the host 50/50.";
  const input = { title: "Co Presence Plan: After the launch", kind: "partnership_plan" as const, sections: [{ heading: "What you want", bullets: ["People we meet remember us", "Not a one night thing"] }, { heading: "Budget", bullets: ["Split with the host 50/50"] }], line: "Here's the presence plan you asked for last night." };
  const h = wired();
  const o = { userId: "u1", taskId: 9, firstName: "Jordan", phone: person.phone, zone: SF, taskTheirWords: THEIRS, read: "", askedAt: at("2026-10-08T05:30:00Z") };
  const r = await DD.sendDocumentForTask(input as any, o, { theirWords: async () => THEIRS, blocked: async () => null, deliver: h.deliver, record: async () => {}, now: () => at("2026-10-08T15:00:00Z"), receipts: h.receipts });
  check("F10: a task's document goes with Co's line, one send", r.ok && h.wire.length === 1 && h.wire[0].content === "Here's the presence plan you asked for last night.", { r, wire: h.wire });
  const lt = src("agent/loopTools.ts");
  const wd = lt.slice(lt.indexOf("writeDocument: tool({"), lt.indexOf("readDocument: tool({"));
  const ep = lt.slice(lt.indexOf("emailPlan: tool({"), lt.indexOf("researchBrief: tool({"));
  check("F10: both tools end with \"Delivered with its line; send nothing more about it unless you have a question for them.\"", LT.DELIVERED_NOTE === "Delivered with its line; send nothing more about it unless you have a question for them." && /DELIVERED_NOTE/.test(wd) && /DELIVERED_NOTE/.test(ep) && !/Say in one line what it covers/.test(lt) && !/Say in one line where it is; don't list the steps again/.test(lt));
  check("F10: both tools pass Co's line through captionFor", /captionFor\(\{ line: input\.line/.test(wd) && /captionFor\(\{ line: input\.line/.test(ep));
  check("F10: the registry tells Co the line is the whole delivery", /Give line: the one sentence that goes with the attachment/.test(Cap.ABILITIES.find((a) => a.id === "write_document")!.use ?? "") && /Give line: the one sentence that goes with the PDF/.test(Cap.ABILITIES.find((a) => a.id === "email_plan")!.use ?? ""));
}

// ---------------------------------------------------------------- B7: a hold line while the PDF is made
{
  const lt = src("agent/loopTools.ts");
  const wd = lt.slice(lt.indexOf("writeDocument: tool({"), lt.indexOf("readDocument: tool({"));
  const ep = lt.slice(lt.indexOf("emailPlan: tool({"), lt.indexOf("researchBrief: tool({"));
  check("B7: the hold skips when ✍️ already went on their text this turn", /const holdWhileWriting = async \(line\?: string\) => \{\s*if \(ctx\.ackSent === "✍️"\) return;\s*await hold\(line\);/.test(lt));
  check("B7: writeDocument and emailPlan take whileWriting and hold before the render", /whileWriting: z\.string\(\)\.optional\(\)/.test(wd) && wd.indexOf("holdWhileWriting(input.whileWriting)") > 0 && wd.indexOf("holdWhileWriting(input.whileWriting)") < wd.indexOf("deliverAndRecord(doc, to") && /whileWriting: z\.string\(\)\.optional\(\)/.test(ep) && ep.indexOf("holdWhileWriting(input.whileWriting)") < ep.indexOf("buildPlanFiles(plan"));
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
  check("B5: a stale event can't fill a plan step until it's re-read", /read its page again \(readPage\)/.test(LT.recordFromFound(salon, now)?.blocked ?? ""));
  // emailPlan's re-read: the event's own page, now, gives the step its time and place.
  const fetched: string[] = [];
  const details = { startAt: "2026-10-10T19:00:00-07:00", endAt: "2026-10-10T22:00:00-07:00", timezone: SF, venue: "The Rooftop", address: "1 Market St", soldOut: false };
  const refreshed = await LT.refreshStoredEvents(loop, ["https://lu.ma/salon", "https://nopasf.com/private-events"], async (u) => { fetched.push(u); return details; }, (u) => u.includes("lu.ma"), now);
  const rec = LT.recordFromFound(loop.found.get("https://lu.ma/salon"), now);
  check("B5: emailPlan re-reads yesterday's event (only events) and its record fills the step", refreshed === 1 && fetched.join() === "https://lu.ma/salon" && rec?.hasRecord === true && !rec.blocked && rec.startAt === details.startAt && rec.venue === "The Rooftop", rec);
  const plan = PS.resolvePlan({ title: "Saturday", note: "x", steps: [{ link: "https://lu.ma/salon", what: "Rooftop Salon" }] }, SF, (l) => LT.recordFromFound(loop.found.get(l), now));
  const problems = PS.planProblems({ title: "Saturday", note: "x", steps: [{ link: "https://lu.ma/salon", what: "Rooftop Salon" }] }, plan, { facts: "Rooftop Salon", theirs: "plan saturday", now: new Date(now), recordFor: (l) => LT.recordFromFound(loop.found.get(l), now) });
  check("B5: ...so a plan built today on yesterday's event passes, with its time from the record", problems.length === 0 && plan.steps[0].start?.toISO()?.startsWith("2026-10-10T19:00") === true, problems);
  const nopaAfter = loop.found.get("https://nopasf.com/private-events")!;
  LT.refreshFound(nopaAfter, "Capacity: 40 people; Rate: $250 an hour", now);
  check("B5: a page read again replaces what it said then and is fresh from now", /\$250/.test(nopaAfter.facts) && !/\$200/.test(nopaAfter.facts) && !LT.staleFind(nopaAfter, now) && nopaAfter.checkedAt === new Date(now).toISOString());
  const lt = src("agent/loopTools.ts");
  const sf = lt.slice(lt.indexOf("export async function storedFinds"), lt.indexOf("export function loopTools"));
  check("B5: every stored read is this member's own (user_id), nothing else's", /recentResearchFinds\(userId\)/.test(sf) && /recentShownFinds\(userId\)/.test(sf) && /WHERE owner_user_id = \$1 AND subject = 'co' AND relation = 'sent'/.test(sf) && /\[userId, SENT_EVENT_DAYS\]/.test(sf) && /loadBrief\(userId\)/.test(sf) && (sf.match(/pool\s*\.query\(/g) ?? []).length === 1);
  check("B5: the turn seeds once, on first use (never in tests), and the tools that cite a find wait for it", /const seeded = \(\): Promise<unknown> => \(seeding \?\?= ctx\.dryRun \|\| ctx\.stubSearch \? Promise\.resolve\(\) : storedFinds\(ctx\.userId\)/.test(lt) && (lt.match(/await seeded\(\);/g) ?? []).length >= 4);
  check("B5: plans, documents and captions cite only fresh facts", /usableFacts\(f\)\}`\), brief \? JSON\.stringify\(brief\)/.test(lt) && /\$\{f\.name\} \$\{usableFacts\(f\)\}`\)\]\.join/.test(lt) && /captionProblems\(it\.caption, `\$\{f\.name\} \$\{usableFacts\(f\)\}`/.test(lt));
  check("B5: emailPlan's recordFor reads the carried-in finds", /const recordFor = \(link: string\): EventRecord \| null => recordFromFound\(loop\.found\.get\(link\)\)/.test(lt) && /refreshStoredEvents\(loop, input\.steps/.test(lt));
}

console.log(`delivery fixes 10-08: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
