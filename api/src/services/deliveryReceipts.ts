// Delivery receipts (Royce, 2026-10-08): every document Co delivers writes a record of what went (doc id, title, version, the
// content itself), to whom, by which channel, and when. Follow-up turns read them, so Co knows what's outstanding (a PDF still to
// follow a text fallback), answers questions from what it actually sent (readDocument quotes the section), sends a changed document
// as a new version with one line naming the change, and never sends the same artifact twice.
//
// Every read here is scoped to one member (user_id = $1).
import { createHash } from "crypto";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import type { Doc } from "./documentSheet.js";
import { deliveredThing } from "./speakable.js";

// email: a plan sheet sent to their own email (agent/loopTools.ts emailPlan), recorded so it shows with the rest.
export type Channel = "pdf_text" | "google_docs" | "text_fallback" | "email";
// delivered: it reached them in its final form. pdf_pending: it went as text because the PDF failed, and the PDF is to follow.
// pdf_failed: the PDF never made it after every retry (the text version stands).
export type ReceiptStatus = "delivered" | "pdf_pending" | "pdf_failed";

export type Receipt = {
  id: number;
  userId: string;
  docKey: string;
  version: number;
  title: string;
  kind: string | null;
  doc: Doc;
  contentHash: string;
  channel: Channel;
  status: ReceiptStatus;
  line: string | null;
  link: string | null;
  taskId: number | null;
  source: string;
  changeNote: string | null;
  error: string | null;
  attempts: number;
  nextRetryAt: Date | null;
  deliveredAt: Date;
};
export type NewReceipt = Omit<Receipt, "id" | "attempts"> & { attempts?: number };

export type ReceiptStore = {
  insert: (r: NewReceipt) => Promise<Receipt>;
  get: (userId: string, id: number) => Promise<Receipt | null>;
  forUser: (userId: string, limit?: number) => Promise<Receipt[]>;
  latest: (userId: string, docKey: string) => Promise<Receipt | null>;
  // A PDF that followed its text fallback, or one more failed try.
  pdfSent: (id: number, at: Date) => Promise<void>;
  pdfRetry: (id: number, error: string, next: Date | null) => Promise<void>;
  duePdfRetries: (now: Date, limit?: number) => Promise<Receipt[]>;
};

// ---------- pure

// The artifact's identity across versions: its name, as you'd say it ("Co Presence Plan: After ..." -> "co-presence-plan").
export function docKeyFor(title: string): string {
  const head = title.split(/\s*[:|–—]\s*|\s+-\s+/)[0] || title;
  return head.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

export function contentHash(doc: Doc): string {
  return createHash("sha1").update(JSON.stringify({ t: doc.title, n: doc.note, s: doc.sections, g: doc.suggestions })).digest("hex");
}

// The next version of an artifact, or the receipt it duplicates (the same content already went).
export function nextVersion(latest: Receipt | null, hash: string): { version: number; duplicate: Receipt | null } {
  if (latest && latest.contentHash === hash) return { version: latest.version, duplicate: latest };
  return { version: (latest?.version ?? 0) + 1, duplicate: null };
}

// The document as in-thread text, for when the PDF can't be made or sent. Plain words, no markdown.
export function documentText(doc: Doc): string {
  const out: string[] = [doc.title];
  if (doc.note) out.push(doc.note);
  for (const s of doc.sections) {
    const part: string[] = [];
    if (s.heading) part.push(s.heading);
    part.push(...s.paragraphs);
    part.push(...s.bullets.map((b) => `• ${b}`));
    out.push(part.join("\n"));
  }
  if (doc.suggestions.length) out.push(["Co's suggestions", ...doc.suggestions.map((b) => `• ${b}`)].join("\n"));
  return out.join("\n\n");
}

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").match(/[a-z0-9][a-z0-9']*/g) ?? [];
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "what", "about", "is", "it", "that", "this", "my", "your", "you", "i", "me", "can", "do", "does", "how", "why", "part", "section", "bit", "doc", "document", "plan"]);

