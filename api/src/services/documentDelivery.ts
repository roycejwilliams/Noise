// Sending a document Co wrote (services/documentSheet.ts). Phase 1: the PDF, attached in their thread, the same way a plan sheet is
// (renderPdf is the plan's own headless-Chrome path; the file is held for ten minutes for Sendblue to fetch, services/planFile.ts).
//
// DELIVERERS is the seam for phase 2: a "save to my Google Docs" step is one more entry here (it needs the Google OAuth client and a
// write scope, services/googleAuth.ts, neither of which exists yet), plus "google_docs" in DocTarget. Nothing else moves.
import pool from "../db/db.js";
import { renderPdf } from "./browserRead.js";
import { cachePlanFile } from "./planFile.js";
import { docSlug, documentHtml, type Doc } from "./documentSheet.js";

export type DocTarget = "pdf_text"; // later: | "google_docs"
export type DeliverResult = { ok: true; via: DocTarget; filename: string } | { ok: false; why: string };
export type DeliverDeps = {
  render: (html: string) => Promise<Buffer | null>;
  cache: (pdf: Buffer) => string;
  send: (m: { number: string; content: string; media_url: string; from_number: string }) => Promise<unknown>;
  from: string;
};
export type DeliverTo = { userId: string; firstName: string; phone: string };

const realDeps = async (): Promise<DeliverDeps> => {
  const sendblue = (await import("./sendblue.js")).default;
  return { render: renderPdf, cache: cachePlanFile, send: (m) => sendblue.messages.send(m as any), from: process.env.SENDBLUE_PHONE_NUMBER! };
};

async function pdfByText(doc: Doc, to: DeliverTo, deps: DeliverDeps): Promise<DeliverResult> {
  const pdf = await deps.render(documentHtml(doc, to.firstName));
  if (!pdf) return { ok: false, why: "the document couldn't be made right now" };
  try {
    await deps.send({ number: to.phone, content: doc.title, media_url: deps.cache(pdf), from_number: deps.from });
  } catch {
    return { ok: false, why: "the PDF didn't send by text" };
  }
  return { ok: true, via: "pdf_text", filename: `${docSlug(doc.title)}.pdf` };
}

export const DELIVERERS: Record<DocTarget, (doc: Doc, to: DeliverTo, deps: DeliverDeps) => Promise<DeliverResult>> = { pdf_text: pdfByText };

export async function deliverDocument(doc: Doc, to: DeliverTo, target: DocTarget = "pdf_text", deps?: DeliverDeps): Promise<DeliverResult> {
  return DELIVERERS[target](doc, to, deps ?? (await realDeps()));
}

// What a document may rest on: what they said in the last two weeks (their texts and their side of calls). Never Co's own lines.
export async function loadTheirWords(userId: string): Promise<string> {
  const { rows } = await pool
    .query(
      `SELECT memory_type, content FROM co_memories
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days' AND (memory_type = 'call_transcript' OR (memory_type = 'text_exchange' AND content LIKE 'User said:%'))
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
