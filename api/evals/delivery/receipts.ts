// Delivery receipts, grounded follow-ups, the text fallback and delivery hours (Royce, 2026-10-08). Zero tokens: an in-memory
// receipt store, stubbed sends and renders, a pinned clock.
//   1. deliver a plan: a receipt (doc id, title, version, channel, who, when); the same artifact never goes twice
//   2. a follow-up question about a section: the answer comes from the delivered text (the section, verbatim, and the quote check)
//   3. a change request: the new version goes with one line naming the change; the receipts show only the newest version
//   4. a forced render failure: the content goes as text at once, saying the PDF follows; the failure is logged; the PDF follows
//      on retry inside their hours, and the text never goes twice
//   5. a delivery due at 2am lands at 8am (unless they asked for it right away)
// The live half of 2 (a real model answering with a quote) is evals/delivery/followUpLive.ts.
//   npx tsx evals/delivery/receipts.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const R = await import("../../src/services/deliveryReceipts.js");
const DD = await import("../../src/services/documentDelivery.js");
const DS = await import("../../src/services/documentSheet.js");
const MT = await import("../../src/services/memberTime.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const SF = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);

const PLAN = DS.resolveDocument({
  title: "Cue Presence Plan: After the Sequin AI November Event",
  note: "How Cue stays present after the November event, from what you told me.",
  kind: "partnership_plan",
  sections: [
    { heading: "What you want", bullets: ["People from the Sequin AI event still thinking about Cue a week later", "Not a one night thing"] },
    { heading: "Budget", paragraphs: ["Split the cost with Sequin AI, as Jacqueline agreed."], bullets: ["Venue at House of AI shared 50/50", "Cue covers the follow-up dinner"] },
    { heading: "Timeline", bullets: ["Recap text the morning after", "Small dinner within two weeks"] },
  ],
  suggestions: ["Send each new contact a short personal note within two days"],
});

// The real PDF and Google senders with their I/O stubbed: every message that leaves is in `wire`.
function harness(o: { render?: "ok" | "fail" } = {}) {
  const wire: { number: string; content: string; media_url?: string }[] = [];
  let renderMode = o.render ?? "ok";
  const pdfDeps: any = { render: async () => (renderMode === "ok" ? Buffer.from("%PDF") : null), cache: (_b: Buffer, name?: string) => `https://files.test/${name}`, send: async (m: any) => { wire.push(m); }, from: "+10000000000" };
  const deliver = (doc: any, to: any, target: any) => DD.deliverDocument(doc, to, target, pdfDeps);
  const receipts = R.memoryReceipts();
  const logs: any[] = [];
  const to = (now: Date, line?: string) => ({ userId: "u1", firstName: "Jordan", phone: "+14155550123", zone: SF, now, line });
  const send = (doc: any, now: Date, extra: any = {}) => DD.deliverAndRecord(doc, to(now, extra.line), { askedForGoogle: false, source: "test", ...extra }, { deliver, receipts, now: () => now, log: async (d) => { logs.push(d); } });
  return { wire, receipts, logs, deliver, send, setRender: (m: "ok" | "fail") => { renderMode = m; } };
}

// ---- 1. deliver a plan: a receipt; never the same artifact twice
{
  const h = harness();
  const t = at("2026-10-08T17:00:00Z"); // 10am SF
  const r = await h.send(PLAN, t, { line: "Here's the Cue Presence Plan." });
  const rec = r.receipts[0];
  check("delivered: one send, the PDF with its line", r.sentOk.length === 1 && h.wire.length === 1 && !!h.wire[0].media_url && h.wire[0].content === "Here's the Cue Presence Plan.", h.wire);
  check("receipt: doc id, title, version, channel, who, when", !!rec && rec.id > 0 && rec.title === PLAN.title && rec.version === 1 && rec.channel === "pdf_text" && rec.userId === "u1" && rec.deliveredAt.getTime() === t.getTime() && rec.status === "delivered", rec);
  check("receipt: the content itself is kept (what was sent, for follow-ups)", JSON.stringify(rec.doc) === JSON.stringify(PLAN) && rec.docKey === "cue-presence-plan-after-the-sequin-ai-november-event");
  const again = await h.send(PLAN, at("2026-10-08T18:00:00Z"));
  check("the same artifact again: refused, nothing sent, the existing receipt named", !again.sentOk.length && again.duplicate?.id === rec.id && h.wire.length === 1 && /already delivered \(doc #1, version 1/.test((again.results[0] as any).why), again.results);
  const asked = await h.send(PLAN, at("2026-10-08T18:05:00Z"), { resend: true });
  check("...unless they asked for it again in their own words (resend): it goes, recorded", asked.sentOk.length === 1 && h.wire.length === 2 && h.receipts.all.length === 2);
  check("a re-ask in their words is told apart from a question", DD.asksToResend("can you send that plan again? I can't find it") && !DD.asksToResend("what's in the budget part?"));
  const lines = R.receiptLines(h.receipts.all, SF, at("2026-10-08T19:00:00Z"));
  check("follow-up turns read the receipts: one line per artifact, its doc number, version, channel and when, never to resend", lines.length === 1 && /^Delivered "Cue Presence Plan: After the Sequin AI November Event" \(doc #\d+, version 1\) as a PDF in this conversation today at 11:05am\. Already theirs: send it again only when they ask for it again \(the same version goes\), as a new version only when they ask for a change/.test(lines[0]) && /never on your own/.test(lines[0]), lines);
  check("the reply reads them: turn context loads receipts, grounding lists them as Documents you've delivered", /deliveries = await import\("\.\/deliveryReceipts\.js"\)/.test(src("services/turnContext.ts")) && /Documents you've delivered: \$\{line\}/.test(src("harness/replyGrounding.ts")));
  check("both paths record: the reply's writeDocument and a task's document go through deliverAndRecord", /deliverAndRecord\(doc, to, \{ saveTo: input\.saveTo/.test(src("agent/loopTools.ts")) && /\brd = await deliverAndRecord\(doc, to,/.test(src("services/documentDelivery.ts")));
}

// ---- 2. a follow-up question about a section: answered from the delivered text, quoted
{
  const sec = R.findSection(PLAN, "how are we splitting the budget with Sequin?");
  check("the question finds its section, verbatim from what was sent", sec?.heading === "Budget" && sec.text.includes("Split the cost with Sequin AI, as Jacqueline agreed.") && sec.text.includes("Venue at House of AI shared 50/50"), sec);
  check("a timeline question finds the timeline", R.findSection(PLAN, "when does the dinner happen in the timeline?")?.heading === "Timeline");
  const quoting = 'The budget section says "Split the cost with Sequin AI, as Jacqueline agreed," with the venue at House of AI shared 50/50.';
  const fresh = "You'll probably want to split costs evenly and keep the dinner small.";
  check("the quote check: an answer quoting the section passes; a fresh generation doesn't", R.quotesDocument(quoting, PLAN) && !R.quotesDocument(fresh, PLAN));
  const reg = (await import("../../src/services/capabilities.js")).ABILITIES.find((a) => a.id === "read_document");
  check("Cue has the tool: readDocument, its registry entry tells Cue to quote and never answer from memory", reg?.tool === "readDocument" && /quoting the section's own words in quotation marks/.test(reg.use ?? "") && /Never answer about a delivered document from memory/.test(reg.use ?? ""));
  check("the tool returns the delivered section and every section, from the receipt", /const rec = await R\.pgReceipts\.get\(ctx\.userId, id\)/.test(src("agent/loopTools.ts")) && /section = about \? R\.findSection\(rec\.doc, about\)/.test(src("agent/loopTools.ts")));
}

// ---- 3. a change request: the new version, one line naming the change
{
  const h = harness();
  const v1 = await h.send(PLAN, at("2026-10-08T17:00:00Z"));
  const id = v1.receipts[0].id;
  const v2doc = { ...PLAN, sections: PLAN.sections.map((s) => (s.heading === "Budget" ? { ...s, bullets: ["Venue at House of AI shared 50/50", "Cue covers the follow-up dinner", "Catering split with Sequin AI"] } : s)) };
  const noNote = await h.send(v2doc, at("2026-10-08T20:00:00Z"), { revises: id });
  check("a new version without a change note is refused (it needs its one line)", !noNote.sentOk.length && /what changed/.test((noNote.results[0] as any).why));
  const v2 = await h.send(v2doc, at("2026-10-08T20:00:00Z"), { revises: id, changed: "updated the budget section" });
  const last = h.wire[h.wire.length - 1];
  check("the new version goes: version 2 of the same document", v2.sentOk.length === 1 && v2.version === 2 && v2.receipts[0].docKey === v1.receipts[0].docKey && v2.receipts[0].version === 2);
  check(`...with one line naming what changed ("${last.content}")`, last.content === "Updated the budget section." && !!last.media_url && h.wire.length === 2);
  check("a change note that isn't a verb phrase is framed", R.changeLine(PLAN.title, "the budget now includes catering") === "Updated the Cue Presence Plan: the budget now includes catering.");
  check("the receipt keeps the change note", v2.receipts[0].changeNote === "updated the budget section");
  const lines = R.receiptLines(h.receipts.all, SF, at("2026-10-08T21:00:00Z"));
  check("follow-ups see only the newest version, with what changed", lines.length === 1 && /version 2\)/.test(lines[0]) && /this version: updated the budget section/.test(lines[0]), lines);
  check("a revision of a document that isn't theirs is refused", /no document #999/.test(((await h.send(v2doc, at("2026-10-08T21:00:00Z"), { revises: 999, changed: "x" })).results[0] as any).why));
}

// ---- 4. a forced render failure: text now, saying the PDF follows; logged; the PDF follows on retry; text never twice
{
  const h = harness({ render: "fail" });
  const t = at("2026-10-08T19:00:00Z"); // noon SF
  const r = await h.send(PLAN, t, { line: "Here's the Cue Presence Plan you asked for last night." });
  const msg = h.wire[0];
  check("render failed: the content went as text at once, no attachment", r.sentOk.length === 1 && r.sentOk[0].via === "text_fallback" && h.wire.length === 1 && !msg.media_url, h.wire);
  check("...leading with its line, carrying the sections, saying the PDF follows", msg.content.startsWith("Here's the Cue Presence Plan you asked for last night.") && msg.content.includes("Split the cost with Sequin AI, as Jacqueline agreed.") && /The PDF version will follow\.$/.test(msg.content));
  const rec = r.receipts[0];
  check("receipt: text_fallback, the PDF pending, the failure kept, a retry set", rec.channel === "text_fallback" && rec.status === "pdf_pending" && /couldn't be made/.test(rec.error ?? "") && !!rec.nextRetryAt && rec.nextRetryAt > t);
  check("the failure is logged for retry", h.logs.some((d) => d.decision === "document.pdf_failed" && d.action === "sent_as_text"));
  check("follow-ups know the PDF is outstanding (and not to resend the document)", /^Outstanding: the PDF of "Cue Presence Plan/.test(R.receiptLines(h.receipts.all, SF, t)[0]) && /don't send the document again/.test(R.receiptLines(h.receipts.all, SF, t)[0]));
  const deps = { receipts: h.receipts, deliver: h.deliver, person: async () => ({ firstName: "Jordan", phone: "+14155550123", zone: SF }), blocked: async (_u: string, zone: string | null, now: Date) => (MT.deliverableAt(now, zone) ? null : DD.QUIET_HOURS), log: async (d: any) => { h.logs.push(d); }, rule: async () => ({ pass: true }) };
  const stillDown = await DD.retryPendingPdfs(new Date(rec.nextRetryAt!.getTime() + 1000), deps);
  check("retry while rendering is still down: no text again, another try later", stillDown.failed === 1 && h.wire.length === 1 && h.receipts.all[0].attempts === 1 && h.receipts.all[0].status === "pdf_pending");
  h.setRender("ok");
  const due = h.receipts.all[0].nextRetryAt!;
  const fixed = await DD.retryPendingPdfs(new Date(due.getTime() + 1000), deps);
  const pdfMsg = h.wire[h.wire.length - 1];
  check("retry once rendering works: the PDF follows with its own line", fixed.sent === 1 && h.wire.length === 2 && !!pdfMsg.media_url && pdfMsg.content === "Here's the PDF version of the Cue Presence Plan.", h.wire);
  check("...and the receipt is delivered as a PDF", h.receipts.all[0].status === "delivered" && h.receipts.all[0].channel === "pdf_text");
  // A retry that comes due in their quiet hours waits for their 8am.
  const h2 = harness({ render: "fail" });
  await h2.send(PLAN, at("2026-10-09T03:50:00Z")); // 8:50pm SF
  h2.setRender("ok");
  const deps2 = { ...deps, receipts: h2.receipts, deliver: h2.deliver };
  const night = await DD.retryPendingPdfs(at("2026-10-09T04:30:00Z"), deps2); // 9:30pm SF
  check("a PDF retry due in their quiet hours waits for 8am, nothing sent at night", night.waiting === 1 && h2.wire.length === 1 && h2.receipts.all[0].nextRetryAt?.toISOString() === "2026-10-09T15:00:00.000Z", h2.receipts.all[0].nextRetryAt);
  check("the retry runs on the 5-minute cron", /retryPendingPdfs\(\)/.test(src("jobs/index.ts")));
  // Both fail: a real failure, never silence claimed as sent.
  const both = await DD.deliverDocument(PLAN, { userId: "u1", firstName: "J", phone: "+1", zone: SF }, "pdf_text", { render: async () => null, cache: () => "x", send: async () => { throw new Error("down"); }, from: "+1" } as any);
  check("render and text both fail: a plain failure (the caller says so), never reported as sent", !both.ok);
}

// ---- 4b. the retry, after review of #106: superseded PDFs never go, quiet hours spend no attempts, a pause doesn't hold
//          their own ask, an unreachable member is closed, two runs never both send, a lost receipt never resends
{
  // No rule of theirs here (harness/notifyGate.ts is exercised in evals/preferences/enforce.ts).
  const base = { person: async () => ({ firstName: "Jordan", phone: "+14155550123", zone: SF }), log: async () => {}, rule: async () => ({ pass: true }) };
  const blockedBy = (state: { paused?: boolean; optedOut?: boolean }) => async (_u: string, zone: string | null, now: Date, o: { immediate?: boolean; asked?: boolean } = {}) =>
    !o.asked && state.paused ? "proactive outreach is paused" : !o.immediate && !MT.deliverableAt(now, zone) ? DD.QUIET_HOURS : state.optedOut ? "they opted out of texts" : null;
  const DAY = at("2026-10-08T19:00:00Z"); // noon SF
  // A new version goes while v1's PDF is still owed: v1's PDF never follows.
  const h = harness({ render: "fail" });
  const v1 = await h.send(PLAN, DAY);
  h.setRender("ok");
  const v2doc = { ...PLAN, sections: [...PLAN.sections, { heading: "Catering", paragraphs: [], bullets: ["Split with Sequin AI"] }] };
  await h.send(v2doc, new Date(DAY.getTime() + 60_000), { revises: v1.receipts[0].id, changed: "added catering" });
  const sentBefore = h.wire.length;
  await DD.retryPendingPdfs(new Date(DAY.getTime() + 20 * 60_000), { ...base, receipts: h.receipts, deliver: h.deliver, blocked: blockedBy({}) });
  check("a newer version went: the old version's pending PDF never follows", h.wire.length === sentBefore && h.receipts.all[0].status === "pdf_failed" && /superseded/.test(h.receipts.all[0].error ?? ""), h.receipts.all[0]);
  // Asked again while the PDF was owed: the resend is the delivery, the old retry never sends it a second time.
  const h2 = harness({ render: "fail" });
  await h2.send(PLAN, DAY);
  h2.setRender("ok");
  await h2.send(PLAN, new Date(DAY.getTime() + 60_000), { resend: true });
  const n2 = h2.wire.length;
  await DD.retryPendingPdfs(new Date(DAY.getTime() + 20 * 60_000), { ...base, receipts: h2.receipts, deliver: h2.deliver, blocked: blockedBy({}) });
  check("a resend while the PDF was owed: the retry doesn't send it again", h2.wire.length === n2);
  // Paused outreach: the PDF they were promised still follows (their own ask). Quiet hours: waits, no attempt spent.
  const h3 = harness({ render: "fail" });
  await h3.send(PLAN, DAY);
  h3.setRender("ok");
  const paused = await DD.retryPendingPdfs(new Date(DAY.getTime() + 20 * 60_000), { ...base, receipts: h3.receipts, deliver: h3.deliver, blocked: blockedBy({ paused: true }) });
  check("a pause doesn't hold the PDF they were told would follow", paused.sent === 1 && h3.receipts.all[0].status === "delivered");
  const h4 = harness({ render: "fail" });
  await h4.send(PLAN, at("2026-10-09T03:50:00Z")); // 8:50pm SF
  h4.setRender("ok");
  for (let i = 0; i < 6; i++) await DD.retryPendingPdfs(new Date(at("2026-10-09T04:00:00Z").getTime() + i * 3_600_000), { ...base, receipts: h4.receipts, deliver: h4.deliver, blocked: blockedBy({}) });
  check("quiet hours spend no attempts (six nightly runs, still 0)", h4.receipts.all[0].attempts === 0 && h4.receipts.all[0].status === "pdf_pending");
  const morning = await DD.retryPendingPdfs(at("2026-10-09T15:01:00Z"), { ...base, receipts: h4.receipts, deliver: h4.deliver, blocked: blockedBy({}) });
  check("...and at 8am the first real try sends it", morning.sent === 1 && h4.receipts.all[0].status === "delivered");
  // Opted out: closed, never polled again.
  const h5 = harness({ render: "fail" });
  await h5.send(PLAN, DAY);
  await DD.retryPendingPdfs(new Date(DAY.getTime() + 20 * 60_000), { ...base, receipts: h5.receipts, deliver: h5.deliver, blocked: blockedBy({ optedOut: true }) });
  check("an opted-out member's pending PDF is closed, not retried forever", h5.receipts.all[0].status === "pdf_failed" && h5.receipts.all[0].nextRetryAt === null);
  // Two runs at once: one claims, one skips.
  const h6 = harness({ render: "fail" });
  await h6.send(PLAN, DAY);
  h6.setRender("ok");
  const when = new Date(DAY.getTime() + 20 * 60_000);
  const both = await Promise.all([1, 2].map(() => DD.retryPendingPdfs(when, { ...base, receipts: h6.receipts, deliver: h6.deliver, blocked: blockedBy({}) })));
  check("two overlapping runs send the PDF once", both.reduce((n, r) => n + r.sent, 0) === 1 && h6.wire.filter((m) => m.media_url).length === 1);
  // The receipt can't be written after it sent: still reported as sent (never a "didn't go out" that would send it again).
  const h7 = harness();
  const broken = { ...h7.receipts, insert: async () => { throw new Error("db down"); } };
  const r7 = await DD.deliverAndRecord(PLAN, { userId: "u1", firstName: "Jordan", phone: "+14155550123", zone: SF, now: DAY }, { askedForGoogle: false, source: "test" }, { deliver: h7.deliver, receipts: broken as any, now: () => DAY, log: async () => {} });
  check("a receipt that can't be saved after the send still reports the send", r7.sentOk.length === 1 && h7.wire.length === 1);
  check("two documents sharing a title head are two documents", R.docKeyFor("Dinner Plan: Friday") !== R.docKeyFor("Dinner Plan: Saturday"));
}

// ---- 5. delivery timing: 9pm to 8am is quiet; due at 2am lands at 8am
{
  const TWO_AM = at("2026-10-09T09:00:00Z"); // 2am SF, Oct 9
  check("2am is quiet hours; 8am and 8:59pm are not; 9pm is", !MT.deliverableAt(TWO_AM, SF) && MT.deliverableAt(at("2026-10-09T15:00:00Z"), SF) && MT.deliverableAt(at("2026-10-09T03:59:00Z"), SF) && !MT.deliverableAt(at("2026-10-09T04:00:00Z"), SF));
  check("a delivery due at 2am goes at 8am that morning", MT.nextDeliveryTime(TWO_AM, SF).toISOString() === "2026-10-09T15:00:00.000Z");
  check("one due at 10pm goes at 8am the next morning", MT.nextDeliveryTime(at("2026-10-09T05:00:00Z"), SF).toISOString() === "2026-10-09T15:00:00.000Z");
  const THEIRS = "After the Sequin AI November event I want the people we meet to remember us. I don't want it to be a one night thing. The budget: split the cost with Sequin AI, as Jacqueline agreed, venue at House of AI shared 50/50, Cue covers the follow-up dinner. Recap text the morning after, small dinner within two weeks.";
  const input = { title: PLAN.title, note: PLAN.note, kind: "partnership_plan" as const, sections: PLAN.sections.map((s) => ({ heading: s.heading ?? undefined, paragraphs: s.paragraphs, bullets: s.bullets })), suggestions: PLAN.suggestions };
  const h = harness();
  const blockedFor = async (_u: string, zone: string | null, now: Date, o: { immediate?: boolean } = {}) => (!o.immediate && !MT.deliverableAt(now, zone) ? DD.QUIET_HOURS : null);
  const o = { userId: "u1", taskId: 111, firstName: "Jordan", phone: "+14155550123", zone: SF, taskTheirWords: THEIRS, read: "", askedAt: at("2026-10-09T05:30:00Z") };
  const tdeps = (now: Date): any => ({ theirWords: async () => THEIRS, blocked: blockedFor, deliver: h.deliver, record: async () => {}, now: () => now, receipts: h.receipts });
  const night = await DD.sendDocumentForTask(input as any, o, tdeps(TWO_AM));
  check("at 2am: not sent, and the next look is their 8am", !night.ok && (night as any).blocked && (night as any).nextAt?.toISOString() === "2026-10-09T15:00:00.000Z" && h.wire.length === 0, night);
  check("...the task turn schedules itself for then (not left to the model)", /if \(quietUntil && deps\.scheduleAt\)/.test(src("services/taskTurn.ts")));
  const EIGHT = at("2026-10-09T15:00:00Z");
  const morning = await DD.sendDocumentForTask(input as any, o, tdeps(EIGHT));
  check("at 8am: delivered, with what was asked and when", morning.ok && h.wire.length === 1 && h.wire[0].content === "Here's the Cue Presence Plan you asked for last night." && h.receipts.all[0].deliveredAt.toISOString() === EIGHT.toISOString(), { morning, wire: h.wire });
  const hi = harness();
  const asap = await DD.sendDocumentForTask(input as any, { ...o, taskTheirWords: `${THEIRS} Send it as soon as it's ready, I'll be up.` }, { ...tdeps(TWO_AM), deliver: hi.deliver, receipts: hi.receipts });
  check("they asked for it right away: it goes at 2am", asap.ok && hi.wire.length === 1);
  check("'tonight' alone is a window, not leave to text at 2am", !MT.askedForImmediate("can you send it tonight?") && MT.askedForImmediate("send it right away") && MT.askedForImmediate("don't wait till morning"));
  check("a call promise made at night is held to their 8am (delivery hours)", /const at = nextDeliveryTime\(t0, person\.zone\);/.test(src("services/callFollowThrough.ts")));
}

console.log(`delivery receipts: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
