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

export const JUDGE_WORDS = { total: 6000, excerpts: 4000, excerptChars: 240, perLine: 3, minScore: 3 } as const;
// An excerpt older than this, about something that changes, doesn't settle a line (Royce, 2026-10-18: "an old fact that may have
// changed"); the judge reads the age on each excerpt and says so (coPages/deckClaims.ts EXCERPT_RULES).
export const OLD_FACT_DAYS = 60;
// What changes: the topics where something said months ago may no longer hold. Each is also a paraphrase cluster for matching: a line
// and an excerpt that share a cluster are matched even with no word in common ("Bootstrapped" and "no outside funding").
export const CHANGEABLE: Record<string, string[]> = {
  "funding stage or raise": ["bootstrap", "self-fund", "unfunded", "funding", "funded", "fund", "raise", "raising", "raised", "investor", "investment", "seed", "pre-seed", "preseed", "angel", "vc", "capital", "round", "series", "grant", "accelerator"],
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
// A cluster word of five letters or more matches any word it starts ("bootstrap": bootstrapped, bootstrapping); a shorter one matches
// only itself or its plural ("vc", "vcs"); a phrase matches as written ("live in").
const clustersIn = (text: string): string[] => {
  const flat = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z' -]+/g, " ").replace(/\s+/g, " ");
  const t = ` ${flat} `;
  const toks = flat.split(/[\s]+/).filter(Boolean);
  const hit = (w: string) => (w.includes(" ") ? t.includes(` ${w} `) : w.length >= 5 ? toks.some((x) => x.startsWith(w)) : toks.some((x) => x === w || x === `${w}s`));
  return Object.entries(CHANGEABLE).filter(([, ws]) => ws.some(hit)).map(([k]) => k);
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
// How much a line needs backing: a number or something that changes first (the facts a judge refuses most), then a name, then a stance.
const factual = (k: LineKeys) => (k.numbers.length || k.clusters.length ? 2 : k.names.length ? 1 : 0);
export const RARE_BONUS = 3;
// Pure: the best sentence (and the one after it, when short) of a row for a line, cut to the excerpt size.
// rare: the line's topic words they rarely use (matchedExcerpts), weighted the same way here, so a long call shows the sentence with
// "bootstrapping" in it, not a sentence about funding in general.
const stemsOf = (t: string) => new Set(t.toLowerCase().replace(/[^a-z' -]+/g, " ").split(/[\s-]+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
function excerptOf(text: string, k: LineKeys, rare: string[] = []): string {
  const flat = shortPhotos(text).replace(/\s+/g, " ").trim();
  const sents = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  let best = 0;
  let at = 0;
  sents.forEach((s, i) => {
    const st = rare.length ? stemsOf(s) : null;
    const r = relevance(s, k) + (st ? rare.reduce((n, p) => n + (st.has(p) ? RARE_BONUS : 0), 0) : 0);
    if (r > best) { best = r; at = i; }
  });
  let out = sents[at] ?? flat;
  if (out.length < 120 && sents[at + 1]) out = `${out} ${sents[at + 1]}`;
  return out.length > JUDGE_WORDS.excerptChars ? `${sliceSafe(out, JUDGE_WORDS.excerptChars - 3).replace(/\s+\S*$/, "")}...` : out;
}
// Pure: the excerpts from their whole history that match the lines: per line, its best rows (score at least minScore, newest first
// among equals), a round at a time, strongest first, so every line gets its share, within the excerpt budget. Oldest first in the block.
export function matchedExcerpts(lines: string[], history: HistoryRow[], skip = ""): HistoryRow[] {
  // Keyed by the excerpt itself: one row can back two lines with two different sentences.
  const picked = new Map<string, { i: number; row: HistoryRow }>();
  const texts = history.map((h) => shortPhotos(h.text));
  const stems = texts.map(stemsOf);
  // A topic word they rarely use is the one that finds the row ("bootstrapped" in one call among 500 rows about funding): it counts
  // RARE_BONUS more where it appears in at most 1% of their rows (3 at least).
  const rareLimit = Math.max(3, Math.floor(history.length * 0.01));
  const ranked = lines.map((l) => {
    const k = lineKeys(l);
    // The rarer the word, the more it counts: RARE_BONUS, plus one for each row fewer than the limit it appears in.
    const df = new Map(k.topics.map((p) => [p, stems.reduce((n, s) => n + (s.has(p) ? 1 : 0), 0)]));
    const rare = k.topics.filter((p) => (df.get(p) ?? 0) <= rareLimit);
    const bonus = (p: string) => RARE_BONUS + Math.max(0, rareLimit - (df.get(p) ?? 0));
    // A row scores as its best sentence does: what the judge will be shown, not words scattered across a long call.
    const sentScore = (t: string) => {
      const st = rare.length ? stemsOf(t) : null;
      return relevance(t, k) + (st ? rare.reduce((n, p) => n + (st.has(p) ? bonus(p) : 0), 0) : 0);
    };
    const score = (i: number) => {
      if (!k.names.some((n) => texts[i].toLowerCase().includes(n)) && !k.numbers.some((n) => texts[i].includes(n)) && !k.topics.some((p) => stems[i].has(p)) && !k.clusters.length) return 0;
      const sents = texts[i].replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
      return Math.max(0, ...sents.map(sentScore));
    };
    return { k, rare, rows: history.map((_h, i) => ({ i, s: score(i) })).filter((x) => x.s >= JUDGE_WORDS.minScore).sort((a, b) => b.s - a.s || b.i - a.i) };
  });
  let used = 0;
  // Each round, every line puts forward its best row not yet taken, and the strongest matches go first: a deck of 25 lines can't fill
  // the budget with weak matches before a strong one is reached (Royce's real deck: the "bootstrapping" call came 20th in line order).
  for (let round = 0; round < JUDGE_WORDS.perLine; round++) {
    const offers = ranked
      .map((r) => ({ r, next: r.rows[0] }))
      .filter((o): o is { r: (typeof ranked)[number]; next: { i: number; s: number } } => !!o.next)
      // Lines that state something checkable (a name, a number, a changeable topic) first: those are the ones a judge refuses; a
      // stance needs no backing.
      .sort((a, b) => factual(b.r.k) - factual(a.r.k) || b.next.s - a.next.s || b.next.i - a.next.i);
    for (const { r, next } of offers) {
      const text = excerptOf(history[next.i].text, r.k, r.rare);
      r.rows = r.rows.filter((x) => x.i !== next.i);
      if (picked.has(text)) continue;
      // Already in their newest words, as read: no need to repeat it.
      if (skip && skip.includes(text.replace(/\.\.\.$/, "").slice(0, 80))) continue;
      const cost = text.length + 16;
      if (used + cost > JUDGE_WORDS.excerpts) continue;
      picked.set(text, { i: next.i, row: { at: history[next.i].at, text } });
      used += cost;
    }
  }
  return [...picked.values()].sort((a, b) => a.i - b.i).map((v) => v.row);
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
