// Royce's document rules (2026-10-11), the parts Co's documents didn't meet. Layer 1: fake Google, fake Sendblue, receipts in memory.
//   Rule 3: a change to a Google Doc Co made goes into that same Doc (same link), and only the change line is texted.
//   Rule 4: every new version says what changed: never a bare "Here's the updated X". When the caller doesn't name it (a plan, a
//           re-run brief), it's worked out from the two versions (review of #143: refusing broke those callers).
//   Review of #143: never write over edits made in the Doc after Co's; the Doc is found by its document, not a recent-50 scan.
//   Rule 6: if the same Doc can't be updated (gone), a new one is made and the text says why; a grant or setup problem is said plainly.
//   npx tsx evals/docs/editRules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
const GD = await import("../../src/services/googleDocs.js");
const X = await import("../../src/services/documentDelivery.js");
const R = await import("../../src/services/deliveryReceipts.js");
const D = await import("../../src/services/documentSheet.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const PAIR = ["11111111-1111-4111-8111-111111111111"];
process.env.GOOGLE_DOCS_TEST_USERS = PAIR.join(",");
const v1 = D.resolveDocument({ title: "Venue brief for the Mission dinner", note: "", kind: "venue_brief", sections: [{ heading: "The room", bullets: ["Alder and Ash, about 40 seated, Friday dinner."] }], suggestions: [] });
const v2 = D.resolveDocument({ title: "Venue brief for the Mission dinner", note: "", kind: "venue_brief", sections: [{ heading: "The room", bullets: ["Mesa Verde, about 40 seated, Saturday dinner."] }], suggestions: [] });
const to = { userId: PAIR[0], firstName: "Jordan", phone: "+15550100001", zone: "America/Los_Angeles", now: new Date("2026-10-11T18:00:00Z") };

// ---------------------------------------------------------------- the Drive call
{
  const seen: { url: string; method: string }[] = [];
  const f = (status: number, body: any): any => async (url: string, init: any) => { seen.push({ url, method: init.method }); return { ok: status < 300, status, json: async () => body }; };
  const ok = await GD.updateGoogleDoc("tok", "F1", "<p>x</p>", f(200, { id: "F1", webViewLink: "https://docs.google.com/document/d/F1/edit" }));
  check("an update writes into the same file (PATCH the upload endpoint for that id)", ok.ok && seen[0].method === "PATCH" && /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/F1\?uploadType=multipart/.test(seen[0].url));
  const gone = await GD.updateGoogleDoc("tok", "F1", "<p>x</p>", f(404, {}));
  check("a Doc they deleted is 'gone'", !gone.ok && (gone as any).cause === "gone");
  const orig = console.error; console.error = () => {};
  const cfg = await GD.updateGoogleDoc("tok", "F1", "<p>x</p>", f(403, { error: { errors: [{ reason: "accessNotConfigured" }], message: "Drive API has not been used in project 1" } }));
  console.error = orig;
  check("our setup is ours (same split as uploads, #141)", !cfg.ok && (cfg as any).cause === "our_config" && /ours to fix/.test(cfg.why));
}

// ---------------------------------------------------------------- rules 3, 4, 6 through deliverAndRecord
const run = async (o: { update?: any; meta?: any; token?: any; oldGrant?: boolean } = {}) => {
  const texts: string[] = [];
  const uploads: string[] = [];
  const updates: string[] = [];
  let n = 0;
  let tokenCalls = 0;
  const deps: any = {
    render: async () => Buffer.alloc(2000, 1), cache: () => "https://x.test/f.pdf", send: async (m: any) => { texts.push(m.content); return {}; }, from: "+1",
    // Disconnected later: the first Doc is made, then the token is gone for the revision.
    googleToken: async () => (o.token !== undefined && tokenCalls++ > 0 ? o.token : "tok"),
    docMeta: async () => o.meta ?? { modifiedAt: new Date("2026-10-11T17:00:00Z") },
    uploadDoc: async (_t: string, name: string) => { uploads.push(name); n++; return { ok: true, id: `F${n}`, link: `https://docs.google.com/document/d/F${n}/edit` }; },
    shareDoc: async () => ({ ok: true }),
    updateDoc: async (_t: string, id: string) => { updates.push(id); return o.update ?? { ok: true, id, link: `https://docs.google.com/document/d/${id}/edit` }; },
  };
  const receipts = R.memoryReceipts();
  const deliver = (d: any, t: any, target: any) => X.deliverDocument(d, t, target, deps);
  const first = await X.deliverAndRecord(v1, { ...to, line: "Here's the venue brief." }, { saveTo: "google_doc", askedForGoogle: true, source: "reply" }, { deliver, receipts, log: async () => null });
  texts.length = 0;
  // A Doc the old combined Google grant made (before 2026-10-15): its receipt names no grant.
  if (o.oldGrant) for (const x of receipts.all) x.driveGrant = null;
  const metaAsked = { n: 0 };
  deps.docMeta = ((m) => async (...a: any[]) => (metaAsked.n++, m(...a)))(deps.docMeta);
  const rid = first.receipts[0]?.id;
  const second = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "reply", revises: rid, changed: "swapped Friday at Alder and Ash for Saturday at Mesa Verde" }, { deliver, receipts, log: async () => null });
  return { first, second, texts, uploads, updates, receipts, metaAsked: metaAsked.n };
};
{
  const r = await run();
  const rec = r.receipts.all.at(-1)!;
  check("rule 3: the change goes into the same Doc (no new upload), even though they didn't say 'Google' this time", r.updates.join() === "F1" && r.uploads.length === 1 && r.second.sentOk[0]?.via === "google_docs" && (r.second.sentOk[0] as any).updatedInPlace === true, r);
  check("rule 3: only the change line is texted (no link, no whole document)", r.texts.length === 1 && /^Swapped Friday at Alder and Ash for Saturday at Mesa Verde\.$/.test(r.texts[0]), r.texts);
  check("the new version's receipt keeps the same link and file", rec.version === 2 && rec.link === "https://docs.google.com/document/d/F1/edit" && rec.driveFileId === "F1");
}
{
  const r = await run({ update: { ok: false, cause: "gone", why: "the Doc isn't in their Drive anymore" } });
  check("rule 6: the Doc is gone, so a new one is made and the text says why, with the new link", r.updates.join() === "F1" && r.uploads.length === 2 && /The earlier Doc isn't in your Drive anymore, so this is a new one\./.test(r.texts[0] ?? "") && /docs\.google\.com\/document\/d\/F2/.test(r.texts[0] ?? ""), r.texts);
}
{
  const r = await run({ update: { ok: false, cause: "reconnect", why: "Google didn't allow it (they need to reconnect Google and allow Docs)" } });
  check("rule 6: a grant problem is said plainly, never swapped for a new Doc silently", r.uploads.length === 1 && r.second.sentOk.length === 0 && /reconnect Google/.test((r.second.results[0] as any).why ?? ""), r.second.results);
}
{
  const r = await run({ meta: { modifiedAt: new Date("2026-10-11T19:30:00Z") } });
  check("review of #143: edits made in the Doc after Co's are never written over: a new Doc, and the text says why", r.updates.length === 0 && r.uploads.length === 2 && /has edits since I made it, so I left it as it is/.test(r.texts[0] ?? ""), r.texts);
}
{
  const r = await run();
  check("a Doc made on Cue's Docs grant is recorded as such, so its next version can go in place", r.receipts.all.every((x) => x.driveGrant === "docs"), r.receipts.all.map((x) => x.driveGrant));
}
{
  // Docs moved to their own grant on Cue's project (2026-10-15); drive.file is per project, so the new grant can't see the old Docs.
  const r = await run({ oldGrant: true });
  check("a Doc the old combined grant made is never checked or written: a new Doc, with the true reason (never 'isn't in your Drive')", r.updates.length === 0 && r.metaAsked === 0 && r.uploads.length === 2 && /I couldn't check the earlier Doc, so this is a new one\./.test(r.texts[0] ?? "") && !/isn't in your Drive/.test(r.texts[0] ?? ""), r.texts);
}
{
  const r = await run({ meta: { gone: true } });
  check("a Doc in the trash or gone is found before writing: a new Doc with the reason", r.updates.length === 0 && r.uploads.length === 2 && /isn't in your Drive anymore/.test(r.texts[0] ?? ""));
}
{
  const r = await run({ token: null });
  const r2 = r.second as any;
  check("…and the member's own text says it's a PDF this time, on any path (not only Co's reply)", /It's a PDF this time, since I couldn't update your Google Doc\./.test(r.texts.at(-1) ?? ""), r.texts);
  check("Google disconnected since: the new version goes as a PDF and Co is told the text said so (no 'they asked for a Google Doc')", r2.docBecamePdf === true && r2.sentOk[0]?.via === "pdf_text" && r2.googleRefused === null && r2.googleMissing === false, { docBecamePdf: r2.docBecamePdf, via: r2.sentOk[0]?.via, refused: r2.googleRefused });
}
{
  // Rule 4 for callers that don't name the change: worked out from the two versions, specific, never bare.
  const receipts = R.memoryReceipts();
  const texts: string[] = [];
  const deps: any = { render: async () => Buffer.alloc(2000, 1), cache: () => "https://x.test/f.pdf", send: async (m: any) => { texts.push(m.content); return {}; }, from: "+1" };
  const deliver = (d: any, t: any, target: any) => X.deliverDocument(d, t, target, deps);
  await X.deliverAndRecord(v1, to, { askedForGoogle: false, source: "reply" }, { deliver, receipts, log: async () => null });
  const plan = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "task:1" }, { deliver, receipts, log: async () => null });
  check("review of #143: a plan or re-run brief without a note still goes, with what changed worked out (section by name and number)", plan.sentOk.length === 1 && plan.line === "Updated the venue brief: changes to the room section (section 1).", plan.line);
  check("and its receipt carries that note", receipts.all.at(-1)?.changeNote === "changes to the room section (section 1)");
  const again = await X.deliverAndRecord(v2, to, { askedForGoogle: false, source: "reply", resend: true }, { deliver, receipts, log: async () => null });
  check("asking for it again still sends the version they have", again.sentOk.length === 1);
  const v3 = D.resolveDocument({ ...v2, sections: [...v2.sections, { heading: "Catering", bullets: ["In house."] }] } as any);
  const added = await X.deliverAndRecord(v3, to, { askedForGoogle: false, source: "task:2" }, { deliver, receipts, log: async () => null });
  check("review of #143: a note that only adds a section still names the document", added.line === "Updated the venue brief: a new Catering section.", added.line);
  const sec = (h: string, b: string[]) => ({ heading: h, paragraphs: [], bullets: b });
  const a = { title: "T", note: "", suggestions: [], sections: [sec("Budget", ["$5k"]), sec("Timeline", ["May"]), sec("Room", ["40"])] } as any;
  check("whatChanged: changed, added and removed sections by name, in Co's own voice (review of #143: never 'Co's suggestions')", R.whatChanged(a, { ...a, sections: [sec("Budget", ["$6k"]), sec("Room", ["40"]), sec("Catering", ["Yes"])] }) === "changes to the Budget section (section 1), and a new Catering section" && R.whatChanged(a, { ...a, suggestions: ["x"] }) === "new suggestions from me" && R.whatChanged(a, { ...a, sections: [a.sections[0], a.sections[2]] }) === "no more Timeline section");
}
{
  // The Doc is looked up by its document, however many receipts they have.
  const receipts = R.memoryReceipts();
  const base: any = { userId: PAIR[0], version: 1, title: "x", kind: "venue_brief", doc: v1, contentHash: "h", status: "delivered", line: null, taskId: null, source: "t", changeNote: null, error: null, nextRetryAt: null };
  await receipts.insert({ ...base, docKey: "brief", channel: "google_docs", link: "https://docs.google.com/document/d/OLD/edit", driveFileId: "OLD", deliveredAt: new Date("2026-01-01") });
  for (let i = 0; i < 80; i++) await receipts.insert({ ...base, docKey: `other-${i}`, channel: "pdf_text", link: null, driveFileId: null, deliveredAt: new Date(`2026-10-0${1 + (i % 9)}`) });
  const found = await receipts.googleDocFor(PAIR[0], "brief");
  check("review of #143: the Doc is found by its document even past 50 other receipts", found?.driveFileId === "OLD");
  check("never another member's Doc", (await receipts.googleDocFor("someone-else", "brief")) === null);
  const src = (await import("node:fs")).readFileSync(new URL("../../src/services/deliveryReceipts.ts", import.meta.url), "utf8");
  check("the database lookup is the member's own, this document's, Google Docs with a file", /WHERE user_id = \$1 AND doc_key = \$2 AND channel = 'google_docs' AND drive_file_id IS NOT NULL/.test(src));
}

console.log(`document edit rules: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
