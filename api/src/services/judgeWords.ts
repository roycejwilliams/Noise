// What the deck judge reads as their words (Royce, 2026-10-18, after the A+H re-measure: the judge's 6,000 characters were about half
// photo descriptions, and the facts that backed his lines sat 3,000 to 25,000 characters back; a fact said months ago must reach it).
//
//   1. Photo descriptions are cut to one short line each (shortPhotos): a photo they sent stays visible ("[sent a photo: Website
//      homepage for Bou...]"), but its full description (Cue's vision, not their words) no longer fills the window.
//   2. Excerpts from their WHOLE history that match the deck's lines come first (matchedExcerpts): the names, numbers and topic words
//      of each line, scored against every text and call line of theirs, the best few per line, dated. Then their newest words fill
//      what's left. Both within the judge's 6,000 characters.
//   3. Their goals are ordered by how much they share with the deck's lines (byRelevance), so the header's cap keeps the ones that
//      matter for this deck.
// Their own words only: the history is their texts and their side of calls, read the way their 14 days are (documentDelivery.ts).
// Pure: no database, no model.
import { sliceSafe } from "./memberRecord.js";

export const JUDGE_WORDS = { total: 6000, excerpts: 3000, excerptChars: 320, perLine: 2, minScore: 3 } as const;
// An excerpt older than this, about something that changes, doesn't settle a line (Royce, 2026-10-18: "an old fact that may have
// changed"); the judge reads the age on each excerpt and says so (coPages/deckClaims.ts EXCERPT_RULES).
export const OLD_FACT_DAYS = 60;
// What changes: the topics where something said months ago may no longer hold. Each is also a paraphrase cluster for matching: a line
// and an excerpt that share a cluster are matched even with no word in common ("Bootstrapped" and "no outside funding").
export const CHANGEABLE: Record<string, string[]> = {
  "funding stage or raise": ["bootstrap", "bootstrapped", "self-funded", "funding", "funded", "fund", "raise", "raising", "raised", "investor", "investors", "investment", "seed", "pre-seed", "preseed", "angel", "angels", "vc", "vcs", "capital", "round", "series", "grant", "accelerator"],
  "job or title": ["job", "role", "title", "founder", "cofounder", "co-founder", "ceo", "cto", "coo", "quit", "hired", "employed", "work at", "working at"],
  company: ["company", "startup", "business", "employer", "pivot", "pivoting"],
  city: ["city", "moved", "moving", "based", "live in", "living in", "relocate", "relocating"],
  "relationship status": ["married", "engaged", "single", "dating", "partner", "boyfriend", "girlfriend", "husband", "wife", "divorced"],
  "team size or headcount": ["team", "hire", "hiring", "headcount", "employees", "staff", "engineers"],
  "revenue, customers or users": ["revenue", "mrr", "arr", "customers", "customer", "paying", "users", "clients", "members", "sales", "traction"],
  "a partnership or deal in progress": ["partner", "partnering", "partnership", "deal", "sponsor", "sponsoring", "collab", "collaboration"],
};
export const PHOTO_LINE_CHARS = 90;
export const EXCERPTS_TITLE = "Earlier, in their own words (matched to these deck lines, each with how long ago they said it):";

