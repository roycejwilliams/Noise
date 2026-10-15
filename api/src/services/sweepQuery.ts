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
import { avoidHits } from "./memberLimits.js";

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
// Everyday words for kinds of things and people, which goals capitalize for emphasis. Never a member's name.
const COMMON = new Set(["event", "events", "founder", "founders", "investor", "investors", "builder", "builders", "club", "clubs", "book", "books", "community", "communities", "meetup", "meetups", "dinner", "dinners", "party", "parties", "launch", "night", "nights", "group", "groups", "team", "teams", "people", "tech", "startup", "startups", "conference", "summit", "demo", "day", "hike", "hikes", "hiking", "run", "running", "climbing", "yoga", "wellness", "art", "arts", "music", "design", "product", "engineers", "engineering", "creators", "friends", "friend", "network", "networking", "program", "programs", "cohort", "fellowship", "residency", "grant", "grants", "accelerator", "venue", "venues", "space", "spaces", "social", "supper", "series", "salon", "workshop", "workshops", "class", "classes", "hackathon", "mixer", "mixers", "brand", "branding", "strategy", "partnership", "partner", "partners", "presence", "users", "customers", "funding", "round", "seed", "pre-seed", "series", "angel", "angels", "mentor", "mentors", "advisor", "advisors", "talent", "hiring", "sales", "marketing", "growth", "fitness", "running", "cycling", "tennis", "golf", "food", "wine", "coffee", "travel", "photography", "writing", "reading", "film", "theater", "comedy", "dance", "fashion", "climate", "health", "crypto", "web3", "gaming", "sports"]);
const MONTHS_DAYS = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|San|Francisco|Bay|Area|Oakland|Berkeley|Tech|Week|I|The|A|An)$/;
// Words a goal sentence starts with ("Get Co in front of users", "Launch the Oct 10 night"): capitalized by position, not names.
const STARTERS = /^(?:get|getting|launch|launching|find|finding|build|building|raise|raising|have|has|make|keep|maintain|maintaining|start|starting|host|hosting|plan|planning|meet|meeting|hire|grow|partner|partnering|connect|connected|connecting|looking|want|wants|help|ship|close|land|learn|move|pivot|pivoting|create|write|draft|run|join|go|do|be|become|stay|throw|organize|explore|figure|work|working|shifting|focus|focusing|offering|seeking|my|our|a|an|the|i|we|to|for|with|after|before|by|in|on|at)$/i;

