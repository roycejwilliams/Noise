// Web results a task may use (Royce, 2026-09-30: "Tasks now text members facts
// from the web on their own, so a wrong price, date or capacity costs trust").
// Every result proves itself before Co can use it:
//   1. its name is on its page, and each detail Co would repeat (capacity, price,
//      dates, address or neighborhood, deadline) is on that page, or it's dropped
//      (the Tier 3 grounding gate, harness/matchGate.ts checkGrounding);
//   2. a blog, directory or listicle is swapped for the thing's own page when that
//      page reads (looksOfficial / findOfficialPage, services/webOpportunitySearch.ts);
//   3. a past date or deadline, closed applications, or a no-longer-available or
//      sold-out listing is rejected (checkTiming, same gate);
//   4. only the verified fields go on (taskTurn.ts passes nothing else to a text);
//   5. every search is logged as task.webSearch with what was kept and dropped.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { checkGrounding, checkTiming, placesClaimed } from "../harness/matchGate.js";
import type { TierMatch } from "./tieredRecommendation.js";
import { findOfficialPage, looksOfficial, readPageText, reserveWebSearch } from "./webOpportunitySearch.js";
import { parseModelJson } from "./modelJson.js";

export type RawDetail = { label: string; value: string };
export type RawResult = { name: string; url: string; details: RawDetail[]; date?: string | null; deadline?: string | null };
// Marketplaces that block even a real browser (checked 2026-09-30). Searched,
// but a result has to come back as the place's own page.
// Peerspace and The Bash read in a real browser (services/browserRead.ts).
export const CANT_CHECK_SITES = ["gigsalad.com", "yelp.com", "theknot.com"];
export const cantCheck = (site: string) => CANT_CHECK_SITES.some((d) => site === d || site.endsWith(`.${d}`));

