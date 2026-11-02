// Research briefs (Royce, 2026-10-07): the document tool's second kind, fed by the research pipeline. A member asks for something
// research-shaped ("find venues for my launch"); a background task runs the find and the result goes out as a document (PDF,
// or a Google Doc link when the shared-artifact gates hold: services/documentDelivery.ts).
//
// Grounding, the part that matters:
//   - Researched sections are exempt from the member-words rule (their source is verified research, not conversation), but
//     every line in them comes from one find, and the section carries that find's link and the time it was checked. No source,
//     no line. Code writes every researched line from the find's fixed fields: no model writes, infers or interpolates them.
//   - "unknown" is an allowed answer and is shown as "unknown".
//   - Sections are marked: what's researched (with sources) and what's from the member (held to their own words, as today).
// Search quality (services/researchQuality.ts) runs through it: the query is built from member state (a missing load-bearing
// fact is a question back, asked by the tool before this starts), every read is the find type's fixed fields, a re-sent brief
// re-reads anything past its freshness window, and the options are ordered by what this member (or everyone) said yes and no to.
// Sources: the scripted Peerspace reader, and since round 2 passed (evals/browserPilot/round2.ts: 39 right, 11 unknown, 0
// wrong on 12 sites with no script) the general reader (services/sdkGeneralReader.ts) for a venue's own pages.
import { DateTime } from "luxon";
import type { Doc, DocSection, ResearchSource } from "./documentSheet.js";
import { regionFor } from "./areaCodes.js";
import { schemaFields, type FieldValue, type FindField, type FindType, type StoredFind } from "./researchQuality.js";

export const SDK_FINDS_ALLOWED = true;
export const BRIEF_LIMITS = { maxOptions: 6, maxContext: 6, maxReads: 8 };

export type { FindField };
export type ResearchFind = { name: string; url: string; checkedAt: string; reader: "scripted" | "sdk"; fields: FindField[] };
// theirWords: their own words asking for it (the task's quote, checked at startTask). searched: what the search actually used.
export type BriefSearched = { date?: string | null; start?: string | null; headcount?: number | null; budget?: string | null; neighborhood?: string | null; city?: string | null };
export type BriefInput = { title: string; asked: string; finds: ResearchFind[]; memberContext: string[]; zone?: string | null; theirWords?: string | null; searched?: BriefSearched | null };

// Pure: the brief's two opening lines (Royce, 2026-10-27: the result says what shaped it): their own words, and the criteria the search
// used, only those it had. Null when there's neither.
export function briefAskedLines(b: Pick<BriefInput, "theirWords" | "searched" | "zone">): string[] {
  const out: string[] = [];
  // The stored words are their message joined with the turn's copy of it (loopTools theirWords), the same text twice on a text turn:
  // said once (review of #287).
  const joined = (b.theirWords ?? "").replace(/\s+/g, " ").trim();
  const words = joined.match(/^(.+?) \1$/)?.[1] ?? joined;
  if (words) out.push(`What you asked: "${words.length > 200 ? `${words.slice(0, 197).replace(/\s+\S*$/, "")}..." ` : `${words}"`}`.trim());
  const s = b.searched ?? {};
  const zone = b.zone && DateTime.now().setZone(b.zone).isValid ? b.zone : "America/Los_Angeles";
  const day = s.date ? DateTime.fromISO(s.date, { zone }) : null;
  // The start as the brief stores it ("6:00 pm"), or a 24-hour "18:00".
  const start = String(s.start ?? "").trim().toLowerCase();
  const at = /^\d{1,2}:\d{2}\s*[ap]m$/.test(start)
    ? DateTime.fromFormat(start.replace(/\s*([ap]m)$/, " $1").toUpperCase(), "h:mm a", { zone })
    : /^\d{1,2}:\d{2}$/.test(start)
      ? DateTime.fromFormat(start.padStart(5, "0"), "HH:mm", { zone })
      : null;
  const parts = [
    day?.isValid ? `${day.toFormat("cccc, LLL d")}${at?.isValid ? ` at ${at.toFormat("h:mm a")}` : ""}` : null,
    s.headcount ? `${s.headcount} ${s.headcount === 1 ? "person" : "people"}` : null,
    s.budget?.trim() || null,
    [s.neighborhood?.trim(), s.city?.trim()].filter(Boolean).join(", ") || null,
  ].filter((x): x is string => !!x);
  if (parts.length) out.push(`Searched for: ${parts.join(" · ")}`);
  return out;
}

