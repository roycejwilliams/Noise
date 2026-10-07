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
import pool from "../db/db.js";
import { renderPdf } from "./browserRead.js";
import { cachePlanFile } from "./planFile.js";
import { DateTime } from "luxon";
import { docFilename, documentHtml, type Doc, type DocKind } from "./documentSheet.js";
import { notToTeammate } from "./teamLines.js";

export type DocTarget = "pdf_text" | "google_docs";
export type DeliverResult = { ok: true; via: DocTarget; filename: string; link?: string; shared?: boolean } | { ok: false; why: string; notConnected?: boolean; notAllowed?: boolean };

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
export type DeliverTo = { userId: string; firstName: string; phone: string; zone?: string | null; now?: Date };

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

const dayFor = (to: DeliverTo) => DateTime.fromJSDate(to.now ?? new Date()).setZone(to.zone && DateTime.now().setZone(to.zone).isValid ? to.zone : "America/Los_Angeles");

async function pdfByText(doc: Doc, to: DeliverTo, deps: DeliverDeps): Promise<DeliverResult> {
  // Dated in their own day, not the server's.
  const day = dayFor(to);
  const filename = docFilename(doc.title, day.toISODate()!);
  const pdf = await deps.render(documentHtml(doc, { firstName: to.firstName, date: day.toFormat("LLLL d, yyyy") }));
  if (!pdf) return { ok: false, why: "the document couldn't be made right now" };
  try {
    await deps.send({ number: to.phone, content: doc.title, media_url: deps.cache(pdf, filename), from_number: deps.from });
  } catch {
    return { ok: false, why: "the PDF didn't send by text" };
  }
  return { ok: true, via: "pdf_text", filename };
}

// The Google Doc: in their own Drive, named like the PDF (without .pdf), opened to anyone with the link as an editor, and the link
// texted with the title and a plain line saying who can open it. Re-checked here, whoever calls: a member outside the narrowing list, or a
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
  const share = deps.shareDoc ? await deps.shareDoc(token, up.id).catch(() => ({ ok: false as const, why: "Google didn't open the link" })) : { ok: false as const, why: "not shared" };
  const who = share.ok ? "Anyone with this link can open and edit it." : "Only you can open it for now; share it from the Doc when you're ready.";
  try {
    await deps.send({ number: to.phone, content: `${doc.title}\n${up.link}\n${who}`, from_number: deps.from });
  } catch {
    return { ok: false, why: "the Google Doc was made in their Drive, but the link didn't send by text" };
  }
  return { ok: true, via: "google_docs", filename: name, link: up.link, shared: share.ok };
}

export const DELIVERERS: Record<DocTarget, (doc: Doc, to: DeliverTo, deps: DeliverDeps) => Promise<DeliverResult>> = { pdf_text: pdfByText, google_docs: googleDoc };

export async function deliverDocument(doc: Doc, to: DeliverTo, target: DocTarget = "pdf_text", deps?: DeliverDeps): Promise<DeliverResult> {
  return DELIVERERS[target](doc, to, deps ?? (await realDeps()));
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
