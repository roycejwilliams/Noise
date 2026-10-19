// Jacqueline's 10-10 / 10-11 conversation, fixed (read-only review of the dev DB and the co-test log, 2026-10-11):
//   1. her pitch deck (a .pptx, twice) was taken for a photo, logged as "[sent a photo, couldn't load it]" once and not at all
//      the first time (it came with her text), and the ask behind it sat open with nothing carrying it (services/inboundFile.ts);
//   2. the fact check made the replies worse: "Happy to. Send over the deck..." became "I don't have a solid read on your deck",
//      and "Nothing's come through on my end yet" was cut while the next text said it anyway (harness/replyGrounding.ts);
//   3. on the call Co pitched Co to its own co-founder and said "glad you called" on a call it placed (elevenLabsCalls.ts,
//      callLlmProxy.ts, extensions.ts TEAM_BUILDER_LINE);
//   4. her answer to SF Social Club never settled its loop (services/openLoops.ts settleOfferLoop, offerReactions.ts);
//   5. she said she's traveling and SF finds kept coming (services/away.ts, harness/proactive.ts away_hold, taskTurn.ts).
// Layer 1: no model, no network, a fake database.   npx tsx evals/reply-flow/fixes1010.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
const { default: pool } = await import("../../src/db/db.js");
const IF = await import("../../src/services/inboundFile.js");
const F = await import("../../src/services/memberFiles.js");
const G = await import("../../src/harness/replyGrounding.js");
const S = await import("../../src/services/speakable.js");
const EL = await import("../../src/services/elevenLabsCalls.js");
const X = await import("../../src/services/extensions.js");
const P = await import("../../src/services/callLlmProxy.js");
const L = await import("../../src/services/openLoops.js");
const A = await import("../../src/services/away.js");
const PR = await import("../../src/harness/proactive.js");
const TT = await import("../../src/services/taskTurn.js");
const FL = await import("../../src/services/factLabels.js");
const srcDir = new URL("../../src/", import.meta.url).pathname;
const src = (p: string) => fs.readFileSync(path.join(srcDir, p), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

// A fake database: every statement logged, answered by the first matching handler.
type Handler = [RegExp, (sql: string, p: any[]) => any];
const log: { sql: string; p: any[] }[] = [];
let handlers: Handler[] = [];
const fakeQuery = async (sql: string, p: any[] = []) => {
  log.push({ sql, p });
  for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, p);
  return { rows: [], rowCount: 0 };
};
(pool as any).query = fakeQuery;
const fakeDb = { query: fakeQuery, connect: async () => ({ query: fakeQuery, release: () => {} }) };
const reset = (h: Handler[] = []) => { log.length = 0; handlers = h; };
const ran = (re: RegExp) => log.some((l) => re.test(l.sql));

// A real zip, written here: what PowerPoint, Word and Keynote files are underneath.
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const raw = Buffer.from(body, "utf8");
    const data = deflateRawSync(raw);
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, n);
    offset += 30 + n.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