// excerpts: for each fact, the passage of the page it was found in (for the
// second reader, services/factCheck.ts).
export type VerifiedResult = { name: string; url: string; official: boolean; facts: string[]; excerpts?: string[]; date: string | null; deadline: string | null };
export type Dropped = { name: string; url: string; why: string };
export type DroppedDetail = { name: string; detail: string; why: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const flat = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9$' ]+/g, " ").replace(/\s+/g, " ").trim()} `;

// Phrases on the page that say it's no longer something they can use.
const GONE = /\b(applications? (are |is )?(now )?closed|no longer (available|accepting|taking|open|in business)|permanently closed|(this )?event (has )?(ended|passed|been cancel+ed)|sold out|registration (is )?closed|not accepting (new )?(applications|bookings|clients))\b/i;

function asMatch(r: { name: string; url: string }, extra: Partial<TierMatch> = {}): TierMatch {
  return { tier: 3, kind: "opportunity", source: "web", name: r.name, url: r.url, reason: "", ...extra } as TierMatch;
}

// A "closed" or "sold out" phrase only counts when it's about this thing: near its
// name, or at the top of the page (2026-09-30: SF.gov's permit page was rejected for
// "The time you selected is no longer available" in a calendar widget, 16k characters in).
export function goneFor(name: string, pageText: string): string | null {
  const lower = pageText.toLowerCase();
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const re = new RegExp(GONE.source, "gi");
  for (const m of pageText.matchAll(re)) {
    const at = m.index ?? 0;
    if (at < 800) return m[0];
    const near = lower.slice(Math.max(0, at - 300), at + 300);
    if (words.some((w) => near.includes(w))) return m[0];
  }
  return null;
}

// Words of a detail that must be on the page: every capitalized word and number,
// and most of the rest (2026-09-30 re-read: "Instant book" and "Free intro call"
// passed because only numbers and places were checked).
export function detailWordsMissing(value: string, page: string, strict: boolean): string[] {
  const words = flat(value).trim().split(" ").filter((w) => w.length >= 4 && !/^(with|from|that|this|their|your|between|near|over|about|into|also|just|only|more|less)$/.test(w));
  const onPage = (w: string) => page.includes(` ${w} `) || page.includes(` ${w.replace(/s$/, "")} `) || page.includes(` ${w}s `) || (w === "centre" && page.includes(" center ")) || (w === "center" && page.includes(" centre "));
  const missing = words.filter((w) => !onPage(w));
  const named = (value.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !onPage(w));
  if (strict || named.length) return [...new Set([...named, ...missing])];
  return missing.length / Math.max(1, words.length) > 0.2 ? missing : [];
}

// A marketplace page for one listing (the whole page is about it).
export const singleItemUrl = (url: string) => /\/pages\/listings\/|\/listings?\/[^/]+\/?$|\/profile\/|\/info\/[^/]+\/?$/i.test(url);

// On a page that lists many things, a price or capacity only counts next to
// this thing's name (2026-09-30: on a directory page, a detail can belong to
// the venue listed beside it). The passage is kept for the second reader.
export function nearName(name: string, value: string, pageText: string, needed: boolean): { ok: boolean; excerpt: string } {
  const page = flat(pageText);
  // Numbers and proper words, mixed case and acronyms included (2026-09-30:
  // "SoMa, SF" had none, so the passage fell back to the site's menu).
  const tokens = [...(value.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "").replace(/,/g, "")), ...(value.match(/\b[A-Z][A-Za-z]{2,}\b|\b[A-Z][a-z]*[A-Z][A-Za-z]*\b/g) ?? []).map((w) => w.toLowerCase())].filter((t, i, a) => t && a.indexOf(t) === i && !flat(name).includes(` ${t} `));
  // Where the fact is on the page, for the passage: its first number or proper
  // word, else its longest plain word.
  const anchor = tokens[0] ?? flat(value).trim().split(" ").filter((w) => w.length >= 4).sort((a, b) => b.length - a.length)[0] ?? null;
  const pageNoCommas = page.replace(/(\d),(\d)/g, "$1$2");
  const key = flat(name).trim();
  const words = key.split(" ").filter((w) => w.length >= 5).sort((a, b) => b.length - a.length);
  const spots: number[] = [];
  for (const k of [key, ...words.slice(0, 1)]) {
    for (let at = pageNoCommas.indexOf(k); at >= 0 && spots.length < 40; at = pageNoCommas.indexOf(k, at + 1)) spots.push(at);
    if (spots.length) break;
  }
  // A listing card or a paragraph about it: a little before the name, more after.
  // Two cards side by side are closer than this; that's the second reader's job.
  const windowAt = (at: number) => pageNoCommas.slice(Math.max(0, at - 200), at + 900);
  const has = (w: string, t: string) => w.includes(` ${t} `) || w.includes(` $${t} `) || w.includes(`$${t}`) || w.includes(` ${t}`);
  // The passage for the second reader: the page as written (case, "$150/hr",
  // line breaks between listings), starting at this thing's own name nearest
  // the spot (2026-09-30: a passage centred by estimate started cards early and
  // the reader couldn't tell whose price was whose).
  const scale = pageText.length / Math.max(1, pageNoCommas.length);
  const lowerPage = pageText.toLowerCase();
  const nameHits: number[] = [];
  for (const k of [name.toLowerCase().trim(), ...words.slice(0, 1)]) {
    for (let at = lowerPage.indexOf(k); at >= 0 && nameHits.length < 40; at = lowerPage.indexOf(k, at + 1)) nameHits.push(at);
    if (nameHits.length) break;
  }
  const original = (at: number) => {
    const guess = at * scale;
    const start = nameHits.length ? nameHits.reduce((a, b) => (Math.abs(b - guess) < Math.abs(a - guess) ? b : a)) : Math.floor(guess);
    return pageText.slice(start, start + 800).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  };
  // Its own page or a single listing: the whole page is about it, so the
  // passage is wherever the fact is (a price far below the name).
  if (!needed) {
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = anchor ? new RegExp(/^\d+$/.test(anchor) ? anchor.split("").map(esc).join(",?") : `\\b${esc(anchor)}`, "i") : null;
    const at = re ? pageText.search(re) : -1;
    if (at >= 0) return { ok: true, excerpt: `(From ${name}'s own page) ${pageText.slice(Math.max(0, at - 400), at + 400).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim()}` };
  }
  const fit = spots.find((at) => tokens.every((t) => has(windowAt(at), t)));
  if (fit !== undefined) return { ok: true, excerpt: original(fit) };
  const first = tokens.length ? Math.max(0, pageNoCommas.indexOf(tokens[0])) : spots[0] ?? 0;
  return { ok: !needed || !tokens.length, excerpt: original(first) };
}

