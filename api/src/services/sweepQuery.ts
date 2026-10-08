// What a sweep query may be (Royce, 2026-10-08): the best result set a search engine can return, never a description of the member.
//   1. The member is stripped out: no name, no company or partner, nothing like "for someone building a private social club". The
//      query names the THING, at the specificity a good researcher would type ("SF AI founder events November"). Who they are is
//      used after the results come back, to judge fit, never inside the query.
//   2. Recall first: broad enough to catch the good stuff, narrowed only by constraints that filter (city, dates, category). More
//      than four content words (city, dates and search operators don't count) and it's too tight: simplify.
//   3. Source-aware: X reads like what people post ("AI founders SF tonight", event names, hashtags); the web like the titles of
//      pages that list the thing ("SF tech events November 2026"). The same string never goes to both.
//   4. Every query is logged next to every keep and every pass (sweepFind.ts, sweep.find `queries`): the tuning data.
// Pure; the sweep's tools refuse a query that breaks these (it isn't run and costs no budget) and Co rewrites it.

export const QUERY_LIMITS = { contentWords: 4 } as const;

// Words that only constrain (where, when) or are search syntax: they don't count toward the four.
const CONSTRAINT = new Set([
  "sf", "san", "francisco", "bay", "area", "oakland", "berkeley", "nyc", "la", "london", "online", "virtual", "remote",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "weekend", "weekday", "weekdays", "weekends",
  "today", "tonight", "tomorrow", "this", "next", "week", "month", "fall", "spring", "summer", "winter",
  "or", "and", "not", "is", "retweet", "lang", "en", "has", "links",
]);
const STOP = new Set(["the", "a", "an", "of", "for", "in", "on", "at", "to", "with", "by", "from", "near", "around", "about", "&", "-", "vs"]);
// Acronyms and words that name a category, never a member.
const GENERIC = new Set(["AI", "ML", "VC", "VCs", "YC", "SaaS", "B2B", "B2C", "DJ", "NYC", "SF", "LA", "US", "UK", "CEO", "CTO", "API", "LLM", "AR", "VR", "IRL", "DAO", "NFT", "PhD", "MBA", "OR", "AND", "NOT", "Co-working"]);
const MONTHS_DAYS = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|San|Francisco|Bay|Area|Oakland|Berkeley|Tech|Week|I|The|A|An)$/;

// Pure: the words that would identify this member in a query: their name, Co itself, and the proper names in their own goals and
// work (their company, partners, the people they work with). A name in the ask itself is the thing being found, so it isn't here.
// except: what is being found (the ask, the edges): a name in it (a neighborhood, a program) is the thing, not them.
export function memberTerms(o: { firstName?: string | null; lastName?: string | null; goals?: (string | null | undefined)[] | null; work?: string | null; except?: string | null }): string[] {
  const out = new Set<string>(["Co", "CoPatible"]);
  for (const n of [o.firstName, o.lastName]) if (n && n.trim().length > 1 && n.trim().toLowerCase() !== "them") out.add(n.trim());
  for (const text of [...(o.goals ?? []), o.work ?? ""]) {
    for (const m of String(text ?? "").matchAll(/\b([A-Z][\w&'.-]*(?:\s+(?:of|the|&|[A-Z][\w&'.-]*))*)/g)) {
      const phrase = m[1].replace(/\s+(?:of|the|&)$/i, "").trim();
      const parts = phrase.split(/\s+/).filter((w) => !MONTHS_DAYS.test(w) && !GENERIC.has(w));
      if (!parts.length) continue;
      // A goal's first word is capitalized because it starts the sentence ("Partnering", "Find"): only names count, so a lone
      // sentence-initial word that's an ordinary lowercase word elsewhere is not a name.
      if (m.index === 0 && phrase.split(/\s+/).length === 1) continue;
      out.add(phrase);
    }
  }
  const thing = String(o.except ?? "").toLowerCase();
  return [...out].filter((t) => t.length > 1 && !(thing && !["co", "copatible"].includes(t.toLowerCase()) && thing.includes(t.toLowerCase())));
}

// Phrases that describe the member instead of the thing.
const ABOUT_THEM = /\b(?:for|by) (?:someone|a member|members|people|a founder|founders) (?:who|building|running|starting|launching)\b|\b(?:my|our|their) (?:startup|company|club|app|event|launch|brand|team)\b|\bprivate social club\b|\bsocial club (?:agent|platform|app)\b/i;