const slide = (...lines: string[]) => `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`;
const PPTX = zip({
  "[Content_Types].xml": "<Types/>",
  "ppt/presentation.xml": "<p:presentation/>",
  "ppt/slides/slide1.xml": slide("Cue", "The companion for people you haven&apos;t met"),
  "ppt/slides/slide2.xml": slide("Problem", "Rooms full of strangers &amp; no way in"),
  "ppt/slides/slide10.xml": slide("Ask", "Raising pre-seed"),
});
const DOCX = zip({ "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Venue terms</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Capacity </w:t></w:r><w:r><w:t>120</w:t></w:r></w:p></w:body></w:document>` });
const KEYNOTE = zip({ "Index/Document.iwa": "x", "Index/Slide-1.iwa": "x", "preview.jpg": "x" });
const PAGES = zip({ "Index/Document.iwa": "x" });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 32)]);
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypqt  "), Buffer.alloc(40)]);
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// ================================================================ 1. the deck
check("a .pptx is known by its own bytes (the 16:20 and 16:22 sends), never taken for a photo", IF.fileKindOf(PPTX, PPTX_TYPE) === "pptx" && IF.fileKindOf(PPTX, "application/octet-stream") === "pptx");
check("the other kinds: docx, keynote, pages, old office, video, jpeg, pdf, unknown", IF.fileKindOf(DOCX) === "docx" && IF.fileKindOf(KEYNOTE) === "keynote" && IF.fileKindOf(PAGES) === "pages" && IF.fileKindOf(OLE) === "old_office" && IF.fileKindOf(MP4) === "video" && IF.fileKindOf(JPEG) === "image" && IF.fileKindOf(PDF) === "pdf" && IF.fileKindOf(Buffer.from("hello there, not a file at all")) === "unknown");
{
  const t = IF.officeText(PPTX, "pptx") ?? "";
  check("a deck's text is read in code, slides in their own order (10 after 2), entities decoded", /^Slide 1:\nCue\nThe companion for people you haven't met\n\nSlide 2:\nProblem\nRooms full of strangers & no way in\n\nSlide 3:\nAsk\nRaising pre-seed$/.test(t), t);
  check("a Word file's paragraphs, runs joined", IF.officeText(DOCX, "docx") === "Venue terms\nCapacity 120");
  check("a deck with no text in it reads as nothing (never 'read')", IF.officeText(zip({ "ppt/presentation.xml": "x", "ppt/slides/slide1.xml": "<p:sld/>" }), "pptx") === null);
  check("a broken zip reads as nothing, never throws", IF.officeText(Buffer.concat([PPTX.subarray(0, 60), Buffer.alloc(30)]), "pptx") === null && IF.zipNames(Buffer.from("PK\x03\x04 not really")) === null);
}
{
  reset([[/COUNT\(\*\)::int AS n FROM member_files/, () => ({ rows: [{ n: 0 }] })], [/INSERT INTO member_files/, () => ({ rows: [{ n: 2 }] })]]);
  const k = await F.keepFile("u1", PPTX, "https://cdn.sendblue.co/x/Co%20Deck.pptx");
  const ins = log.find((l) => /INSERT INTO member_files/.test(l.sql));
  check("a deck is kept like a PDF: for them alone, numbered, its text read in code (no model call)", k.ok && k.n === 2 && ins?.p[0] === "u1" && /^Slide 1:/.test(String(ins?.p[4])) && ins?.p[1] === "Co Deck.pptx");
  reset();
  check("a Keynote deck isn't kept (Cue can't read it), and nothing is stored", (await F.keepFile("u1", KEYNOTE, null)).ok === false && !ran(/INSERT/));
  check("only PDF, PowerPoint and Word files are keepable", IF.isKeepable("pdf") && IF.isKeepable("pptx") && IF.isKeepable("docx") && !IF.isKeepable("keynote") && !IF.isKeepable("image"));
}
{
  const fact = IF.unreadableFileFact("keynote");
  check("an unreadable file is named for what it is, and the reply offers routes that work", /a Keynote deck/.test(fact) && /paste the key slides/.test(fact) && /PDF/.test(fact) && /link/.test(fact) && /never call it a photo/.test(fact) && /never blame their connection/.test(fact));
  check("the routes and facts carry no em dash and no exclamation point", ![IF.FILE_ROUTES, fact, IF.keptFileFact("pptx", { n: 1, isNew: true }), IF.AWAITED_DETAIL, IF.pickUpFact("x")].some((t) => /—|!/.test(t)));
  check("the record notes: alone, it is the message; with their text, it rides after it", IF.fileRecordNote({ kind: "pptx", unreadable: true }, false) === "[sent a PowerPoint deck Cue couldn't open]" && IF.fileRecordNote({ kind: "pptx", unreadable: true }, true) === "[also sent a PowerPoint deck Cue couldn't open]");
  const sb = src("routes/sendblue.ts");
  check("intake: the file's kind is read before it's taken for a photo, and only an image goes to vision", /fileKind = fileKindOf\(fileBytes, imageRes\.headers\.get\("content-type"\)\)/.test(sb) && /if \(isKeepable\(fileKind\)\)/.test(sb) && /else if \(fileKind === "image" \|\| fileKind === "heic"\)/.test(sb));
  check("intake: a file that came with their text is in the record (the first send left no trace)", /\$\{fileNoteWithText \? ` \$\{fileNoteWithText\}` : ""\}/.test(sb) && /fileNoteWithText = fileRecordNote\(/.test(sb));
  check("intake: the old 'photo, couldn't load it' line is gone", !/\[sent a photo — couldn't load it\]/.test(sb));
  check("intake: an unreadable file's fact and the awaited-file loop are both wired", /unreadableFileFact\(u\.kind/.test(sb) && /IF\.openAwaitedFile\(pool, user\.id/.test(sb) && /type: "loop_check"/.test(sb) && /IF\.closeAwaitedFile\(pool, user\.id\)/.test(sb));
}
{
  reset([[/INSERT INTO open_loops/, () => ({ rows: [{ id: 901 }] })]]);
  const id = await IF.openAwaitedFile(fakeDb as any, "u1", "pptx");
  const w = log[0];
  check("the ask that waits on the file is one loop Cue carries, for that member only, open (so it can be asked about once)", id === 901 && w.p[0] === "u1" && w.p[1] === IF.AWAITED_REF && /source, source_ref/.test(w.sql) && /'open'/.test(w.sql) && /PowerPoint deck/.test(w.p[2]));
  reset([[/UPDATE open_loops SET status = 'done'/, () => ({ rows: [{ title: IF.awaitedFileTitle("pptx") }] })]]);
  const t = await IF.closeAwaitedFile(fakeDb as any, "u1");
  check("a readable file closes it, scoped to them, and the reply picks the ask back up", t === IF.awaitedFileTitle("pptx") && /WHERE user_id = \$1 AND source = 'co'/.test(log[0].sql) && /pick that request back up/.test(IF.pickUpFact(t!)));
  check("the one-time ask carries what would work", /what_would_work: c\.payload\.note/.test(src("harness/proactiveRegistry.ts")));
}

// ================================================================ 2. the fact check
const empty = { message: "", recentConversation: "", contextSummary: "", recentMemories: "", sentThisTurn: [] };
{
  // Row 10393: the draft, and the claims the check found in it.
  const draft = "Happy to. Send over the deck or walk me through the key slides and I'll give you a real read.";
  const rf = G.createReplyFacts();
  const checks = G.claimChecks([{ text: "Happy to.", type: "capability", supported: false, factId: null, quote: null }, { text: "I'll give you a real read", type: "future_promise", supported: false, factId: null, quote: null }], rf, empty as any);
  check("row 10393: agreeing to help is not a capability claim", checks[0].pass === true && checks[1].pass === false);
  const cut = G.stripUnsupported(draft, checks.filter((c) => !c.pass));
  check("row 10393: only the unbacked promise is cut; the invitation to send the deck stays", cut === "Happy to. Send over the deck or walk me through the key slides.", cut);
  check("a capability with a thing in it is still a capability", G.WILLING.test("Happy to.") && G.WILLING.test("Sure, glad to help.") && G.WILLING.test("Absolutely, let's do it.") && !G.WILLING.test("Happy to search for venues.") && !G.WILLING.test("I can call them for you."));
  check("a clause is kept only when it stands as a sentence and carries no failed claim of its own", G.cutTrailingClaims("Sure and I'll send it.", [{ name: "claim_future_promise", pass: false, reason: `future_promise: "I'll send it"` }]) === "Sure and I'll send it." && G.cutTrailingClaims("I sent the link yesterday and I'll send the next one.", [{ name: "claim_past_action", pass: false, reason: `past_action: "I sent the link yesterday"` }, { name: "claim_future_promise", pass: false, reason: `future_promise: "I'll send the next one"` }]) === "I sent the link yesterday and I'll send the next one.");
  check("a head that only sets up the cut part is left whole (it would dangle)", G.cutTrailingClaims("If you send the deck over tonight, I'll read it tonight.", [{ name: "claim_future_promise", pass: false, reason: `future_promise: "I'll read it tonight"` }]) === "If you send the deck over tonight, I'll read it tonight.");
  check("the extraction prompt says a yes to their ask is not a claim", /Saying yes to what they just asked \("Happy to\.", "Sure\."/.test(src("harness/replyGrounding.ts")));
}
{
  // Rows 10405 / 10410: "Nothing's come through on my end yet", with and without the record behind it.
  const draft = "Nothing's come through on my end yet. Send it as a PDF and I'll take a look.";
  const withRecord = G.createReplyFacts();
  G.addFact(withRecord, "known", IF.fileRecordFact([{ at: new Date(), content: "User said: [sent a PowerPoint deck Cue couldn't open]" }], "Did you receive it? I just sent it")!);
  const noRecord = G.createReplyFacts();
  const narr = (rf: any) => G.codeChecks(draft, rf, empty as any).some((c) => c.name === "no_internal_narration" && !c.pass);
  check("narration: allowed when the record shows nothing readable arrived", !narr(withRecord));
  check("narration: still refused with no record behind it", narr(noRecord));
  const claim = [{ text: "Nothing's come through on my end yet", type: "past_action" as const, supported: false, factId: null, quote: null }];
  check("the claim check agrees with the narration check, both ways", G.claimChecks(claim, withRecord, empty as any)[0].pass === true && G.claimChecks(claim, noRecord, empty as any)[0].pass === false);
  check("a positive 'it came through' is never backed by that record", G.claimChecks([{ text: "Got it, it came through", type: "past_action", supported: false, factId: null, quote: null }], withRecord, empty as any)[0].pass === false);
  check("row 10410's wording is an arrival denial too", IF.arrivalDenial("That one didn't come through either, Jacqueline.") && IF.arrivalDenial("Photo didn't come through on my end, can't see it.") && !IF.arrivalDenial("Still digging on my end."));
  check("narration rule itself is unchanged for Cue's machinery", !!S.narratesInternalState("The search hit a limit on my end.") && !S.narratesInternalState("Nothing's come through on my end yet.", { allow: IF.arrivalDenial }));
}
{
  const at = (min: number) => new Date(Date.UTC(2026, 9, 10, 23, min));
  const line = (min: number, content: string) => ({ at: at(min), content });
  check("the record: an unreadable file means nothing readable has come", /no readable file or photo has come through since/.test(IF.fileRecordFact([line(20, "User said: Hi Cue, can you help pressure test my pitch deck? [also sent a PowerPoint deck Cue couldn't open]")], "Did you receive it?") ?? ""));
  check("the record: the old photo line counts as unreadable", /a photo/.test(IF.fileRecordFact([line(21, "User said: [sent a photo — couldn't load it]")], "x") ?? ""));
  check("the record: a readable photo or kept file in the window means no such fact", IF.fileRecordFact([line(1, "User said: [sent a photo showing: a slide]")], "did you get it") === null && IF.fileRecordFact([line(1, "User said: here [also sent a PDF, kept as their file #3]")], "did you get it") === null);
  check("review #140, 5: a deck kept 45 minutes ago (outside the 30-minute lines) still means 'it came', so no 'nothing arrived' fact", IF.fileRecordFact([line(45, "User said: did you get my deck?")], "did you get my deck?", at(0)) === null);
  check("review #140, 5: an unreadable file AFTER an older kept one is still 'couldn't open'; one before a newer kept one is not", /couldn't be opened/.test(IF.fileRecordFact([line(30, "User said: [sent a Keynote deck Cue couldn't open]")], "x", at(0)) ?? "") && IF.fileRecordFact([line(10, "User said: [sent a Keynote deck Cue couldn't open]")], "x", at(20)) === null);
  check("the record: 'I just sent it' with nothing on file says nothing has arrived", /no file or photo from them has arrived/.test(IF.fileRecordFact([], "Did you receive it? I just sent it") ?? ""));
  check("the record: an everyday message gets no fact, nor 'I sent it to my boss'", IF.fileRecordFact([], "How was your weekend?") === null && IF.fileRecordFact([], "I sent it to my boss already") === null && IF.fileRecordFact([], "I can't see why not") === null);
  check("an arrival denial needs an object or an end: 'can't see why' isn't one", !IF.arrivalDenial("I can't see why not.") && IF.arrivalDenial("I can't open it.") && IF.arrivalDenial("Couldn't open that file."));
  check("a photo or video that didn't open isn't carried as work; a document is", IF.AWAITED_KINDS.has("pptx") && IF.AWAITED_KINDS.has("keynote") && !IF.AWAITED_KINDS.has("image") && !IF.AWAITED_KINDS.has("video"));
  check("a PDF Cue couldn't use says why, not that the format can't be opened", /couldn't use this one \(too large to read here\)/.test(IF.unreadableFileFact("pdf", "too large to read here")));
}

// ================================================================ 3. the call
{
  const out = EL.callSituation({ direction: "outbound", team: true });
  check("outbound: the call says Cue placed it, and never to thank them for calling", /you called them; they did not call you/.test(out) && /Never thank them for calling/.test(out));
  check("team: the call says they build Cue", out.includes(X.TEAM_BUILDER_LINE) && /Never pitch Cue to them/.test(X.TEAM_BUILDER_LINE));
  check("not team: nothing about building Cue", !EL.callSituation({ direction: "inbound", team: false }).includes("builds you"));
  check("the situation leads the call's context", EL.withCallSituation("Recent: interviews.", { direction: "outbound", team: false }).startsWith("This call: you called them") && /Recent: interviews\.$/.test(EL.withCallSituation("Recent: interviews.", { direction: "outbound", team: false })));
  check("registration writes it, from the team flag", /context_summary: withCallSituation\(o\.contextSummary, \{ direction: o\.direction, team: await isTeamMember\(o\.userId\)/.test(src("services/elevenLabsCalls.ts")));
  check("texts: a team member's reply is told they build Cue", /addInstruction\(rf, TEAM_BUILDER_LINE\)/.test(src("harness/replyGrounding.ts")));
  check("the team line has no em dash or exclamation point", !/—|!/.test(X.TEAM_BUILDER_LINE));
}
{
  check("outbound: the slip is dropped, alone", P.thanksForCallingCut("I'm really glad you called.") === null && P.thanksForCallingCut("Thanks for calling.") === null);
  check("outbound: as a clause, the rest stays", P.thanksForCallingCut("I'm really glad you called, because this is a big week for you.") === "This is a big week for you." && P.thanksForCallingCut("So glad you called and I want to hear more.") === "I want to hear more." && P.thanksForCallingCut("Honestly, thanks for calling, it means a lot.") === "Honestly, it means a lot.", [P.thanksForCallingCut("I'm really glad you called, because this is a big week for you."), P.thanksForCallingCut("So glad you called and I want to hear more."), P.thanksForCallingCut("Honestly, thanks for calling, it means a lot.")]);
  check("true lines stay: glad we talked, called it out, glad you picked up", P.thanksForCallingCut("Glad we got to talk.") === "Glad we got to talk." && P.thanksForCallingCut("I'm glad you called that out.") === "I'm glad you called that out." && P.thanksForCallingCut("Glad you picked up.") === "Glad you picked up.");
  const text = (s: string) => [{ type: "content_block_start", index: 0, content_block: { type: "text" } }, ...(s.match(/.{1,6}/gs) ?? []).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })), { type: "content_block_stop", index: 0 }];
  const go = async (system: string) => {
    const out: string[] = [], dropped: string[] = [];
    const body = { model: "x", stream: true, messages: [{ role: "system", content: system }, { role: "assistant", content: "Hey Jordan, it's Cue." }, { role: "user", content: "I've been thinking about the launch a lot." }] };
    for await (const c of P.runCallLlm(body as any, { stream: () => (async function* () { for (const e of text("I'm really glad you called. Tell me what's on your mind about it.")) yield e; })() as any, onDropped: (s, w) => dropped.push(w) })) if (c.choices[0].delta.content) out.push(String(c.choices[0].delta.content));
    return { said: out.join(""), dropped };
  };
  const ob = await go("You are Cue.\nThis call is outbound.");
  check("the call brain: on an outbound call the line never reaches the voice", !/glad you called/i.test(ob.said) && /Tell me what's on your mind/.test(ob.said) && ob.dropped.some((w) => /call Cue placed/.test(w)), ob);
  const ib = await go("You are Cue.\nThis call is inbound.");
  check("the call brain: on an inbound call it's true and stays", /glad you called/i.test(ib.said), ib);
}

// ================================================================ 4. the offer she answered
{
  const rows = [
    { id: 53372, source: "offer", sourceRef: "event_offer:opportunity:sf social club", title: "Sent them SF Social Club", closedAt: null },
    { id: 2, source: "offer", sourceRef: "event_offer:event:other", title: "Sent them Other Night", closedAt: null },
    { id: 3, source: "ask", sourceRef: "a", title: "Sent them SF Social Club", closedAt: null },
  ];
  check("loop 53372: her answer about SF Social Club finds its offer loop, and only it", L.offerLoopsFor(rows, "SF Social Club").map((r) => r.id).join() === "53372");
  reset([[/SELECT id, source, source_ref, title, closed_at FROM open_loops/, () => ({ rows: rows.map((r) => ({ id: r.id, source: r.source, source_ref: r.sourceRef, title: r.title, closed_at: null })) })]]);
  const settled = await L.settleOfferLoop("u1", "SF Social Club", "interested", "interested but traveling, wants to look into it once back in SF", fakeDb as any);
  const up = log.find((l) => /UPDATE open_loops SET status = 'done'/.test(l.sql));
  check("it settles: done, with her answer as the detail, closed as 'answered', scoped to her", settled.join() === "53372" && !!up && up.p[0] === "u1" && /closed_reason = 'answered'/.test(up.sql) && /interested/.test(up.p[2]) && /once back in SF/.test(up.p[2]));
  check("the sync keeps an answered loop closed (the derived offer can't reopen it)", /closed_reason IN \('co', 'expired', 'date_passed', 'answered', 'removed'\)/.test(src("services/openLoops.ts")) && L.planLoop({ source: "offer", sourceRef: "k", title: "t", status: "waiting_on_reply", detail: null, dueDate: null, taskId: null }, { closed_at: new Date(), status: "done" }, null).kind === "keep_closed");
  check("every way a reaction is recorded settles it: noteReaction, the catch-up, the router", /settleSentOffer\(ctx\.userId, match\.name, reaction/.test(src("agent/conversationTools.ts")) && /settleSentOffer\(userId, match\.name, reaction/.test(src("services/reactionCatchup.ts")) && /settleOfferLoop\(userId, pending\.itemName/.test(src("services/offerReactions.ts")));
}

// ================================================================ 5. away
{
  const her = A.awayFromWords("These sound like great activities! Right now imt raveling but interested when im back in sf", "2026-10-11");
  check("her own words (typo and all) say she's away", !!her && her.until === null && /away from home/.test(her.text) && (her.quote ?? "").length >= 8 && "These sound like great activities! Right now imt raveling but interested when im back in sf".includes(her.quote!), her);
  check("a date she names is when it ends", A.awayFromWords("I'm out of town until Oct 20", "2026-10-11")?.until === "2026-10-20" && A.awayFromWords("traveling till the 20th", "2026-10-11")?.until === "2026-10-20" && A.awayFromWords("I'm away, back in SF on Sunday", "2026-10-12")?.until === "2026-10-18");
  check("not away now: away from a desk, a trip still ahead; 'until tomorrow' still is", !A.awayFromWords("I'm away from my desk for an hour", "2026-10-11") && !A.awayFromWords("I'm traveling to LA tomorrow", "2026-10-11") && !A.awayFromWords("I'm out of town next week", "2026-10-11") && A.awayFromWords("I'm traveling until tomorrow", "2026-10-11")?.until === "2026-10-12");
  check("not away: 'not traveling anymore', 'I travel a lot for work', planning a trip", !A.awayFromWords("I'm not traveling anymore", "2026-10-11") && !A.awayFromWords("I travel a lot for work", "2026-10-11") && !A.awayFromWords("thinking about a trip to Tokyo next month", "2026-10-11"));
  check("back: 'I'm back', 'just got back', 'back in SF!'; never 'back to work' or 'when I'm back'", A.backFromWords("I'm back!") && A.backFromWords("just got back last night") && A.backFromWords("back in SF") && !A.backFromWords("I'm back to work tomorrow") && !A.backFromWords("interested when im back in sf"));
  const c = A.awayClaim(her!, "2026-10-11");
  check("the claim: their own words, kind away, a week unless renewed; a dated one ends the day after", c.kind === "away" && c.provenance === "user_said" && c.expiresOn === "2026-10-18" && A.awayClaim(A.awayFromWords("away until Oct 20", "2026-10-11")!, "2026-10-11").expiresOn === "2026-10-21");
  check("away is a kind with a lifetime, written by code only", FL.KINDS.away.lifetime === "ephemeral");
  const now = new Date("2026-10-12T17:00:00Z");
  check("live while it holds, gone after", !!A.awayFromClaims([c], now) && !A.awayFromClaims([c], new Date("2026-10-19T17:00:00Z")) && !A.awayFromClaims([{ ...c, kind: "plan" }], now));

  reset();
  const said = await A.noteAwayFromText(fakeDb as any, "u1", "Right now imt raveling", new Date("2026-10-11T15:58:00Z"), "America/Los_Angeles");
  const ins = log.find((l) => /INSERT INTO member_claims/.test(l.sql));
  check("written the moment she says it, under the claims lock, replacing any older one, for her only", said === "away" && ran(/pg_advisory_xact_lock\(hashtext\('member_claims:' \|\| \$1\)\)/) && ran(/DELETE FROM member_claims WHERE user_id = \$1 AND kind = 'away'/) && ins?.p[0] === "u1" && ins?.p[3] === "away");
  reset();
  check("'I'm back' removes it, and writes nothing", (await A.noteAwayFromText(fakeDb as any, "u1", "Just got back to SF", new Date())) === "back" && ran(/DELETE FROM member_claims/) && !ran(/INSERT/));
  reset();
  check("an everyday text touches nothing", (await A.noteAwayFromText(fakeDb as any, "u1", "Sounds good, see you Thursday", new Date())) === null && log.length === 0);

  const away = A.awayFromClaims([c], now)!;
  const cand = (type: string, payload: any = { askId: "profile", fromProfile: true }) => ({ id: "1", userId: "u1", type, targetKey: `${type}:x`, topicKey: "t", summary: "", priority: 50, dueAt: now, expiresAt: null, payload, attempts: 0, createdAt: now }) as any;
  const held = (type: string, payload?: any) => PR.candidateChecks(cand(type, payload), { now, sends: [], lastInboundAt: now, away } as any).some((k) => k.name === "away_hold" && !k.pass);
  check("dispatch: a find Cue started waits while she's away; an in-room nudge too", held("event_offer") && held("event_match_nudge"));
  check("review #140, 2: an answer to her own ask is never held (\"I'm in NYC, any founder dinners this week?\"), nor a resurfaced answer", !held("event_offer", { askId: "a1", fromProfile: false }) && !held("event_offer", { askId: "a1", fromProfile: false, again: true }));
  check("dispatch: what isn't tied to a place still goes (a companion check-in, an intro tease)", !held("companion") && !held("network_tease"));
  check("dispatch: not away, nothing held", !PR.candidateChecks(cand("event_offer"), { now, sends: [], lastInboundAt: now, away: null } as any).some((k) => k.name === "away_hold"));
  check("a goal's discovery sweep doesn't run while she's away", PR.SWEEP_BLOCKERS.goal.includes("away_hold") && PR.sweepBlockedBy({ state: { now, timezone: null, optedOut: false, sends: [], lastInboundAt: now, away } as any, holdUntil: null, spaceUntil: null }, "goal", []).includes("away_hold"));
  check("the restraint read carries it to dispatch", /away: raw\.away \?\? null/.test(src("harness/proactive.ts")) && /kind = 'away'/.test(src("services/memberKnowledge.ts")));
  const events = [{ name: "Founder Friends SF", url: "https://lu.ma/ff" }];
  check("tasks 164/165: a text carrying an event it found is held while she's away; a role still goes", TT.eventInSend("Founder Friends SF is Monday", [], events) && TT.eventInSend("This one fits", ["https://lu.ma/ff"], events) && !TT.eventInSend("A growth role at Acme fits what you said", ["https://acme.com/jobs/1"], events));
  check("review #140, 2: only a look-out Cue started waits; an ask task, a member look-out and a promise (owed delivery) never do", A.awayHoldsTask({ source: "lookout", lookoutOrigin: "co" }) && !A.awayHoldsTask({ source: "lookout", lookoutOrigin: "member" }) && !A.awayHoldsTask({ source: "promise" }) && !A.awayHoldsTask({ source: "ask" }) && /schedule your next look for the day after 2026-10-20/.test(A.awayTaskNote({ until: "2026-10-20", quote: null, text: "" })));
  check("inbound texts note it", /A\.noteAwayFromText\(pool, user\.id, resolvedContent/.test(src("routes/sendblue.ts")));
}

// ================================================================ review of #140
{
  // 1. A crafted slide: 1.5MB of unclosed <a:p> openers (and one of <a:t> with no close) reads in well under a second.
  const bomb = "<a:p>".repeat(300_000);
  const t0 = Date.now();
  const out = IF.officeText(zip({ "ppt/presentation.xml": "x", "ppt/slides/slide1.xml": bomb, "ppt/slides/slide2.xml": "<a:p><a:t>x".repeat(150_000), "ppt/slides/slide3.xml": slide("Still read") }), "pptx");
  const ms = Date.now() - t0;
  check("review #140, 1: a 1.5MB slide of unclosed openers finishes in well under a second, and the real slide is still read", ms < 500 && /Still read/.test(out ?? ""), { ms, out: (out ?? "").slice(0, 80) });
  check("review #140, 1: <a:tab/>, <a:tbl> and <a:tr> are not text runs", IF.officeText(zip({ "ppt/presentation.xml": "x", "ppt/slides/slide1.xml": "<a:p><a:tbl><a:tr>junk</a:tr></a:tbl><a:r><a:t>One</a:t></a:r><a:tab/><a:r><a:t xml:space=\"preserve\"> two</a:t></a:r></a:p>" }), "pptx") === "Slide 1:\nOne two");
  // 9. An out-of-range entity is dropped, never a thrown error.
  let threw = false, t9: string | null = null;
  try { t9 = IF.officeText(zip({ "ppt/presentation.xml": "x", "ppt/slides/slide1.xml": slide("Bad &#x110000; entity &#xD800; ok &#65;") }), "pptx"); } catch { threw = true; }
  check("review #140, 9: &#x110000; and a lone surrogate don't sink the deck", !threw && t9 === "Slide 1:\nBad entity ok A", t9);
}
{
  // 3. False positives that started a week's hold.
  const no = ["Traveling is exhausting honestly", "when I get back from the gym", "once I'm back from lunch", "I'm traveling on Friday", "I'm back to back with meetings today", "I'm away", "I'm flying to Austin next week"];
  check("review #140, 3: none of these say she's away now", no.every((t) => !A.awayFromWords(t, "2026-10-14")), no.filter((t) => A.awayFromWords(t, "2026-10-14")));
  check("review #140, 3: 'back to back' is not back", !A.backFromWords("I'm back to back with meetings today") && !A.backFromWords("just got back from the gym"));
  check("review #140, 3: 'out of town for the weekend' said Saturday ends Sunday, not in a week; said Wednesday it's ahead", A.awayFromWords("out of town for the weekend", "2026-10-10")?.until === "2026-10-11" && !A.awayFromWords("I'm out of town for the weekend", "2026-10-14"));
  check("review #140, 3: real travel still counts", !!A.awayFromWords("when I'm back from my trip", "2026-10-11") && !!A.awayFromWords("I'm on vacation", "2026-10-11") && !!A.awayFromWords("we're abroad until the 20th", "2026-10-11"));
}
{
  // 4. Only her own words hold anything; the nightly model read can't write one.
  const base = { kind: "away", text: "They're away from home right now (traveling).", quote: "Right now imt raveling", expiresOn: "2026-10-18" };
  const now = new Date("2026-10-12T17:00:00Z");
  check("review #140, 4: a co_inferred or unquoted away claim holds nothing; her own does", !A.awayFromClaims([{ ...base, provenance: "co_inferred" }], now) && !A.awayFromClaims([{ ...base, provenance: "user_said", quote: null }], now) && !!A.awayFromClaims([{ ...base, provenance: "user_said" }], now));
  const C = await import("../../src/services/claims.js");
  const fin = C.finishClaims([{ text: "She is traveling.", provenance: "user_said", kind: "away", quote: "Right now imt raveling", said_on: "2026-10-11" }, { text: "She cooks.", provenance: "user_said", kind: "preference", quote: "I am a cook.", said_on: "2026-10-10" }], [{ at: "2026-10-11", text: "Right now imt raveling" }, { at: "2026-10-10", text: "I am a cook." }], "2026-10-12");
  check("review #140, 4: the nightly read drops a proposed away claim and keeps the rest", fin.length === 1 && fin[0].kind === "preference" && !C.MODEL_KINDS.includes("away" as any));
}
{
  // 6. Real sentences about calling someone else are untouched on an outbound call.
  const keep = ["I'm glad you called me out on that.", "Happy you called Sam back.", "Glad you reached out to her, that took guts.", "Thanks for calling the venue first."];
  check("review #140, 6: about calling someone else, never cut", keep.every((t) => P.thanksForCallingCut(t) === t), keep.map((t) => P.thanksForCallingCut(t)));
  check("review #140, 6: about calling Cue, still cut", P.thanksForCallingCut("I'm really glad you called.") === null && P.thanksForCallingCut("Thanks for calling me back.") === null && P.thanksForCallingCut("Glad you called today, because I had news.") === "I had news.");
}
{
  // 7. WILLING needs the agreeing words.
  check("review #140, 7: '', '.', 'Sure.', 'On it.', 'Count me in.' are not bare agreement", !["", ".", "Sure.", "On it.", "Count me in."].some((t) => G.WILLING.test(t)) && G.WILLING.test("Happy to.") && G.WILLING.test("Sure, happy to help."));
  const sureCap = G.claimChecks([{ text: "On it.", type: "capability", supported: false, factId: null, quote: null }], G.createReplyFacts(), empty as any)[0];
  check("review #140, 7: 'On it.' as a capability still needs support", sureCap.pass === false);
  // 8. A head announcing a count or a list is left whole.
  const f8 = [{ name: "claim_detail", pass: false, reason: `detail: "the Rosewood supper"` }];
  check("review #140, 8: 'I found two options for you, the Rosewood supper.' is not cut to a promise of two", G.cutTrailingClaims("I found two options for you, the Rosewood supper.", f8) === "I found two options for you, the Rosewood supper." && G.cutTrailingClaims("Here's what I found for you this week: the Rosewood supper.", f8) === "Here's what I found for you this week: the Rosewood supper.");
}
{
  // 10. Only a kept document closes the awaited-file loop.
  check("review #140, 10: a selfie after the failed deck leaves it open; a kept deck closes it; a failed deck opens it; a failed photo does nothing", IF.awaitedAction({ kept: null, unreadable: null }) === null && IF.awaitedAction({ kept: "pptx", unreadable: null }) === "close" && IF.awaitedAction({ kept: null, unreadable: "keynote" }) === "open" && IF.awaitedAction({ kept: null, unreadable: "image" }) === null);
}

console.log(`jacqueline 10-10 fixes: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
