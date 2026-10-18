// Sending a document Co wrote (services/documentSheet.ts). Phase 1: the PDF, attached in their thread, the same way a plan sheet is
// (renderPdf is the plan's own headless-Chrome path; the file is held for ten minutes for Sendblue to fetch, services/planFile.ts).
//
// Phase 2 (2026-10-08): "google_docs" puts the same document in their own Drive as an editable Google Doc and texts the link
// (services/googleDocs.ts). It needs their Docs grant (services/cueGrants.ts, Drive files only, on Cue's published project since
// 2026-10-15; before that, the combined Google grant); without it, it fails plainly and the PDF still goes.
//
// Scope (Royce, 2026-10-07): the Google Doc is for shared working artifacts around events and partnerships (a venue brief, a
// partnership plan, a readout), not member goal-tracking or general productivity docs. Who: whoever has connected Google with Docs
// allowed. GOOGLE_DOCS_TEST_USERS (user ids, at most two) is optional: set, it narrows Docs to those members,
// and it is the lock to set before the Google project ever leaves Testing mode. Every other kind gets the PDF.
import type { Receipt, ReceiptStore } from "./deliveryReceipts.js";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { renderPdf } from "./browserRead.js";
import { cachePlanFile } from "./planFile.js";
import { DateTime } from "luxon";
import { docFilename, documentHtml, type Doc, type DocKind } from "./documentSheet.js";
import { notToTeammate } from "./teamLines.js";

export type DocTarget = "pdf_text" | "google_docs";
// They asked for a Google Doc (or for it in their Drive), in their own words (agent/loopTools.ts re-exports it).
export const GOOGLE_DOC_ASK = /\bgoogle\s*docs?\b|\bgoogle\s*drive\b|\bgdocs?\b|\b(?:in|to) (?:my )?(?:google )?drive\b/i;
// Link sharing (security review, 2026-10-11): Co never opens a Doc to anyone with the link on its own. Three rounds of reading the
// member's words for "share it" each found new over-shares ("don't let the venue see it", "share it with Notion", "send it to my work
// email"), so the guard checks nothing it would have to guess: every Doc is theirs alone, and the text says they can share it from the
// Doc. shareByLink stays on DeliverTo for a later, explicit yes (a logged answer to "want anyone with the link to edit it?").
// via text_fallback: the PDF couldn't be made or sent, so the content went as text in the thread, and the PDF is to follow
// (pdfPending, with the failure in error, retried from the receipt: services/deliveryReceipts.ts).
export type DeliverResult = { ok: true; via: DocTarget | "text_fallback"; filename: string; link?: string; driveFileId?: string; driveGrant?: "docs"; shared?: boolean; updatedInPlace?: boolean; newDocBecause?: string; pdfPending?: boolean; error?: string } | { ok: false; why: string; notConnected?: boolean; notAllowed?: boolean };

// The kinds that may become a shared Google Doc, and the optional narrowing list of members (at most two user ids).
export const SHARED_DOC_KINDS: readonly DocKind[] = ["venue_brief", "partnership_plan", "readout"];
export function docsTestPair(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.GOOGLE_DOCS_TEST_USERS ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 2);
}
// Unset: anyone (their connected Google, checked at delivery, is the gate). Set: only those members.
export function docsMemberAllowed(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pair = docsTestPair(env);
  return pair.length === 0 || pair.includes(userId);
}
// The Docs grant's moment (Royce, 2026-10-15): "the consent screen appears the first time a member actually makes a doc, never
// before." True once a document that could be a Google Doc (a shared working artifact) has been made for them and Docs is open to
// them; until then no Docs link goes, whatever is said.
export async function docsMomentReached(userId: string, db: { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> } = pool, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!docsMemberAllowed(userId, env)) return false;
  const { rows } = await db.query(`SELECT 1 FROM document_deliveries WHERE user_id = $1 AND kind = ANY($2::text[]) LIMIT 1`, [userId, [...SHARED_DOC_KINDS]]);
  return rows.length > 0;
}
export function googleDocAllowed(userId: string, kind: DocKind | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return docsMemberAllowed(userId, env) && SHARED_DOC_KINDS.includes(kind ?? "other");
}
// Pure: where a document goes. A Google Doc only when they asked for one in their own words AND it's allowed for them and this kind;
// otherwise the PDF in their thread.
//   googleRefused: "not_yet" (the narrowing list is set and they aren't on it: Google Docs aren't open to them yet), "kind" (not a shared working artifact).
export function docTargets(o: { userId: string; kind: DocKind | undefined; saveTo?: "pdf" | "google_doc" | "both"; askedForGoogle: boolean; env?: NodeJS.ProcessEnv }): { targets: DocTarget[]; googleRefused: "not_yet" | "kind" | null } {
  const wants = (o.saveTo === "google_doc" || o.saveTo === "both") && o.askedForGoogle;
  if (!wants) return { targets: ["pdf_text"], googleRefused: null };
  if (!docsMemberAllowed(o.userId, o.env)) return { targets: ["pdf_text"], googleRefused: "not_yet" };
  if (!googleDocAllowed(o.userId, o.kind, o.env)) return { targets: ["pdf_text"], googleRefused: "kind" };
  return { targets: o.saveTo === "both" ? ["google_docs", "pdf_text"] : ["google_docs"], googleRefused: null };
}
export type DeliverDeps = {
  render: (html: string) => Promise<Buffer | null>;
  cache: (pdf: Buffer, name?: string) => string;
  send: (m: { number: string; content: string; media_url?: string; from_number: string }) => Promise<unknown>;
  from: string;
  // Their Docs grant's access token (services/cueGrants.ts), else null.
  googleToken?: (userId: string) => Promise<string | null>;
  uploadDoc?: (token: string, name: string, html: string) => Promise<import("./googleDocs.js").DocsUpload>;
  shareDoc?: (token: string, fileId: string) => Promise<import("./googleDocs.js").DocsShare>;
  updateDoc?: (token: string, fileId: string, html: string) => Promise<Awaited<ReturnType<typeof import("./googleDocs.js").updateGoogleDoc>>>;
  docMeta?: (token: string, fileId: string) => Promise<Awaited<ReturnType<typeof import("./googleDocs.js").googleDocMeta>>>;
  // Their design system's look for the PDF (services/designSystem.ts), and the shared design QA before it goes (services/designQa.ts).
  // Left out (tests), the PDF is Co's own design and goes unmeasured.
  look?: (userId: string, doc: Doc) => Promise<import("./coPages/style.js").DeckStyle | null>;
  // Returns the HTML to print: fixed where QA could fix it (a heading left at a page's foot starts the next page), else as it was.
  qa?: (html: string, doc: Doc, userId: string) => Promise<string | null>;
};
// line: the one sentence that goes with the attachment (services/speakable.ts deliveryLine). Without one, the title.
// noFallback: a retry of a PDF that already went as text (deliveryReceipts) must not send the text again.
// inPlace: a new version of a Google Doc Co already made for them (its Drive file and link, from the receipt): written into that same
// Doc, so the link stays the same and only the change line goes (Royce, 2026-10-11 rule 3).
// grant: which grant made it ("docs", or null for the old combined Google grant, which Cue's Docs grant can't see or write).
export type DeliverTo = { userId: string; firstName: string; phone: string; zone?: string | null; now?: Date; line?: string; noFallback?: boolean; shareByLink?: boolean; inPlace?: { fileId: string; link: string; writtenAt: Date; grant?: "docs" | null } };