const placeLabel = (label: string) => /address|neighbou?rhood|location|area|street|where/i.test(label);
const dateLabel = (label: string) => /date|when|deadline|due/i.test(label);

// Pure: one result against the text of the page it came from.
export function verifyResult(raw: RawResult, pageText: string, opts: { now: Date; zone?: string | null; official: boolean }): { kept: VerifiedResult | null; dropped: Dropped | null; droppedDetails: DroppedDetail[] } {
  const base = { name: raw.name, url: raw.url };
  const facts = { searchCity: null, distanceMiles: null, alreadyOffered: false, now: opts.now, zone: opts.zone ?? null, evidence: pageText } as any;
  const nameCheck = checkGrounding(asMatch(base), facts);
  if (!nameCheck.pass) return { kept: null, dropped: { ...base, why: nameCheck.reason ?? "not on its page" }, droppedDetails: [] };
  const gone = goneFor(raw.name, pageText);
  if (gone) return { kept: null, dropped: { ...base, why: `the page says "${gone}"` }, droppedDetails: [] };
  const date = raw.date && ISO.test(raw.date) ? raw.date : null;
  const deadline = raw.deadline && ISO.test(raw.deadline) ? raw.deadline : null;
  const timing = checkTiming(asMatch(base, { ...(date ? { statedDates: { start: date, end: null } } : {}), ...(deadline ? { deadline } : {}) } as any), facts);
  if (!timing.pass) return { kept: null, dropped: { ...base, why: timing.reason ?? "stale" }, droppedDetails: [] };

  const kept: string[] = [];
  const excerpts: string[] = [];
  const droppedDetails: DroppedDetail[] = [];
  const page = flat(pageText);
  const needNear = !opts.official && !singleItemUrl(raw.url);
  for (const d of raw.details ?? []) {
    const label = String(d?.label ?? "").trim().slice(0, 40);
    const value = String(d?.value ?? "").trim().slice(0, 160);
    if (!label || !value) continue;
    // Numbers, places and a stated deadline: the Tier 3 gate.
    const g = checkGrounding(asMatch(base, { reason: value } as any), facts);
    if (!g.pass) {
      droppedDetails.push({ name: raw.name, detail: `${label}: ${value}`, why: g.reason ?? "not on the page" });
      continue;
    }
    // The value's own words: all of them for places and dates, names always, and
    // most of the rest for everything else.
    const missing = detailWordsMissing(value, page, placeLabel(label) || dateLabel(label));
    if (missing.length) {
      droppedDetails.push({ name: raw.name, detail: `${label}: ${value}`, why: `"${missing.join(" ")}" isn't on the page` });
      continue;
    }
    const near = nearName(raw.name, value, pageText, needNear);
    if (!near.ok) {
      droppedDetails.push({ name: raw.name, detail: `${label}: ${value}`, why: "on the page, but not next to its name (another listing's?)" });
      continue;
    }
    kept.push(`${label}: ${value}`);
    excerpts.push(near.excerpt);
  }
  // A date or deadline is only repeated when the page states it (the gate's deadline check).
  let keptDate = date;
  if (date && !checkGrounding(asMatch(base, { deadline: date } as any), facts).pass) {
    droppedDetails.push({ name: raw.name, detail: `date: ${date}`, why: "the date isn't stated on the page" });
    keptDate = null;
  }
  let keptDeadline = deadline;
  if (deadline && !checkGrounding(asMatch(base, { deadline } as any), facts).pass) {
    droppedDetails.push({ name: raw.name, detail: `deadline: ${deadline}`, why: "the deadline isn't stated on the page" });
    keptDeadline = null;
  }
  return { kept: { name: raw.name.slice(0, 120), url: raw.url, official: opts.official, facts: kept, excerpts, date: keptDate, deadline: keptDeadline }, dropped: null, droppedDetails };
}

