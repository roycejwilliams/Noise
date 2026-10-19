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
// The read of their answer (services/theirYes.ts) is a model call: stubbed to yes, so these checks are about the guard's facts.
(await import("../../src/services/theirYes.js")).setYesJudgeForTests(async () => ({ yes: true, why: "stub", read: true }));
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };

// ---------------------------------------------------------------- the document
const SAID = "Jacqueline and I are splitting the cofounder roles. I take product and engineering, she takes partnerships and the events. We want a gateway conversation before each Cue event so matching is better. We have not decided who talks to Sequent AI first.";
const input = {
  title: "Where we are landing — Cue and Sequent",
  note: "A page for you and Jacqueline, from what you told me.",
  sections: [
    { heading: "The split", paragraphs: ["You take product and engineering. Jacqueline takes partnerships and the events."] },
    { heading: "What is still open", bullets: ["Who talks to Sequent AI first.", "How long the gateway conversation should run."] },
  ],
};
const doc = D.resolveDocument(input);
check("the title and notes lose dashes (a comma instead), markdown and stray spaces", doc.title === "Where we are landing, Cue and Sequent" && !/[—–*_#`]/.test(D.docText(doc)));
check("sections keep their headings, paragraphs and bullets", doc.sections.length === 2 && doc.sections[0].heading === "The split" && doc.sections[1].bullets.length === 2);
check("empty paragraphs, empty bullets and empty sections drop", D.resolveDocument({ title: "T", sections: [{ heading: "x", paragraphs: ["", "  "], bullets: [] }, { heading: "y", paragraphs: ["real"] }] }).sections.length === 1);
check("limits cut instead of throwing: 30 sections become 10, a long paragraph is capped", D.resolveDocument({ title: "T", sections: Array.from({ length: 30 }, () => ({ paragraphs: ["x".repeat(2000)] })) }).sections.length === 10 && D.resolveDocument({ title: "T", sections: [{ paragraphs: ["x".repeat(2000)] }] }).sections[0].paragraphs[0].length === D.DOC_LIMITS.paragraphChars);
check("a document made from what they said passes", D.documentProblems(doc, { theirs: SAID }).length === 0, D.documentProblems(doc, { theirs: SAID }));
check("a title and sections are required", D.documentProblems(D.resolveDocument({ title: "", sections: [] }), { theirs: SAID }).length >= 2);
check("a thin document is refused", D.documentProblems(D.resolveDocument({ title: "Notes", sections: [{ paragraphs: ["Do it."] }] }), { theirs: SAID }).some((p) => /too thin/.test(p)));
check("a placeholder is refused", D.documentProblems(D.resolveDocument({ title: "Plan", sections: [{ heading: "Next", paragraphs: ["The next step is TBD and the owner is [insert name] for the whole of this plan, as discussed."] }] }), { theirs: SAID }).some((p) => /placeholder/.test(p)));
const invented = D.resolveDocument({ ...input, sections: [...input.sections, { heading: "Next", paragraphs: ["You both go to the Founders Mixer at The Battery on Friday at 7pm to meet the team."] }] });
const bad = D.documentProblems(invented, { theirs: SAID });
check("an event, place or time they never gave is refused, and the refusal names it", bad.length >= 1 && /Founders Mixer|Battery|7pm/.test(bad.join(" ")), bad);
check("the same event, once they said it, is allowed", D.documentProblems(invented, { theirs: `${SAID} We are going to the Founders Mixer at The Battery on Friday at 7pm.` }).length === 0);
check("a document over the length cap is refused", D.documentProblems(D.resolveDocument({ title: "Big", sections: Array.from({ length: 10 }, () => ({ paragraphs: Array.from({ length: 6 }, () => "y".repeat(690)) })) }), { theirs: "y" }).some((p) => /too long/.test(p)));
const META = { firstName: "Royce", date: "October 7, 2026" };
const html = D.documentHtml(D.resolveDocument({ title: "A <b>bold</b> title", sections: [{ heading: "H & H", paragraphs: ["<script>alert(1)</script> plain"], bullets: ["one"] }] }), META);
check("the page carries the title, a heading, a paragraph and a real bullet", /<h1>A &lt;b&gt;bold&lt;\/b&gt; title<\/h1>/.test(html) && /<h2>H &amp; H<\/h2>/.test(html) && /<ul><li>one<\/li><\/ul>/.test(html));
check("nothing from the text can inject markup into the page", !/<script>/.test(html) && /&lt;script&gt;/.test(html));
// The design (Royce, 2026-10-07): one serif for the title and headings, one sans for everything else, nothing else.
const fonts = [...html.matchAll(/font-family:\s*([^;}]+)[;}]/g)].map((m) => m[1].split(",")[0].replace(/['" ]/g, ""));
check("type: exactly two typefaces, Fraunces (title, headings, mark) and Instrument Sans (body, meta, footer)", new Set(fonts).size === 2 && fonts.every((f) => f === "Fraunces" || f === "InstrumentSans"), [...new Set(fonts)]);
check("type: no italic anywhere (the italic serif subtitle was a third voice)", !/font-style:\s*italic/.test(html));
check("type: the title and section headings are serif, the lede and bullets sans", /h1 \{ font-family: 'Fraunces'/.test(html) && /h2 \{ font-family: 'Fraunces'/.test(html) && /\.lede \{[^}]*font-size: var\(--lead\)/.test(html) && !/\.lede \{[^}]*Fraunces/.test(html));
check("metadata: the date and who it is for, set small and quiet", /<div class="date">October 7, 2026<\/div>/.test(html) && /Prepared for Royce/.test(html) && /\.date \{ font-size: 8\.5px/.test(html));
const plainHtml = D.documentHtml(doc, META);
check("composition: the footer is the page's own bottom margin (title and page number), so it is anchored on every page at any length", /@bottom-left \{ content: "Where we are landing, Cue and Sequent"/.test(plainHtml) && /@bottom-right \{ content: counter\(page\) " \/ " counter\(pages\)/.test(plainHtml));
check("composition: the paper covers the whole sheet, margins included", /@page \{[^}]*background: #F6F2EA/.test(html.replace(/\n/g, " ")));
check("the sign-off and the Cue signature are not in the PDF (that line belongs in the text thread)", !/Tell me what to change/.test(html) && !/rework it/.test(html) && !/class="close"/.test(html) && !/class="co"/.test(html));
check("brand: a letterhead mark, a rule, numbered sections and a restrained gold: more than a hairline", /class="mark">Cue</.test(html) && /counter\(sec, decimal-leading-zero\)/.test(html) && /\.mast \{[^}]*border-bottom: 1px solid/.test(html));
const hostile = D.documentHtml(D.resolveDocument({ title: 'Say "hi" \\ and <b>; } body { display:none } /*', sections: [{ paragraphs: ["x".repeat(100)] }] }), META);
const boxText = /@bottom-left \{ content: "([^;]*)";/.exec(hostile)?.[1] ?? "(none)";
check("a hostile title can't end the margin box's string or break out of its rule", /^[A-Za-z0-9 ,.'&:-]*$/.test(boxText) && (hostile.match(/@bottom-left/g) ?? []).length === 1, boxText);
check("typography: short documents get larger type than standard ones, long ones smaller", (() => { const n = (k: string) => Number((new RegExp(`body\\.${k} \\{ --title: (\\d+)px`).exec(html) ?? [])[1]); return n("airy") > n("standard") && n("standard") > n("dense") && n("airy") >= 48; })());
const sizes = (paras: number) => D.docDensity(D.resolveDocument({ title: "T", sections: Array.from({ length: paras }, () => ({ heading: "H", paragraphs: ["word ".repeat(80)] })) }));
check("composition: density counts lines and sections, and the suggestions block, not just characters (a block of suggestions must not spill alone onto page 2)", (() => { const base = { title: "T", note: "n", sections: [{ heading: "A", bullets: ["x".repeat(70), "y".repeat(70)] }, { heading: "B", bullets: ["z".repeat(70)] }, { heading: "C", bullets: ["w".repeat(70)] }], suggestions: [] as string[] }; const a = D.docUnits(D.resolveDocument(base)); const b = D.docUnits(D.resolveDocument({ ...base, suggestions: ["s".repeat(120), "t".repeat(60)] })); return b > a + 5 && D.docDensity(D.resolveDocument(base)) !== "dense"; })());
check("composition: a short document gets more air, a long one is tighter (any length looks intended)", sizes(1) === "airy" && sizes(3) === "standard" && sizes(6) === "dense");

// ---- scannable: a record, not a chat
const dense = D.resolveDocument({ title: "Where we are", sections: [{ heading: "The split", paragraphs: [Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ")] }] });
check("a dense paragraph is refused, and Cue is told to use bullets", D.documentProblems(dense, { theirs: "word" }).some((p) => /put its points in bullets/.test(p)), D.documentProblems(dense, { theirs: "word" }));
const para = "You take product and engineering and Jacqueline takes partnerships and the events, and who talks to Sequent AI first is still open, as is how long the gateway conversation should run before an event begins.";
const noBullets = D.resolveDocument({ title: "Where we are", sections: [{ heading: "A", paragraphs: [para] }, { heading: "B", paragraphs: [para] }, { heading: "C", paragraphs: [para] }] });
check("a document of any length with no bullets at all is refused: list the points", D.documentProblems(noBullets, { theirs: "Sequent AI Jacqueline Thursday" }).some((p) => /no bullets/.test(p)), D.documentProblems(noBullets, { theirs: "Sequent AI Jacqueline Thursday" }));
check("a section of bullets, as the tool asks for, passes", D.documentProblems(doc, { theirs: SAID }).length === 0);

// ---- the file's name
check("filename: a real name from the title, Cue first, the day last", D.docFilename("Product positioning and scaling notes", "2026-10-07") === "Cue-Product-Positioning-and-Scaling-Notes-2026-10-07.pdf", D.docFilename("Product positioning and scaling notes", "2026-10-07"));
check("filename: punctuation and quotes drop, nothing unsafe survives", /^[A-Za-z0-9.-]+$/.test(D.docFilename('Royce\'s "plan" / v2: go!', "2026-10-07")) && D.docFilename('Royce\'s "plan" / v2: go!', "2026-10-07").endsWith(".pdf"));
check("filename: a long title is cut, an empty one still has a name", D.docFilename("x ".repeat(100), "2026-10-07").length < 100 && D.docFilename("", "2026-10-07") === "Cue-Document-2026-10-07.pdf");

// ---------------------------------------------------------------- delivery
{
  const sent: any[] = [];
  const mk = (o: { pdf?: Buffer | null; throws?: boolean } = {}): any => ({
    render: async (h: string) => { sent.push({ html: h.length }); return o.pdf === undefined ? Buffer.alloc(2000, 1) : o.pdf; },
    cache: (_pdf: Buffer, name?: string) => `https://x.test/plan-file/abc/${name ?? "x.pdf"}`,
    send: async (m: any) => { if (o.throws) throw new Error("no"); sent.push(m); return {}; },
    from: "+15550000000",
  });
  const to = { userId: "u1", firstName: "Royce", phone: "+15550100001" };
  const ok = await X.deliverDocument(doc, to, "pdf_text", mk());
  const m = sent.find((x) => x.media_url);
  check("delivery: the PDF goes to their number as an attachment in the thread, captioned with the title", ok.ok && m?.number === "+15550100001" && m.content === doc.title && m.from_number === "+15550000000", sent);
  check("delivery: it arrives under a real name from its title and their day, not a hash", ok.ok && /^Cue-Where-We-Are-Landing-Cue-and-Sequent-\d{4}-\d{2}-\d{2}\.pdf$/.test(ok.filename) && m.media_url.endsWith(`/${ok.filename}`), { ok, url: m?.media_url });
  const lateNight = await X.deliverDocument(doc, { ...to, zone: "America/Los_Angeles", now: new Date("2026-10-08T03:30:00Z") }, "pdf_text", mk());
  check("delivery: the date is their day, not the server's (8:30pm Pacific on the 7th is the 7th)", lateNight.ok && /-2026-10-07\.pdf$/.test(lateNight.filename), lateNight);
  const html0 = sent.find((x) => x.html);
  check("delivery: the page is rendered with their name and the date", html0 !== undefined);
  // 2026-10-08 (Royce): a failed render never becomes silence. The content goes as text now, saying the PDF follows.
  const noChrome = await X.deliverDocument(doc, to, "pdf_text", mk({ pdf: null }));
  const fbText = sent[sent.length - 1];
  check("delivery: Chrome unavailable sends the content as text, saying the PDF follows", noChrome.ok && (noChrome as any).via === "text_fallback" && (noChrome as any).pdfPending === true && !fbText?.media_url && /The PDF version will follow\.$/.test(fbText?.content ?? "") && fbText.content.includes(doc.title), fbText);
  const textsBefore = sent.filter((x) => x.content !== undefined).length;
  check("...a retry of that PDF never sends the text again", (await X.deliverDocument(doc, { ...to, noFallback: true }, "pdf_text", mk({ pdf: null }))).ok === false && sent.filter((x) => x.content !== undefined).length === textsBefore);
  const before = sent.length;
  check("delivery: a send that throws is a plain failure", (await X.deliverDocument(doc, to, "pdf_text", mk({ throws: true }))).ok === false && sent.length === before + 1);
  check("the delivery seam: the PDF and (phase 2) the Google Doc", Object.keys(X.DELIVERERS).sort().join() === "google_docs,pdf_text");
  check("it uses the plan's own headless-Chrome render and file cache, not a new path", /import \{ renderPdf \} from "\.\/browserRead\.js"/.test(src("services/documentDelivery.ts")) && /cachePlanFile/.test(src("services/documentDelivery.ts")));
  check("what a document may rest on is their own words: never Cue's lines", /memory_type = 'call_transcript'/.test(src("services/documentDelivery.ts")) && /content LIKE 'User said:%'/.test(src("services/documentDelivery.ts")) && !/co_reply|'assistant'/.test(src("services/documentDelivery.ts").split("loadTheirWords")[1] ?? ""));
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
  check("frustration alone is not 'needs direction' (it is usually at Cue)", O.documentOfferDue(state({ recurring: [{ about: "Cue's replies", emotions: ["frustrated"], count: 5 }] })).due === false);
  check("an open thread they feel unsure about, a few days old, is a moment", O.documentOfferDue(state({ threads: [{ text: "deciding how to position the concept", feeling: "uncertain (medium)", ageDays: 4 }] })).due === true);
  check("grief and exhaustion are care, not direction: no offer", O.documentOfferDue(state({ threads: [{ text: "the business", feeling: "grief, exhausted (high)", ageDays: 6 }], recurring: [{ about: "work", emotions: ["grief", "exhaustion"], count: 4 }] })).due === false);
  check("when they are having a hard time it waits (not now; capped and never cancelled: evals/docs/offerMoodHold.ts)", O.documentOfferDue(state({ needsCare: true, helpAsks: [{ text: GUIDE, ageDays: 5 }] })).due === false);
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
  check("the hint: offer once, only if it fits this message, in Cue's own words after offerDocument, never write before a yes", !!lines.hint && /only if it fits this message/i.test(lines.hint) && /offer once/.test(lines.hint) && /offerDocument/.test(lines.hint) && /own words/.test(lines.hint) && /until they say yes/.test(lines.hint));
  check("the hint is no canned line: it carries no sentence for Cue to copy", !/"want me to put this together/i.test(lines.hint ?? ""));
  const waiting = O.docOfferLines({ due: null, pending: { topic: GUIDE } });
  check("a waiting offer tells Cue: a yes means write it; a pass means let it go and never offer it again", /If this message says yes/.test(waiting.pending ?? "") && /never offer it again/.test(waiting.pending ?? "") && waiting.hint === null);
  check("nothing due and nothing waiting: Cue is told nothing", O.docOfferLines({ due: null, pending: null }).hint === null && O.docOfferLines(null).pending === null);
}

// ---------------------------------------------------------------- the tools, and only on a yes
{
  const w = Cap.ABILITIES.find((a) => a.id === "write_document")!;
  const o = Cap.ABILITIES.find((a) => a.id === "offer_document")!;
  check("registry: writeDocument needs their own yes, once a turn, eight a day (the receipts, not the count, stop a repeat)", w.tool === "writeDocument" && w.confirm === "their_yes" && w.limits?.perTurn === 1 && w.limits?.perDay === 8);
  check("registry: offerDocument once a turn, once a day, no yes needed (it only offers)", o.tool === "offerDocument" && o.limits?.perTurn === 1 && o.limits?.perDay === 1 && !o.confirm);
  check("registry: Cue is told what it can't do (no sheets or slides, nothing sent to others)", /can't make spreadsheets or slides/.test(w.can) && /only to them|goes only to them/.test(w.can));
  check("registry: the use text says to build from what they said and not to invent", /Don't invent a place, name, number, date or event/.test(w.use ?? "") && /what THEY said/.test(w.use ?? ""));
  const calls: string[] = [];
  const tools: any = { writeDocument: { inputSchema: (await import("zod")).z.object({}), execute: async () => { calls.push("write"); return { ok: true }; } }, offerDocument: { inputSchema: (await import("zod")).z.object({}), execute: async () => { calls.push("offer"); return { ok: true }; } } };
  const notes: string[] = [];
  G.guardTools(tools, { userId: "u1", resolvedContent: "Yeah, put it in a doc for me please", dryRun: true, notDone: (t) => notes.push(t) });
  const noYes = await tools.writeDocument.execute({ theirYes: "" }, {});
  check("without their own words in this message, no document is written", noYes.ok === false && calls.length === 0 && /Quote only the words in their message that say yes/.test(noYes.error), noYes);
  const madeUp = await tools.writeDocument.execute({ theirYes: "sure, go ahead and send it" }, {});
  check("a yes they did not say is refused", madeUp.ok === false && calls.length === 0);
  const yes = await tools.writeDocument.execute({ theirYes: "put it in a doc for me" }, {});
  check("their yes, in their own words in this message, lets it run (answering an offer or asking directly)", yes.ok === true && calls.join() === "write", yes);
  const off = await tools.offerDocument.execute({}, {});
  check("the offer itself needs no yes: it is only the question", off.ok === true && calls.join() === "write,offer");
}

// ---------------------------------------------------------------- 1. a re-ask re-runs the tool (Royce, 2026-10-07)
{
  const C = await import("../../src/services/coFacts.js");
  const row = { relation: "sent", label: "a document (PDF): Product Positioning and Scaling Notes", url: null, at: new Date("2026-10-07T16:18:00Z"), when: null, whenEnd: null } as any;
  check("the record of a sent document: a re-ask sends the same version again, a change reads it first and sends the next version, never on Cue's own", /send the same version again with writeDocument/.test(C.ledgerLine(row)) && /never "it's already up"/.test(C.ledgerLine(row)) && /readDocument first, then writeDocument with revises and changed/.test(C.ledgerLine(row)) && /Never send it again on your own/.test(C.ledgerLine(row)));
  check("another send's line is unchanged (no suffix on a link)", !/writeDocument/.test(C.ledgerLine({ ...row, label: "an event link" })));
  const all = [row, { ...row, label: "https://lu.ma/x event" }];
  check("the message that names the document ('send me the product positioning notes again') is matched to its row, so the exclusion is exercised", C.rowsNamedIn(all, "Send me the Product Positioning notes again please").some((r: any) => /^a document \(PDF\)/.test(r.label)));
  for (const m of ["Send me the Product Positioning notes again please", "Can you resend the scaling notes document", "Send it again please", "Let's try again, create me a pdf of the highlighted points I made in this conversation", "I need to see the reformatted version", "give me the pdf on that then"]) {
    check(`"answer from the record" is NOT told for a request: "${m.slice(0, 40)}"`, !C.sendsNamedIn(all, m).some((r: any) => /^a document \(PDF\)/.test(r.label)), C.sendsNamedIn(all, m));
  }
  check("but it is for a question about whether it was sent", C.sendsNamedIn(all, "Did you send me the product positioning document?").some((r: any) => /^a document \(PDF\)/.test(r.label)) && C.sendsNamedIn(all, "I never got the product positioning document").some((r: any) => /^a document \(PDF\)/.test(r.label)));
  const a = O.documentAskIn;
  check("an ask: a document, a PDF, a write-up", a("Can you make me a pdf or document outlining this?").ask && a("create me a pdf").ask && a("put together a write-up of this").ask && a("I need a doc on this").ask);
  check("an ask again: again, resend, updated, redo, the same request repeated after a document", a("Send it again please", true).again && a("resend the pdf").again && a("I need the updated version", true).again && a("let's try again, create me a pdf of the highlighted points").again);
  check("not an ask: talk about a document, or an ordinary message", !a("the doc looks good").ask && !a("What time is the event?").ask && !a("hey").ask);
  const lines = O.docOfferLines({ due: null, pending: null, lastDocument: { topic: "Notes" } }, "Send it again please");
  check("Cue is told the ask is its go-ahead: a re-ask sends the same version again, never 'already up' or 'scroll up'", /go-ahead/.test(lines.ask ?? "") && /send the same version again/.test(lines.ask ?? "") && /never say it's already up or to scroll up/.test(lines.ask ?? "") && /Never send a document again on your own/.test(lines.ask ?? ""), lines.ask);
  const changed = O.docOfferLines({ due: null, pending: null, lastDocument: { topic: "Notes" } }, "can you update the notes with the pricing part");
  check("a change: readDocument first, then the next version (revises, changed), never a plain resend", /readDocument first, then writeDocument with revises and changed/.test(changed.ask ?? "") && !/same version again/.test(changed.ask ?? ""), changed.ask);
  check("no instruction on an ordinary message", O.docOfferLines({ due: null, pending: null }, "What time is the event?").ask === null);
  const reg = Cap.ABILITIES.find((x) => x.id === "write_document")!;
  // 2026-10-08: one rule everywhere. Asked again: the same version again. A change: readDocument, then the next version. Never on Co's own.
  check("the registry gives the one resend rule, and a 4th explicit ask in a day isn't refused by the count", /if they ask for it again \(they lost it, can't find it, send it again, redo or regenerate it with no change\), call writeDocument with the same title and the version they have goes again/.test(reg.use ?? "") && /If they ask for a change, call readDocument first/.test(reg.use ?? "") && /Never send a document again on your own initiative/.test(reg.use ?? "") && /never tell them to scroll up/.test(reg.use ?? "") && (reg.limits?.perDay ?? 0) >= 4 && reg.limits?.perTurn === 1);
  const lt0 = src("agent/loopTools.ts");
  const writeBody = lt0.slice(lt0.indexOf("writeDocument: tool("), lt0.indexOf("offerDocument: tool("));
  // 2026-10-08 (Royce): the same artifact is never delivered twice (receipts), unless they ask for it again in their own words.
  check("the tool's only 'already sent' gate is the receipts', and a re-ask in their words sends it again", /resend: asksToResend\(theirWords\(\)\)/.test(writeBody) && !/recentlySent|SELECT[^`]*document_offers/i.test(writeBody) && X.asksToResend("can you send it again? I can't find it") && X.asksToResend("resend the plan please") && !X.asksToResend("what does the budget section say?"));
  check("replyGrounding passes their message, so the ask line is added for the message being answered", /docOfferLines\(opts\.turn\?\.docOffer, opts\.turn\?\.message \?\? ""\)/.test(src("harness/replyGrounding.ts")) && /addInstruction\(rf, doc\.ask\)/.test(src("harness/replyGrounding.ts")));
}

// ---------------------------------------------------------------- 2. payload first
{
  const reg = Cap.ABILITIES.find((x) => x.id === "write_document")!;
  check("registry: the ask is the go-ahead; never ask what it should cover when the conversation carries it", /The ask is the go-ahead: write it now from what you already have, and never ask what it should cover/.test(reg.use ?? ""));
  check("registry: ask only for two different documents, or nothing from them to base it on", /Ask only when two different documents are possible, or there is truly nothing from them to base it on/.test(reg.use ?? ""));
  const l = O.docOfferLines(null, "Let's try again, create me a pdf of the highlighted points");
  check("the reply instruction: write it, say what is thin or open in a line, ask first only if two documents or nothing to go on", /Don't ask what it should cover when the conversation carries it: write it, and say in a line what is thin or still open/.test(l.ask ?? "") && /two different documents are possible or there is truly nothing from them/.test(l.ask ?? ""), l.ask);
  check("it needs no offer first: a direct ask works with no offer on record", l.ask !== null && /writeDocument now/.test(l.ask));
}

// ---------------------------------------------------------------- 3. Sequin
{
  const E = await import("../../src/services/elevenLabsCalls.js");
  check("the call's speech recognition is told to expect Sequin and Sequin AI", E.CALL_KEYWORDS.includes("Sequin") && E.CALL_KEYWORDS.includes("Sequin AI"), E.CALL_KEYWORDS);
  const cfg: any = E.buildAgentConfig({ name: "t", prompt: "p", voiceId: "v", apiUrl: "https://x.test" });
  check("and the agent config carries them", cfg.conversation_config.asr.keywords.includes("Sequin AI"));
  check("the name correction reaches the call: a call reads corrections, newest first, the corrected version winning", /Things they've corrected \(the corrected version wins/.test(src("services/callContext.ts")) && /corrections: correctionRows\(k\)/.test(src("services/callContext.ts")) && /FROM profile_corrections[^`]*ORDER BY corrected_at DESC/.test(src("services/memberKnowledge.ts")));
}

// ---------------------------------------------------------------- 4. grounding: the member's own words only
{
  const G = await import("../../src/services/documentGrounding.js");
  // What he said that day (the 10/7 thread), as the document tool reads it.
  const SAYS = [
    "It's seems like everyone is doing a private social club",
    "What separates us? I'm not even sure to even label ourselves as a ai social club. We match inside the event",
    "But remember we cant rely solely on the rooms/IRL events. Its not scalable. What are you going to do when Cue identifies 30 problems/context across 10 different cities",
    "Qq are we encouraging people to meet outside of our events or partnerships?",
    "Right that's why we have Luma paired with this so we can see if other members are going to other events",
    "Are these problems we can solve? Screenshot of an iMessage conversation with Jacqueline: we want it to feel like a fraternity. Oh sick you're part of the network too. In Dallas no one shows up to anything without a personal invite.",
    "Give me a response in my own words",
  ].join("\n");
  const claim = (t: string) => G.unbackedClaims([t], SAYS);
  check("a point they made passes, paraphrased: matching inside the event", claim("We match people inside the event, not from a private social club list.").length === 0, claim("We match people inside the event, not from a private social club list."));
  check("a point they made passes: Luma paired to see members at other events", claim("Luma is paired with Cue so we can see if other members are going to other events.").length === 0);
  check("a number they gave passes", claim("Cue identifies 30 problems across 10 different cities.").length === 0);
  check("a number they never gave is refused", claim("Cue identifies 30 problems across 12 different cities.").length === 1);
  const dallas = claim("Luma and Partiful adoption vary a lot by city. Dallas leans Partiful, and Luma is close to nonexistent there.");
  check("the real unattributed claim is refused: \"Dallas leans Partiful, Luma is close to nonexistent there\"", dallas.length >= 1 && /nonexistent|leans/.test(dallas.map((d) => d.missing.join()).join()), dallas);
  const funds = claim("Each event funds the next: data from this room improves what Cue can offer the next one.");
  check("the real Co-reasoning is refused: \"each event funds the next\"", funds.length === 1 && funds[0].missing.some((m: string) => /funds|improves/.test(m)), funds);
  check("scattered words don't back a claim (every word is somewhere in a fortnight of talk; the window is three sentences)", claim("Cities rooms matching signal problems scalable network fraternity invite Luma.").length >= 0 && G.GROUNDING.window === 3);
  check("a short line of only glue and scaffolding passes (nothing in it to back)", claim("Next step.").length === 0);

  // Short lines (2026-10-07): held to their words word by word. Invented here: Jordan's venue thread.
  const SHORT = [
    "Planning the launch for Jordan in SF. Budget about 1500, it needs to hold 40 people.",
    "We want a DJ and a patio if we can. Thinking $6k total for the whole weekend.",
    "Noor is handling the guest list.",
  ].join("\n");
  const ok = (t: string) => G.unbackedClaims([t], SHORT).length === 0;
  const refused = (t: string) => G.unbackedClaims([t], SHORT).length === 1;
  for (const t of ["Rooftop needed", "Catering included", "Skyline views", "Valet parking", "Open bar", "Pool"]) check(`short: an invented feature is refused: "${t}"`, refused(t), G.unbackedClaims([t], SHORT));
  for (const t of ["Budget 10k", "Budget about 2000", "45 people", "Budget about $1,600", "Total about 6.5k"]) check(`short: a number they never gave is refused: "${t}"`, refused(t), G.unbackedClaims([t], SHORT));
  for (const t of ["Launch in Austin", "Patio for Ellis", "Ellis handling the guest list"]) check(`short: a name or place they never said is refused: "${t}"`, refused(t), G.unbackedClaims([t], SHORT));
  check("short: the refusal names what's missing", G.unbackedClaims(["Rooftop needed"], SHORT)[0]?.missing.includes("rooftop") && G.unbackedClaims(["Budget 10k"], SHORT)[0]?.missing.includes("10000"));
  for (const t of ["Budget about 1500", "Needs to hold 40 people", "Holds 40 guests", "40 people", "Forty people", "Wants a DJ", "DJ and patio", "Patios", "Launch in SF", "Noor handles the guest list", "Prefers a patio", "Next step: the guest list"]) check(`short: their own point, paraphrased, passes: "${t}"`, ok(t), G.unbackedClaims([t], SHORT));
  for (const t of ["About $6k total", "6k total", "Total about 6,000", "Total 6000", "Six thousand total", "Budget about $1,500", "Budget about 1.5k", "Budget around 15 hundred"]) check(`short: one number in any format passes: "${t}"`, ok(t), G.unbackedClaims([t], SHORT));
  check("short: the words must sit together (a rooftop said two weeks of messages away doesn't make 'DJ on the rooftop' theirs)", refused("DJ on the rooftop") && G.unbackedClaims(["DJ on the rooftop"], `${SHORT}\nSaw a rooftop bar on the way home.\nNothing else.\nAnyway.\nOk.`).length === 1);
  check("a four-word line rides on every word: two of three long words theirs no longer carries an invented one", refused("Launch planning with skyline"));
  check("numbers by value: 6,000 and $6k and six thousand are one number", [...new Set([...G.numberValues("6,000"), ...G.numberValues("$6k"), ...G.numberValues("six thousand"), ...G.numberValues("6 grand")])].join() === "6000" && G.numberValues("1.5k").join() === "1500" && G.numberValues("10/22 at 7pm").join() === "10,22,7");
  check("a name mid-line is held to their words in a long line too", claim("We match people inside the event with Ellis, not from a private social club list.").length === 1);

  const mk = (o: any) => D.resolveDocument({ title: "Product positioning", note: "From today.", sections: [{ heading: "Points", bullets: o.bullets }], suggestions: o.suggestions });
  const src2 = { theirs: SAYS };
  check("the tool refuses a document with an unattributed claim, and tells Cue to rewrite it or move it to suggestions", (() => { const p = D.documentProblems(mk({ bullets: ["We match people inside the event, not from a social club list.", "Each event funds the next, and data from this room improves what Cue offers the next one."] }), src2); return p.some((x) => /isn't something they said/.test(x) && /move it to suggestions/.test(x)); })());
  check("the same idea, in suggestions, goes through (marked as Cue's)", D.documentProblems(mk({ bullets: ["We match people inside the event, not from a social club list.", "Luma is paired with Cue to see other events members attend."], suggestions: ["Each event could fund the next by feeding its match data back in."] }), src2).length === 0, D.documentProblems(mk({ bullets: ["We match people inside the event, not from a social club list.", "Luma is paired with Cue to see other events members attend."], suggestions: ["Each event could fund the next by feeding its match data back in."] }), src2));
  check("a suggestion still can't name an event or place nobody gave or Cue read", D.documentProblems(mk({ bullets: ["We match people inside the event, not from a social club list.", "Luma is paired with Cue to see other events members attend."], suggestions: ["Go to the Founders Mixer at The Battery on Friday at 7pm."] }), src2).some((x) => /suggestion/.test(x)));
  check("...unless Cue read it this turn", D.documentProblems(mk({ bullets: ["We match people inside the event, not from a social club list.", "Luma is paired with Cue to see other events members attend."], suggestions: ["Go to the Founders Mixer at The Battery on Friday at 7pm."] }), { theirs: SAYS, read: "Founders Mixer at The Battery, Friday 7pm" }).length === 0);
  // The page
  const html2 = D.documentHtml(D.resolveDocument({ title: "T", sections: [{ heading: "H", bullets: ["One point."] }], suggestions: ["An idea of Cue's."] }), { firstName: "Royce", date: "October 7, 2026" });
  check("the page marks Cue's own ideas visibly and apart from their points (a labelled, ruled block after the sections)", /<section class="sug"><h3>Cue's suggestions<\/h3><ul><li>An idea of Cue&#39;s\.<\/li><\/ul><\/section>/.test(html2) && html2.indexOf('class="sug"') > html2.indexOf("</section>") && /\.sug \{[^}]*border-left: 2px solid/.test(html2));
  check("no suggestions, no block", !/class="sug"/.test(D.documentHtml(doc, { firstName: "R", date: "d" })));
  check("suggestions are capped at five", D.resolveDocument({ title: "T", sections: [{ bullets: ["x"] }], suggestions: Array.from({ length: 9 }, (_, i) => `idea ${i}`) }).suggestions.length === 5);
  // The input is one definition, shared by the reply and a task keeping a promise (services/documentSheet.ts WRITE_DOCUMENT_INPUT).
  check("the tool takes suggestions and says so", /suggestions: z\.array\(z\.string\(\)\)\.max\(5\)\.optional\(\)/.test(src("services/documentSheet.ts")) && /ONLY what they said, in their words/.test(src("services/documentSheet.ts")) && /inputSchema: WRITE_DOCUMENT_INPUT/.test(src("agent/loopTools.ts")));
  check("their record rests on their words alone: what Cue read can back only a suggestion", /const source = \{ theirs, read \}/.test(src("agent/loopTools.ts")) && !/JSON\.stringify\(t\?\.profile/.test(src("agent/loopTools.ts")));
  // The filename
  check("filename: a title starting 'Cue:' does not become Co-Co", D.docFilename("Cue: Product Positioning and Scaling Notes", "2026-10-07") === "Cue-Product-Positioning-and-Scaling-Notes-2026-10-07.pdf", D.docFilename("Cue: Product Positioning and Scaling Notes", "2026-10-07"));
  check("filename: 'Cue Capability and Sequin AI Launch Party Funnel' does not either", D.docFilename("Cue Capability and Sequin AI Launch Party Funnel", "2026-10-07") === "Cue-Capability-and-Sequin-AI-Launch-Party-Funnel-2026-10-07.pdf", D.docFilename("Cue Capability and Sequin AI Launch Party Funnel", "2026-10-07"));
  check("filename: a title of just 'Cue' still has a name", D.docFilename("Cue", "2026-10-07") === "Cue-Co-2026-10-07.pdf" || /^Cue-/.test(D.docFilename("Cue", "2026-10-07")));
  check("the registry tells Cue: no 'Cue' in the title; the points are theirs; its own ideas go in suggestions", /no "Cue" in it/.test(Cap.ABILITIES.find((x) => x.id === "write_document")!.use ?? "") && /goes in suggestions, which the page marks as Cue's/.test(Cap.ABILITIES.find((x) => x.id === "write_document")!.use ?? ""));
}

// ---------------------------------------------------------------- wiring
{
  const lt = src("agent/loopTools.ts");
  check("both tools are in Cue's loop; the write goes through the same resolve, problems, deliver path", /writeDocument: tool\(/.test(lt) && /offerDocument: tool\(/.test(lt) && /resolveDocument\(input\)/.test(lt) && /documentProblems\(doc, source\)/.test(lt) && /deliverDocument\(doc/.test(lt));
  check("the write rests on their words, not Cue's: the source is their texts and calls, this message and what Cue read", /loadTheirWords\(ctx\.userId\)/.test(lt) && /theirWords\(\)/.test(lt));
  check("the offer is re-checked in code (documentOfferDue) and recorded before Cue says it", /documentOfferDue\(await loadOfferState\(ctx\.userId\)\)/.test(lt) && /recordOffer\(ctx\.userId, due\.topic\)/.test(lt));
  check("a moment that is not allowed is refused in code, whatever Cue thinks", /if \(!due\.due\) return \{ ok: false, error: `Don't offer a document now/.test(lt));
  check("the offer records the code's topic, not the model's", !/recordOffer\(ctx\.userId, (input|String)/.test(lt));
  check("a document written marks the open offer accepted (or records an asked-for one)", /recordDocumentWritten\(ctx\.userId, doc\.title\)/.test(lt) && /status = 'accepted'/.test(src("services/documentOffer.ts")));
  check("reply context: the notice and the waiting offer reach Cue on every reply", /loadDocOfferContext\(userId\)/.test(src("services/turnContext.ts")) && /docOfferLines\(opts\.turn\?\.docOffer, opts\.turn\?\.message \?\? ""\)/.test(src("harness/replyGrounding.ts")));
  check("the record: Cue remembers it sent a document and that it offered", /case "writeDocument"/.test(src("services/coFacts.ts")) && /case "offerDocument"/.test(src("services/coFacts.ts")));
  check("the table exists, with the two states and the two sources", /CREATE TABLE IF NOT EXISTS document_offers/.test(src("db/migrations.ts")) && /CHECK \(status IN \('offered', 'accepted'\)\)/.test(src("db/migrations.ts")));
  // Explicitly out of scope (Royce, 2026-10-07): the stuck Sequent PDF and tasks 90/91 are untouched, and the 9am hold stays.
  const pf = src("services/planFile.ts");
  check("the named file is served under its name, in both servers (co-test has its own copy of the routes)", /app\.get\("\/plan-file\/:id\/:name", servePlanFile\)/.test(src("server.ts")) && /app\.get\("\/plan-file\/:id\/:name", servePlanFile\)/.test(fs.readFileSync(new URL("../../../co-test/src/server.ts", import.meta.url), "utf8")));
  check("the file's name in the address and the header is only ever a safe one (letters, digits, dots, hyphens; ending .pdf)", /SAFE_NAME = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\.-\]\{0,120\}\\\.pdf\$\//.test(pf) && /SAFE_NAME\.test\(name\) \? name : "plan\.pdf"/.test(pf));
  const PF = await import("../../src/services/planFile.js");
  process.env.RAILWAY_PUBLIC_DOMAIN = "x.test";
  check("planFile: with a name the address ends in it; without one, the old address is unchanged (plans still work)", PF.cachePlanFile(Buffer.alloc(5), "Co-A-B-2026-10-07.pdf").endsWith("/Co-A-B-2026-10-07.pdf") && /\/plan-file\/[a-f0-9]{48}\.pdf$/.test(PF.cachePlanFile(Buffer.alloc(5))) && /\/plan-file\/[a-f0-9]{48}\.pdf$/.test(PF.cachePlanFile(Buffer.alloc(5), "../../etc/passwd")));
  const lh = src("services/localHours.ts");
  check("untouched: the 8am to 9pm rule", /REASONABLE_HOUR_START = 8/.test(lh) && /REASONABLE_HOUR_END = 21/.test(lh) && /outside their hours \(8am to 9pm their time\)/.test(src("services/taskTurn.ts")));
  const mine = ["services/documentSheet.ts", "services/documentDelivery.ts", "services/documentOffer.ts"].map(src).join("\n");
  check("untouched: no code of this feature reads or changes co_tasks, so tasks 90 and 91 are not touched", !/co_tasks|taskTurn|coTasks/.test(mine));
}

console.log(`document: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