export const UNKNOWN = "unknown";
const fmtChecked = (iso: string, zone?: string | null) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: zone || "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
};
// The oldest field's check time: the section says no more than its stalest line can back.
export const findCheckedAt = (fields: FindField[], fallback: string) => fields.map((x) => x.checkedAt).filter(Boolean).sort()[0] ?? fallback;

// Pure: one find, one researched section. Each field is a line "Label: value" (or "Label: unknown"); the last line is the source.
export function findSection(f: ResearchFind, zone?: string | null, n?: number): DocSection {
  const bullets = f.fields.map((x) => `${x.label}: ${x.value && x.value.trim() ? x.value.trim() : UNKNOWN}`);
  bullets.push(`Source: ${f.url} (checked ${fmtChecked(f.checkedAt, zone)})`);
  return { heading: n ? `${n}. ${f.name}` : f.name, paragraphs: [], bullets, research: { url: f.url, checkedAt: f.checkedAt, reader: f.reader } };
}

// Pure: the brief. Researched options first (numbered, so they can say "the second one"), then what the member told Co.
export function buildBrief(b: BriefInput): Doc {
  const finds = b.finds.slice(0, BRIEF_LIMITS.maxOptions);
  const asked = briefAskedLines(b);
  const sections: DocSection[] = [...(asked.length ? [{ heading: null, paragraphs: asked, bullets: [] } as unknown as DocSection] : []), ...finds.map((f, i) => findSection(f, b.zone, i + 1))];
  const context = b.memberContext.map((x) => x.trim()).filter(Boolean).slice(0, BRIEF_LIMITS.maxContext);
  if (context.length) sections.push({ heading: "From what you told me", paragraphs: [], bullets: context });
  const sources = finds.length ? `${finds.length} option${finds.length === 1 ? "" : "s"} researched, each with its source and when it was checked` : "nothing could be verified";
  return {
    title: b.title,
    // Their own words lead when there are any (the opening lines above); Cue's paraphrase only stands in when there aren't.
    note: `${asked.length ? "" : `For: ${b.asked}. `}Researched sections: ${sources}. "unknown" means the page didn't say.`,
    sections,
    suggestions: [],
    kind: "venue_brief",
  };
}

// Pure: what's wrong with a brief's research. Empty when every researched line is sourced, dated and allowed.
export function researchProblems(doc: Doc, opts: { sdkAllowed?: boolean } = {}): string[] {
  const out: string[] = [];
  const researched = doc.sections.filter((s) => s.research);
  if (!researched.length) out.push("a research brief needs at least one researched option");
  for (const s of researched) {
    const r = s.research as ResearchSource;
    let ok = false;
    try {
      ok = /^https:$/.test(new URL(r.url).protocol);
    } catch {}
    if (!ok) out.push(`"${s.heading}" has no source link`);
    if (!r.checkedAt || Number.isNaN(new Date(r.checkedAt).getTime())) out.push(`"${s.heading}" has no time it was checked`);
    if (r.reader === "sdk" && !(opts.sdkAllowed ?? SDK_FINDS_ALLOWED)) out.push(`"${s.heading}" came from the general reader, which isn't cleared for briefs yet`);
    if (s.paragraphs.length) out.push(`"${s.heading}" has free text: researched sections carry only sourced fields`);
    const last = s.bullets[s.bullets.length - 1] ?? "";
    if (!last.startsWith(`Source: ${r.url} (checked `)) out.push(`"${s.heading}" doesn't show its source and check time`);
    for (const b of s.bullets.slice(0, -1)) if (!/^[A-Z][A-Za-z ()/0-9,:.-]{1,50}?: \S/.test(b)) out.push(`"${b.slice(0, 60)}" in "${s.heading}" isn't a sourced field`);
  }
  return out;
}