const tokens = (q: string) => q.replace(/[()"]/g, " ").split(/\s+/).filter(Boolean);

// Terms people search as one concept ("open calls", "applications open"): one word each.
const PHRASES = /\b(open calls?|applications? (?:open|due)|call for (?:speakers|applications|proposals)|demo (?:days?|nights?)|pitch (?:nights?|competitions?)|office hours|happy hours?|speaker slots?|run clubs?|book clubs?|supper clubs?|dinner series|co-?working spaces?|event spaces?|private dining|tech week)\b/gi;

// Pure: the words that narrow a query by what it is (not where or when). A parenthesized OR group is one concept, and so is a
// term people search as one ("open calls").
export function contentWords(q: string): string[] {
  const grouped = q.replace(/\(([^)]*\bOR\b[^)]*)\)/gi, (_m, g: string) => ` ${g.split(/\s+OR\s+/i)[0].trim().replace(/\s+/g, "_")} `).replace(PHRASES, (m) => m.replace(/\s+/g, "_"));
  return tokens(grouped)
    .map((w) => w.replace(/^[-#@]+/, (p) => (p.startsWith("#") ? "#" : "")).replace(/[,.;:!?]+$/, ""))
    .filter((w) => w && !/^-?\w+:\w+$/.test(w) && !/^\d{1,4}$/.test(w) && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(w))
    .filter((w) => !STOP.has(w.toLowerCase()) && !CONSTRAINT.has(w.toLowerCase().replace(/^#/, "")));
}

const norm = (q: string) => tokens(q.toLowerCase()).map((w) => w.replace(/[^a-z0-9#]/g, "")).filter((w) => w && !STOP.has(w) && !CONSTRAINT.has(w) && !/^\w+:\w+$/.test(w));
// Pure: two queries are the same string for this rule when their meaningful words are nearly the same set.
export function samePhrasing(a: string, b: string): boolean {
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size >= 0.8;
}

export type QuerySource = "web" | "x" | "events";

// Pure: what's wrong with a query, in words Co can act on. Empty: it may run.
export function queryProblems(q: string, o: { terms: string[]; source: QuerySource; otherSourceQueries?: string[] }): string[] {
  const out: string[] = [];
  const text = q.trim();
  if (!text) return ["it's empty"];
  const hits = o.terms.filter((t) => new RegExp(`(^|[^\\w])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\w])`, t.length <= 3 ? "" : "i").test(text));
  if (hits.length) out.push(`it names the member or their own work (${hits.slice(0, 3).join(", ")}): describe the thing being found, not them`);
  if (ABOUT_THEM.test(text)) out.push("it describes the member: describe the thing being found; who they are is for judging the results");
  // Events search matches meaning, not keywords: only the member rule applies to it.
  if (o.source !== "events") {
    const cw = contentWords(text);
    if (cw.length > QUERY_LIMITS.contentWords) out.push(`it's too tight (${cw.length} content words, at most ${QUERY_LIMITS.contentWords}; city and dates don't count): keep only what really filters`);
    const twin = (o.otherSourceQueries ?? []).find((x) => samePhrasing(x, text));
    if (twin) out.push(o.source === "x" ? `it's the same as the web query "${twin}": write it the way posts read (event names, hashtags, "tonight")` : `it's the same as the X query "${twin}": write it the way page titles read`);
  }
  return out;
}

// What the sweep is told about writing queries.
export const SWEEP_QUERY_RULES = `How to write searches: each query names the thing being found, never them. No names (theirs, their company, partners or people), nothing like "for someone building a startup"; who they are is for judging what comes back. Aim for recall: a few words, narrowed only by what really filters (city, dates, category); more than four words besides city and dates is too tight. Write for the source: X like what people post ("AI founders SF tonight", an event name, a hashtag); the web like the title of a page that lists the thing ("SF tech events November 2026", "pre-seed founder programs applications open"). Never send the same words to both. A query that breaks this comes back with what to fix and costs nothing.`;

// ---------- the sweep's query ledger: every query checked, run or refused, and logged beside what became of its results

export type LedgerSource = QuerySource;
export type QueryLog = { source: LedgerSource; query: string; results: number; kept: number; passed: number; refused?: string[] };
export type Looked = { source: LedgerSource; url: string; query?: string };

export class QueryLedger {
  readonly queries: QueryLog[] = [];
  constructor(private terms: string[]) {}
  private asked(source: LedgerSource): string[] {
    return this.queries.filter((x) => x.source === source && !x.refused).map((x) => x.query);
  }
  // Problems for a query before it runs (it's refused and logged when there are any). X and web are checked against each other.
  check(source: LedgerSource, query: string): string[] {
    const other = source === "x" ? this.asked("web") : source === "web" ? this.asked("x") : [];
    const bad = queryProblems(query, { terms: this.terms, source, otherSourceQueries: other });
    if (bad.length) this.queries.push({ source, query: query.slice(0, 200), results: 0, kept: 0, passed: 0, refused: bad });
    return bad;
  }
  refusal(query: string, bad: string[]): string {
    return `Not searched: "${query.slice(0, 120)}" ${bad.join("; ")}. Rewrite it and search again; it cost nothing.`;
  }
  ran(source: LedgerSource, query: string, results: number): void {
    this.queries.push({ source, query: query.slice(0, 200), results, kept: 0, passed: 0 });
  }
  // After the sweep: each query's kept and passed counts, and each keep with the query that found it.
  finish(looked: Looked[], keptUrls: Set<string>, keptItems: { name: string; url: string }[], viaPost: Map<string, string> = new Map()) {
    const queryOf = new Map<string, { source: LedgerSource; query: string }>();
    for (const l of looked) if (l.query && !queryOf.has(l.url)) queryOf.set(l.url, { source: l.source, query: l.query });
    for (const q of this.queries) {
      if (q.refused) continue;
      const mine = new Set(looked.filter((l) => l.source === q.source && l.query === q.query).map((l) => l.url));
      q.kept = [...mine].filter((u) => keptUrls.has(u)).length;
      q.passed = [...mine].filter((u) => !keptUrls.has(u)).length;
    }
    const keptBy = keptItems.map((k) => {
      const via = queryOf.get(k.url) ?? queryOf.get(viaPost.get(k.url) ?? "") ?? null;
      return { name: k.name, url: k.url, source: via?.source ?? null, query: via?.query ?? null };
    });
    return { queries: this.queries, keptBy };
  }
}
