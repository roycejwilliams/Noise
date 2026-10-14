// LIVE (layer 2, metered: a few Haiku calls, about $0.01): grounded follow-ups on a delivered document (Royce, 2026-10-08).
// Co sees what a reply sees about deliveries (the receipt line under "Documents you've delivered", the registry's tool text) and
// the real tools, backed by an in-memory receipt store and stubbed sends:
//   - a question about a section: Co reads the document and its answer quotes it (deliveryReceipts.ts quotesDocument)
//   - a change request: Co writes the new version as a revision, sent with one line naming the change
//   npm run eval:live -- evals/delivery/followUpLive.ts
import "dotenv/config";
import "../lib/requireMeter.js";
import Anthropic from "@anthropic-ai/sdk";
const R = await import("../../src/services/deliveryReceipts.js");
const DD = await import("../../src/services/documentDelivery.js");
const DS = await import("../../src/services/documentSheet.js");
const { CO_CORE } = await import("../../src/services/coCore.js");
const { toolUse } = await import("../../src/services/capabilities.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const SF = "America/Los_Angeles";
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

const wire: any[] = [];
const receipts = R.memoryReceipts();
const pdfDeps: any = { render: async () => Buffer.from("%PDF"), cache: (_b: Buffer, n?: string) => `https://files.test/${n}`, send: async (m: any) => { wire.push(m); }, from: "+1" };
const deliver = (doc: any, to: any, target: any) => DD.deliverDocument(doc, to, target, pdfDeps);
const NOW = new Date("2026-10-08T19:00:00Z");
const to = { userId: "u1", firstName: "Jordan", phone: "+14155550123", zone: SF, now: NOW };
const v1 = await DD.deliverAndRecord(PLAN, { ...to, line: "Here's the Cue Presence Plan." }, { askedForGoogle: false, source: "test" }, { deliver, receipts, now: () => NOW, log: async () => {} });
const docId = v1.receipts[0].id;

const tools: Anthropic.Tool[] = [
  { name: "readDocument", description: toolUse("readDocument"), input_schema: { type: "object", properties: { doc: { type: "integer" }, about: { type: "string" } }, required: ["doc"] } },
  { name: "writeDocument", description: toolUse("writeDocument"), input_schema: { type: "object", properties: { title: { type: "string" }, note: { type: "string" }, kind: { type: "string" }, sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, paragraphs: { type: "array", items: { type: "string" } }, bullets: { type: "array", items: { type: "string" } } } } }, suggestions: { type: "array", items: { type: "string" } }, revises: { type: "integer", description: "Only for a change to a delivered document: its doc number." }, changed: { type: "string", description: "With revises: what changed, in a few words (\"updated the budget section\")." } }, required: ["title", "sections"] } },
];
async function run(question: string): Promise<{ text: string; calls: { name: string; input: any }[] }> {
  const client = new Anthropic();
  const system = `${CO_CORE}\n\nYou're replying by text. Keep it short.\n\nWhat you know:\nDocuments you've delivered: ${R.receiptLines(receipts.all, SF, NOW).join("\n")}`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const calls: { name: string; input: any }[] = [];
  for (let step = 0; step < 5; step++) {
    const res = await client.messages.create({ model: "claude-haiku-5-5", max_tokens: 1500, system, tools, messages });
    const uses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    if (!uses.length) return { text: res.content.filter((c): c is Anthropic.TextBlock => c.type === "text").map((c) => c.text).join(" "), calls };
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const input: any = u.input;
      calls.push({ name: u.name, input });
      let out: any;
      if (u.name === "readDocument") {
        const rec = await receipts.get("u1", Number(input.doc));
        out = rec ? { ok: true, title: rec.title, version: rec.version, section: input.about ? R.findSection(rec.doc, input.about) : null, sections: R.sectionsOf(rec.doc), note: `Answer from this text only. Quote the words of the section they asked about, in quotation marks, then answer. If they want it changed, write the new version with writeDocument (revises: ${rec.id}, changed: what changed), starting from these words.` } : { ok: false, error: "no such document" };
      } else {
        const doc = DS.resolveDocument(input);
        const r = await DD.deliverAndRecord(doc, to, { askedForGoogle: false, source: "reply", revises: input.revises ?? null, changed: input.changed ?? null }, { deliver, receipts, now: () => NOW, log: async () => {} });
        out = r.sentOk.length ? { ok: true, note: "Sent with its one line. Don't describe it again." } : { ok: false, error: (r.results[0] as any)?.why };
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "", calls };
}

// A question about one section.
const q = await run("Quick question on the plan you sent, what did the budget part say about splitting costs with Sequin?");
check("the question: Cue read the delivered document first", q.calls.some((c) => c.name === "readDocument" && Number(c.input.doc) === docId), q.calls);
check(`the answer quotes the document ("${q.text.slice(0, 200)}")`, R.quotesDocument(q.text, PLAN), q.text);
check("...and nothing was re-sent for a question", wire.length === 1);

// A change request.
const c = await run("Can you add catering to the budget section? We're splitting catering with Sequin AI too.");
const w = c.calls.find((x) => x.name === "writeDocument");
check("the change: written as a revision of the delivered document, with a change note", !!w && Number(w.input.revises) === docId && !!String(w.input.changed ?? "").trim(), c.calls);
const sent = wire[wire.length - 1];
check(`the new version went with one line naming the change ("${sent?.content}")`, wire.length === 2 && !!sent.media_url && /^(?:Updated|Added|Changed)\b/i.test(sent.content) && /budget|catering/i.test(sent.content), sent);
check("the receipts show version 2", receipts.all.some((r) => r.version === 2 && r.docKey === v1.receipts[0].docKey));

console.log(`  answer: ${q.text}\n  change line: ${wire[wire.length - 1]?.content}`);
console.log(`delivery follow-ups (live): ${total - failed}/${total} passed`);
if (failed) process.exit(1);
