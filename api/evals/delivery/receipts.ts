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
  title: "Co Presence Plan: After the Sequin AI November Event",
  note: "How Co stays present after the November event, from what you told me.",
  kind: "partnership_plan",
  sections: [
    { heading: "What you want", bullets: ["People from the Sequin AI event still thinking about Co a week later", "Not a one night thing"] },
    { heading: "Budget", paragraphs: ["Split the cost with Sequin AI, as Jacqueline agreed."], bullets: ["Venue at House of AI shared 50/50", "Co covers the follow-up dinner"] },
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
  const r = await h.send(PLAN, t, { line: "Here's the Co Presence Plan." });
  const rec = r.receipts[0];
  check("delivered: one send, the PDF with its line", r.sentOk.length === 1 && h.wire.length === 1 && !!h.wire[0].media_url && h.wire[0].content === "Here's the Co Presence Plan.", h.wire);
  check("receipt: doc id, title, version, channel, who, when", !!rec && rec.id > 0 && rec.title === PLAN.title && rec.version === 1 && rec.channel === "pdf_text" && rec.userId === "u1" && rec.deliveredAt.getTime() === t.getTime() && rec.status === "delivered", rec);
  check("receipt: the content itself is kept (what was sent, for follow-ups)", JSON.stringify(rec.doc) === JSON.stringify(PLAN) && rec.docKey === "co-presence-plan");
  const again = await h.send(PLAN, at("2026-10-08T18:00:00Z"));
  check("the same artifact again: refused, nothing sent, the existing receipt named", !again.sentOk.length && again.duplicate?.id === rec.id && h.wire.length === 1 && /already delivered \(doc #1, version 1/.test((again.results[0] as any).why), again.results);
  const asked = await h.send(PLAN, at("2026-10-08T18:05:00Z"), { resend: true });
  check("...unless they asked for it again in their own words (resend): it goes, recorded", asked.sentOk.length === 1 && h.wire.length === 2 && h.receipts.all.length === 2);
  check("a re-ask in their words is told apart from a question", DD.asksToResend("can you send that plan again? I can't find it") && !DD.asksToResend("what's in the budget part?"));
  const lines = R.receiptLines(h.receipts.all, SF, at("2026-10-08T19:00:00Z"));
  check("follow-up turns read the receipts: one line per artifact, its doc number, version, channel and when, never to resend", lines.length === 1 && /^Delivered "Co Presence Plan: After the Sequin AI November Event" \(doc #\d+, version 1\) as a PDF in this conversation today at 11:05am\. Already theirs: send it again only when they ask for it again \(the same version goes\), as a new version only when they ask for a change/.test(lines[0]) && /never on your own/.test(lines[0]), lines);
  check("the reply reads them: turn context loads receipts, grounding lists them as Documents you've delivered", /deliveries = await import\("\.\/deliveryReceipts\.js"\)/.test(src("services/turnContext.ts")) && /Documents you've delivered: \$\{line\}/.test(src("harness/replyGrounding.ts")));
  check("both paths record: the reply's writeDocument and a task's document go through deliverAndRecord", /deliverAndRecord\(doc, to, \{ saveTo: input\.saveTo/.test(src("agent/loopTools.ts")) && /const rd = await deliverAndRecord\(doc, to,/.test(src("services/documentDelivery.ts")));
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
  check("Co has the tool: readDocument, its registry entry tells Co to quote and never answer from memory", reg?.tool === "readDocument" && /quoting the section's own words in quotation marks/.test(reg.use ?? "") && /Never answer about a delivered document from memory/.test(reg.use ?? ""));
  check("the tool returns the delivered section and every section, from the receipt", /const rec = await R\.pgReceipts\.get\(ctx\.userId, id\)/.test(src("agent/loopTools.ts")) && /section = about \? R\.findSection\(rec\.doc, about\)/.test(src("agent/loopTools.ts")));
}

// ---- 3. a change request: the new version, one line naming the change
{
  const h = harness();
  const v1 = await h.send(PLAN, at("2026-10-08T17:00:00Z"));
  const id = v1.receipts[0].id;
  const v2doc = { ...PLAN, sections: PLAN.sections.map((s) => (s.heading === "Budget" ? { ...s, bullets: ["Venue at House of AI shared 50/50", "Co covers the follow-up dinner", "Catering split with Sequin AI"] } : s)) };
  const noNote = await h.send(v2doc, at("2026-10-08T20:00:00Z"), { revises: id });
  check("a new version without a change note is refused (it needs its one line)", !noNote.sentOk.length && /what changed/.test((noNote.results[0] as any).why));
  const v2 = await h.send(v2doc, at("2026-10-08T20:00:00Z"), { revises: id, changed: "updated the budget section" });
  const last = h.wire[h.wire.length - 1];
  check("the new version goes: version 2 of the same document", v2.sentOk.length === 1 && v2.version === 2 && v2.receipts[0].docKey === v1.receipts[0].docKey && v2.receipts[0].version === 2);
  check(`...with one line naming what changed ("${last.content}")`, last.content === "Updated the budget section." && !!last.media_url && h.wire.length === 2);
  check("a change note that isn't a verb phrase is framed", R.changeLine(PLAN.title, "the budget now includes catering") === "Updated the Co Presence Plan: the budget now includes catering.");
  check("the receipt keeps the change note", v2.receipts[0].changeNote === "updated the budget section");
  const lines = R.receiptLines(h.receipts.all, SF, at("2026-10-08T21:00:00Z"));
  check("follow-ups see only the newest version, with what changed", lines.length === 1 && /version 2\)/.test(lines[0]) && /this version: updated the budget section/.test(lines[0]), lines);
  check("a revision of a document that isn't theirs is refused", /no document #999/.test(((await h.send(v2doc, at("2026-10-08T21:00:00Z"), { revises: 999, changed: "x" })).results[0] as any).why));
}

// ---- 4. a forced render failure: text now, saying the PDF follows; logged; the PDF follows on retry; text never twice
{
  const h = harness({ render: "fail" });
  const t = at("2026-10-08T19:00:00Z"); // noon SF
  const r = await h.send(PLAN, t, { line: "Here's the Co Presence Plan you asked for last night." });
  const msg = h.wire[0];
  check("render failed: the content went as text at once, no attachment", r.sentOk.length === 1 && r.sentOk[0].via === "text_fallback" && h.wire.length === 1 && !msg.media_url, h.wire);
  check("...leading with its line, carrying the sections, saying the PDF follows", msg.content.startsWith("Here's the Co Presence Plan you asked for last night.") && msg.content.includes("Split the cost with Sequin AI, as Jacqueline agreed.") && /The PDF version will follow\.$/.test(msg.content));
  const rec = r.receipts[0];
  check("receipt: text_fallback, the PDF pending, the failure kept, a retry set", rec.channel === "text_fallback" && rec.status === "pdf_pending" && /couldn't be made/.test(rec.error ?? "") && !!rec.nextRetryAt && rec.nextRetryAt > t);
  check("the failure is logged for retry", h.logs.some((d) => d.decision === "document.pdf_failed" && d.action === "sent_as_text"));
  check("follow-ups know the PDF is outstanding (and not to resend the document)", /^Outstanding: the PDF of "Co Presence Plan/.test(R.receiptLines(h.receipts.all, SF, t)[0]) && /don't send the document again/.test(R.receiptLines(h.receipts.all, SF, t)[0]));
  const deps = { receipts: h.receipts, deliver: h.deliver, person: async () => ({ firstName: "Jordan", phone: "+14155550123", zone: SF }), blocked: async (_u: string, zone: string | null, now: Date) => (MT.deliverableAt(now, zone) ? null : DD.QUIET_HOURS), log: async (d: any) => { h.logs.push(d); } };
  const stillDown = await DD.retryPendingPdfs(new Date(rec.nextRetryAt!.getTime() + 1000), deps);
  check("retry while rendering is still down: no text again, another try later", stillDown.failed === 1 && h.wire.length === 1 && h.receipts.all[0].attempts === 1 && h.receipts.all[0].status === "pdf_pending");
  h.setRender("ok");
  const due = h.receipts.all[0].nextRetryAt!;
  const fixed = await DD.retryPendingPdfs(new Date(due.getTime() + 1000), deps);
  const pdfMsg = h.wire[h.wire.length - 1];
  check("retry once rendering works: the PDF follows with its own line", fixed.sent === 1 && h.wire.length === 2 && !!pdfMsg.media_url && pdfMsg.content === "Here's the PDF version of the Co Presence Plan.", h.wire);
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

// ---- 5. delivery timing: 9pm to 8am is quiet; due at 2am lands at 8am
{
  const TWO_AM = at("2026-10-09T09:00:00Z"); // 2am SF, Oct 9
  check("2am is quiet hours; 8am and 8:59pm are not; 9pm is", !MT.deliverableAt(TWO_AM, SF) && MT.deliverableAt(at("2026-10-09T15:00:00Z"), SF) && MT.deliverableAt(at("2026-10-09T03:59:00Z"), SF) && !MT.deliverableAt(at("2026-10-09T04:00:00Z"), SF));
  check("a delivery due at 2am goes at 8am that morning", MT.nextDeliveryTime(TWO_AM, SF).toISOString() === "2026-10-09T15:00:00.000Z");
  check("one due at 10pm goes at 8am the next morning", MT.nextDeliveryTime(at("2026-10-09T05:00:00Z"), SF).toISOString() === "2026-10-09T15:00:00.000Z");
  const THEIRS = "After the Sequin AI November event I want the people we meet to remember us. I don't want it to be a one night thing. The budget: split the cost with Sequin AI, as Jacqueline agreed, venue at House of AI shared 50/50, Co covers the follow-up dinner. Recap text the morning after, small dinner within two weeks.";
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
  check("at 8am: delivered, with what was asked and when", morning.ok && h.wire.length === 1 && h.wire[0].content === "Here's the Co Presence Plan you asked for last night." && h.receipts.all[0].deliveredAt.toISOString() === EIGHT.toISOString(), { morning, wire: h.wire });
  const hi = harness();
  const asap = await DD.sendDocumentForTask(input as any, { ...o, taskTheirWords: `${THEIRS} Send it as soon as it's ready, I'll be up.` }, { ...tdeps(TWO_AM), deliver: hi.deliver, receipts: hi.receipts });
  check("they asked for it right away: it goes at 2am", asap.ok && hi.wire.length === 1);
  check("'tonight' alone is a window, not leave to text at 2am", !MT.askedForImmediate("can you send it tonight?") && MT.askedForImmediate("send it right away") && MT.askedForImmediate("don't wait till morning"));
  check("a call promise made at night is held to their 8am (delivery hours)", /const at = nextDeliveryTime\(t0, person\.zone\);/.test(src("services/callFollowThrough.ts")));
}

console.log(`delivery receipts: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