// Design QA for a document (services/designQa.ts), bounded to 10 seconds: the printed pages are rendered and measured; a heading left
// at the foot of a page is moved to start the next one, and the pages are measured once more. The findings wait here for the delivery
// record (deliverAndRecord logs them with the document's key).
export const DOC_QA_MS = 10_000;
const lastDocQa = new Map<string, { at: number; qa: unknown }>();
export function takeDocQa(userId: string): unknown | null {
  const hit = lastDocQa.get(userId);
  lastDocQa.delete(userId);
  return hit && Date.now() - hit.at < 120_000 ? hit.qa : null;
}
// Pure: CSS that starts each named section on a new page (sections are the document's <section class="sec"> elements, in order).
export function pageBreakFix(doc: Doc, headings: string[]): string {
  const idx = headings.map((h) => doc.sections.findIndex((s) => (s.heading ?? "").trim().slice(0, 60) === h.trim().slice(0, 60))).filter((i) => i >= 0);
  return [...new Set(idx)].map((i) => `section.sec:nth-of-type(${i + 1}){break-before:page}`).join("");
}
async function docQa(html: string, doc: Doc, userId: string): Promise<string | null> {
  const run = async () => {
    const Q = await import("./designQa.js");
    const first = await Q.runQa(html, "doc", doc, { screenshot: false });
    const stranded = first.findings.filter((f) => f.rule === "page_break").map((f) => f.where.replace(/^"|"$/g, ""));
    const fix = pageBreakFix(doc, stranded);
    let out = html;
    let final = first;
    if (fix) {
      out = html.replace("</style>", `${fix}</style>`);
      final = await Q.runQa(out, "doc", doc, { screenshot: false });
    }
    lastDocQa.set(userId, { at: Date.now(), qa: { ran: final.ran, findings: final.findings, first: first.findings.length, fixed: fix ? stranded.map((h) => `"${h}" starts a new page`) : [] } });
    return out;
  };
  return Promise.race([run(), new Promise<null>((r) => setTimeout(() => r(null), DOC_QA_MS))]);
}

const realDeps = async (): Promise<DeliverDeps> => {
  const sendblue = (await import("./sendblue.js")).default;
  const g = await import("./cueGrants.js");
  const d = await import("./googleDocs.js");
  return {
    render: renderPdf,
    cache: cachePlanFile,
    send: (m) => sendblue.messages.send(m as any),
    from: process.env.SENDBLUE_PHONE_NUMBER!,
    googleToken: async (userId) => (g.docsConfigured() ? g.docsToken(userId).catch(() => null) : null),
    uploadDoc: (token, name, html) => d.uploadGoogleDoc(token, name, html),
    shareDoc: (token, fileId) => d.shareWithLink(token, fileId),
    updateDoc: (token, fileId, html) => d.updateGoogleDoc(token, fileId, html),
    docMeta: (token, fileId) => d.googleDocMeta(token, fileId),
    look: async (userId, doc) => {
      const DS = await import("./designSystem.js");
      // A venue brief, a partnership plan or a readout is work; anything else (their goals, a plan for themselves) is personal.
      const ds = await DS.loadDesignSystem(userId, doc.kind && doc.kind !== "other" ? "professional" : "personal");
      return ds.answered.size && !ds.dontCare ? DS.fillDesign(ds, {}).style : null;
    },
    qa: (html, doc, userId) => docQa(html, doc, userId),
  };
};
// The real senders with one part swapped: a plan sends its own rendered sheet (agent/loopTools.ts emailPlan) through the same
// delivery, receipt and fallback path as a document.
export async function deliverDepsWith(over: Partial<DeliverDeps>): Promise<DeliverDeps> {
  return { ...(await realDeps()), ...over };
}

const dayFor = (to: DeliverTo) => DateTime.fromJSDate(to.now ?? new Date()).setZone(to.zone && DateTime.now().setZone(to.zone).isValid ? to.zone : "America/Los_Angeles");

async function pdfByText(doc: Doc, to: DeliverTo, deps: DeliverDeps): Promise<DeliverResult> {
  // Dated in their own day, not the server's.
  const day = dayFor(to);
  const filename = docFilename(doc.title, day.toISODate()!);
  // A failed render or attachment never becomes silence (Royce, 2026-10-08): the content goes as text now, the PDF follows.
  const fallback = async (error: string): Promise<DeliverResult> => {
    if (to.noFallback) return { ok: false, why: error };
    const { documentText } = await import("./deliveryReceipts.js");
    const lead = to.line ?? doc.title;
    try {
      await deps.send({ number: to.phone, content: `${lead}\n\n${documentText(doc)}\n\nThe PDF version will follow.`, from_number: deps.from });
    } catch {
      return { ok: false, why: `the PDF failed (${error}) and the text version didn't send either` };
    }
    return { ok: true, via: "text_fallback", filename, pdfPending: true, error };
  };
  const look = deps.look ? await deps.look(to.userId, doc).catch(() => null) : null;
  const html0 = documentHtml(doc, { firstName: to.firstName, date: day.toFormat("LLLL d, yyyy"), look });
  // Measured before it goes, and fixed where it can be; a QA that can't run (or runs long) never holds the PDF.
  const html = (deps.qa ? await deps.qa(html0, doc, to.userId).catch((err: any) => (console.error("doc design QA failed (non-fatal):", err?.message ?? err), null)) : null) ?? html0;
  const pdf = await deps.render(html).catch(() => null);
  if (!pdf) return fallback("the PDF couldn't be made");
  try {
    // The attachment and its one line, as one send (2026-10-08: a title text, then a "here it is" text, said it three times).
    await deps.send({ number: to.phone, content: to.line ?? doc.title, media_url: deps.cache(pdf, filename), from_number: deps.from });
  } catch (err: any) {
    return fallback(`the PDF didn't send by text (${String(err?.message ?? err).slice(0, 80)})`);
  }
  return { ok: true, via: "pdf_text", filename };
}