// Pure: the words that would identify this member in a query: their name, Co itself, and the proper names in their own goals and
// work (their company, partners, the people they work with). A name in the ask itself is the thing being found, so it isn't here.
// except: what is being found (the ask, the edges): a name in it (a neighborhood, a program) is the thing, not them.
export function memberTerms(o: { firstName?: string | null; lastName?: string | null; goals?: (string | null | undefined)[] | null; work?: string | null; except?: string | null }): string[] {
  const out = new Set<string>(["Co", "CoPatible"]);
  for (const n of [o.firstName, o.lastName]) if (n && n.trim().length > 1 && n.trim().toLowerCase() !== "them") out.add(n.trim());
  for (const text of [...(o.goals ?? []), o.work ?? ""]) {
    for (const m of String(text ?? "").matchAll(/\b([A-Z][\w&'.-]*(?:\s+(?:of|the|&|[A-Z][\w&'.-]*))*)/g)) {
      let words = m[1].split(/\s+/);
      // A sentence's first word is capitalized because it starts the sentence ("Get Co…", "Launch the Oct 10…"), not because it's a name.
      const before = String(text ?? "").slice(0, m.index ?? 0);
      if ((!before.trim() || /[.!?:;]\s*$/.test(before)) && STARTERS.test(words[0])) words = words.slice(1);
      while (words.length && /^(?:of|the|&)$/i.test(words[0])) words = words.slice(1);
      while (words.length && /^(?:of|the|&)$/i.test(words[words.length - 1])) words = words.slice(0, -1);
      const parts = words.filter((w) => !MONTHS_DAYS.test(w) && !GENERIC.has(w) && !/^\d/.test(w));
      if (!parts.length || parts.every((w) => /^(?:Co|CoPatible)$/.test(w))) continue;
      // A capitalized category word ("Host Events", "AI Founders", "a Book Club") is not a name (review of #107): a term needs at
      // least one word that isn't an everyday category word.
      if (parts.every((w) => COMMON.has(w.toLowerCase().replace(/'s$/, "")))) continue;
      out.add(words.join(" "));
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
// Who someone is (gender, age bracket, faith, ethnicity, sexuality, parenthood) is never assumed in a search (Royce, 2026-10-09: "drop my
// guard" was searched as "men's circle vulnerability sharing"). A group word goes in a query only when their own ask says it.
const IDENTITY_TERMS = /\b(?:men'?s|women'?s|women|woman|men|male|female|mens|womens|guys?'?|girls?'?|ladies|moms?|mothers?|dads?|fathers?|parents?|gay|lesbian|queer|lgbtq\+?|trans|black|latin[oax]s?|latine|asian|christian|muslim|jewish|catholic|seniors?|20s|30s|40s|50s|twenty-?somethings|millennials?|gen z|veterans?)\b/gi;
// Phrases where a group word is part of a thing, not a person (review of #133: "black tie gala", "parent company", "trans-Pacific",
// "Mothers Day" were refused).
const NOT_ABOUT_PEOPLE = /\b(?:black[\s-]tie|parent company|trans[\s-]?pacific|trans[\s-]?atlantic|(?:mother|father|parent)s?'?\s+day|black\s+friday|senior\s+(?:engineer|designer|manager|developer|pm)|20s\s+(?:style|theme|party))\b/gi;
// A capitalized group word inside the name of a place or institution ("Asian Art Museum", "Contemporary Jewish Museum", "Veterans
// Building", "Women's Building"): the name ends, within two more capitalized words, in a word for a place. Capitals alone aren't a
// venue (re-review of #133: "Black Women In Tech Summit", "Queer Film Fest" passed in Title Case). A name with two group words in it
// ("Gay Men's Chorus Hall", "Asian Women Founders Park") is about people, not a place (Phase A, the re-review's low finding).
const PLACE_RE = "(?:\\s+[A-Z][\\w'&.-]*){0,2}?\\s+(?:Building|Hall|Museum|Center|Centre|Theater|Theatre|Library|College|University|Institute|Gallery|Park|Plaza|Square|Street|Cathedral|Memorial|Auditorium|Pavilion|Opera House)\\b";
const PLACE = new RegExp(`^${PLACE_RE}`);
function inProperName(query: string, index: number, length: number): boolean {
  if (!/^[A-Z]/.test(query.slice(index, index + length))) return false;
  const rest = query.slice(index + length).match(PLACE);
  if (!rest) return false;
  // The words from this one to the place word, and any capitalized words right before it: one group word at most.
  const lead = query.slice(0, index).match(/(?:[A-Z][\w'&.-]*\s+)*$/)?.[0] ?? "";
  const name = `${lead}${query.slice(index, index + length)}${rest[0]}`;
  return (name.match(IDENTITY_TERMS) ?? []).length <= 1;
}
export function assumedIdentity(query: string, theirWords: string): string[] {
  const cleaned = query.replace(NOT_ABOUT_PEOPLE, (m) => " ".repeat(m.length));
  const base = (w: string) => w.replace(/\+$/, "").replace(/'?s$/, "");
  const said = new Set((theirWords.toLowerCase().match(/[a-z0-9'+-]+/g) ?? []).map(base));
  const out = new Set<string>();
  for (const m of cleaned.matchAll(IDENTITY_TERMS)) {
    if (inProperName(query, m.index ?? 0, m[0].length)) continue;
    const w = m[0].toLowerCase();
    // Whole words only (review of #133: "men's" passed because "mentor" contained "men").
    if (!said.has(base(w))) out.add(w);
  }
  return [...out];
}

export function queryProblems(q: string, o: { terms: string[]; source: QuerySource; otherSourceQueries?: string[]; theirWords?: string; avoid?: string[] }): string[] {
  const out: string[] = [];
  const text = q.trim();
  if (!text) return ["it's empty"];
  // A kind they told Co to stop suggesting is never searched for (services/memberLimits.ts; Phase A2). The list passed here is already
  // the one for this ask (avoidFor): a kind the ask names is theirs again.
  const ruledOut = o.avoid?.length ? avoidHits(text, o.avoid) : [];
  if (ruledOut.length) out.push(`it looks for ${ruledOut.map((k) => `"${k}"`).join(", ")}, which they told Co to stop suggesting: search for something else they want`);
  const assumed = o.theirWords !== undefined ? assumedIdentity(text, o.theirWords) : [];
  if (assumed.length) out.push(`it assumes who they are (${assumed.join(", ")}), which their ask doesn't say: search for the thing itself`);
  // Whole words only, never inside a hyphenated word ("Co" is not in "co-working"). A one-word term matches case as written (a name
  // is capitalized; "events" is not "Events"); a longer one matches in any case.
  const hits = o.terms.filter((t) => new RegExp(`(^|[^\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\w-])`, /\s/.test(t) ? "i" : "").test(text));
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
export const SWEEP_QUERY_RULES = `How to write searches: each query names the thing being found, never them. No names (theirs, their company, partners or people), nothing like "for someone building a startup"; who they are is for judging what comes back. Aim for recall: a few words, narrowed only by what really filters (city, dates, category); more than four words besides city and dates is too tight. Write for the source: X like what people post ("AI founders SF tonight", an event name, a hashtag); the web like the title of a page that lists the thing ("SF tech events November 2026", "pre-seed founder programs applications open"). Never send the same words to both. A query that's only too long runs loosened to its first four words besides city and dates, so put what filters most first; anything else that breaks this comes back with what to fix and costs nothing.`;

// Pure: a query too tight for its source, loosened (Royce, 2026-10-15: "a query over 4 key words gets auto-loosened and retried once,
// not refused"): the first QUERY_LIMITS.contentWords key words in the order Co wrote them, with everything that isn't a key word
// (the city, dates, operators) kept. An OR group or a term searched as one ("open calls") counts as one word, as in contentWords.
export function loosenQuery(q: string, max: number = QUERY_LIMITS.contentWords, keep: string[] = []): string {
  const marked = q.replace(PHRASES, (m) => m.replace(/\s+/g, "\u0001"));
  const segs = marked.match(/\([^)]*\)|"[^"]*"|\S+/g) ?? [];
  // Never loosened away: an exclusion ("-crypto") and the words of where it's searched (their want's place or city).
  const kept_ = new Set(keep.flatMap((k) => k.toLowerCase().split(/[\s,]+/)).filter(Boolean));
  let n = 0;
  const kept = segs.filter((seg) => {
    if (/^-\S/.test(seg) || kept_.has(seg.toLowerCase().replace(/[,.;:]+$/, ""))) return true;
    if (!contentWords(seg.replace(/\u0001/g, " ")).length) return true;
    n++;
    return n <= max;
  });
  return kept.join(" ").replace(/\u0001/g, " ").replace(/\s+/g, " ").trim();
}
const TOO_TIGHT = /^it's too tight \(/;

// ---------- the sweep's query ledger: every query checked, run or refused, and logged beside what became of its results

export type LedgerSource = QuerySource;
// loosenedFrom: the query as Co wrote it, when it was too tight and ran loosened (loosenQuery), so a lost find is never invisible.
export type QueryLog = { source: LedgerSource; query: string; results: number; kept: number; passed: number; refused?: string[]; loosenedFrom?: string };
export type Looked = { source: LedgerSource; url: string; query?: string };

export class QueryLedger {
  readonly queries: QueryLog[] = [];
  // theirWords: the ask, in their words: the only source a group word in a query may come from (assumedIdentity).
  // avoid: the kinds they ruled out that apply to this ask (services/memberLimits.ts avoidFor).
  constructor(private terms: string[], private theirWords?: string, private avoid: string[] = []) {}
  private asked(source: LedgerSource): string[] {
    return this.queries.filter((x) => x.source === source && !x.refused).map((x) => x.query);
  }
  // Problems for a query before it runs (it's refused and logged when there are any). X and web are checked against each other.
  check(source: LedgerSource, query: string): string[] {
    const other = source === "x" ? this.asked("web") : source === "web" ? this.asked("x") : [];
    const bad = queryProblems(query, { terms: this.terms, source, otherSourceQueries: other, theirWords: this.theirWords, avoid: this.avoid });
    if (bad.length) this.queries.push({ source, query: query.slice(0, 200), results: 0, kept: 0, passed: 0, refused: bad });
    return bad;
  }
  // A query whose only problem is that it's too tight runs loosened, once (loosenQuery), and is logged with what Co wrote. Anything
  // else wrong with it is refused as before (check).
  checkOrLoosen(source: LedgerSource, query: string, keep: string[] = []): { query: string; bad: string[]; loosenedFrom?: string } {
    const other = source === "x" ? this.asked("web") : source === "web" ? this.asked("x") : [];
    const problems = (q: string) => queryProblems(q, { terms: this.terms, source, otherSourceQueries: other, theirWords: this.theirWords, avoid: this.avoid });
    const bad = problems(query);
    if (bad.length === 1 && TOO_TIGHT.test(bad[0])) {
      const loose = loosenQuery(query, QUERY_LIMITS.contentWords, keep);
      if (loose && loose !== query && !problems(loose).length) return { query: loose, bad: [], loosenedFrom: query.slice(0, 200) };
    }
    if (bad.length) this.queries.push({ source, query: query.slice(0, 200), results: 0, kept: 0, passed: 0, refused: bad });
    return { query, bad };
  }
  refusal(query: string, bad: string[]): string {
    return `Not searched: "${query.slice(0, 120)}" ${bad.join("; ")}. Rewrite it and search again; it cost nothing.`;
  }
  ran(source: LedgerSource, query: string, results: number, loosenedFrom?: string): void {
    this.queries.push({ source, query: query.slice(0, 200), results, kept: 0, passed: 0, ...(loosenedFrom ? { loosenedFrom } : {}) });
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