// Pure: each photo description as one short line. The two ways a photo is written into their words (routes/sendblue.ts): a photo on
// its own ("[sent a photo showing: ...] (saved as their image #3)") and one sent with text (" [They also sent a photo. It shows:
// .... Saved as their image #3]").
const oneShort = (d: string) => {
  const flat = d.replace(/\s+/g, " ").trim();
  return flat.length > PHOTO_LINE_CHARS ? `${sliceSafe(flat, PHOTO_LINE_CHARS - 3).replace(/\s+\S*$/, "")}...` : flat;
};
export function shortPhotos(text: string): string {
  return text
    .replace(/\[sent a photo showing: ([\s\S]*?)\](?=(?: \(saved as their image #\d+\))?(?:\n|$))/g, (_m, d: string) => `[sent a photo: ${oneShort(d)}]`)
    .replace(/ \[They also sent a photo\. It shows: ([\s\S]*?)(\. Saved as their image #\d+)?\](?=\s*(?:\[|\n|$))/g, (_m, d: string, saved: string | undefined) => ` [They also sent a photo: ${oneShort(d)}${saved ?? ""}]`);
}

// ---------------------------------------------------------------- matching a line to their words
const STOP = new Set(
  "about above after again against almost already also always among another around because been before being between both cannot could does doing done down during each either else even ever every first from further have having here into itself just keep kind like make many might more most much must never next only other over really right same should since some still such take than that their them then there these they thing things think this those through today under until upon very want well were what when where which while will with within without would your yours you're they're that's it's don't doesn't people every thing where while built build building real really great better best part point show shows something nothing everything".split(" "),
);
const NOT_NAMES = new Set("the a an and or but our your their my we you they it this that these those not no yes why how what when where who for with from into onto at by of in on to is are was be".split(" "));
export type LineKeys = { names: string[]; numbers: string[]; topics: string[]; clusters: string[] };
const clustersIn = (text: string): string[] => {
  const t = ` ${text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z' -]+/g, " ").replace(/\s+/g, " ")} `;
  return Object.entries(CHANGEABLE).filter(([, ws]) => ws.some((w) => t.includes(` ${w} `) || t.includes(` ${w}s `) || t.includes(` ${w}, `))).map(([k]) => k);
};
// Pure: the names (capitalized words after the first, and acronyms), numbers and topic words (first five letters of a longer word)
// of a line.
export function lineKeys(line: string): LineKeys {
  const toks = line.replace(/[’‘]/g, "'").split(/\s+/).map((w) => w.replace(/^[("'“\[]+|[)"'”\].,!?;:]+$/g, "")).filter(Boolean);
  const names = new Set<string>();
  toks.forEach((w, i) => {
    const bare = w.replace(/'s$/i, "");
    if (/^[A-Z]{2,}$/.test(bare) || (i > 0 && /^[A-Z][a-z]/.test(bare))) if (!NOT_NAMES.has(bare.toLowerCase())) names.add(bare.toLowerCase());
  });
  const numbers = new Set((line.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/,/g, "")));
  const topics = new Set(
    line
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z' -]+/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length >= 5 && !STOP.has(w) && !names.has(w))
      .map((w) => w.slice(0, 5)),
  );
  return { names: [...names], numbers: [...numbers], topics: [...topics], clusters: clustersIn(line) };
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Pure: how much a text shares with a line's keys: a name, a number or a shared changeable topic (a paraphrase cluster) 3 each, a
// topic word 1. The judge decides what the words mean; this only picks which of their words it reads.
export function relevance(text: string, k: LineKeys): number {
  const t = text.toLowerCase();
  let s = 0;
  for (const n of k.names) if (new RegExp(`(?<![a-z0-9])${esc(n)}(?![a-z0-9])`).test(t)) s += 3;
  for (const n of k.numbers) if (new RegExp(`(?<![0-9])${esc(n)}(?![0-9])`).test(t)) s += 3;
  const words = new Set(t.replace(/[^a-z' -]+/g, " ").split(/[\s-]+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
  for (const p of k.topics) if (words.has(p)) s += 1;
  if (k.clusters.length) {
    const has = new Set(clustersIn(text));
    for (const c of k.clusters) if (has.has(c)) s += 3;
  }
  return s;
}

// Pure: goals ordered by how much they share with the deck's lines (all lines together), ties kept in their stored order.
export function byRelevance(goals: string[], lines: string[]): string[] {
  if (!lines.length) return goals;
  const keys = lines.map(lineKeys);
  const score = (g: string) => keys.reduce((s, k) => s + relevance(g, k), 0);
  return goals.map((g, i) => ({ g, i, s: score(g) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.g);
}

export type HistoryRow = { at: string; text: string };
// Pure: the best sentence (and the one after it, when short) of a row for a line, cut to the excerpt size.
function excerptOf(text: string, k: LineKeys): string {
  const flat = shortPhotos(text).replace(/\s+/g, " ").trim();
  const sents = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  let best = 0;
  let at = 0;
  sents.forEach((s, i) => {
    const r = relevance(s, k);
    if (r > best) { best = r; at = i; }
  });
  let out = sents[at] ?? flat;
  if (out.length < 120 && sents[at + 1]) out = `${out} ${sents[at + 1]}`;
  return out.length > JUDGE_WORDS.excerptChars ? `${sliceSafe(out, JUDGE_WORDS.excerptChars - 3).replace(/\s+\S*$/, "")}...` : out;
}
// Pure: the excerpts from their whole history that match the lines: per line, its best rows (score at least minScore, newest first
// among equals), taken a line at a time so every line gets its share, within the excerpt budget. Oldest first in the block.
export function matchedExcerpts(lines: string[], history: HistoryRow[], skip = ""): HistoryRow[] {
  const picked = new Map<number, HistoryRow>();
  const ranked = lines.map((l) => {
    const k = lineKeys(l);
    return { k, rows: history.map((h, i) => ({ i, s: relevance(shortPhotos(h.text), k) })).filter((x) => x.s >= JUDGE_WORDS.minScore).sort((a, b) => b.s - a.s || b.i - a.i) };
  });
  let used = 0;
  for (let round = 0; round < JUDGE_WORDS.perLine; round++) {
    for (const r of ranked) {
      const next = r.rows.find((x) => !picked.has(x.i));
      if (!next) continue;
      const text = excerptOf(history[next.i].text, r.k);
      r.rows = r.rows.filter((x) => x.i !== next.i);
      // Already in their newest words, as read: no need to repeat it.
      if (skip && skip.includes(text.replace(/\.\.\.$/, "").slice(0, 80))) continue;
      const cost = text.length + 16;
      if (used + cost > JUDGE_WORDS.excerpts) continue;
      picked.set(next.i, { at: history[next.i].at, text });
      used += cost;
    }
  }
  return [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

// Pure: how long ago, as the judge reads it: "today", "12 days ago" (under 90 days, so the 60-day line is exact), "4 months ago".
export function ageOf(at: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return "said today";
  if (days === 1) return "said 1 day ago";
  if (days < 90) return `said ${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `said ${months} months ago` : `said ${Math.floor(days / 365)} years ago`;
}
export const NEWEST_TITLE = "Their newest words, newest first:";
// Pure: their words as the judge reads them: the matched excerpts first, each with its age ("[said 4 months ago]"), then their newest
// words (newest first, as given), photos cut short in both, all within JUDGE_WORDS.total. newest: their recent words, newest first.
// history: every text and call line of theirs, oldest first, with when. now: the moment the deck is judged.
export function judgeWords(lines: string[], newest: string, history: HistoryRow[], now: Date = new Date()): string {
  const recent = shortPhotos(newest);
  const ex = matchedExcerpts(lines, history, sliceSafe(recent, JUDGE_WORDS.total - JUDGE_WORDS.excerpts));
  if (!ex.length) return sliceSafe(recent, JUDGE_WORDS.total);
  const block = `${EXCERPTS_TITLE}\n${ex.map((e) => `- [${ageOf(e.at, now)}] ${e.text}`).join("\n")}\n\n${NEWEST_TITLE}\n`;
  return sliceSafe(`${block}${recent}`, JUDGE_WORDS.total);
}