// The Google Doc: in their own Drive, named like the PDF (without .pdf), theirs alone (opened to anyone with the link only on an
// explicit, logged yes; nothing sets that yet), and the link texted with the title and a plain line saying who can open it. Re-checked here, whoever calls: a member outside the narrowing list, or a
// kind that isn't a shared working artifact, never gets one.
async function googleDoc(doc: Doc, to: DeliverTo, deps: DeliverDeps): Promise<DeliverResult> {
  if (!googleDocAllowed(to.userId, doc.kind)) return { ok: false, why: "a Google Doc is only for a venue brief, partnership plan or readout (and, when GOOGLE_DOCS_TEST_USERS is set, only for those members)", notAllowed: true };
  const token = deps.googleToken ? await deps.googleToken(to.userId).catch(() => null) : null;
  if (!token || !deps.uploadDoc) return { ok: false, why: "they haven't connected Google Docs", notConnected: true };
  const day = dayFor(to);
  const name = docFilename(doc.title, day.toISODate()!).replace(/\.pdf$/, "");
  const { docsHtml } = await import("./googleDocs.js");
  const html = docsHtml(doc, { firstName: to.firstName, date: day.toFormat("LLLL d, yyyy") });
  // A new version of a Doc Co made: the same Doc, the same link, and only the change line (the link they have still opens it).
  let newDocBecause: string | undefined;
  // A Doc the old combined Google grant made (the Co Club project): Cue's Docs grant can't see it (drive.file is per project), so it's
  // left as it is and this version goes in a new Doc, saying so (never "it isn't in your Drive anymore", which wouldn't be true).
  const oldGrant = !!to.inPlace && to.inPlace.grant !== "docs";
  if (oldGrant) newDocBecause = "I couldn't check the earlier Doc, so this is a new one.";
  // Someone changed the Doc after Co last wrote it (they, or whoever they shared it with): Co never writes over their edits. The new
  // version goes in a new Doc and the text says why (review of #143).
  const EDIT_SLACK_MS = 2 * 60_000;
  const meta = to.inPlace && !oldGrant && deps.updateDoc && deps.docMeta ? await deps.docMeta(token, to.inPlace.fileId).catch(() => null) : null;
  const editedSince = meta && "modifiedAt" in meta && to.inPlace ? meta.modifiedAt.getTime() > to.inPlace.writtenAt.getTime() + EDIT_SLACK_MS : false;
  if (to.inPlace && !oldGrant && editedSince) newDocBecause = "The earlier Doc has edits since I made it, so I left it as it is and put this version in a new one.";
  if (to.inPlace && !oldGrant && meta && "gone" in meta) newDocBecause = "The earlier Doc isn't in your Drive anymore, so this is a new one.";
  if (to.inPlace && !oldGrant && deps.updateDoc && deps.docMeta && !meta) newDocBecause = "I couldn't check the earlier Doc, so this is a new one.";
  if (to.inPlace && deps.updateDoc && !newDocBecause) {
    const upd = await deps.updateDoc(token, to.inPlace.fileId, html).catch(() => ({ ok: false as const, why: "Google didn't answer in time" }));
    if (upd.ok) {
      try {
        await deps.send({ number: to.phone, content: to.line ?? `Updated the ${doc.title}.`, from_number: deps.from });
      } catch {
        return { ok: false, why: "the Google Doc was updated in their Drive, but the line saying so didn't send by text" };
      }
      return { ok: true, via: "google_docs", filename: name, link: to.inPlace.link, driveFileId: upd.id, driveGrant: "docs", updatedInPlace: true };
    }
    // Their grant or our setup: the same failure a new Doc would hit, said plainly. Gone (deleted, moved out of reach) or anything
    // else: a new Doc, and the text says why the link changed (never a silent swap, rule 6).
    if ("cause" in upd && (upd.cause === "reconnect" || upd.cause === "our_config")) return { ok: false, why: upd.why };
    newDocBecause = "cause" in upd && upd.cause === "gone" ? "The earlier Doc isn't in your Drive anymore, so this is a new one." : "I couldn't update the earlier Doc, so this is a new one.";
  }
  const up = await deps.uploadDoc(token, name, html);
  if (!up.ok) return { ok: false, why: up.why };
  const share = !to.shareByLink ? { ok: false as const, why: "they didn't ask to share it" } : deps.shareDoc ? await deps.shareDoc(token, up.id).catch(() => ({ ok: false as const, why: "Google didn't open the link" })) : { ok: false as const, why: "not shared" };
  const who = share.ok ? "Anyone with this link can open and edit it." : "Only you can open it for now; share it from the Doc when you're ready.";
  try {
    await deps.send({ number: to.phone, content: `${to.line ?? doc.title}${newDocBecause ? ` ${newDocBecause}` : ""}\n${up.link}\n${who}`, from_number: deps.from });
  } catch {
    return { ok: false, why: "the Google Doc was made in their Drive, but the link didn't send by text" };
  }
  return { ok: true, via: "google_docs", filename: name, link: up.link, driveFileId: up.id, driveGrant: "docs", shared: share.ok, newDocBecause };
}

export const DELIVERERS: Record<DocTarget, (doc: Doc, to: DeliverTo, deps: DeliverDeps) => Promise<DeliverResult>> = { pdf_text: pdfByText, google_docs: googleDoc };

