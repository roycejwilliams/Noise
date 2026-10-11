// "Save it as a Google Doc" (Royce, 2026-10-08; phase 2 of services/documentDelivery.ts). The same document Co writes for the PDF,
// put in the member's own Drive as an editable Google Doc they can share (with a cofounder, a partner) and change.
//
// Scope: drive.file only, Google's narrowest Drive scope (non-sensitive): Co can create files and see only the files it created or the
// member picks. Never their other files. The file is theirs, in their Drive; Co keeps no copy, only the link it texted and the file's ID (on the delivery receipt, for a later edit of that same Doc).
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

export type DocsUpload = { ok: true; id: string; link: string } | { ok: false; why: string; cause?: GoogleRefusal };

// Why Google said no (Royce, 2026-10-11, Google audit). A 403 has two very different causes: the member's grant (signed out, or Docs
// not allowed when they connected), which only they can fix by reconnecting; or our own Cloud project (the Drive API not enabled
// for it), which is ours to fix and must never send them to reconnect. Google says which in the error body.
export type GoogleRefusal = "reconnect" | "our_config" | "other";
export function googleRefusal(status: number, body: any): GoogleRefusal {
  const err = body?.error ?? {};
  const reasons: string[] = [
    ...(Array.isArray(err.errors) ? err.errors.map((e: any) => String(e?.reason ?? "")) : []),
    ...(Array.isArray(err.details) ? err.details.map((d: any) => String(d?.reason ?? "")) : []),
    String(err.status ?? ""),
  ];
  const message = String(err.message ?? "");
  if (reasons.some((r) => /^(accessNotConfigured|SERVICE_DISABLED|API_DISABLED)$/.test(r)) || /has not been used in project|is disabled|it is disabled/i.test(message)) return "our_config";
  if (status === 401 || (status === 403 && (reasons.some((r) => /^(insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED|forbidden|authError)$/.test(r)) || /scope|permission/i.test(message) || !message))) return "reconnect";
  return "other";
}

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
    if (!res.ok || !j.id) {
      const cause = res.ok ? "other" : googleRefusal(res.status, j);
      if (cause === "our_config") {
        console.error(`googleDocs: OUR CONFIG, not the member's: the Drive API refused the upload (${res.status}): ${String(j?.error?.message ?? "").slice(0, 300)}`);
        return { ok: false, cause, why: "a Google setting on Co's side isn't switched on yet; that's ours to fix, not theirs. Tell them it's on our end and we'll fix it, nothing they need to do (never ask them to reconnect)" };
      }
      if (cause === "reconnect") return { ok: false, cause, why: "Google didn't allow it (they need to reconnect Google and allow Docs)" };
      return { ok: false, cause, why: "Google didn't take the document" };
    }
    return { ok: true, id: String(j.id), link: String(j.webViewLink ?? `https://docs.google.com/document/d/${j.id}/edit`) };
  } catch {
    return { ok: false, why: "Google didn't answer in time" };
  }
}

// Shared working artifacts (a venue brief, a partnership plan, a readout) are made to be passed to a venue or a partner and edited
// together, so the Doc is opened to anyone with the link, as an editor, never listed or searchable (allowFileDiscovery false). That is a
// real tradeoff: whoever holds the link can read and change it. It is used only for those kinds, only for the test pair, and only
// when their own words ask to share it (SHARE_ASK, services/documentDelivery.ts); the link goes only to the member, in their own thread. drive.file allows this on files Co created.
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
