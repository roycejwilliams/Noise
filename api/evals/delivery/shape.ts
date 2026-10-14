// The delivery shape (Royce, 2026-10-08). A plan promised on a call at night arrived next morning as four texts: "Got it, I'll send
// the doc to both you and Jacqueline this morning" (written the night before), the PDF, its title as a text, and "The Co presence
// plan ... is ready". Two rules (services/speakable.ts):
//   1. "Got it" only while the ask is seconds old. Later, lead with the thing and when it was asked for.
//   2. One delivery, one line: the attachment plus one sentence, nothing else saying it again.
// Test: a commitment made at night and delivered next morning opens with what was asked and when, never "Got it", and arrives as
// attachment + one line. Zero tokens: stubbed sends, pinned clock.
//   npx tsx evals/delivery/shape.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const S = await import("../../src/services/speakable.js");
const F = await import("../../src/services/callFollowThrough.js");
const DD = await import("../../src/services/documentDelivery.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const SF = "America/Los_Angeles";

// The night: the call ends 11:30pm SF (Oct 7); their morning is 8am SF (Oct 8, 15:00 UTC), when delivery hours start.
const CALL_END = new Date("2026-10-08T06:30:00Z");
const MORNING = new Date("2026-10-08T15:00:00Z");

// ---- 1. the rules
check("'Got it' is an acknowledgment opener", S.opensWithAck("Got it, I'll send the doc this morning.") && S.opensWithAck("On it. Sending now.") && !S.opensWithAck("Here's the plan you asked for last night."));
check("an acknowledgment is allowed seconds after the ask", S.ackAllowed(new Date("2026-10-08T18:00:00Z"), new Date("2026-10-08T18:00:40Z")));
check("...and not hours later", !S.ackAllowed(CALL_END, MORNING));
check("when they asked, from the morning after an 11:30pm ask: last night", S.askedWhenWords(CALL_END, MORNING, SF) === "last night", S.askedWhenWords(CALL_END, MORNING, SF));
check("...a 1am ask delivered at 9am: last night", S.askedWhenWords(new Date("2026-10-08T08:00:00Z"), MORNING, SF) === "last night");
check("...a 2pm ask delivered at 9am next day: yesterday", S.askedWhenWords(new Date("2026-10-07T21:00:00Z"), MORNING, SF) === "yesterday");
check("...a 10am ask delivered at 3pm: earlier today", S.askedWhenWords(new Date("2026-10-08T17:00:00Z"), new Date("2026-10-08T22:00:00Z"), SF) === "earlier today");
check("...three days back: by weekday", S.askedWhenWords(new Date("2026-10-05T20:00:00Z"), MORNING, SF) === "on Monday");
check("the line for a later delivery: the thing and when it was asked for", S.deliveryLine({ title: "Cue Presence Plan: After the Sequin AI November Event", askedAt: CALL_END, sendAt: MORNING, zone: SF }) === "Here's the Cue Presence Plan you asked for last night.");
check("a title that isn't a document noun is named by its kind (the attachment shows the title)", S.deliveryLine({ title: "Staying present after the Sequin AI event", kind: "partnership_plan", askedAt: CALL_END, sendAt: MORNING, zone: SF }) === "Here's the plan you asked for last night.");
check("the line for a fresh ask: just the thing", S.deliveryLine({ title: "Venue Brief: Hayes Valley", askedAt: new Date(MORNING.getTime() - 60_000), sendAt: MORNING, zone: SF }) === "Here's the Venue Brief.");
check("a stale 'Got it' breaks the shape; a fresh one doesn't", S.deliveryShapeProblems("Got it, I'll send it.", { askedAt: CALL_END, sendAt: MORNING }).length === 1 && S.deliveryShapeProblems("Got it, I'll send it.", { askedAt: new Date(MORNING.getTime() - 30_000), sendAt: MORNING }).length === 0);
check("a held text loses its stale 'Got it'", S.dropStaleAck("Got it, I'll send the doc this morning.", { askedAt: CALL_END, sendAt: MORNING }) === "I'll send the doc this morning.");
check("...a fresh one keeps it", S.dropStaleAck("Got it, sending now.", { askedAt: new Date(MORNING.getTime() - 20_000), sendAt: MORNING }) === "Got it, sending now.");
check("held sends go through it at send time (deferred_sends)", /dropStaleAck\(m, \{ askedAt: queuedAt, sendAt: now \}\)/.test(src("services/deferredSends.ts")) && /d\.created_at/.test(src("services/deferredSends.ts")));

// ---- 2. the night: no "Got it" drafted or held; the work waits for their 8am
{
  const drafted: any[] = [], sent: any[] = [], decisions: any[] = [];
  let held: { ids: number[]; until: Date } | null = null;
  const deps: any = {
    now: () => CALL_END,
    track: async () => {},
    commitments: async () => [{ taskId: 111, sentence: "I'll text you what I put together on how Cue keeps its presence after the November event.", wakes: 0 }],
    person: async () => ({ firstName: "Jordan", phone: "+14155550123", zone: SF, reachable: true }),
    draft: async (x: any) => { drafted.push(x); return "Got it, I'll send the presence plan this morning."; },
    send: async (x: any) => { sent.push(x); return { sent: true }; },
    runTask: async () => ({ ran: true }),
    hold: async (_u: string, ids: number[], until: Date) => { held = { ids, until }; },
    record: async (d: any) => { decisions.push(d); },
  };
  const r = await F.followThroughOnCallEnd({ userId: "u1", transcript: "assistant: I'll text you what I put together.\nuser: Perfect." }, deps);
  check("night: nothing sent, no confirmation drafted", r.action === "held" && sent.length === 0 && drafted.length === 0 && !r.text, { r, drafted });
  check("night: the task's check is set for their 8am", !!held && (held as any).until.toISOString() === MORNING.toISOString() && (held as any).ids.join() === "111");
}

// ---- 3. the morning: attachment + one line, the line says what and when, never "Got it"
{
  const THEIRS = "After the Sequin AI November event I want the people we meet to remember us. I don't want it to be a one night thing.";
  const planDoc = {
    title: "Cue Presence Plan: After the Sequin AI November Event",
    note: "A plan for after the November event, from what you told me.",
    sections: [{ heading: "What you want", bullets: ["The people you meet at the Sequin AI November event remember you", "Not a one night thing"] }],
    suggestions: ["Send each new contact a short personal note within two days of the event", "Host a small dinner for the people who connected most", "Share a one-page recap of what you heard in the room", "Check in with your closest new contacts a month later"],
  };
  // The real PDF sender (pdfByText) with its own sends stubbed: every message that leaves is recorded.
  const wire: { number: string; content: string; media_url?: string }[] = [];
  const pdfDeps: any = { render: async () => Buffer.from("%PDF"), cache: () => "https://files.test/plan.pdf", send: async (m: any) => { wire.push(m); }, from: "+10000000000" };
  const deliver = (doc: any, to: any, target: any) => DD.deliverDocument(doc, to, target, pdfDeps);
  const r = await DD.sendDocumentForTask(planDoc as any, { userId: "u1", taskId: 111, firstName: "Jordan", phone: "+14155550123", zone: SF, taskTheirWords: THEIRS, read: "", askedAt: CALL_END }, { theirWords: async () => THEIRS, blocked: async () => null, deliver, record: async () => {}, now: () => MORNING, receipts: (await import("../../src/services/deliveryReceipts.js")).memoryReceipts() });
  check("morning: the document went", r.ok, r);
  check(`morning: one send, the attachment with its line (${wire.length} sent)`, wire.length === 1 && !!wire[0].media_url, wire);
  const line = wire[0]?.content ?? "";
  check(`morning: the line says what was asked and when ("${line}")`, line === "Here's the Cue Presence Plan you asked for last night.");
  check("morning: never 'Got it', never the bare title as its own text", !S.opensWithAck(line) && line !== planDoc.title);
  check("morning: one sentence", (line.match(/[.!?](?:\s|$)/g) ?? []).length === 1);
}

// ---- 4. nothing says it again: a task that sent the document can't text about it
check("the task's text tool refuses once the document went (one delivery, one line)", /if \(docsSent\.length\) return \{ ok: false, error: "The document already went out with its one line/.test(src("services/taskTurn.ts")));
check("the task passes when they asked, so the line can say it", /askedAt: task\.createdAt \? new Date\(task\.createdAt\) : null/.test(src("services/taskTurn.ts")));
check("a task's own status text with a stale 'Got it' fails its checks and is redrafted", /deliveryShapeProblems\(t, \{ askedAt: new Date\(task\.createdAt\), sendAt: deps\.now\(\) \}\)/.test(src("services/taskTurn.ts")));

console.log(`delivery shape: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
