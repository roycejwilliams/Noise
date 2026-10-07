// Sending a document Co wrote (services/documentSheet.ts). Phase 1: the PDF, attached in their thread, the same way a plan sheet is
// (renderPdf is the plan's own headless-Chrome path; the file is held for ten minutes for Sendblue to fetch, services/planFile.ts).
//
// Phase 2 (2026-10-08): "google_docs" puts the same document in their own Drive as an editable Google Doc and texts the link
// (services/googleDocs.ts). It needs their Google connected with Docs allowed; without that it fails plainly and the PDF still goes.
import pool from "../db/db.js";
import { renderPdf } from "./browserRead.js";
import { cachePlanFile } from "./planFile.js";
import { DateTime } from "luxon";
import { docFilename, documentHtml, type Doc } from "./documentSheet.js";
import { notToTeammate } from "./teamLines.js";

export type DocTarget = "pdf_text" | "google_docs";
export type DeliverResult = { ok: true; via: DocTarget; filename: string; link?: string } | { ok: false; why: string; notConnected?: boolean };
export type DeliverDeps = {
  render: (html: string) => Promise<Buffer | null>;
  cache: (pdf: Buffer, name?: string) => string;
  send: (m: { number: string; content: string; media_url?: string; from_number: string }) => Promise<unknown>;
  from: string;
  // Their Google access token when they connected with Docs allowed, else null (services/googleAuth.ts).
  googleToken?: (userId: string) => Promise<string | null>;
  uploadDoc?: (token: string, name: string, html: string) => Promise<import("./googleDocs.js").DocsUpload>;
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

// The Google Doc: in their own Drive, named like the PDF (without .pdf), and the link texted with the title.
async function googleDoc(doc: Doc, to: DeliverTo, deps: DeliverDeps): Promise<DeliverResult> {
  const token = deps.googleToken ? await deps.googleToken(to.userId).catch(() => null) : null;
  if (!token || !deps.uploadDoc) return { ok: false, why: "their Google isn't connected with Docs allowed", notConnected: true };
  const day = dayFor(to);
  const name = docFilename(doc.title, day.toISODate()!).replace(/\.pdf$/, "");
  const { docsHtml } = await import("./googleDocs.js");
  const up = await deps.uploadDoc(token, name, docsHtml(doc, { firstName: to.firstName, date: day.toFormat("LLLL d, yyyy") }));
  if (!up.ok) return { ok: false, why: up.why };
  try {
    await deps.send({ number: to.phone, content: `${doc.title}\n${up.link}`, from_number: deps.from });
  } catch {
    return { ok: false, why: "the Google Doc was made in their Drive, but the link didn't send by text" };
  }
  return { ok: true, via: "google_docs", filename: name, link: up.link };
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
