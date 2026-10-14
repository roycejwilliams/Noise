// What a member's attachment actually is, and what Co can truthfully say about it (Jacqueline, 2026-10-10).
//
// She asked Co to pressure test her pitch deck and sent it as a PowerPoint file, twice. routes/sendblue.ts tried every non-audio
// attachment as a photo: the first send came with her text, so the failure left no trace at all (the record said only "can you
// help pressure test my pitch deck?"); the second, alone, was logged as "[sent a photo, couldn't load it]". Co then told her "Photo
// didn't come through on my end" and offered nothing else. The co-test log has both: "unreadable image format
// (application/vnd.openxmlformats-officedocument.presentationml.presentation)" at 16:20:50 and 16:22:00 Pacific.
//
// So the file's kind is read from its own bytes first (links and content types lie), and:
//   - a PowerPoint (.pptx) or Word (.docx) file is read in code, with no model call: its slides' or paragraphs' own text, kept for
//     that member exactly like a PDF (services/memberFiles.ts, the same four rules: their own, scoped to them, deletable, grounded);
//   - anything Co still can't open (Keynote, Pages, an older .ppt/.doc, a video, something unknown) is named as what it is, never
//     "a photo", and the reply is told to say so plainly and offer routes that work (the key slides pasted as text, a PDF, a link);
//   - the record always says a file came, even when it came with text, so the next turn knows what arrived and what didn't.
// Pure, except the awaited-file loop at the end (injectable query).
import { inflateRawSync } from "node:zlib";
import { imageTypeOf, isHeic } from "./imageRead.js";

export type FileKind = "pdf" | "image" | "heic" | "pptx" | "docx" | "xlsx" | "keynote" | "pages" | "numbers" | "old_office" | "zip" | "video" | "unknown";

// How Co names it, in a member's words.
export const FILE_LABEL: Record<FileKind, string> = {
  pdf: "a PDF",
  image: "a photo",
  heic: "a photo",
  pptx: "a PowerPoint deck",
  docx: "a Word document",
  xlsx: "an Excel spreadsheet",
  keynote: "a Keynote deck",
  pages: "a Pages document",
  numbers: "a Numbers spreadsheet",
  old_office: "an older Office file",
  zip: "a zip file",
  video: "a video",
  unknown: "a file",
};

// Kept like a PDF: text Co can read without a model guessing at it.
export const KEEPABLE: ReadonlySet<FileKind> = new Set(["pdf", "pptx", "docx"]);
export const isKeepable = (k: FileKind) => KEEPABLE.has(k);

// ---------------------------------------------------------------- a zip, read in code
// .pptx, .docx and Apple's iWork files are all zip archives. A small reader (no dependency): the central directory at the end,
// then each wanted entry, stored or deflated. Bounded so a crafted file can't blow up memory: at most ZIP_LIMITS.entries entries,
// and each inflated entry capped at ZIP_LIMITS.entryBytes.
export const ZIP_LIMITS = { entries: 4000, entryBytes: 8_000_000, totalBytes: 40_000_000 };
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const isZip = (b: Buffer) => b.length > 30 && b.subarray(0, 4).equals(ZIP_SIG);

// The entry names in a zip, or null when it isn't one it can read.
export function zipNames(b: Buffer): string[] | null {
  const cd = centralDirectory(b);
  return cd ? cd.map((e) => e.name) : null;
}