// Which page a result is checked against: its own official page when the found
// page is a blog or directory and the official one reads; else the found page.
export async function pickPage(
  raw: RawResult,
  deps: { read: (url: string) => Promise<string | null>; official: (name: string) => Promise<string | null> },
): Promise<{ url: string; text: string | null; official: boolean; swapped: boolean }> {
  if (!looksOfficial(raw.url, raw.name)) {
    const off = await deps.official(raw.name).catch(() => null);
    if (off && off !== raw.url && looksOfficial(off, raw.name)) {
      const text = await deps.read(off);
      if (text) return { url: off, text, official: true, swapped: true };
    }
    return { url: raw.url, text: await deps.read(raw.url), official: false, swapped: false };
  }
  return { url: raw.url, text: await deps.read(raw.url), official: true, swapped: false };
}

export function parseRawResults(text: string): RawResult[] {
  try {
    const p = parseModelJson<{ items?: any[] }>(text);
    return (p?.items ?? [])
      .filter((i) => typeof i?.name === "string" && typeof i?.url === "string" && /^https:\/\//.test(i.url))
      .slice(0, 3)
      .map((i) => ({
        name: String(i.name),
        url: String(i.url),
        details: Array.isArray(i.details) ? i.details.filter((d: any) => typeof d?.label === "string" && typeof d?.value === "string").slice(0, 6) : [],
        date: typeof i.date === "string" ? i.date : null,
        deadline: typeof i.deadline === "string" ? i.deadline : null,
      }));
  } catch {
    return [];
  }
}

export type TaskWebResult = { kept: VerifiedResult[]; dropped: Dropped[]; droppedDetails: DroppedDetail[]; note: string };

// One web search for a task: the model finds, code verifies.
export async function taskWebSearch(
  userId: string,
  what: string,
  opts: { city?: string | null; zone?: string | null; taskId?: number | null; skipBudget?: boolean; log?: boolean; sites?: string[]; source?: "sweep" | "request" } = {},
): Promise<TaskWebResult> {
  if (!opts.skipBudget) {
    const budget = await reserveWebSearch(userId, opts.source ?? "sweep", what);
    if (!budget.ok) return { kept: [], dropped: [], droppedDetails: [], note: `No web search right now: ${budget.reason}.` };
  }
  let raws: RawResult[] = [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "taskWeb.search", metadata: { userId } },
      tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 2 }) },
      stopWhen: stepCountIs(3),
      timeout: 60_000,
      prompt: `Find on the real web: ${what}${opts.city ? ` (they're in ${opts.city})` : ""}. Today: ${new Date().toISOString().slice(0, 10)}.${opts.sites?.length ? ` Good places to look: ${opts.sites.join(", ")} (and the thing's own site).` : ""}${opts.sites?.some(cantCheck) ? ` Listings on ${opts.sites.filter(cantCheck).join(", ")} can't be opened to check, so for anything found there give the place's OWN website and its real name (a listing that hides the name, like "Modern loft in SoMa", can't be used).` : ""}
Up to 3 real, specific options, each from a page you actually read, ideally the thing's own site. For each, the details that matter (capacity, price, dates, address or neighborhood, deadline), each copied from that page as it's written there.
Return ONLY JSON: {"items": [{"name": "...", "url": "https://the page you read", "details": [{"label": "capacity", "value": "..."}], "date": "YYYY-MM-DD or null (when it happens, if it's an event)", "deadline": "YYYY-MM-DD or null"}]}. {"items": []} if nothing real.`,
    });
    raws = parseRawResults(text);
  } catch (err: any) {
    return { kept: [], dropped: [], droppedDetails: [], note: `Web search failed: ${err?.message ?? "error"}.` };
  }
  const kept: VerifiedResult[] = [];
  const dropped: Dropped[] = [];
  const droppedDetails: DroppedDetail[] = [];
  // Every result's page is found and read at once, then checked in order
  // (2026-10-01: one after another was most of a ~35s search).
  const pages = await Promise.all(raws.map((raw) => pickPage(raw, { read: (u) => readPageText(u), official: (n) => findOfficialPage(n, 20_000) }).catch(() => ({ url: raw.url, text: null, official: false, swapped: false }))));
  for (const [i, raw] of raws.entries()) {
    const page = pages[i];
    if (!page.text) {
      dropped.push({ name: raw.name, url: raw.url, why: "its page couldn't be read" });
      continue;
    }
    const v = verifyResult({ ...raw, url: page.url }, page.text, { now: new Date(), zone: opts.zone ?? null, official: page.official });
    droppedDetails.push(...v.droppedDetails);
    // Found on a list page read in the browser: link its own listing instead.
    if (v.kept && !page.official && !singleItemUrl(page.url)) {
      const { ownLink } = await import("./browserRead.js");
      const own = ownLink(page.url, raw.name);
      if (own) v.kept.url = own;
    }
    if (v.kept) kept.push(v.kept);
    else if (v.dropped) dropped.push(v.dropped);
  }
  if (opts.log !== false) {
    await recordDecision({
      layer: 7,
      decision: "task.webSearch",
      userId,
      outcome: kept.length ? "act" : "skip",
      action: `kept ${kept.length}, dropped ${dropped.length}`,
      proposal: { taskId: opts.taskId ?? null, query: what, kept: kept.map((k) => ({ name: k.name, url: k.url, official: k.official, facts: k.facts, date: k.date, deadline: k.deadline })), dropped, droppedDetails },
    }).catch(() => {});
  }
  return { kept, dropped, droppedDetails, note: kept.length ? "Each kept result was checked against its own page; only the listed facts are verified." : "Nothing came back that proved itself on its page." };
}

// The facts a task text may use from web results: verified fields only.
export function verifiedFactLines(results: VerifiedResult[]): string[] {
  return results.map((r) => `${r.name} (${r.url})${r.facts.length ? `: ${r.facts.join("; ")}` : ""}${r.date ? `; a date its page mentions: ${r.date} (not proof it's available then)` : ""}${r.deadline ? `; deadline ${r.deadline}` : ""}`);
}

// A drafted text may only name places that are in the facts it was given
// (2026-09-30: "Penny Roma … in Bernal Heights" when the verified address was on
// 20th Street). Uses the grounding gate's own place detector.
export function placesBacked(text: string, facts: string): { ok: boolean; missing: string[] } {
  const have = facts.toLowerCase();
  const missing = placesClaimed(text).filter((p) => !have.includes(p.toLowerCase()) && !["san francisco", "sf", "the city"].includes(p.toLowerCase()));
  return { ok: missing.length === 0, missing };
}

// Co can't call, book, or contact anyone for them; a task text never offers to.
export const OFFERS_WHAT_CO_CANT = /\b(want me to|should i|i can|i'?ll|let me)\s+(give them a |)(call|phone|ring|book|reserve|email|contact|reach out to|message|dm)\b/i;

// Claims a page rarely makes and a text easily implies (2026-09-30): that it's
// available on their date, confirmed, open or happy to host, or has done
// something before. Only when the facts say so in those words; otherwise Co
// says it's unconfirmed, the way a friend would.
const CLAIMS = [
  { re: /\b(is|are|it's|they're|looks?|should be)\s+(still\s+)?((available|free)\b(?!\s+(to book|for booking|for private))|open\b(?!\s+to\b))/i, backed: /\bavailab/i },
  { re: /\b(confirmed|guaranteed|locked in|booked for you)\b/i, backed: /\bconfirm|guarantee/i },
  { re: /\b(open to|happy to|willing to|down to|keen to)\s+(host|donate|sponsor|partner|co-?host|lend)/i, backed: /\b(donat|sponsor|partner|co-?host|free for|community use)/i },
  { re: /\b(has|have|they've|it's)\s+(already\s+)?(hosted|done|run|thrown|put on)\b/i, backed: /\b(hosted|past events|previous events|has held|have held)\b/i },
  { re: /\b(allows?|lets? you|permits?)\s+(a\s+|your own\s+)?(dj|music|alcohol|drinks|food|catering)/i, backed: /\b(allowed|permitted|welcome|bring your own|byo|outside (food|catering|vendors))/i },
];
export function unbackedClaims(text: string, facts: string): string[] {
  return CLAIMS.filter((c) => c.re.test(text) && !c.backed.test(facts)).map((c) => text.match(c.re)![0]);
}

// A drafted text may only carry numbers that are in the facts it was given.
export function numbersBacked(text: string, facts: string): { ok: boolean; missing: string[] } {
  const have = facts.replace(/,/g, "");
  const missing = (text.match(/\$?\d[\d,.]*/g) ?? [])
    .map((n) => n.replace(/[,.]$/, "").replace(/,/g, "").replace(/^\$/, ""))
    .filter((n) => n && !have.includes(n));
  return { ok: missing.length === 0, missing };
}