export async function deliverDocument(doc: Doc, to: DeliverTo, target: DocTarget = "pdf_text", deps?: DeliverDeps): Promise<DeliverResult> {
  return DELIVERERS[target](doc, to, deps ?? (await realDeps()));
}

export type DeliveredOk = Extract<DeliverResult, { ok: true }>;
export type TargetsResult = { results: DeliverResult[]; sentOk: DeliveredOk[]; googleRefused: "not_yet" | "kind" | null; googleMissing: boolean };

// Every target docTargets picks, in order; a Google Doc that can't be made (not connected, not allowed) falls back to the PDF.
// One loop for every caller of writeDocument (a reply and a task keeping a promise).
export async function deliverToTargets(doc: Doc, to: DeliverTo, o: { saveTo?: "pdf" | "google_doc" | "both"; askedForGoogle: boolean }, deliver: typeof deliverDocument = deliverDocument): Promise<TargetsResult> {
  const { targets, googleRefused } = docTargets({ userId: to.userId, kind: doc.kind, saveTo: o.saveTo, askedForGoogle: o.askedForGoogle });
  const results: DeliverResult[] = [];
  let googleMissing = false;
  // A new version of their Google Doc that can't go to it (Docs not allowed for it now, or Google disconnected) goes as a PDF, and
  // the text says so itself, on every path (a reply, a task, a brief), never a silent downgrade (rule 6, review of #143).
  const asPdfInstead = to.inPlace ? { ...to, line: `${to.line ?? doc.title} It's a PDF this time, since I couldn't update your Google Doc.` } : to;
  for (const target of targets) {
    const r = await deliver(doc, target === "pdf_text" && to.inPlace && !targets.includes("google_docs") ? asPdfInstead : to, target);
    results.push(r);
    if (!r.ok && target === "google_docs" && (r.notConnected || r.notAllowed)) {
      googleMissing = !!r.notConnected;
      if (!targets.includes("pdf_text")) results.push(await deliver(doc, asPdfInstead, "pdf_text"));
    }
  }
  return { results, sentOk: results.filter((r): r is DeliveredOk => r.ok), googleRefused, googleMissing };
}

// ---------- receipts (services/deliveryReceipts.ts): every delivery is recorded; the same artifact never goes twice

export type RecordedDelivery = TargetsResult & { receipts: Receipt[]; duplicate: Receipt | null; docKey: string; version: number; line: string | undefined; docBecamePdf?: boolean };
export type RecordDeps = { deliver?: typeof deliverDocument; receipts?: ReceiptStore; now?: () => Date; log?: (d: Parameters<typeof recordDecision>[0]) => Promise<unknown> };