// Pure: why a brief was refused, as the kinds of problem and how many of each ("no brief: unbacked time (2), research sourcing
// (1)"), never a problem's own text: the checks quote the brief's lines, and those are the member's words (forget by default,
// 2026-10-18). Read from the checkers' own wording (documentSheet.ts documentProblems, documentClaims.ts, researchProblems above).
export function problemKinds(problems: string[]): string {
  const timeLike = (x: string) => /^\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*$/i.test(x);
  const numberLike = (x: string) => /\d/.test(x);
  // What a "names X, Y, which they never said" or "it has X, Y, which they never gave" lists: times, numbers, names, or a mix.
  const facts = (list: string) => {
    const items = list.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
    if (items.length && items.every(timeLike)) return "unbacked time";
    if (items.length && items.every(numberLike)) return "unbacked number";
    if (items.some((x) => timeLike(x) || numberLike(x))) return "name and number or time not in their words";
    return "name not in their words";
  };
  const kindOf = (p: string): string => {
    const listed = p.match(/it has (.+?), which they never gave/) ?? p.match(/\bnames (.+?), which they never said/);
    if (listed) return facts(listed[1]);
    if (/opens on .+, which they never said/.test(p)) return "opening word not in their words";
    if (/isn't something they said/.test(p)) return "line not in their words";
    if (/placeholder/.test(p)) return "placeholder";
    if (/too thin|too long|needs a title|nothing in it|paragraph runs|no bullets|only repeat their headings/.test(p)) return "document shape";
    if (/source link|time it was checked|general reader|free text|source and check time|isn't a sourced field|researched option/.test(p)) return "research sourcing";
    return "other check";
  };
  const counts = new Map<string, number>();
  for (const p of problems) {
    const k = kindOf(String(p ?? ""));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} (${n})`).join(", ") || "no reason given";
}

// ---------------------------------------------------------------- reading a source as the venue schema

export type VenueAsk = { what: string; city: string | null; slot: { date: string; start: string } | null };
const slotLabel = (slot: VenueAsk["slot"]) => (slot ? `${slot.date} from ${slot.start}` : null);

// Pure: a scripted Peerspace read as the venue fields. Prices exactly as the listing shows them (a range stays a range);
// availability only when a date and start were asked; never a value the reader didn't return.
export function peerspaceFields(facts: import("./peerspaceSlot.js").SlotFacts, slot: VenueAsk["slot"], checkedAt = new Date().toISOString()): FindField[] {
  const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const rate = facts.priceRange ? `${money(facts.priceRange[0])} to ${money(facts.priceRange[1])} an hour, depending on the day` : facts.hourlyPrice !== null ? `${money(facts.hourlyPrice)} an hour` : null;
  const read: Record<string, FieldValue> = {
    rate: { value: rate },
    minimum: { value: facts.minimumHours !== null ? `${facts.minimumHours} hour${facts.minimumHours === 1 ? "" : "s"}` : null },
    capacity: { value: facts.capacity !== null ? `${facts.capacity} people` : null },
    open: { value: facts.available === "unknown" ? null : facts.available },
    inquire: { value: null }, // Peerspace books through its own panel; the source link is the way in
  };
  return schemaFields("venue", read, checkedAt, { slotLabel: slotLabel(slot) }).filter((f) => f.key !== "inquire");
}

const PEERSPACE_LISTING = /^https:\/\/www\.peerspace\.com\/pages\/listings\/[a-f0-9]{24}$/;

// One source, read as the venue schema: the scripted reader for a Peerspace listing, the general reader for anything else.
// Null when the page couldn't be read or said nothing the schema asks.
export async function readVenueSource(url: string, slot: VenueAsk["slot"]): Promise<{ reader: "scripted" | "sdk"; fields: FindField[]; title: string; gone?: boolean } | null> {
  const now = () => new Date().toISOString();
  if (PEERSPACE_LISTING.test(url)) {
    const { readPeerspaceSlot } = await import("./peerspaceSlot.js");
    const read = await readPeerspaceSlot(url, slot).catch(() => null);
    if (!read) return null;
    const { goneFor } = await import("./taskWeb.js");
    const title = (read.text.match(/^([^\n|]{3,80})/)?.[1] ?? "").trim();
    return { reader: "scripted", fields: peerspaceFields(read.facts, slot, now()), title, gone: !!goneFor(title, read.text) };
  }
  if (!SDK_FINDS_ALLOWED) return null;
  const { FIND_SCHEMAS } = await import("./researchQuality.js");
  const { readWithSdk } = await import("./sdkGeneralReader.js");
  const asks = FIND_SCHEMAS.venue.filter((f) => f.key !== "open").map((f) => ({ key: f.key, ask: f.ask }));
  const r = await readWithSdk(url, asks).catch(() => null);
  if (!r || r.stopped === "blocked site") return null;
  const fields = schemaFields("venue", r.answers, now(), { slotLabel: slotLabel(slot) });
  if (!fields.some((f) => f.value)) return null;
  const title = (r.pageText.match(/^([^\n|]{3,80})/)?.[1] ?? "").trim();
  return { reader: "sdk", fields, title };
}

// The find's search never ran (every pass failed, or the web search budget blocked it): thrown so the brief retries, then says it
// couldn't search, never that nothing fits.
export class SearchFailed extends Error {}

// The find, in a background task only. The assembled query (researchQuality.assembleQuery) goes to the verified web search;
// each result below Co's bar is skipped; each other result is read as the venue schema.
export async function findVenueOptions(userId: string, query: string, ask: VenueAsk, zone: string | null): Promise<ResearchFind[]> {
  const { taskWebSearch } = await import("./taskWeb.js");
  const { belowTheBar } = await import("./researchQuality.js");
  // Each option is read from its own page: a Peerspace listing, or the venue's own site. A listicle or directory about many
  // places is never read for one of them (taskWeb marks official pages). Too few of those from the first pass: one more pass
  // asking only for venues' own private-events pages.
  const { coreName } = await import("./taskWeb.js");
  const own = (k: { url: string; official: boolean }) => k.official || PEERSPACE_LISTING.test(k.url.split("?")[0]);
  // One option per place: a second page on the same site (Copra's reservations page and its private-events page) or the
  // same name again isn't another option. Peerspace listings are each their own place.
  const placeKey = (k: { url: string; name: string }) => (PEERSPACE_LISTING.test(k.url.split("?")[0]) ? k.url.split("?")[0] : (() => { try { return new URL(k.url).hostname.replace(/^www\./, ""); } catch { return k.url; } })());
  const sameName = (a: string, b: string) => coreName(a).toLowerCase() === coreName(b).toLowerCase();
  const ownPage = "For each, give the venue's OWN website page for private events or private dining, never a guide, list, review or directory.";
  // Each pass after the first names what's already found and looks somewhere else (2026-10-07 live brief: two passes that
  // returned 3 results each, mostly the same restaurants, came to 2 options).
  const angles = ["", "Look further: different venues from these, already found:", "This time look at a different kind of place at the same standard: a top hotel's private dining room or salon, a gallery or museum event space, or a private members' club that hosts dinners. Not these, already found:"];
  const kept: import("./taskWeb.js").VerifiedResult[] = [];
  const ownPlaces = () => kept.filter(own).filter((k, i, a) => a.findIndex((x) => placeKey(x) === placeKey(k)) === i);
  const log: { pass: number; kept: number; own: number; listicles: string[] }[] = [];
  // A search that failed (Exa down or timed out) or that the budget blocked never ran: when no pass ran, that's a failure, never
  // "no venues fit" (review of #225).
  const failures: string[] = [];
  for (const [i, angle] of angles.entries()) {
    if (i > 0 && ownPlaces().length >= BRIEF_LIMITS.maxOptions) break;
    const seen = [...new Set(kept.map((k) => coreName(k.name)))].slice(0, 12).join("; ");
    const q = i === 0 ? `${query} ${ownPage}` : `${query} ${ownPage} ${angle}${seen ? ` ${seen}.` : ""}`;
    // A brief is always one the member asked for (or said yes to), so its searches draw from the direct-ask share of the day's web
    // search budget, never the sweep's (re-review of #235: it defaulted to "sweep", so a used-up sweep share blocked a member's brief
    // while the direct-ask share sat unused).
    const r = await taskWebSearch(userId, q, { city: ask.city, zone, background: true, max: BRIEF_LIMITS.maxOptions, searches: 4, ownPage: "private events or private dining page", readsPageItself: true, source: "request" });
    if (/^(?:Web search failed|No web search right now)/.test(r.note)) failures.push(r.note);
    for (const k of r.kept) if (!kept.some((x) => x.url === k.url || (own(x) && own(k) && (placeKey(x) === placeKey(k) || sameName(x.name, k.name))))) kept.push(k);
    log.push({ pass: i + 1, kept: r.kept.length, own: r.kept.filter(own).length, listicles: r.kept.filter((k) => !own(k)).map((k) => k.url).slice(0, 4) });
  }
  if (failures.length === log.length && !kept.length) throw new SearchFailed(failures[0]);
  const urls = [...new Set(ownPlaces().map((k) => (PEERSPACE_LISTING.test(k.url.split("?")[0]) ? k.url.split("?")[0] : k.url)).filter((u) => u.startsWith("https://") && !belowTheBar(u)))].slice(0, BRIEF_LIMITS.maxReads);
  // The place's name, without the room the search named: the fields read below are the venue's, and may be another room's
  // (2026-10-07 live brief: "Scoma's Restaurant – The Scalia Room" over the Bayside Patio's capacity).
  const names = new Map(kept.map((k) => [k.url.split("?")[0], coreName(k.name)]));
  const finds: ResearchFind[] = [];
  const reads: { url: string; got: string }[] = [];
  for (const url of urls) {
    if (finds.length >= BRIEF_LIMITS.maxOptions) break;
    const read = await readVenueSource(url, ask.slot).catch((err: any) => {
      console.error(`research brief read failed for ${url} (non-fatal):`, err?.message ?? err);
      return null;
    });
    reads.push({ url, got: !read ? "nothing readable" : read.gone ? "gone" : `${read.fields.filter((f) => f.value).length} fields` });
    if (!read || read.gone) continue;
    const checkedAt = findCheckedAt(read.fields, new Date().toISOString());
    finds.push({ name: names.get(url.split("?")[0]) || read.title || new URL(url).hostname.replace(/^www\./, ""), url, checkedAt, reader: read.reader, fields: read.fields });
  }
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 7, decision: "research.find", userId, outcome: finds.length ? "act" : "skip", action: `${finds.length} options`, proposal: { passes: log, reads } }).catch(() => {});
  return finds;
}

// Pure: after trying to send a brief's closing line, what happens to the task. "told": it went (or already had, same target key),
// close as planned. "hold": it's outside their hours, so keep the task open and say it when their hours start (bounded by the
// task's wake-ups, so a line that never fits can't loop). "untold": paused, opted out or failed: close as dropped and say so.
// A brief whose document won't send: tried again this many times (DOC_RETRY_MINUTES apart), then the options go as a plain text.
export const DOC_RETRIES = 2;
export const DOC_RETRY_MINUTES = 30;
// Pure: the options as a short text when the document itself won't go: what it is, then each option with its link. Never a status.
export function briefOptionsText(title: string, options: { name: string; url: string }[]): string {
  const lines = options.slice(0, BRIEF_LIMITS.maxOptions).map((o, i) => `${i + 1}. ${o.name}: ${o.url}`);
  return `The ${title.replace(/^Venue options:\s*/i, "venue options for ").trim()} wouldn't come through as a PDF, so here they are:\n${lines.join("\n")}`;
}

export const BRIEF_HOLD_MAX_WAKES = 6;

// What they're told when the find's search never ran, after its retries: it couldn't search, never that nothing fits. Wording
// pending Royce's approval (PR #235).
export const SEARCH_FAILED_LINE = "My search didn't go through just now, so I couldn't look for venues yet. Want me to try again?";
// A find whose search never ran (Exa down or timed out, or the web search budget blocked it) is tried again at the task's next wake
// this many times before they're told (Royce, 2026-10-17: "retry once or twice ... Only tell the member if those fail"). No new
// machinery: the task is left open, and coTasks.claimDueTasks already leased it to its next wake 45 minutes on, when the whole run
// (and the find) goes again. task.wakes counts the runs (the first is 1), so runs 1 and 2 retry and run 3 tells them.
export const BRIEF_SEARCH_RETRIES = 2;
export const briefSearchNext = (wakes: number): "retry" | "tell" => (wakes <= BRIEF_SEARCH_RETRIES ? "retry" : "tell");

// A brief's identity across sends: what it's for, not its "Venue options" title (services/deliveryReceipts.ts docKeyFor reads only
// a title's head), so the same ask asked again is its next version and a different ask is its own document.
export const briefDocKey = (what: string): string => `venue-brief-${what.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "options"}`;

export type BriefDelivery = { sent: true; via: string; pdfPending: boolean; line: string | undefined } | { sent: false; why: string; quietUntil?: Date };
export type BriefDeliverDeps = {
  deliver?: typeof import("./documentDelivery.js").deliverDocument;
  receipts?: import("./deliveryReceipts.js").ReceiptStore;
  now?: () => Date;
  blocked?: (userId: string, zone: string | null, now: Date, o: { immediate?: boolean; asked?: boolean }) => Promise<string | null>;
  record?: typeof import("./documentDelivery.js").recordDocumentSent;
  log?: (d: any) => Promise<unknown>;
};

// One brief, delivered the way every document is (services/documentDelivery.ts deliverAndRecord): a receipt, its version, one line
// that says when they asked, the same artifact never twice unless they asked again. Inside their delivery hours (8am to 9pm their
// time) unless they asked for it right away: outside them it waits (quietUntil) and the caller holds it to then.
// One retry path each, never both: a PDF that failed to render went as text and its receipt retries the PDF (retryPendingPdfs);
// only when nothing reached them at all does the caller keep the brief (pendingDoc) and try again.
export async function deliverBrief(
  doc: Doc,
  o: { task: { id: number; userId: string; createdAt?: string | null; theirWords: string }; person: { firstName: string; phone: string }; zone: string | null; wantsGoogle: boolean; what: string; again: boolean; rechecked: number },
  deps: BriefDeliverDeps = {},
): Promise<BriefDelivery> {
  const D = await import("./documentDelivery.js");
  const { askedForImmediate, nextDeliveryTime } = await import("./memberTime.js");
  const now = deps.now?.() ?? new Date();
  const blocked = await (deps.blocked ?? D.documentSendBlocked)(o.task.userId, o.zone, now, { immediate: askedForImmediate(o.task.theirWords), asked: true }).catch(() => null);
  if (blocked === D.QUIET_HOURS) return { sent: false, why: blocked, quietUntil: nextDeliveryTime(now, o.zone) };
  if (blocked) return { sent: false, why: blocked };
  const askedAt = o.task.createdAt ? new Date(o.task.createdAt) : null;
  const line = await D.captionFor({ title: doc.title, kind: doc.kind, askedAt, sendAt: now, zone: o.zone });
  const to = { userId: o.task.userId, firstName: o.person.firstName, phone: o.person.phone, zone: o.zone, now, line };
  const changed = o.again ? (o.rechecked ? `rechecked ${o.rechecked === 1 ? "one option" : `${o.rechecked} options`} against their own pages` : "rechecked every option") : null;
  const rd = await D.deliverAndRecord(
    doc,
    to,
    // Asked again ("send it again", "update it"): the same version goes again when nothing changed, the next one when a re-check did.
    { saveTo: o.wantsGoogle ? "google_doc" : "pdf", askedForGoogle: o.wantsGoogle, source: `task:${o.task.id}`, taskId: o.task.id, resend: o.again, changed, docKey: briefDocKey(o.what) },
    { deliver: deps.deliver, receipts: deps.receipts, now: () => now, log: deps.log },
  );
  if (!rd.sentOk.length) return { sent: false, why: rd.results.map((r) => (r.ok ? "" : r.why)).filter(Boolean).join("; ") || "it didn't go out" };
  const via = rd.sentOk.map((r) => r.via).join("+");
  await (deps.record ?? D.recordDocumentSent)(o.task.userId, doc, via, `task:${o.task.id}`).catch(() => {});
  return { sent: true, via, pdfPending: rd.sentOk.some((r) => r.pdfPending), line: rd.line };
}
export function briefLineOutcome(r: { sent: boolean; reason?: string }, wakes: number): "told" | "hold" | "untold" {
  if (r.sent || r.reason === "already sent") return "told";
  // Held by their own rule or the spacing (harness/notifyGate.ts) waits the same way: it's work they asked for, never dropped for it.
  // Held by their own rule or the spacing (harness/notifyGate.ts): it's work they asked for, it waits however long, never dropped for it
  // (its wake is given back, below).
  if (r.reason?.startsWith("held:")) return "hold";
  if (r.reason === "outside local hours" && wakes < BRIEF_HOLD_MAX_WAKES) return "hold";
  return "untold";
}

type BriefParams = { what?: string; city?: string | null; neighborhood?: string | null; date?: string | null; start?: string | null; headcount?: number | null; budget?: string | null; title?: string; memberContext?: string[]; wantsGoogle?: boolean; again?: boolean };

// The background run of one research-brief task (services/taskTurn.ts runDueTasks): find (or, for "send it again", re-check the
// last brief's finds), rank, build, check, deliver, record what was shown, close.
// The member asked (or said yes) before this task existed: the reply-loop tool that starts it carries that check, and asks
// them first when a load-bearing fact is missing.
export async function runResearchBriefTask(task: import("./coTasks.js").CoTask): Promise<void> {
  const { closeTask } = await import("./coTasks.js");
  const { default: pool } = await import("../db/db.js");
  const Q = await import("./researchQuality.js");
  const p = (task.followup ?? {}) as BriefParams;
  const { rows } = await pool.query(`SELECT u.first_name, u.phone_number, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [task.userId]);
  const person = rows[0];
  if (!person?.phone_number || !p.what) {
    await closeTask(task.userId, task.id, "dropped", "missing what to research or who to send it to");
    return;
  }
  const city = p.city ?? person.city ?? null;
  const zone = city ? await import("./geocoding.js").then((g) => g.getTimezoneForCity(city, { region: regionFor({ city, phone: person?.phone_number }) })).catch(() => null) : null;
  const slot = p.date && p.start ? { date: p.date, start: p.start } : null;
  const { sendExempt } = await import("../harness/proactive.js");
  // A line to them that ends the brief (what it came to, or the question it needs first). Outside their hours it used to be
  // dropped while the task closed as done, so they never heard (2026-10-07). Now: told, then closed; outside their hours, held
  // to their morning with the task kept open; never told for any other reason, closed as dropped and saying so.
  const tellThenClose = async (text: string, status: "done" | "dropped", outcome: string) => {
    const r = await sendExempt({ userId: task.userId, phoneNumber: person.phone_number, type: "task_update", targetKey: `research_brief:${task.id}`, messages: [text], timezone: zone, respectHours: true, answers: { askedAt: task.createdAt ? new Date(task.createdAt) : null } }).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }));
    const next = briefLineOutcome(r, task.wakes);
    if (next === "hold") {
      const { holdBriefLine, unspendWake } = await import("./coTasks.js");
      const { nextSendable } = await import("./memberTime.js");
      // Held by their rule or the spacing: it waits until it may go, and the wake comes back (a hold never uses up an owed delivery).
      const held = r.reason?.startsWith("held:") ? (r as { retryAt?: Date }).retryAt ?? null : null;
      if (await holdBriefLine(task.userId, task.id, { text, status, outcome }, held ?? nextSendable(new Date(), zone))) {
        if (held) await unspendWake(task.userId, task.id).catch(() => {});
        return;
      }
    }
    await closeTask(task.userId, task.id, next === "told" ? status : "dropped", next === "told" ? outcome : `${outcome}; never told them (${r.reason ?? "not sent"})`);
  };
  // A line held from an earlier run: say it now (the find isn't run again).
  const held = (task.followup as any)?.held as { text: string; status: "done" | "dropped"; outcome: string } | undefined;
  if (held?.text) {
    await tellThenClose(held.text, held.status, held.outcome);
    return;
  }
  // A finished brief whose document didn't go out last time: send that same document again (no new find). After DOC_RETRIES it
  // goes as a short text with the options, so it always reaches them.
  const pendingDoc = (task.followup as any)?.pendingDoc as { doc: any; options: { name: string; url: string }[]; tries: number; title: string; list: string } | undefined;
  const sendBrief = (doc: Doc, what: string) =>
    deliverBrief(doc, { task, person: { firstName: String(person.first_name ?? ""), phone: person.phone_number }, zone, wantsGoogle: !!p.wantsGoogle, what, again: !!p.again, rechecked: 0 }).catch((err: any) => ({ sent: false as const, why: String(err?.message ?? err) }) as BriefDelivery);
  if (pendingDoc?.doc) {
    const r = await sendBrief(pendingDoc.doc, p.what ?? pendingDoc.title);
    if (r.sent) {
      await closeTask(task.userId, task.id, "done", `sent the brief${pendingDoc.tries ? ` on retry ${pendingDoc.tries}` : ""}${r.pdfPending ? " as text, the PDF to follow" : ""}: ${pendingDoc.list}`);
      return;
    }
    // Their quiet hours: not a failed try, just later (their 8am).
    if (!r.sent && r.quietUntil) {
      const { holdBriefDoc } = await import("./coTasks.js");
      if (await holdBriefDoc(task.userId, task.id, pendingDoc, r.quietUntil)) return;
    }
    if (pendingDoc.tries + 1 < DOC_RETRIES) {
      const { holdBriefDoc } = await import("./coTasks.js");
      if (await holdBriefDoc(task.userId, task.id, { ...pendingDoc, tries: pendingDoc.tries + 1 }, new Date(Date.now() + DOC_RETRY_MINUTES * 60_000))) return;
    }
    await tellThenClose(briefOptionsText(pendingDoc.title, pendingDoc.options), "done", `the PDF wouldn't send; sent the options as a text: ${pendingDoc.list}`);
    return;
  }

  let finds: ResearchFind[] = [];
  let rechecked = 0;
  if (p.again) {
    // The same brief again: its own finds, each re-read where a field is past its window, before it goes.
    const last = await Q.lastBriefFinds(task.userId, "venue");
    for (const f of last.finds) {
      const r = await Q.freshForShow(f, async (old) => {
        const read = await readVenueSource(old.url, slot);
        return read ? { gone: !!read.gone, fields: read.fields } : null;
      });
      rechecked += r.rechecked.length ? 1 : 0;
      if (r.find) finds.push({ name: r.find.name, url: r.find.url, reader: r.find.reader, fields: r.find.fields, checkedAt: findCheckedAt(r.find.fields, new Date().toISOString()) });
    }
  } else {
    const state = await Q.loadMemberSearchState(task.userId, { city, neighborhood: p.neighborhood ?? null, budget: p.budget ?? null, date: p.date ?? null, start: p.start ?? null, headcount: p.headcount ?? null });
    const q = Q.assembleQuery("venue", p.what, state);
    if (!q.ok) {
      // The tool asks first; this is the backstop. Never search on a guess.
      await tellThenClose(q.question, "dropped", `asked them first: missing ${q.missing.join(", ")}`);
      return;
    }
    const find = { failed: null as string | null };
    finds = await findVenueOptions(task.userId, q.query, { what: p.what, city, slot }, zone).catch((err: any) => {
      console.error("research brief find failed (non-fatal):", err?.message ?? err);
      find.failed = err instanceof SearchFailed ? err.message : "the find threw an error";
      return [] as ResearchFind[];
    });
    // The find never ran (the search failed or was blocked): tried again at the next wake, then they're told it couldn't search,
    // never that no venues fit (review of #225).
    if (find.failed) {
      if (briefSearchNext(task.wakes) === "retry") {
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 7, decision: "research.find", userId: task.userId, outcome: "skip", action: `search didn't run; retry ${task.wakes} of ${BRIEF_SEARCH_RETRIES} at the next wake`, reason: find.failed, proposal: { taskId: task.id, wakes: task.wakes } }).catch(() => {});
        return;
      }
      await tellThenClose(SEARCH_FAILED_LINE, "dropped", `the search didn't run after ${BRIEF_SEARCH_RETRIES} retries: ${find.failed}`);
      return;
    }
  }
  // Ordered by what they (or everyone) said yes and no to before.
  const signal = await Q.rankingSignal(task.userId);
  finds = Q.rankFinds(finds.map((f) => ({ ...f, type: "venue" as FindType })), signal.member, signal.global).map(({ score: _s, type: _t, ...f }) => f);

  const doc = buildBrief({
    title: p.title || `Venue options: ${p.what}`.slice(0, 70),
    asked: p.what,
    finds,
    memberContext: p.memberContext ?? [],
    zone,
    theirWords: task.theirWords,
    searched: { date: p.date ?? null, start: p.start ?? null, headcount: p.headcount ?? null, budget: p.budget ?? null, neighborhood: p.neighborhood ?? null, city },
  });
  const { loadTheirWords } = await import("./documentDelivery.js");
  const theirs = [await loadTheirWords(task.userId).catch(() => ""), task.theirWords].join("\n");
  const problems = [...researchProblems(doc), ...(await (await import("./documentClaims.js")).judgedDocumentProblems(doc, { theirs }))];
  if (problems.length) {
    const line = finds.length ? "I looked, but I couldn't verify enough to put a brief together that I'd stand behind. I'll tell you what I can check by hand if you want." : "I looked, but couldn't verify any venues that fit. Want me to widen the search?";
    // The note is read back to Cue (coTasks.ts briefFactLines): what it came to and why, as kinds, never the lines the checks quoted.
    await tellThenClose(line, "done", `no brief: ${problemKinds(problems)}`);
    return;
  }
  // Through the receipts (deliverAndRecord): its version, its one line, and a failed PDF that went as text retried from its receipt.
  const delivered = await deliverBrief(doc, { task, person: { firstName: String(person.first_name ?? ""), phone: person.phone_number }, zone, wantsGoogle: !!p.wantsGoogle, what: p.what, again: !!p.again, rechecked }).catch((err: any) => ({ sent: false as const, why: String(err?.message ?? err) }) as BriefDelivery);
  const sent = delivered.sent;
  const shown = finds.slice(0, BRIEF_LIMITS.maxOptions);
  if (sent) await Q.recordShownFinds(task.userId, task.id, shown.map((f) => ({ type: "venue", name: f.name, url: f.url, reader: f.reader, fields: f.fields }) as StoredFind));
  const { recordDecision } = await import("../harness/core.js");
  // The kind of thing, never its title (the title is their ask in words).
  await recordDecision({ layer: 7, decision: "task.researchBrief", userId: task.userId, outcome: sent ? "act" : "skip", action: sent ? "venue brief sent" : "venue brief not sent", proposal: { taskId: task.id, options: shown.length, again: !!p.again, rechecked, readers: [...new Set(shown.map((f) => f.reader))] } }).catch(() => {});
  // The close note is Co's record of what went out: the options by number, so a reaction ("the second one") can be matched. The
  // options are the places found, never their words; the brief's title isn't in it (what it was for is the task's own goal).
  const list = shown.map((f, i) => `${i + 1}. ${f.name}`).join("; ");
  if (!delivered.sent) {
    // The brief is done but its document didn't go: keep it and send it again shortly (or at their 8am when it's their quiet
    // hours), never close silently. Nothing reached them, so there's no receipt retry for it: this is its one retry.
    const { holdBriefDoc } = await import("./coTasks.js");
    const options = shown.map((f) => ({ name: f.name, url: f.url }));
    if (await holdBriefDoc(task.userId, task.id, { doc, options, tries: 0, title: doc.title, list }, delivered.quietUntil ?? new Date(Date.now() + DOC_RETRY_MINUTES * 60_000))) return;
    await tellThenClose(briefOptionsText(doc.title, options), "done", `the PDF wouldn't send; sent the options as a text: ${list}`);
    return;
  }
  await closeTask(task.userId, task.id, "done", `sent the brief${delivered.pdfPending ? " as text, the PDF to follow" : ""}: ${list}`);
}