// The section a question is about: the one whose heading and lines share the most words with it. Each section's text verbatim.
export function sectionsOf(doc: Doc): { heading: string; text: string }[] {
  const out = doc.sections.map((s, i) => ({ heading: s.heading ?? `Section ${i + 1}`, text: [...s.paragraphs, ...s.bullets].join("\n") }));
  if (doc.suggestions.length) out.push({ heading: "Co's suggestions", text: doc.suggestions.join("\n") });
  return out;
}
export function findSection(doc: Doc, query: string): { heading: string; text: string } | null {
  const q = new Set(words(query).filter((w) => !STOP.has(w) && w.length > 2));
  if (!q.size) return null;
  let best: { heading: string; text: string } | null = null;
  let bestScore = 0;
  for (const s of sectionsOf(doc)) {
    const head = words(s.heading).filter((w) => q.has(w)).length * 3;
    const body = new Set(words(s.text).filter((w) => q.has(w))).size;
    if (head + body > bestScore) { bestScore = head + body; best = s; }
  }
  return best;
}

// An answer that quotes the document: a run of at least `min` words from it, word for word (the quote check for grounded follow-ups).
export function quotesDocument(answer: string, doc: Doc, min = 5): boolean {
  const a = ` ${words(answer).join(" ")} `;
  for (const s of sectionsOf(doc)) {
    for (const line of s.text.split("\n")) {
      const w = words(line);
      for (let i = 0; i + min <= w.length; i++) if (a.includes(` ${w.slice(i, i + min).join(" ")} `)) return true;
      if (w.length >= 3 && w.length < min && a.includes(` ${w.join(" ")} `)) return true;
    }
  }
  return false;
}

// The one line for a new version: what changed ("Updated the budget section." or "Updated the Co Presence Plan: the budget now has catering.").
export function changeLine(title: string, changed: string, kind?: string | null): string {
  const c = changed.trim().replace(/[.\s]+$/, "");
  if (/^(?:updated|added|removed|changed|cut|moved|rewrote|rewritten|fixed|replaced|expanded|shortened|trimmed|reworked|swapped|dropped)\b/i.test(c)) return `${c[0].toUpperCase()}${c.slice(1)}.`;
  return `Updated the ${deliveredThing(title, kind)}: ${c}.`;
}

// The one rule for sending a document again (Royce, 2026-10-08), everywhere it's said: asked for it again (lost it, can't find it,
// send it again, redo it with no change), the same version goes again; asked for a change, the next version; never on Co's own.
export const RESEND_RULE = "Already theirs: send it again only when they ask for it again (the same version goes), as a new version only when they ask for a change (readDocument first), and never on your own.";

// What the next turn reads: each artifact once (its newest version), what's outstanding first.
export function receiptLines(receipts: Receipt[], zone?: string | null, now: Date = new Date()): string[] {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const newest = new Map<string, Receipt>();
  for (const r of [...receipts].sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime())) if (!newest.has(r.docKey)) newest.set(r.docKey, r);
  const when = (d: Date) => {
    const t = DateTime.fromJSDate(d).setZone(z);
    const days = Math.round(DateTime.fromJSDate(now).setZone(z).startOf("day").diff(t.startOf("day"), "days").days);
    return `${days === 0 ? "today" : days === 1 ? "yesterday" : t.toFormat("ccc LLL d")} at ${t.toFormat("h:mma").toLowerCase()}`;
  };
  const how: Record<Channel, string> = { pdf_text: "as a PDF in this conversation", google_docs: "as a Google Doc", text_fallback: "as text in this conversation", email: "to their email" };
  const lines: string[] = [];
  for (const r of newest.values()) {
    const head = `"${r.title}" (doc #${r.id}, version ${r.version})`;
    if (r.status === "pdf_pending") lines.push(`Outstanding: the PDF of ${head}. It went ${how.text_fallback} ${when(r.deliveredAt)} because the PDF failed; the PDF follows on its own, so don't send the document again.`);
    else lines.push(`Delivered ${head} ${how[r.channel]} ${when(r.deliveredAt)}${r.changeNote ? `; this version: ${r.changeNote}` : ""}${r.status === "pdf_failed" ? " (the PDF never went; the text version stands)" : ""}. ${RESEND_RULE}`);
  }
  return lines;
}

// ---------- the store