// One delivery, recorded: the artifact's identity (a revision keeps the original's), its version, a duplicate refused, the line
// (a change note for a new version), the send through every target, and one receipt per channel it reached them by.
export async function deliverAndRecord(
  doc: Doc,
  to: DeliverTo,
  // resend: they asked for it again in their own words ("send it again", "I can't find it"): the same version goes once more.
  // docKey: the artifact's identity when its title doesn't carry it (a venue brief is keyed by what it's for, not "Venue options").
  o: { saveTo?: "pdf" | "google_doc" | "both"; askedForGoogle: boolean; source: string; taskId?: number | null; revises?: number | null; changed?: string | null; resend?: boolean; docKey?: string },
  deps: RecordDeps = {},
): Promise<RecordedDelivery> {
  const R = await import("./deliveryReceipts.js");
  const store = deps.receipts ?? R.pgReceipts;
  const now = deps.now?.() ?? to.now ?? new Date();
  const log = deps.log ?? ((d) => recordDecision(d));
  const none = (why: string, extra: Partial<RecordedDelivery> = {}): RecordedDelivery => ({ results: [{ ok: false, why }], sentOk: [], googleRefused: null, googleMissing: false, receipts: [], duplicate: null, docKey: "", version: 0, line: undefined, ...extra });
  const prior = o.revises ? await store.get(to.userId, Number(o.revises)) : null;
  if (o.revises && !prior) return none(`there's no document #${o.revises} on record for them`);
  const docKey = prior?.docKey ?? (o.docKey?.trim() || R.docKeyFor(doc.title));
  const latest = await store.latest(to.userId, docKey);
  const { version, duplicate } = R.nextVersion(latest, R.contentHash(doc));
  if (duplicate && !o.resend) {
    const day = DateTime.fromJSDate(duplicate.deliveredAt).setZone(to.zone && DateTime.now().setZone(to.zone).isValid ? to.zone : "America/Los_Angeles").toFormat("ccc LLL d, h:mma").toLowerCase();
    return none(`it's the same document already delivered (doc #${duplicate.id}, version ${duplicate.version}, ${day}); it goes again only when they ask for it again, never on your own, so point them to the one they have; if they want something changed, read it (readDocument) and send the next version`, { duplicate, docKey, version });
  }
  if (prior && !o.changed?.trim()) return none("a new version needs a short note of what changed (changed), for its one line");
  // Any new version says what changed (Royce, 2026-10-11 rule 4: "never a bare 'I updated your doc'"). A caller that doesn't name it
  // (a plan, a re-run brief) gets it worked out from the two versions: the sections that changed, by name and number.
  const changedNote = o.changed?.trim() || (version > 1 && latest ? R.whatChanged(latest.doc, doc) : "");
  // They asked for it again (lost it, can't find it, send it again, redo it with no change): the version they have goes again, as
  // it is. A rewrite of it isn't a new version; only a change they asked for (revises) is.
  // A caller that names what changed (a re-checked brief) is sending a new version when the content differs.
  const again = o.resend && !o.revises ? (duplicate ?? (o.changed?.trim() ? null : latest)) : null;
  const sendDoc = again ? again.doc : doc;
  const sendVersion = again ? again.version : version;
  const { deliveredThing } = await import("./speakable.js");
  const line = again ? to.line : version > 1 ? (changedNote ? R.changeLine(doc.title, changedNote, doc.kind) : `Here's the updated ${deliveredThing(doc.title, doc.kind)}.`) : to.line;
  // A new version of a Google Doc Co made goes into that same Doc (its file id kept on the receipt since #141).
  const priorDoc = !again && version > 1 ? await store.googleDocFor(to.userId, docKey).catch(() => null) : null;
  const inPlace = priorDoc ? { fileId: priorDoc.driveFileId!, link: priorDoc.link!, writtenAt: priorDoc.deliveredAt, grant: priorDoc.driveGrant ?? null } : undefined;
  // They asked for it as a Google Doc the first time: the new version goes to that Doc (they needn't say "Google" again to change it).
  const r0 = await deliverToTargets(sendDoc, { ...to, line, inPlace }, { saveTo: inPlace ? "google_doc" : o.saveTo, askedForGoogle: o.askedForGoogle || !!inPlace }, deps.deliver);
  // Design metrics (services/designSystem.ts): a document is keyed by its delivery key, so its first version is "made" and every
  // change after it "revised"; first-shot acceptance reads the two. A resend of the same version isn't either. Real deliveries only.
  if (!deps.receipts && !again && r0.sentOk.length) {
    const DS = await import("./designSystem.js");
    await DS.logArtifactDesign({ ownerUserId: to.userId, pageId: `doc:${docKey}`.slice(0, 200), medium: "doc", event: version > 1 ? "revised" : "made", layout: "letter", qa: takeDocQa(to.userId) ?? { ran: false } }).catch(() => {});
  }
  // The earlier version was a Google Doc but this one went as a PDF (Docs no longer allowed for it, or Google disconnected): Co says so
  // (rule 6, never a silent downgrade), and never "they asked for a Google Doc" when this time they didn't.
  const docBecamePdf = !!inPlace && !r0.sentOk.some((x) => x.via === "google_docs") && r0.sentOk.length > 0;
  // The text already said it's a PDF this time (deliverToTargets), so Co isn't handed a reason to repeat (review of #144).
  const r = inPlace && (!o.askedForGoogle || docBecamePdf) ? { ...r0, googleRefused: null, googleMissing: false } : r0;
  const receipts: Receipt[] = [];
  // It already reached them: a receipt that can't be written is logged, never turned into "it didn't go out" (which would send it
  // again, review of #106).
  for (const ok of r.sentOk) {
    const rec = await store.insert({
        userId: to.userId, docKey, version: sendVersion, title: sendDoc.title, kind: sendDoc.kind ?? null, doc: sendDoc, contentHash: R.contentHash(sendDoc),
        channel: ok.via, status: ok.pdfPending ? "pdf_pending" : "delivered", line: line ?? sendDoc.title, link: ok.link ?? null, driveFileId: ok.driveFileId ?? null, driveGrant: ok.driveGrant ?? null,
        taskId: o.taskId ?? null, source: o.source, changeNote: again ? again.changeNote : version > 1 ? (changedNote || "updated") : null,
        error: ok.error ?? null, nextRetryAt: ok.pdfPending ? new Date(now.getTime() + PDF_RETRY.firstAfterMs) : null, deliveredAt: now,
      }).catch((err: any) => {
        console.error("documentDelivery: the receipt didn't save (it did send):", err?.message ?? err);
        return null;
      });
    if (rec) receipts.push(rec);
    if (ok.pdfPending) await log({ layer: 7, decision: "document.pdf_failed", userId: to.userId, outcome: "skip", action: "sent_as_text", reason: ok.error ?? null, proposal: { title: sendDoc.title, docKey, version: sendVersion, source: o.source } }).catch(() => {});
  }
  return { ...r, receipts, duplicate: null, docKey, version: sendVersion, line, docBecamePdf };
}

// A receipt for a delivery that didn't go through deliverAndRecord's senders (a plan emailed to them): the same identity and
// versioning, so it shows under "Documents you've delivered" and readDocument can quote it.
export async function recordSent(doc: Doc, o: { userId: string; channel: Receipt["channel"]; line: string | null; source: string; taskId?: number | null; link?: string | null; now?: Date; docKey?: string }, store?: ReceiptStore): Promise<Receipt> {
  const R = await import("./deliveryReceipts.js");
  const s = store ?? R.pgReceipts;
  const docKey = o.docKey?.trim() || R.docKeyFor(doc.title);
  const latest = await s.latest(o.userId, docKey);
  const { version, duplicate } = R.nextVersion(latest, R.contentHash(doc));
  return s.insert({
    userId: o.userId, docKey, version, title: doc.title, kind: doc.kind ?? null, doc, contentHash: R.contentHash(doc), channel: o.channel, status: "delivered",
    line: o.line ?? doc.title, link: o.link ?? null, driveFileId: null, taskId: o.taskId ?? null, source: o.source, changeNote: duplicate ? duplicate.changeNote : version > 1 ? "updated" : null,
    error: null, nextRetryAt: null, deliveredAt: o.now ?? new Date(),
  });
}

// Pure: the one line that goes with a delivered document (Royce, 2026-10-08: one delivery is the attachment and one line). Co's own
// sentence when it holds to the delivery rules, else the plain line (speakable.ts deliveryLine): no dash, no exclamation point, no
// stale "Got it" for an ask that isn't seconds old, no narrating its own workings, at most two short sentences, and a later delivery
// still says when they asked ("you asked for last night").
export async function captionFor(o: { line?: string | null; title: string; kind?: string | null; askedAt?: Date | null; sendAt: Date; zone?: string | null }): Promise<string> {
  const S = await import("./speakable.js");
  const fallback = S.deliveryLine({ title: o.title, kind: o.kind ?? null, askedAt: o.askedAt ?? null, sendAt: o.sendAt, zone: o.zone ?? null });
  let t = String(o.line ?? "").replace(/\s*[—–]\s*/g, ", ").replace(/\s*!+/g, ".").replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  t = S.dropStaleAck(t, { askedAt: o.askedAt ?? o.sendAt, sendAt: o.sendAt });
  const sentences = t.match(/[^.?]+(?:[.?]+|$)/g)?.filter((x) => x.trim()) ?? [];
  if (sentences.length > 2 || S.wordCount(t) > 40 || S.narratesInternalState(t)) return fallback;
  if (o.askedAt && !S.ackAllowed(o.askedAt, o.sendAt) && !t.toLowerCase().includes(S.askedWhenWords(o.askedAt, o.sendAt, o.zone ?? null))) return fallback;
  return /[.?]$/.test(t) ? t : `${t}.`;
}

