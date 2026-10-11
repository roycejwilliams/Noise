// Sending a document Co wrote (services/documentSheet.ts). Phase 1: the PDF, attached in their thread, the same way a plan sheet is
// (renderPdf is the plan's own headless-Chrome path; the file is held for ten minutes for Sendblue to fetch, services/planFile.ts).
//
// Phase 2 (2026-10-08): "google_docs" puts the same document in their own Drive as an editable Google Doc and texts the link
// (services/googleDocs.ts). It needs their Google connected with Docs allowed; without that it fails plainly and the PDF still goes.
//
// Scope (Royce, 2026-10-07): the Google Doc is for shared working artifacts around events and partnerships (a venue brief, a
// partnership plan, a readout), not member goal-tracking or general productivity docs. Who: whoever has connected Google with Docs
// allowed. While Co's Google project is in Testing mode, Google itself lets only its listed test users connect, so that is the two test
// users without any setting here. GOOGLE_DOCS_TEST_USERS (user ids, at most two) is optional: set, it narrows Docs to those members,
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
// They asked for others to get at it (security review, 2026-10-11): the Doc is opened to anyone with the link only then. The kind
// (venue brief, partnership plan, readout) is Co's own label, so it alone never opens a Doc: their words have to. Otherwise the Doc is
// theirs alone and the text says they can share it from the Doc. Sentence by sentence: a sentence that says not to share ("don't share
// it", "keep it private") closes it for the whole message; one that asks to share it with someone else opens it. "Send it to me",
// "so I can see it" and "the shared space" are not asks to share.
const SHARE_NO = /\b(?:don'?t|do not|never|no need to|not|without) (?:\w+ )?(?:share|sharing|send|forward|give)\b|\bkeep (?:it|this|that)? ?(?:private|to myself|just for me|between us)\b|\bjust for me\b|\bonly (?:for )?me\b|\bprivate\b/i;
const OTHERS = "(?!(?:me|myself|us|i|we|you)\\b)(?:my|the|our|his|her|their|a|an)?\\s*[\\w'-]+(?: [\\w'-]+)?";
const SHARE_YES: RegExp[] = [
  /\bshare (?:it|this|that|the (?:doc|document|link|plan|brief|readout|file))\b/i,
  /\bmake (?:it|this|that) (?:shareable|sharable|editable|public)\b/i,
  new RegExp(`\\b(?:send|forward|email|text|pass) (?:it|this|that|the (?:doc|document|link|plan|brief|readout|file))(?: over| along| on)? to ${OTHERS}`, "i"),
  new RegExp(`\\b(?:give|grant) ${OTHERS} access\\b`, "i"),
  new RegExp(`\\blet ${OTHERS} (?:see|edit|open|read|review|access|look at|work on|add to)\\b`, "i"),
  new RegExp(`\\b(?:so|that) ${OTHERS} (?:can|could) (?:see|edit|open|read|review|access|look at|work on|add to)\\b`, "i"),
  /\bcollaborat\w*/i,
  /\b(?:edit|work on) (?:it |this )?together\b/i,
  /\bshareable\b|\bsharable\b/i,
];
export function asksToShare(words: string): boolean {
  const sentences = String(words ?? "").split(/(?<=[.!?\n])\s*/).map((x) => x.trim()).filter(Boolean);
  if (sentences.some((x) => SHARE_NO.test(x))) return false;
  return sentences.some((x) => SHARE_YES.some((re) => re.test(x)));
}
// via text_fallback: the PDF couldn't be made or sent, so the content went as text in the thread, and the PDF is to follow
// (pdfPending, with the failure in error, retried from the receipt: services/deliveryReceipts.ts).
export type DeliverResult = { ok: true; via: DocTarget | "text_fallback"; filename: string; link?: string; driveFileId?: string; shared?: boolean; pdfPending?: boolean; error?: string } | { ok: false; why: string; notConnected?: boolean; notAllowed?: boolean };

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
  // Their Google access token when they connected with Docs allowed, else null (services/googleAuth.ts).
  googleToken?: (userId: string) => Promise<string | null>;
  uploadDoc?: (token: string, name: string, html: string) => Promise<import("./googleDocs.js").DocsUpload>;
  shareDoc?: (token: string, fileId: string) => Promise<import("./googleDocs.js").DocsShare>;
};
// line: the one sentence that goes with the attachment (services/speakable.ts deliveryLine). Without one, the title.
// noFallback: a retry of a PDF that already went as text (deliveryReceipts) must not send the text again.
export type DeliverTo = { userId: string; firstName: string; phone: string; zone?: string | null; now?: Date; line?: string; noFallback?: boolean; shareByLink?: boolean };

