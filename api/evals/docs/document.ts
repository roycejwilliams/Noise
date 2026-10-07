// Co's document tool and the offer to write one (services/documentSheet.ts, documentDelivery.ts, documentOffer.ts, agent/loopTools.ts).
// Layer 1: no model, no network, no database.   npx tsx evals/docs/document.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const D = await import("../../src/services/documentSheet.js");
const X = await import("../../src/services/documentDelivery.js");
const O = await import("../../src/services/documentOffer.js");
const Cap = await import("../../src/services/capabilities.js");
const G = await import("../../src/agent/toolGuard.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

// ---------------------------------------------------------------- the document
const SAID = "Jacqueline and I are splitting the cofounder roles. I take product and engineering, she takes partnerships and the events. We want a gateway conversation before each Co event so matching is better. We have not decided who talks to Sequent AI first.";
const input = {
  title: "Where we are landing — Co and Sequent",
  note: "A page for you and Jacqueline, from what you told me.",
  sections: [
    { heading: "The split", paragraphs: ["You take product and engineering. Jacqueline takes partnerships and the events."] },
    { heading: "What is still open", bullets: ["Who talks to Sequent AI first.", "How long the gateway conversation should run."] },
  ],
};
const doc = D.resolveDocument(input);
check("the title and notes lose dashes (a comma instead), markdown and stray spaces", doc.title === "Where we are landing, Co and Sequent" && !/[—–*_#`]/.test(D.docText(doc)));
check("sections keep their headings, paragraphs and bullets", doc.sections.length === 2 && doc.sections[0].heading === "The split" && doc.sections[1].bullets.length === 2);
check("empty paragraphs, empty bullets and empty sections drop", D.resolveDocument({ title: "T", sections: [{ heading: "x", paragraphs: ["", "  "], bullets: [] }, { heading: "y", paragraphs: ["real"] }] }).sections.length === 1);
check("limits cut instead of throwing: 30 sections become 10, a long paragraph is capped", D.resolveDocument({ title: "T", sections: Array.from({ length: 30 }, () => ({ paragraphs: ["x".repeat(2000)] })) }).sections.length === 10 && D.resolveDocument({ title: "T", sections: [{ paragraphs: ["x".repeat(2000)] }] }).sections[0].paragraphs[0].length === D.DOC_LIMITS.paragraphChars);
check("a document made from what they said passes", D.documentProblems(doc, SAID).length === 0, D.documentProblems(doc, SAID));
check("a title and sections are required", D.documentProblems(D.resolveDocument({ title: "", sections: [] }), SAID).length >= 2);
check("a thin document is refused", D.documentProblems(D.resolveDocument({ title: "Notes", sections: [{ paragraphs: ["Do it."] }] }), SAID).some((p) => /too thin/.test(p)));
check("a placeholder is refused", D.documentProblems(D.resolveDocument({ title: "Plan", sections: [{ heading: "Next", paragraphs: ["The next step is TBD and the owner is [insert name] for the whole of this plan, as discussed."] }] }), SAID).some((p) => /placeholder/.test(p)));
const invented = D.resolveDocument({ ...input, sections: [...input.sections, { heading: "Next", paragraphs: ["You both go to the Founders Mixer at The Battery on Friday at 7pm to meet the team."] }] });
const bad = D.documentProblems(invented, SAID);
check("an event, place or time they never gave is refused, and the refusal names it", bad.length >= 1 && /Founders Mixer|Battery|7pm/.test(bad.join(" ")), bad);
check("the same event, once they said it, is allowed", D.documentProblems(invented, `${SAID} We are going to the Founders Mixer at The Battery on Friday at 7pm.`).length === 0);
check("a document over the length cap is refused", D.documentProblems(D.resolveDocument({ title: "Big", sections: Array.from({ length: 10 }, () => ({ paragraphs: Array.from({ length: 6 }, () => "y".repeat(690)) })) }), "y").some((p) => /too long/.test(p)));
const html = D.documentHtml(D.resolveDocument({ title: "A <b>bold</b> title", sections: [{ heading: "H & H", paragraphs: ["<script>alert(1)</script> plain"], bullets: ["one"] }] }), "Royce");
check("the page carries the title, a heading, a paragraph and a bullet, for the member by name", /<h1>A &lt;b&gt;bold&lt;\/b&gt; title<\/h1>/.test(html) && /<h2>H &amp; H<\/h2>/.test(html) && /<li>one<\/li>/.test(html) && /Written for Royce/.test(html));
check("nothing from the text can inject markup into the page", !/<script>/.test(html) && /&lt;script&gt;/.test(html));
check("it is the plan sheet's page: the same card, serif and rule", /class="card"/.test(html) && /Fraunces/.test(html) && /@page \{ size: Letter/.test(html));

// ---------------------------------------------------------------- delivery
{
  const sent: any[] = [];
  const mk = (o: { pdf?: Buffer | null; throws?: boolean } = {}): any => ({
    render: async (h: string) => { sent.push({ html: h.length }); return o.pdf === undefined ? Buffer.alloc(2000, 1) : o.pdf; },
    cache: () => "https://x.test/plan-file/abc.pdf",
    send: async (m: any) => { if (o.throws) throw new Error("no"); sent.push(m); return {}; },
    from: "+15550000000",
  });
  const to = { userId: "u1", firstName: "Royce", phone: "+15550100001" };
  const ok = await X.deliverDocument(doc, to, "pdf_text", mk());
  const m = sent.find((x) => x.media_url);
  check("delivery: the PDF goes to their number as an attachment in the thread, captioned with the title", ok.ok && m?.number === "+15550100001" && m.media_url.endsWith("abc.pdf") && m.content === doc.title && m.from_number === "+15550000000", sent);
  check("delivery: the file is named for the document", ok.ok && ok.filename === "where-we-are-landing-co-and-sequent.pdf", ok);
  check("delivery: Chrome unavailable is a plain failure, nothing sent", (await X.deliverDocument(doc, to, "pdf_text", mk({ pdf: null }))).ok === false);
  const before = sent.length;
  check("delivery: a send that throws is a plain failure", (await X.deliverDocument(doc, to, "pdf_text", mk({ throws: true }))).ok === false && sent.length === before + 1);
  check("the delivery seam: one target now, and a Google Docs step is one more entry (no other code moves)", Object.keys(X.DELIVERERS).join() === "pdf_text" && /google_docs/.test(src("services/documentDelivery.ts")));
  check("it uses the plan's own headless-Chrome render and file cache, not a new path", /import \{ renderPdf \} from "\.\/browserRead\.js"/.test(src("services/documentDelivery.ts")) && /cachePlanFile/.test(src("services/documentDelivery.ts")));
  check("what a document may rest on is their own words: never Co's lines", /memory_type = 'call_transcript'/.test(src("services/documentDelivery.ts")) && /content LIKE 'User said:%'/.test(src("services/documentDelivery.ts")) && !/co_reply|'assistant'/.test(src("services/documentDelivery.ts").split("loadTheirWords")[1] ?? ""));
}

// ---------------------------------------------------------------- the offer trigger
const now = new Date("2026-10-07T18:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
const state = (o: Partial<import("../../src/services/documentOffer.js").OfferState> = {}) => ({ now, helpAsks: [], threads: [], recurring: [], needsCare: false, history: [], ...o });
const GUIDE = "seeking guidance on how to split the cofounder roles with Jacqueline";
{
  const both = O.documentOfferDue(state({ helpAsks: [{ text: GUIDE, ageDays: 3 }], recurring: [{ about: "splitting the cofounder roles", emotions: ["uncertain"], count: 3 }] }));
  check("asked for guidance, and it keeps coming up unsettled: due, about that", both.due && both.topic === GUIDE && /keeps coming up unsettled/.test(both.why), both);
  check("an ask for guidance open a few days is enough alone", O.documentOfferDue(state({ helpAsks: [{ text: GUIDE, ageDays: 3 }] })).due === true);
  check("a fresh ask (a day old) is not a stuck one yet", O.documentOfferDue(state({ helpAsks: [{ text: GUIDE, ageDays: 1 }] })).due === false);
  check("a feeling of being unsure that keeps coming up (circling) is a moment", O.documentOfferDue(state({ recurring: [{ about: "whether to take on a CTO", emotions: ["uncertain", "confused"], count: 2 }] })).due === true);
  check("frustration alone is not 'needs direction' (it is usually at Co)", O.documentOfferDue(state({ recurring: [{ about: "Co's replies", emotions: ["frustrated"], count: 5 }] })).due === false);
  check("an open thread they feel unsure about, a few days old, is a moment", O.documentOfferDue(state({ threads: [{ text: "deciding how to position the concept", feeling: "uncertain (medium)", ageDays: 4 }] })).due === true);
  check("grief and exhaustion are care, not direction: no offer", O.documentOfferDue(state({ threads: [{ text: "the business", feeling: "grief, exhausted (high)", ageDays: 6 }], recurring: [{ about: "work", emotions: ["grief", "exhaustion"], count: 4 }] })).due === false);
  check("when they are having a hard time, their state comes first: never, whatever else is true", O.documentOfferDue(state({ needsCare: true, helpAsks: [{ text: GUIDE, ageDays: 5 }] })).due === false);
  check("nothing unsettled: nothing to offer", O.documentOfferDue(state()).due === false);
  const hist = (topic: string, d: number, status: "offered" | "accepted" = "offered", source: "offered" | "asked" = "offered") => ({ topic, source, status, at: ago(d) });
  const ask = { helpAsks: [{ text: GUIDE, ageDays: 5 }] };
  const waitingNow = O.documentOfferDue(state({ ...ask, history: [hist(GUIDE, 1)] }));
  check("an offer still waiting on its answer (a day old) is never repeated, and the reason says so", waitingNow.due === false && /waiting on their answer/.test(waitingNow.why), waitingNow);
  check("a thread that is both unsure and exhausted is care first: no offer", O.documentOfferDue(state({ threads: [{ text: "the cofounder split", feeling: "stressed, exhausted (high)", ageDays: 5 }] })).due === false);
  check("a passed offer (no yes, a week later) is not offered again: not the same topic, not within two weeks", O.documentOfferDue(state({ ...ask, history: [hist(GUIDE, 7)] })).due === false);
  check("and not the same topic ever, even months on", O.documentOfferDue(state({ ...ask, history: [hist(GUIDE, 60)] })).due === false);
  check("a different topic after the two weeks is fine", O.documentOfferDue(state({ helpAsks: [{ text: "figuring out how to price the first event", ageDays: 4 }], history: [hist(GUIDE, 20)] })).due === true);
  check("a different topic inside the two weeks is not: one offer a fortnight, whatever the answer", O.documentOfferDue(state({ helpAsks: [{ text: "figuring out how to price the first event", ageDays: 4 }], history: [hist(GUIDE, 6)] })).due === false);
  check("a document just written (yesterday) holds the next offer", O.documentOfferDue(state({ helpAsks: [{ text: "figuring out how to price the first event", ageDays: 4 }], history: [hist("anything", 1, "accepted", "asked")] })).due === false);
  check("sameTopic: the same words in another order are the same topic; different ones are not", O.sameTopic("how to split the cofounder roles", "the cofounder roles split") && !O.sameTopic("pricing the first event", GUIDE));
  const lines = O.docOfferLines({ due: { topic: GUIDE, why: "x" }, pending: null });
  check("the hint: offer once, only if it fits this message, in Co's own words after offerDocument, never write before a yes", !!lines.hint && /only if it fits this message/i.test(lines.hint) && /offer once/.test(lines.hint) && /offerDocument/.test(lines.hint) && /own words/.test(lines.hint) && /until they say yes/.test(lines.hint));
  check("the hint is no canned line: it carries no sentence for Co to copy", !/"want me to put this together/i.test(lines.hint ?? ""));
  const waiting = O.docOfferLines({ due: null, pending: { topic: GUIDE } });
  check("a waiting offer tells Co: a yes means write it; a pass means let it go and never offer it again", /If this message says yes/.test(waiting.pending ?? "") && /never offer it again/.test(waiting.pending ?? "") && waiting.hint === null);
  check("nothing due and nothing waiting: Co is told nothing", O.docOfferLines({ due: null, pending: null }).hint === null && O.docOfferLines(null).pending === null);
}

// ---------------------------------------------------------------- the tools, and only on a yes
{
  const w = Cap.ABILITIES.find((a) => a.id === "write_document")!;
  const o = Cap.ABILITIES.find((a) => a.id === "offer_document")!;
  check("registry: writeDocument needs their own yes, once a turn, three a day", w.tool === "writeDocument" && w.confirm === "their_yes" && w.limits?.perTurn === 1 && w.limits?.perDay === 3);
  check("registry: offerDocument once a turn, once a day, no yes needed (it only offers)", o.tool === "offerDocument" && o.limits?.perTurn === 1 && o.limits?.perDay === 1 && !o.confirm);
  check("registry: Co is told what it can't do (no sheets, slides, Google Docs, nothing sent to others)", /can't make spreadsheets, slides or Google Docs/.test(w.can) && /only to them|goes only to them/.test(w.can));
  check("registry: the use text says to build from what they said and not to invent", /Don't invent a place, name, number, date or event/.test(w.use ?? "") && /what THEY said/.test(w.use ?? ""));
  const calls: string[] = [];
  const tools: any = { writeDocument: { inputSchema: (await import("zod")).z.object({}), execute: async () => { calls.push("write"); return { ok: true }; } }, offerDocument: { inputSchema: (await import("zod")).z.object({}), execute: async () => { calls.push("offer"); return { ok: true }; } } };
  const notes: string[] = [];
  G.guardTools(tools, { userId: "u1", resolvedContent: "Yeah, put it in a doc for me please", dryRun: true, notDone: (t) => notes.push(t) });
  const noYes = await tools.writeDocument.execute({ theirYes: "" }, {});
  check("without their own words in this message, no document is written", noYes.ok === false && calls.length === 0 && /needs their own yes/.test(noYes.error), noYes);
  const madeUp = await tools.writeDocument.execute({ theirYes: "sure, go ahead and send it" }, {});
  check("a yes they did not say is refused", madeUp.ok === false && calls.length === 0);
  const yes = await tools.writeDocument.execute({ theirYes: "put it in a doc for me" }, {});
  check("their yes, in their own words in this message, lets it run (answering an offer or asking directly)", yes.ok === true && calls.join() === "write", yes);
  const off = await tools.offerDocument.execute({}, {});
  check("the offer itself needs no yes: it is only the question", off.ok === true && calls.join() === "write,offer");
}

// ---------------------------------------------------------------- wiring
{
  const lt = src("agent/loopTools.ts");
  check("both tools are in Co's loop; the write goes through the same resolve, problems, deliver path", /writeDocument: tool\(/.test(lt) && /offerDocument: tool\(/.test(lt) && /resolveDocument\(input\)/.test(lt) && /documentProblems\(doc, source\)/.test(lt) && /deliverDocument\(doc/.test(lt));
  check("the write rests on their words, not Co's: the source is their texts and calls, this message and what Co read", /loadTheirWords\(ctx\.userId\)/.test(lt) && /theirWords\(\)/.test(lt));
  check("the offer is re-checked in code (documentOfferDue) and recorded before Co says it", /documentOfferDue\(await loadOfferState\(ctx\.userId\)\)/.test(lt) && /recordOffer\(ctx\.userId, due\.topic\)/.test(lt));
  check("a moment that is not allowed is refused in code, whatever Co thinks", /if \(!due\.due\) return \{ ok: false, error: `Don't offer a document now/.test(lt));
  check("the offer records the code's topic, not the model's", !/recordOffer\(ctx\.userId, (input|String)/.test(lt));
  check("a document written marks the open offer accepted (or records an asked-for one)", /recordDocumentWritten\(ctx\.userId, doc\.title\)/.test(lt) && /status = 'accepted'/.test(src("services/documentOffer.ts")));
  check("reply context: the notice and the waiting offer reach Co on every reply", /loadDocOfferContext\(userId\)/.test(src("services/turnContext.ts")) && /docOfferLines\(opts\.turn\?\.docOffer\)/.test(src("harness/replyGrounding.ts")));
  check("the record: Co remembers it sent a document and that it offered", /case "writeDocument"/.test(src("services/coFacts.ts")) && /case "offerDocument"/.test(src("services/coFacts.ts")));
  check("the table exists, with the two states and the two sources", /CREATE TABLE IF NOT EXISTS document_offers/.test(src("db/migrations.ts")) && /CHECK \(status IN \('offered', 'accepted'\)\)/.test(src("db/migrations.ts")));
  // Explicitly out of scope (Royce, 2026-10-07): the stuck Sequent PDF and tasks 90/91 are untouched, and the 9am hold stays.
  const lh = src("services/localHours.ts");
  check("untouched: the 9am to 8pm rule", /REASONABLE_HOUR_START = 9/.test(lh) && /REASONABLE_HOUR_END = 20/.test(lh) && /outside their hours \(9am to 8pm their time\)/.test(src("services/taskTurn.ts")));
  const mine = ["services/documentSheet.ts", "services/documentDelivery.ts", "services/documentOffer.ts"].map(src).join("\n");
  check("untouched: no code of this feature reads or changes co_tasks, so tasks 90 and 91 are not touched", !/co_tasks|taskTurn|coTasks/.test(mine));
}

console.log(`document: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