// Pure: they asked for a document again, in their own words (it got lost, they can't find it, send it again, redo it with no
// change). A change in the same breath ("redo it with the budget", "send it again but add the dinner") is a change, not a resend:
// that's readDocument and the next version (Royce, 2026-10-08). documentOffer.ts reads this too.
const THE_DOC = String.raw`(?:it|that|this|them|the (?:doc|pdf|plan|document|brief|file|write-?up|one))`;
const RESEND = new RegExp(
  [
    String.raw`\b(?:send|text|share|forward)(?: me)? ${THE_DOC}(?: (?:over|to me|back))? again\b`,
    String.raw`\b(?:can|could|may) i (?:get|have|see) ${THE_DOC} again\b`,
    String.raw`\b(?:redo|regenerate|remake|re-?run) ${THE_DOC}(?: again)?(?=\s*(?:$|[.?!,]|please|pls|for me|\bi\b))`,
    String.raw`\bresend\b|\bre-send\b`,
    String.raw`\bcan'?t find ${THE_DOC}\b|\b(?:lost|deleted) ${THE_DOC}\b`,
    String.raw`\bone more time\b`,
  ].join("|"),
  "i",
);
const CHANGE = /\b(?:update|change|edit|add|adding|remove|removing|include|including|fix|swap|replace|instead|rewrite|revise|tweak|shorten|expand|without|but with)\b|\bwith (?:the|a|an|my|our|more|less|fewer)\b/i;
export const asksToResend = (words: string): boolean => {
  const w = String(words ?? "").replace(/[’‘]/g, "'");
  return RESEND.test(w) && !CHANGE.test(w);
};

export const PDF_RETRY = { firstAfterMs: 5 * 60_000, maxAttempts: 5, backoffMs: 15 * 60_000, claimMs: 15 * 60_000 } as const;

// The PDFs still owed after a text fallback, retried inside their delivery hours: sent with its own line, never the text again.
export async function retryPendingPdfs(now: Date = new Date(), deps: { receipts?: ReceiptStore; deliver?: typeof deliverDocument; person?: (userId: string) => Promise<{ firstName: string; phone: string; zone: string | null } | null>; blocked?: (userId: string, zone: string | null, now: Date, o?: { immediate?: boolean; asked?: boolean }) => Promise<string | null>; log?: RecordDeps["log"] } = {}): Promise<{ sent: number; failed: number; waiting: number }> {
  const R = await import("./deliveryReceipts.js");
  const { deliveredThing } = await import("./speakable.js");
  const { nextDeliveryTime } = await import("./memberTime.js");
  const store = deps.receipts ?? R.pgReceipts;
  const deliver = deps.deliver ?? deliverDocument;
  const log = deps.log ?? ((d) => recordDecision(d));
  const person = deps.person ?? (async (userId: string) => {
    const { rows } = await pool.query(`SELECT first_name, phone_number FROM users WHERE id = $1`, [userId]);
    if (!rows[0]?.phone_number) return null;
    const zone = await (await import("./memberTime.js")).memberZone(userId);
    return { firstName: String(rows[0].first_name ?? ""), phone: String(rows[0].phone_number), zone };
  });
  const out = { sent: 0, failed: 0, waiting: 0 };
  for (const rec of await store.duePdfRetries(now)) {
    // One run owns the row while it works (review of #106: the 5-minute cron had no claim).
    if (!(await store.claim(rec.id, now, new Date(now.getTime() + PDF_RETRY.claimMs)))) continue;
    // A newer delivery of the same document went (a new version, or the same one sent again): this PDF is moot.
    const latest = await store.latest(rec.userId, rec.docKey).catch(() => null);
    if (latest && latest.id !== rec.id && latest.deliveredAt.getTime() >= rec.deliveredAt.getTime()) {
      await store.close(rec.id, `superseded by doc #${latest.id} (version ${latest.version})`);
      out.waiting++;
      continue;
    }
    const p = await person(rec.userId).catch(() => null);
    if (!p) { await store.close(rec.id, "no phone on file"); out.failed++; continue; }
    // The PDF they were told would follow is their own ask, not outreach: a pause doesn't hold it; their hours do.
    const blocked = await (deps.blocked ?? documentSendBlocked)(rec.userId, p.zone, now, { asked: true });
    if (blocked === QUIET_HOURS) {
      // Not a failed try, just later: attempts stay.
      await store.defer(rec.id, nextDeliveryTime(new Date(now.getTime() + 60_000), p.zone), `waiting: ${blocked}`);
      out.waiting++;
      continue;
    }
    if (blocked) {
      // Opted out, no longer a member, or unreadable: never retried again.
      await store.close(rec.id, `not sent: ${blocked}`);
      await log({ layer: 7, decision: "document.pdf_retry", userId: rec.userId, outcome: "skip", action: "closed", reason: blocked, proposal: { receipt: rec.id } }).catch(() => {});
      out.failed++;
      continue;
    }
    const r = await deliver(rec.doc, { userId: rec.userId, firstName: p.firstName, phone: p.phone, zone: p.zone, now, noFallback: true, line: `Here's the PDF version of the ${deliveredThing(rec.title, rec.kind)}.` }, "pdf_text").catch((err: any) => ({ ok: false as const, why: String(err?.message ?? err) }));
    if (r.ok) {
      await store.pdfSent(rec.id, now);
      await log({ layer: 7, decision: "document.pdf_retry", userId: rec.userId, outcome: "act", action: "pdf_sent", proposal: { receipt: rec.id, attempt: rec.attempts + 1 } }).catch(() => {});
      out.sent++;
    } else {
      const last = rec.attempts + 1 >= PDF_RETRY.maxAttempts;
      await store.pdfRetry(rec.id, r.why, last ? null : new Date(now.getTime() + PDF_RETRY.backoffMs * 2 ** rec.attempts));
      await log({ layer: 7, decision: "document.pdf_retry", userId: rec.userId, outcome: "skip", action: last ? "gave_up" : "retry_later", reason: r.why, proposal: { receipt: rec.id, attempt: rec.attempts + 1 } }).catch(() => {});
      out.failed++;
    }
  }
  return out;
}