const realDeps = async (): Promise<DeliverDeps> => {
  const sendblue = (await import("./sendblue.js")).default;
  const g = await import("./googleAuth.js");
  const d = await import("./googleDocs.js");
  return {
    render: renderPdf,
    cache: cachePlanFile,
    send: (m) => sendblue.messages.send(m as any),
    from: process.env.SENDBLUE_PHONE_NUMBER!,
    googleToken: async (userId) => (g.googleConfigured() && g.canCreateDocs((await g.isConnected(userId)).scopes) ? g.accessTokenFor(userId).catch(() => null) : null),
    uploadDoc: (token, name, html) => d.uploadGoogleDoc(token, name, html),
    shareDoc: (token, fileId) => d.shareWithLink(token, fileId),
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
  const pdf = await deps.render(documentHtml(doc, { firstName: to.firstName, date: day.toFormat("LLLL d, yyyy") })).catch(() => null);
  if (!pdf) return fallback("the PDF couldn't be made");
  try {
    // The attachment and its one line, as one send (2026-10-08: a title text, then a "here it is" text, said it three times).
    await deps.send({ number: to.phone, content: to.line ?? doc.title, media_url: deps.cache(pdf, filename), from_number: deps.from });
  } catch (err: any) {
    return fallback(`the PDF didn't send by text (${String(err?.message ?? err).slice(0, 80)})`);
  }
  return { ok: true, via: "pdf_text", filename };
}

// The Google Doc: in their own Drive, named like the PDF (without .pdf), opened to anyone with the link as an editor only when they
// asked to share it (asksToShare; otherwise theirs alone), and the link texted with the title and a plain line saying who can open it. Re-checked here, whoever calls: a member outside the narrowing list, or a
// kind that isn't a shared working artifact, never gets one.
async function googleDoc(doc: Doc, to: DeliverTo, deps: DeliverDeps): Promise<DeliverResult> {
  if (!googleDocAllowed(to.userId, doc.kind)) return { ok: false, why: "a Google Doc is only for a venue brief, partnership plan or readout (and, when GOOGLE_DOCS_TEST_USERS is set, only for those members)", notAllowed: true };
  const token = deps.googleToken ? await deps.googleToken(to.userId).catch(() => null) : null;
  if (!token || !deps.uploadDoc) return { ok: false, why: "their Google isn't connected with Docs allowed", notConnected: true };
  const day = dayFor(to);
  const name = docFilename(doc.title, day.toISODate()!).replace(/\.pdf$/, "");
  const { docsHtml } = await import("./googleDocs.js");
  const up = await deps.uploadDoc(token, name, docsHtml(doc, { firstName: to.firstName, date: day.toFormat("LLLL d, yyyy") }));
  if (!up.ok) return { ok: false, why: up.why };
  const share = !to.shareByLink ? { ok: false as const, why: "they didn't ask to share it" } : deps.shareDoc ? await deps.shareDoc(token, up.id).catch(() => ({ ok: false as const, why: "Google didn't open the link" })) : { ok: false as const, why: "not shared" };
  const who = share.ok ? "Anyone with this link can open and edit it." : "Only you can open it for now; share it from the Doc when you're ready.";
  try {
    await deps.send({ number: to.phone, content: `${to.line ?? doc.title}\n${up.link}\n${who}`, from_number: deps.from });
  } catch {
    return { ok: false, why: "the Google Doc was made in their Drive, but the link didn't send by text" };
  }
  return { ok: true, via: "google_docs", filename: name, link: up.link, driveFileId: up.id, shared: share.ok };
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
  for (const target of targets) {
    const r = await deliver(doc, to, target);
    results.push(r);
    if (!r.ok && target === "google_docs" && (r.notConnected || r.notAllowed)) {
      googleMissing = !!r.notConnected;
      if (!targets.includes("pdf_text")) results.push(await deliver(doc, to, "pdf_text"));
    }
  }
  return { results, sentOk: results.filter((r): r is DeliveredOk => r.ok), googleRefused, googleMissing };
}

// ---------- receipts (services/deliveryReceipts.ts): every delivery is recorded; the same artifact never goes twice

export type RecordedDelivery = TargetsResult & { receipts: Receipt[]; duplicate: Receipt | null; docKey: string; version: number; line: string | undefined };
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
  // They asked for it again (lost it, can't find it, send it again, redo it with no change): the version they have goes again, as
  // it is. A rewrite of it isn't a new version; only a change they asked for (revises) is.
  // A caller that names what changed (a re-checked brief) is sending a new version when the content differs.
  const again = o.resend && !o.revises ? (duplicate ?? (o.changed?.trim() ? null : latest)) : null;
  const sendDoc = again ? again.doc : doc;
  const sendVersion = again ? again.version : version;
  const { deliveredThing } = await import("./speakable.js");
  const line = again ? to.line : version > 1 ? (o.changed?.trim() ? R.changeLine(doc.title, o.changed, doc.kind) : `Here's the updated ${deliveredThing(doc.title, doc.kind)}.`) : to.line;
  const r = await deliverToTargets(sendDoc, { ...to, line }, { saveTo: o.saveTo, askedForGoogle: o.askedForGoogle }, deps.deliver);
  const receipts: Receipt[] = [];
  // It already reached them: a receipt that can't be written is logged, never turned into "it didn't go out" (which would send it
  // again, review of #106).
  for (const ok of r.sentOk) {
    const rec = await store.insert({
        userId: to.userId, docKey, version: sendVersion, title: sendDoc.title, kind: sendDoc.kind ?? null, doc: sendDoc, contentHash: R.contentHash(sendDoc),
        channel: ok.via, status: ok.pdfPending ? "pdf_pending" : "delivered", line: line ?? sendDoc.title, link: ok.link ?? null, driveFileId: ok.driveFileId ?? null,
        taskId: o.taskId ?? null, source: o.source, changeNote: again ? again.changeNote : version > 1 ? (o.changed?.trim() || "updated") : null,
        error: ok.error ?? null, nextRetryAt: ok.pdfPending ? new Date(now.getTime() + PDF_RETRY.firstAfterMs) : null, deliveredAt: now,
      }).catch((err: any) => {
        console.error("documentDelivery: the receipt didn't save (it did send):", err?.message ?? err);
        return null;
      });
    if (rec) receipts.push(rec);
    if (ok.pdfPending) await log({ layer: 7, decision: "document.pdf_failed", userId: to.userId, outcome: "skip", action: "sent_as_text", reason: ok.error ?? null, proposal: { title: sendDoc.title, docKey, version: sendVersion, source: o.source } }).catch(() => {});
  }
  return { ...r, receipts, duplicate: null, docKey, version: sendVersion, line };
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
  theirWords: loadTheirWords, blocked: documentSendBlocked, deliver: deliverDocument, record: recordDocumentSent, now: () => new Date(),
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
  const problems = documentProblems(doc, { theirs, read: o.read });
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
    if (!deps.claim) return { ok: false, blocked: true, why: "Not sent: a document Co starts itself needs the proactive ledger, and it isn't available here." };
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
    const to: DeliverTo = { userId: o.userId, firstName: o.firstName, phone: o.phone, zone: o.zone, now, line, shareByLink: asksToShare(o.taskTheirWords) };
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
  const { rows } = await pool
    .query(
      `SELECT memory_type, content FROM co_memories
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days' AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}))
       ORDER BY created_at DESC LIMIT 120`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows
    .map((r: any) =>
      r.memory_type === "call_transcript"
        ? String(r.content).split("\n").filter((l) => /^\s*user\s*:/i.test(l)).map((l) => l.replace(/^\s*user\s*:\s*/i, "")).join(" ")
        : String(r.content).replace(/^User said:\s*/i, ""),
    )
    .join("\n");
}