const fromRow = (x: any): Receipt => ({
  id: Number(x.id),
  userId: String(x.user_id),
  docKey: String(x.doc_key),
  version: Number(x.version),
  title: String(x.title),
  kind: x.kind ?? null,
  doc: x.content,
  contentHash: String(x.content_hash),
  channel: x.channel,
  status: x.status,
  line: x.line ?? null,
  link: x.link ?? null,
  taskId: x.task_id === null || x.task_id === undefined ? null : Number(x.task_id),
  source: String(x.source),
  changeNote: x.change_note ?? null,
  error: x.error ?? null,
  attempts: Number(x.attempts ?? 0),
  nextRetryAt: x.next_retry_at ? new Date(x.next_retry_at) : null,
  deliveredAt: new Date(x.delivered_at),
});

export const pgReceipts: ReceiptStore = {
  insert: async (r) => {
    const { rows } = await pool.query(
      `INSERT INTO document_deliveries (user_id, doc_key, version, title, kind, content, content_hash, channel, status, line, link, task_id, source, change_note, error, attempts, next_retry_at, delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [r.userId, r.docKey, r.version, r.title, r.kind, JSON.stringify(r.doc), r.contentHash, r.channel, r.status, r.line, r.link, r.taskId, r.source, r.changeNote, r.error, r.attempts ?? 0, r.nextRetryAt, r.deliveredAt],
    );
    return fromRow(rows[0]);
  },
  get: async (userId, id) => {
    const { rows } = await pool.query(`SELECT * FROM document_deliveries WHERE user_id = $1 AND id = $2`, [userId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  },
  forUser: async (userId, limit = 20) => {
    const { rows } = await pool.query(`SELECT * FROM document_deliveries WHERE user_id = $1 ORDER BY delivered_at DESC LIMIT $2`, [userId, limit]);
    return rows.map(fromRow);
  },
  latest: async (userId, docKey) => {
    const { rows } = await pool.query(`SELECT * FROM document_deliveries WHERE user_id = $1 AND doc_key = $2 ORDER BY version DESC, delivered_at DESC LIMIT 1`, [userId, docKey]);
    return rows[0] ? fromRow(rows[0]) : null;
  },
  pdfSent: async (id, at) => {
    await pool.query(`UPDATE document_deliveries SET status = 'delivered', channel = 'pdf_text', pdf_sent_at = $2, next_retry_at = NULL WHERE id = $1`, [id, at]);
  },
  pdfRetry: async (id, error, next) => {
    await pool.query(`UPDATE document_deliveries SET attempts = attempts + 1, error = $2, next_retry_at = $3, status = CASE WHEN $3::timestamptz IS NULL THEN 'pdf_failed' ELSE status END WHERE id = $1`, [id, error.slice(0, 500), next]);
  },
  duePdfRetries: async (now, limit = 20) => {
    const { rows } = await pool.query(`SELECT * FROM document_deliveries WHERE status = 'pdf_pending' AND next_retry_at <= $1 ORDER BY next_retry_at LIMIT $2`, [now, limit]);
    return rows.map(fromRow);
  },
};

// The same store in memory (tests).
export function memoryReceipts(): ReceiptStore & { all: Receipt[] } {
  const all: Receipt[] = [];
  let next = 1;
  return {
    all,
    insert: async (r) => { const x = { ...r, id: next++, attempts: r.attempts ?? 0 } as Receipt; all.push(x); return x; },
    get: async (userId, id) => all.find((r) => r.userId === userId && r.id === id) ?? null,
    forUser: async (userId, limit = 20) => all.filter((r) => r.userId === userId).sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime()).slice(0, limit),
    latest: async (userId, docKey) => all.filter((r) => r.userId === userId && r.docKey === docKey).sort((a, b) => b.version - a.version || b.deliveredAt.getTime() - a.deliveredAt.getTime())[0] ?? null,
    pdfSent: async (id) => { const r = all.find((x) => x.id === id); if (r) { r.status = "delivered"; r.channel = "pdf_text"; r.nextRetryAt = null; } },
    pdfRetry: async (id, error, nextAt) => { const r = all.find((x) => x.id === id); if (r) { r.attempts++; r.error = error; r.nextRetryAt = nextAt; if (!nextAt) r.status = "pdf_failed"; } },
    duePdfRetries: async (now) => all.filter((r) => r.status === "pdf_pending" && r.nextRetryAt && r.nextRetryAt <= now),
  };
}