type CdEntry = { name: string; method: number; compSize: number; size: number; localOffset: number };
function centralDirectory(b: Buffer): CdEntry[] | null {
  if (!isZip(b)) return null;
  // End of central directory: signature 0x06054b50, within the last 64KB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  if (count > ZIP_LIMITS.entries) return null;
  const out: CdEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return out.length ? out : null;
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// The wanted entries' bytes. A broken or oversized entry is left out, never thrown.
export function readZip(b: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const cd = centralDirectory(b);
  if (!cd) return out;
  let total = 0;
  for (const e of cd) {
    if (!wanted(e.name) || e.size > ZIP_LIMITS.entryBytes) continue;
    try {
      const lh = e.localOffset;
      if (lh + 30 > b.length || b.readUInt32LE(lh) !== 0x04034b50) continue;
      const start = lh + 30 + b.readUInt16LE(lh + 26) + b.readUInt16LE(lh + 28);
      const raw = b.subarray(start, start + e.compSize);
      const data = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? inflateRawSync(raw, { maxOutputLength: ZIP_LIMITS.entryBytes }) : null;
      if (!data) continue;
      total += data.length;
      if (total > ZIP_LIMITS.totalBytes) break;
      out.set(e.name, data);
    } catch {
      // One unreadable entry doesn't sink the rest.
    }
  }
  return out;
}

// ---------------------------------------------------------------- what kind of file it is
// By its own bytes first; the content type only names what the bytes can't tell apart (a zip of unknown shape).
export function fileKindOf(b: Buffer, contentType: string | null = null): FileKind {
  const ct = (contentType ?? "").toLowerCase();
  if (b.length > 8 && b.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (imageTypeOf(b)) return "image";
  if (isHeic(b)) return "heic";
  // Old binary Office (.ppt, .doc, .xls): the OLE compound file header.
  if (b.length > 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1) return "old_office";
  if (isZip(b)) {
    const names = zipNames(b) ?? [];
    if (names.includes("ppt/presentation.xml") || names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return "pptx";
    if (names.includes("word/document.xml")) return "docx";
    if (names.includes("xl/workbook.xml")) return "xlsx";
    // Apple iWork: Index/*.iwa inside (or an Index.zip in older files). Slides mean Keynote, tables Numbers, else Pages.
    const iwork = names.some((n) => /^Index\/.+\.iwa$/.test(n) || n === "Index.zip");
    if (iwork || /keynote|iwork/.test(ct)) {
      if (names.some((n) => /^Index\/(?:Slide|MasterSlide|TemplateSlide)/.test(n)) || /keynote/.test(ct)) return "keynote";
      if (names.some((n) => /^Index\/Tables\//.test(n)) || /numbers/.test(ct)) return "numbers";
      return "pages";
    }
    if (/presentationml/.test(ct)) return "pptx";
    if (/wordprocessingml/.test(ct)) return "docx";
    return "zip";
  }
  // MP4 / QuickTime: "ftyp" at 4 (HEIC, also ftyp, was caught above).
  if (b.length > 12 && b.toString("latin1", 4, 8) === "ftyp") return "video";
  if (/presentation|powerpoint/.test(ct)) return "old_office";
  if (/msword|ms-excel/.test(ct)) return "old_office";
  if (/keynote/.test(ct)) return "keynote";
  if (/^video\//.test(ct)) return "video";
  return "unknown";
}

// ---------------------------------------------------------------- the text of a .pptx or .docx, in code
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// A numeric entity outside Unicode (&#x110000;) or a surrogate becomes nothing, never a thrown error that sinks the whole deck
// (review of #140).
const codePoint = (n: number) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|amp|lt|gt|quot|apos);/gi, (_, e: string) => (e[0] === "#" ? codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()] ?? ""));

// The most XML read from one slide or document, before anything is scanned (review of #140: an 8MB slide is a few KB zipped).
export const XML_SCAN_MAX = 2_000_000;

// One line per paragraph: the runs of <t> text, a line ending at each </p>. A single linear pass with indexOf (review of #140: the
// old lazy regex `<a:p[ >][\s\S]*?</a:p>` was quadratic on unclosed openers and could hold the event loop for minutes). Each
// search starts where the last ended and is reused until passed, so the whole scan is linear in the (capped) input; it stops once
// OFFICE_MAX_CHARS of text are out.
function paragraphs(xmlIn: string, ns: "a" | "w"): string[] {
  const xml = xmlIn.length > XML_SCAN_MAX ? xmlIn.slice(0, XML_SCAN_MAX) : xmlIn;
  const T_OPEN = `<${ns}:t`, T_CLOSE = `</${ns}:t>`, P_CLOSE = `</${ns}:p>`;
  const out: string[] = [];
  let line = "", chars = 0, pos = 0;
  let nextP = xml.indexOf(P_CLOSE, 0);
  const findT = (from: number) => {
    let t = xml.indexOf(T_OPEN, from);
    while (t !== -1 && !/[\s>]/.test(xml[t + T_OPEN.length] ?? "")) t = xml.indexOf(T_OPEN, t + T_OPEN.length);
    return t;
  };
  let nextT = findT(0);
  const flush = () => {
    const l = line.replace(/\s+/g, " ").trim();
    if (l) { out.push(l); chars += l.length; }
    line = "";
  };
  while (pos < xml.length && chars < OFFICE_MAX_CHARS) {
    // The next <t> or <t ...> (never <tab/>, <tbl>, <tr>: the character after the name decides), kept until passed.
    if (nextT !== -1 && nextT < pos) nextT = findT(pos);
    const t = nextT;
    if (nextP !== -1 && nextP < pos) nextP = xml.indexOf(P_CLOSE, pos);
    if (nextP !== -1 && (t === -1 || nextP < t)) {
      flush();
      pos = nextP + P_CLOSE.length;
      nextP = xml.indexOf(P_CLOSE, pos);
      continue;
    }
    if (t === -1) break;
    const gt = xml.indexOf(">", t);
    if (gt === -1) break;
    if (xml[gt - 1] === "/") { pos = gt + 1; continue; }
    const close = xml.indexOf(T_CLOSE, gt);
    if (close === -1) break;
    line += unxml(xml.slice(gt + 1, close));
    pos = close + T_CLOSE.length;
  }
  flush();
  return out;
}

export const OFFICE_MAX_CHARS = 30_000;

// The deck's slides in order ("Slide 3:" then its lines), or the document's paragraphs. Null when there's no text in it at all
// (a deck of images only): Co says it couldn't read anything, never that it read it.
export function officeText(b: Buffer, kind: FileKind): string | null {
  if (kind === "pptx") {
    const slides = readZip(b, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const ordered = [...slides.entries()].sort((x, y) => Number(x[0].match(/(\d+)\.xml$/)![1]) - Number(y[0].match(/(\d+)\.xml$/)![1]));
    const parts = ordered.map(([name, xml], i) => {
      const lines = paragraphs(xml.toString("utf8"), "a");
      return lines.length ? `Slide ${i + 1}:\n${lines.join("\n")}` : null;
    }).filter(Boolean) as string[];
    const text = parts.join("\n\n").trim();
    return text ? text.slice(0, OFFICE_MAX_CHARS) : null;
  }
  if (kind === "docx") {
    const doc = readZip(b, (n) => n === "word/document.xml").get("word/document.xml");
    const text = doc ? paragraphs(doc.toString("utf8"), "w").join("\n").trim() : "";
    return text ? text.slice(0, OFFICE_MAX_CHARS) : null;
  }
  return null;
}

// ---------------------------------------------------------------- what the record and the reply are told

// The note in the conversation record. With their text, it rides after it ("User said: <text> [also sent ...]"), the way a photo
// already does, so a file that came with a message is never silent again.
export function fileRecordNote(o: { kind: FileKind; kept?: { n: number } | null; unreadable?: boolean }, withText: boolean): string {
  const label = FILE_LABEL[o.kind];
  const what = o.kept ? `${label}, kept as their file #${o.kept.n}` : `${label} Cue couldn't open`;
  return withText ? `[also sent ${what}]` : `[sent ${what}]`;
}

// The routes that work when a file can't be read (Jacqueline, 2026-10-10: nothing was offered). Plain and ordered by what lets Co
// help soonest: text pasted in is read right in the thread; a PDF is kept for them and Co can write them a document from it; a
// link is read when it's public.
export const FILE_ROUTES = "paste the key slides or points right here as text (you can go over them in this thread), export it as a PDF and send that, or share a link to it";

// The fact the reply gets when this turn's file couldn't be opened. Co says what happened, offers the routes, and never pretends.
export function unreadableFileFact(kind: FileKind, why: string | null = null): string {
  const label = FILE_LABEL[kind];
  return `They sent ${label} this turn. It reached Cue, but Cue ${why ? `couldn't use this one (${why})` : `can't open ${kind === "unknown" ? "it" : "that kind of file"}`}, so nothing in it was read. Say so plainly in a few words (it came through, but you can't open that format); never call it a photo unless it is one, never say or hint at what's in it, and never blame their connection. Then offer the ways that work: ${FILE_ROUTES}.`;
}

// A file Co kept (a PDF, now also a deck or a Word file): what Co may say about it. Never its contents (services/memberFiles.ts).
export function keptFileFact(kind: FileKind, kept: { n: number; isNew: boolean }): string {
  return `They sent ${FILE_LABEL[kind]} this turn. It's kept for them alone as their file #${kept.n}${kept.isNew ? "" : " (they had sent it before)"}. You haven't read it and don't know what it says, so don't describe or guess its contents. You can write them a document from it when they ask (writeFromFile), and delete it whenever they ask (deleteMyFiles). If they want to talk it through right here, they can paste the parts they care about as text.`;
}

// ---------------------------------------------------------------- "it didn't come through": a true statement, from the record
// Row 10405 (2026-10-10): "Nothing's come through on my end yet" was cut twice, once as narration of Co's machinery and once as an
// unbacked past action, and the next turn's text said "didn't come through on my end" anyway. Whether a file arrived readable is
// a fact about the inbound record, not Co's machinery. So the record is put in the reply's facts, and both checks read it: the
// sentence is allowed when the record shows nothing readable came, and still refused when something did.
export const FILE_RECORD_PREFIX = "Their file record for the last 30 minutes:";
export const RECORD_MINUTES = 30;

// Saying a file didn't arrive or can't be opened: "Nothing's come through on my end yet", "That one didn't come through either",
// "Photo didn't come through, can't see it", "I can't open that file".
export const ARRIVAL_DENIAL = /\b(?:didn'?t|did not|hasn'?t|has not|haven'?t|have not|nothing'?s?|nothing has|never|not)\b[^.?!]{0,30}?\b(?:come|came|coming|gotten|got|get|gone) through\b|\b(?:can'?t|cannot|couldn'?t|could not|wasn'?t able to|unable to)\s+(?:open|load|read|see|view)(?:\s+(?:it|that|this|them|the|your|any)\b|\s*[.,!?]|\s*$)|\b(?:didn'?t|hasn'?t|has not|did not)\s+(?:arrive|land|load|show up)\b|\bnothing (?:has )?(?:arrived|landed|shown up)\b|\bno (?:file|deck|photo|attachment|pdf|slides?) (?:has )?(?:come|came|arrived|landed)\b/i;
export const arrivalDenial = (s: string) => ARRIVAL_DENIAL.test(s.replace(/[’‘]/g, "'"));

// Their words saying they sent something or asking whether it arrived.
const SENT_TALK = /\b(?:i (?:just )?(?:sent|attached|shared|texted|uploaded)|did you (?:get|receive|see)|(?:get|got|receive|received) (?:it|my|the)|sending (?:it|now)|resent|re-?sending|come through|came through)\b/i;
const FILE_NOUN = /\b(?:deck|slides?|file|pdf|doc|document|photo|pic|picture|screenshot|attachment)\b/i;
// Asking whether it arrived ("Did you receive it?"), which needs no file noun.
const RECEIPT_Q = /\b(?:did you (?:get|receive|see) (?:it|that|this|them|my)|(?:did it|has it|it didn'?t) (?:come|go) through|you get it\?)/i;

// The markers fileRecordNote and the photo path write into "User said:" lines.
const READABLE_MARK = /\[(?:also )?sent (?:a photo showing|a photo\]|a PDF, kept|a PowerPoint deck, kept|a Word document, kept)|kept as their file #|\[They also sent a photo/;
const UNREADABLE_MARK = /\[(?:also )?sent [^\]]*?(?:(?:Co|Cue) couldn't open|couldn't load it|(?:Co|Cue) couldn't keep)\]/;

// Pure: the record fact for this turn, or none. `recent` is their "User said:" lines from the last RECORD_MINUTES, this turn's included.
// recent: their lines from the last RECORD_MINUTES (this turn's included), each with when it came. lastReadableAt: the newest file Co
// kept or photo it saw for them over READABLE_LOOKBACK_DAYS (review of #140: a deck kept at 2:00 and "did you get my deck?" at
// 2:45 made the record say nothing had arrived, and "Nothing's come through" passed both checks). So:
//   - an unreadable file with nothing readable after it: "it didn't come through in a form you can open";
//   - anything readable lately (and after the last unreadable one): no fact, so a denial needs real support;
//   - nothing at all lately, and they say they sent something: "nothing has come through yet".
export const READABLE_LOOKBACK_DAYS = 7;
export function fileRecordFact(recent: { at: Date; content: string }[], message: string, lastReadableAt: Date | null = null): string | null {
  const readableTimes = [...recent.filter((l) => READABLE_MARK.test(l.content)).map((l) => l.at.getTime()), lastReadableAt?.getTime() ?? -Infinity];
  const lastReadable = Math.max(...readableTimes);
  const unreadable = recent.filter((l) => UNREADABLE_MARK.test(l.content)).sort((a, b) => b.at.getTime() - a.at.getTime());
  if (unreadable.length && unreadable[0].at.getTime() > lastReadable) {
    const what = unreadable.map((l) => l.content.match(/sent ([^\]]*?)(?: (?:Co|Cue) couldn't open| — couldn't load it|, couldn't load it| (?:Co|Cue) couldn't keep)\]/)?.[1]).filter(Boolean)[0] ?? "a file";
    return `${FILE_RECORD_PREFIX} what they sent (${what}) arrived but couldn't be opened, and no readable file or photo has come through since. It is true to say it didn't come through in a form you can open.`;
  }
  if (Number.isFinite(lastReadable)) return null;
  if ((SENT_TALK.test(message) && FILE_NOUN.test(message)) || RECEIPT_Q.test(message)) {
    return `${FILE_RECORD_PREFIX} no file or photo from them has arrived. It is true to say nothing has come through yet.`;
  }
  return null;
}

// Pure: whether the reply's facts carry a record saying nothing readable arrived (what lets an arrival denial through).
export function recordSaysNothingReadable(facts: { text: string }[]): boolean {
  return facts.some((f) => f.text.startsWith(FILE_RECORD_PREFIX));
}

// ---------------------------------------------------------------- the ask that waits on the file
// Loop 52372 (2026-10-10): "pressure testing their pitch deck" sat open with nothing behind it, because the deck never arrived in a
// form Co could read. Now an unreadable file opens one loop Co carries for them ("their deck, once a readable copy comes"), which
// every reply sees (services/openLoops.ts describeLoops); a readable file arriving closes it and tells the reply to pick the ask
// back up; and if nothing comes, Co asks about it once, a day later (a loop_check candidate, the same one-time ask decay uses).
export const AWAITED_REF = "awaited_file";
// Only a document is something to help with later: a photo or a video that didn't open isn't carried as work.
export const AWAITED_KINDS: ReadonlySet<FileKind> = new Set(["pdf", "pptx", "docx", "xlsx", "keynote", "pages", "numbers", "old_office", "zip", "unknown"]);
export const AWAITED_ASK_AFTER_HOURS = 24;
export function awaitedFileTitle(kind: FileKind): string {
  return `Going over the ${FILE_LABEL[kind].replace(/^an? /, "")} they sent, once a copy Cue can open arrives`;
}
export const AWAITED_DETAIL = `waiting on them: Cue couldn't open what they sent; a PDF, a link, or the key points pasted as text would work`;

// Pure: what this turn does to the awaited-file loop. An unreadable document opens it; only a kept document closes it (review of
// #140: a selfie after the failed deck closed it); a photo, a video or nothing at all leaves it as it is.
export function awaitedAction(t: { kept: FileKind | null; unreadable: FileKind | null }): "open" | "close" | null {
  if (t.unreadable && AWAITED_KINDS.has(t.unreadable)) return "open";
  if (t.kept) return "close";
  return null;
}

type Q = { query: (sql: string, args: unknown[]) => Promise<{ rows: any[] }> };

// Opens (or refreshes) the awaited-file loop. Returns its id, or null when the write failed.
export async function openAwaitedFile(db: Q, userId: string, kind: FileKind): Promise<number | null> {
  const { rows } = await db.query(
    `INSERT INTO open_loops (user_id, source, source_ref, title, status, status_by, detail, seen_at, last_confirmed_at)
     VALUES ($1, 'co', $2, $3, 'open', 'code', $4, NOW(), NOW())
     ON CONFLICT (user_id, source, source_ref) DO UPDATE SET title = EXCLUDED.title, status = 'open', status_by = 'code', detail = EXCLUDED.detail,
       changed_at = NOW(), seen_at = NOW(), updated_at = NOW(), last_confirmed_at = NOW(), closed_at = NULL, closed_reason = NULL, decay_asked_at = NULL
     RETURNING id`,
    [userId, AWAITED_REF, awaitedFileTitle(kind), AWAITED_DETAIL],
  );
  return rows[0]?.id != null ? Number(rows[0].id) : null;
}

// Closes it when a readable file comes. Returns what it was waiting for, so the reply can pick that ask back up.
export async function closeAwaitedFile(db: Q, userId: string): Promise<string | null> {
  const { rows } = await db.query(
    `UPDATE open_loops SET status = 'done', status_by = 'code', detail = 'a readable copy arrived', closed_at = NOW(), closed_reason = 'co', changed_at = NOW(), seen_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND source = 'co' AND source_ref = $2 AND closed_at IS NULL RETURNING title`,
    [userId, AWAITED_REF],
  );
  return rows[0]?.title ? String(rows[0].title) : null;
}

export function pickUpFact(title: string): string {
  return `Earlier they sent a file Cue couldn't open, and you were waiting on a copy you could read (${title}). What they sent this turn is likely it: pick that request back up.`;
}
