// "Save it as a Google Doc" (Royce, 2026-10-08; phase 2 of services/documentDelivery.ts). The same document Co writes for the PDF,
// put in the member's own Drive as an editable Google Doc they can share (with a cofounder, a partner) and change.
//
// Scope: drive.file only, Google's narrowest Drive scope (non-sensitive): Co can create files and see only the files it created or the
// member picks. Never their other files. The file is theirs, in their Drive; Co keeps no copy, only the link it texted.
// How: one multipart upload of plain HTML with the Google Doc type, which Drive converts (headings, paragraphs, bullets).
import { escapeHtml } from "./emailDesign.js";
import type { Doc } from "./documentSheet.js";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";

// Pure: the document as Drive will convert it. Plain structure only (a Google Doc takes its own styles): the title, the line under it,
// the date and who it is for, the sections, and Co's suggestions under their own heading, apart from the member's points.
export function docsHtml(doc: Doc, o: { firstName: string; date: string }): string {
  const e = escapeHtml;
  const sections = doc.sections
    .map((s) => `${s.heading ? `<h2>${e(s.heading)}</h2>` : ""}${s.paragraphs.map((p) => `<p>${e(p)}</p>`).join("")}${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : ""}`)
    .join("");
  const sug = doc.suggestions.length ? `<h2>Co's suggestions</h2><ul>${doc.suggestions.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${e(doc.title)}</title></head><body><h1>${e(doc.title)}</h1><p>${e(`Prepared for ${o.firstName.trim() || "you"}, ${o.date}`)}</p>${doc.note ? `<p>${e(doc.note)}</p>` : ""}${sections}${sug}</body></html>`;
}

// Pure: the multipart body Drive expects (metadata, then the file).
export function multipartBody(name: string, html: string, boundary: string): string {
  const meta = JSON.stringify({ name, mimeType: "application/vnd.google-apps.document" });
  return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
}

export type DocsUpload = { ok: true; id: string; link: string } | { ok: false; why: string };

export async function uploadGoogleDoc(accessToken: string, name: string, html: string, fetchImpl: typeof fetch = fetch): Promise<DocsUpload> {
  const boundary = `co-${Math.random().toString(36).slice(2)}`;
  try {
    const res = await fetchImpl(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody(name, html, boundary),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.id) return { ok: false, why: res.status === 403 || res.status === 401 ? "Google didn't allow it (they may need to reconnect Google and allow Docs)" : "Google didn't take the document" };
    return { ok: true, id: String(j.id), link: String(j.webViewLink ?? `https://docs.google.com/document/d/${j.id}/edit`) };
  } catch {
    return { ok: false, why: "Google didn't answer in time" };
  }
}

// Shared working artifacts (a venue brief, a partnership plan, a readout) are made to be passed to a venue or a partner and edited
// together, so the Doc is opened to anyone with the link, as an editor, never listed or searchable (allowFileDiscovery false). That is a
// real tradeoff: whoever holds the link can read and change it. It is used only for those kinds, only for the test pair
// (services/documentDelivery.ts), and the link goes only to the member, in their own thread. drive.file allows this on files Co created.
// A refusal (a Workspace that forbids link sharing) leaves the Doc private to them, and says so.
export type DocsShare = { ok: true } | { ok: false; why: string };
export async function shareWithLink(accessToken: string, fileId: string, fetchImpl: typeof fetch = fetch): Promise<DocsShare> {
  try {
    const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", type: "anyone", allowFileDiscovery: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, why: res.status === 403 ? "their Google account doesn't allow link sharing" : "Google didn't open the link" };
    return { ok: true };
  } catch {
    return { ok: false, why: "Google didn't answer in time" };
  }
}