// A document Co sends on its own (a task keeping a promise, not a reply to a text they just sent) goes inside its window but never in
// their quiet hours, 9pm to 8am their time (services/memberTime.ts DELIVERY_HOURS, Royce 2026-10-08), unless they asked for it right
// away; never while paused, and never to someone who opted out or left, re-read right before it goes. Returns why it can't go now,
// or null.
// asked: something they asked for minutes ago (a research brief), not outreach Co starts, so a pause on proactive outreach doesn't hold it.
export async function documentSendBlocked(userId: string, zone: string | null, now: Date = new Date(), o: { immediate?: boolean; asked?: boolean } = {}): Promise<string | null> {
  const { proactivePaused } = await import("./proactivePause.js");
  if (!o.asked && proactivePaused()) return "proactive outreach is paused";
  const { deliverableAt } = await import("./memberTime.js");
  if (!o.immediate && !deliverableAt(now, zone)) return QUIET_HOURS;
  const { rows } = await pool.query(`SELECT sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] as any[] }));
  if (!rows[0]) return "they couldn't be read";
  if (rows[0].sms_opted_out) return "they opted out of texts";
  if (rows[0].archived_at) return "they're no longer a member";
  return null;
}
export const QUIET_HOURS = "it's their quiet hours (9pm to 8am their time)";

// The record of a document Co sent on its own: a co_facts row (the same label the reply's writeDocument writes, so "promise kept"
// and "did I send you that?" read it, services/followThrough.ts sendsSince) and a line in their thread, so the next reply and the
// "what are you working on" view see it.
export async function recordDocumentSent(userId: string, doc: Pick<Doc, "title">, via: string, source: string, at: Date = new Date()): Promise<void> {
  const { recordFact } = await import("./coFacts.js");
  const { writeMemory } = await import("./memory.js");
  await recordFact({ ownerUserId: userId, subject: "co", relation: "sent", label: `a document (PDF): ${doc.title}`, visibility: "owner", source, happenedAt: at, meta: { via } });
  await writeMemory(userId, "text_exchange", `Co replied: [sent a document: ${doc.title}]`).catch((err: any) => console.error("documentDelivery: logging a sent document failed (it did send):", err?.message ?? err));
  await import("./documentOffer.js").then((m) => m.recordDocumentWritten(userId, doc.title)).catch(() => {});
}

// A task keeping a promise sends the document it promised (the task runner's writeDocument), through the same pipeline as a
// reply: the same input, the same grounding (their points rest on their words; Co's own plan goes in suggestions, which may lean
// only on what Co read), the same targets. What a reply doesn't need and a task does: their hours and opt-out re-checked right
// before it goes, and the record written here (co_facts + their thread), since no reply turn records it.
export type TaskDocResult = { ok: true; title: string; via: string; line?: string; pdfPending?: boolean } | { ok: false; why: string; problems?: string[]; blocked?: boolean; nextAt?: Date; duplicate?: boolean };
export type TaskDocDeps = {
  theirWords: (userId: string) => Promise<string>;
  // Their own record for the checks (services/memberRecord.ts): name and goals for the judge, first name for the word checks.
  // Optional, so stubs without it work (no record: the checks run as before).
  member?: (userId: string) => Promise<import("./memberRecord.js").MemberRecord | null>;
  blocked: typeof documentSendBlocked;
  deliver: typeof deliverDocument;
  record: typeof recordDocumentSent;
  now: () => Date;
  receipts?: ReceiptStore;
  // A Co-initiated document (a look-out from Co's own promise): claimed on the proactive ledger first, released if nothing went.
  claim?: (o: { userId: string; targetKey: string; message: string; kind: "find" | null; zone: string | null; now: Date }) => Promise<{ ok: true; ledgerId: number } | { ok: false; reason: string; retryAt?: Date }>;
  release?: (userId: string, ledgerId: number) => Promise<void>;
};
export const realTaskDocDeps: TaskDocDeps = {
  theirWords: loadTheirWords, member: async (userId) => (await import("./memberRecord.js")).loadMemberRecord(userId), blocked: documentSendBlocked, deliver: deliverDocument, record: recordDocumentSent, now: () => new Date(),
  claim: async (c) => (await import("../harness/proactive.js")).claimCoInitiatedSend({ userId: c.userId, type: "task_update", targetKey: c.targetKey, message: c.message, kind: c.kind, timezone: c.zone, now: c.now }),
  release: async (userId, id) => (await import("../harness/proactive.js")).releaseCoInitiatedClaim(userId, id),
};

export async function sendDocumentForTask(
  input: import("./documentSheet.js").WriteDocumentInput,
  // askedAt: when they asked (the promise task's start), so a later delivery says when: "Here's the plan you asked for last night."
  // coInitiated: a document Co starts itself (a look-out from Co's own promise), PDF or Google Doc alike: it waits on the same gate
  // as any Co-initiated text and goes on the ledger with its kind (Royce, 2026-10-09). Absent: owed, as before.
  o: { userId: string; taskId: number; firstName: string; phone: string; zone: string | null; taskTheirWords: string; read: string; askedAt?: Date | null; coInitiated?: { kind: "find" | null } },
  deps: TaskDocDeps = realTaskDocDeps,
): Promise<TaskDocResult> {
  const { resolveDocument, documentProblems } = await import("./documentSheet.js");
  const doc = resolveDocument(input);
  const theirs = [await deps.theirWords(o.userId).catch(() => ""), o.taskTheirWords].join("\n");
  const member = deps.member ? await deps.member(o.userId).catch(() => null) : null;
  const problems = await (await import("./documentClaims.js")).judgedDocumentProblems(doc, { theirs, read: o.read, member }, documentProblems(doc, { theirs, read: o.read, member }));
  if (problems.length) return { ok: false, problems, why: `Not sent: ${problems.slice(0, 5).join(" | ")}. Fix these and try once more: their points only in their own words; your plan, ideas and recommendations go in suggestions.` };
  // Their quiet hours hold it to their 8am, unless they asked for it right away, in their own words.
  const { askedForImmediate, nextDeliveryTime } = await import("./memberTime.js");
  const immediate = askedForImmediate(o.taskTheirWords);
  const blocked = await deps.blocked(o.userId, o.zone, deps.now(), { immediate });
  if (blocked) {
    const nextAt = blocked === QUIET_HOURS ? nextDeliveryTime(deps.now(), o.zone) : undefined;
    return { ok: false, blocked: true, nextAt, why: `Not sent: ${blocked}.${nextAt ? ` It goes at ${DateTime.fromJSDate(nextAt).setZone(o.zone && DateTime.now().setZone(o.zone).isValid ? o.zone : "America/Los_Angeles").toFormat("h:mma cccc").toLowerCase()} their time; your next look is set for then.` : " Note it and schedule your next look for when it can go."}` };
  }
  const now = deps.now();
  let claimed: number | null = null;
  if (o.coInitiated) {
    if (!deps.claim) return { ok: false, blocked: true, why: "Not sent: a document Cue starts itself needs the proactive ledger, and it isn't available here." };
    const c = await deps.claim({ userId: o.userId, targetKey: `task:${o.taskId}:doc:${now.getTime()}`, message: `[document] ${doc.title}`, kind: o.coInitiated.kind, zone: o.zone, now });
    if (!c.ok) return { ok: false, blocked: true, nextAt: c.retryAt, why: `Not sent: ${c.reason}.` };
    claimed = c.ledgerId;
  }
  const unclaim = async () => { if (claimed !== null) await deps.release?.(o.userId, claimed).catch(() => {}); };
  // Anything that throws before something went out (a caption, a receipts read) releases the claim too (re-review of #131).
  let rd: Awaited<ReturnType<typeof deliverAndRecord>>;
  let line: string;
  try {
    // Co's own line when it holds to the delivery rules (it must still say when they asked), else "Here's the X you asked for last night."
    line = await captionFor({ line: input.line, title: doc.title, kind: doc.kind, askedAt: o.askedAt ?? null, sendAt: now, zone: o.zone });
    const to: DeliverTo = { userId: o.userId, firstName: o.firstName, phone: o.phone, zone: o.zone, now, line, };
    rd = await deliverAndRecord(doc, to, { saveTo: input.saveTo, askedForGoogle: GOOGLE_DOC_ASK.test(o.taskTheirWords), source: `task:${o.taskId}`, taskId: o.taskId, revises: input.revises ?? null, changed: input.changed ?? null }, { deliver: deps.deliver, receipts: deps.receipts, now: deps.now });
  } catch (err) {
    await unclaim();
    throw err;
  }
  if (rd.duplicate) { await unclaim(); return { ok: false, duplicate: true, why: `Not sent: ${(rd.results[0] as any).why}.` }; }
  const { results, sentOk } = rd;
  if (!sentOk.length) await unclaim();
  if (!sentOk.length) return { ok: false, why: `Not sent: ${results.map((r) => (r.ok ? "" : r.why)).filter(Boolean).join("; ") || "it didn't go out"}.` };
  const via = sentOk.map((r) => r.via).join("+");
  // Recorded at the real moment it went (never a pinned test clock: a send dated in the future would "keep" later promises).
  await deps.record(o.userId, doc, via, `task:${o.taskId}`);
  return { ok: true, title: doc.title, via, line: rd.line, pdfPending: sentOk.some((r) => r.pdfPending) };
}

// What a document may rest on: what they said in the last two weeks (their texts and their side of calls). Never Co's own lines.
export async function loadTheirWords(userId: string): Promise<string> {
  return (await loadTheirLines(userId)).join("\n");
}
// The same words, one entry per text or call (oldest first), for a reader that orders them its own way (a deck's judge reads the
// newest first: agent/deckTools.ts deckSource).
export async function loadTheirLines(userId: string): Promise<string[]> {
  const { rows: raw } = await pool
    .query(
      `SELECT memory_type, content FROM co_memories
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days' AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}))
       ORDER BY created_at DESC LIMIT 120`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  // What they had Cue forget or correct never comes back (services/whatCoKnows.ts guardRows, the read-time guard the reply's memory
  // and member knowledge use; a failed guard read leaves the rows as they were, as for those readers).
  const rows = await (await import("./whatCoKnows.js")).guardRows(userId, raw);
  // Oldest first (the newest 120): one stable order, so a claim that spans two of their texts reads in the order they said it, and
  // the verdict doesn't turn on which messages sit next to which (2026-10-12).
  return rows.reverse().map(theirLine);
}
// One row as their words: a call's lines that are theirs, or a text without its prefix.
const theirLine = (r: any): string =>
  r.memory_type === "call_transcript"
    ? String(r.content).split("\n").filter((l) => /^\s*user\s*:/i.test(l)).map((l) => l.replace(/^\s*user\s*:\s*/i, "")).join(" ")
    : String(r.content).replace(/^User said:\s*/i, "");
// Everything they've said, with when (Royce, 2026-10-18: a fact said months ago must reach the deck judge; services/judgeWords.ts
// picks the parts that match the deck's lines). The same rows as their 14 days, any age: their texts and their side of calls, their
// user id only, teammate texts left out. Oldest first; the newest HISTORY_LIMIT rows.
export const HISTORY_LIMIT = 3000;
// Forgetting holds here too (Royce, 2026-10-18): every row goes through the read-time guard (whatCoKnows.ts guardText), so a thing
// they removed or had Cue forget is never read or matched. If the guard can't be read, no history at all (fails closed: a removed
// fact must never come back by this door).
export async function loadTheirHistory(userId: string, q: { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> } = pool): Promise<{ at: string; text: string }[]> {
  const W = await import("./whatCoKnows.js");
  const guards = await W.forgottenRows(userId, q).catch(() => null);
  if (guards === null) return [];
  const { rows } = await q
    .query(
      `SELECT memory_type, content, created_at FROM co_memories
       WHERE user_id = $1 AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}))
       ORDER BY created_at DESC LIMIT $2`,
      [userId, HISTORY_LIMIT],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows
    .reverse()
    .flatMap((r: any) => {
      const content = W.guardText(String(r.content ?? ""), guards);
      return content === null ? [] : [{ at: new Date(r.created_at).toISOString(), text: theirLine({ ...r, content }) }];
    })
    .filter((r) => r.text.trim());
}
