// Search quality (services/researchQuality.ts): zero tokens.
//   npx tsx evals/research/quality.ts
// The four pieces: query assembly from member state, unknown fields staying unknown, freshness re-check triggers, and outcome
// recording feeding ranking.
import { readFileSync } from "node:fs";
const Q = await import("../../src/services/researchQuality.js");
const RB = await import("../../src/services/researchBrief.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ---- 1. the query, from member state
const state = (o: Partial<import("../../src/services/researchQuality.js").MemberSearchState> = {}) => ({ city: "San Francisco", neighborhood: null, budget: null, date: null, start: null, headcount: 40, likes: [], passes: [], ...o });
const full = Q.assembleQuery("venue", "a launch dinner", state({ neighborhood: "Mission", budget: "$5k", date: "2026-10-22", start: "6:00 pm", likes: ["Foreign Cinema"], passes: ["Clarion Performing Arts Center (too plain)"] }));
check("a search carries the member's city, neighborhood, headcount, date and budget", full.ok && /Mission, San Francisco/.test(full.query) && /40 people/.test(full.query) && /2026-10-22 from 6:00 pm/.test(full.query) && /\$5k/.test(full.query), full);
check("a search carries what they liked and passed on", full.ok && /They liked: Foreign Cinema/.test(full.query) && /Not like: Clarion Performing Arts Center \(too plain\)/.test(full.query));
check("a search carries the high-end bar", full.ok && full.query.includes(Q.QUALITY_FLOOR.venue) && /not budget rentals/.test(Q.QUALITY_FLOOR.venue));
check("a search is never the bare keyword", full.ok && full.query.length > "a launch dinner".length * 4 && full.query !== "a launch dinner");
const noCount = Q.assembleQuery("venue", "a launch dinner", state({ headcount: null }));
check("a venue search with no headcount is a question back, not a guess", !noCount.ok && noCount.missing.includes("headcount") && /how many people/.test(noCount.question));
const noCity = Q.assembleQuery("venue", "a launch dinner", state({ city: null, headcount: null }));
check("missing city and headcount: one question asking both", !noCity.ok && noCity.missing.join() === "city,headcount" && /which city.*and about how many people/.test(noCity.question));
check("an event search needs only the city", Q.assembleQuery("event", "a talk on AI", state({ headcount: null })).ok && !Q.assembleQuery("event", "a talk", state({ city: null })).ok);
check("missing budget or date isn't load-bearing: searched around, shown as unknown", Q.assembleQuery("venue", "dinner", state({ budget: null, date: null })).ok);
check("sources below the bar are skipped", Q.belowTheBar("https://sf.funcheap.com/free-zoo-day/") && Q.belowTheBar("https://www.groupon.com/deals/x") && !Q.belowTheBar("https://www.sfmoma.org/event/x/") && !Q.belowTheBar("https://www.eventbrite.com/e/portfolio-night-1"));
const tool = src("agent/loopTools.ts");
check("the brief tool asks first when a load-bearing fact is missing (nothing starts)", /const q = Q\.assembleQuery\("venue", input\.what, known\);\s*if \(!q\.ok\) return \{ ok: false, askThem: q\.question/.test(tool));
check("the task backstops it: missing facts are asked, never searched on a guess", /if \(!q\.ok\) \{[\s\S]{0,200}await tellThenClose\(q\.question, "dropped"/.test(src("services/researchBrief.ts")));
check("options are read only from their own page (never a listicle), up to six asked of the search", /k\.official \|\| PEERSPACE_LISTING/.test(src("services/researchBrief.ts")) && /max: BRIEF_LIMITS\.maxOptions/.test(src("services/researchBrief.ts")) && /Up to \$\{Math\.min\(6, Math\.max\(1, opts\.max \?\? 3\)\)\}/.test(src("services/taskWeb.ts")));
check("the task's search is the assembled query, not the raw ask", /findVenueOptions\(task\.userId, q\.query,/.test(src("services/researchBrief.ts")));

// ---- 2. fixed fields; unknown stays unknown
const at = "2026-10-07T21:00:00.000Z";
const v = Q.schemaFields("venue", { rate: { value: "$225 USD /hr", evidence: "$225 USD /hr" }, capacity: { value: null }, vibe: { value: "gorgeous" } as any }, at, { slotLabel: "2026-10-22 from 6:00 pm" });
check("fields come in the type's fixed order", v.map((f) => f.key).join() === "rate,minimum,capacity,open,inquire", v.map((f) => f.key));
check("a key outside the schema is dropped (no prose)", !v.some((f) => f.key === "vibe"));
check("a missing field stays missing", v.find((f) => f.key === "minimum")?.value === null && v.find((f) => f.key === "capacity")?.value === null);
check("no date asked: no availability field at all", !Q.schemaFields("venue", {}, at).some((f) => f.key === "open"));
check("a hedge the page didn't make is unknown", Q.schemaFields("venue", { rate: { value: "probably around $200 an hour", evidence: "$200" } }, at)[0].value === null);
check("a hedge in the page's own words stands", Q.schemaFields("venue", { rate: { value: "might cost under $2,000", evidence: "a 49-person two hour daytime rental might cost under $2,000" } }, at)[0].value === "might cost under $2,000");
{
  const cap = (value: string) => Q.schemaFields("venue", { capacity: { value, evidence: value } }, at).find((f) => f.key === "capacity")?.value ?? null;
  check("a group minimum isn't a capacity: it goes as unknown", ["16 people or more", "minimum 20 guests", "at least 10", "15+ guests", "Min. 12"].every((v) => cap(v) === null), ["16 people or more", "15+ guests"].map(cap));
  check("a real capacity stands, ranges and maximums included", cap("Maximum seated: 40, maximum standing: 70") === "Maximum seated: 40, maximum standing: 70" && cap("8 to 150 guests seated") !== null && cap("up to 250 guests for a standing reception") !== null && cap("Mastro's Terrace: 80 seated or 200 standing") !== null);
}
// ---- the find (services/researchBrief.ts findVenueOptions): more than one angle, one option per place, factless own pages
{
  const rb = src("services/researchBrief.ts");
  const find = rb.slice(rb.indexOf("export async function findVenueOptions"), rb.indexOf("type BriefParams"));
  check("the find runs up to three passes, each later one naming what's already found", /const angles = \[/.test(find) && (find.match(/angles = \[([^\]]*)\]/)?.[1].split('", "').length ?? 0) === 3 && /already found/.test(find) && /\$\{seen \? ` \$\{seen\}\.` : ""\}/.test(find));
  check("the find stops early only once it has a full brief's worth of distinct places", /if \(i > 0 && ownPlaces\(\)\.length >= BRIEF_LIMITS\.maxOptions\) break;/.test(find));
  check("one option per place: a second page on the same site isn't another option", /placeKey\(x\) === placeKey\(k\)/.test(find) && /findIndex\(\(x\) => placeKey\(x\) === placeKey\(k\)\) === i/.test(find));
  check("the find reads each own page itself, so a name-checked own page with no search details still counts", /readsPageItself: true/.test(find) && /ownPage: "private events or private dining page"/.test(find));
  check("a brief heading is the place's core name, not a room the search named", /coreName\(k\.name\)\]/.test(find));
}
check("an estimate with no evidence is unknown", Q.schemaFields("event", { price: { value: "typically $30" } }, at).find((f) => f.key === "price")?.value === null);
check("a long prose answer is replaced by the page's own short words", Q.schemaFields("venue", { capacity: { value: "x".repeat(200), evidence: "Up to 75 guests" } }, at).find((f) => f.key === "capacity")?.value === "Up to 75 guests");
check("a long answer with no short quote is unknown", Q.schemaFields("venue", { capacity: { value: "x".repeat(200), evidence: "y".repeat(200) } }, at).find((f) => f.key === "capacity")?.value === null);
const doc = RB.buildBrief({ title: "t", asked: "a", memberContext: [], finds: [{ name: "The Interval", url: "https://longnow.org/interval/book/", checkedAt: at, reader: "sdk", fields: v }] });
check("unknowns render as unknown in the brief", doc.sections[0].bullets.includes("Minimum: unknown") && doc.sections[0].bullets.includes("Open 2026-10-22 from 6:00 pm: unknown"));
check("a value that repeats its own label loses it", Q.schemaFields("venue", { capacity: { value: "Capacity: 80 seated or 200 standing" } }, at).find((f) => f.key === "capacity")?.value === "80 seated or 200 standing");
check("size is read from the largest number stated", Q.findFeatures({ type: "venue", url: "https://www.perbaccosf.com/dining/", fields: [{ key: "capacity", label: "Capacity", value: "Groups ranging from 8 to 150 guests seated and up to 250 guests", checkedAt: at }] }).includes("size:large"));
check("every field carries its check time", v.every((f) => f.checkedAt === at));

// ---- 3. freshness: re-check before showing
const now = new Date("2026-10-10T12:00:00.000Z");
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const stored = (fields: import("../../src/services/researchQuality.js").FindField[]) => ({ type: "venue" as const, name: "Foreign Cinema", url: "https://foreigncinema.com/private-dining/", reader: "sdk" as const, fields });
const fresh = stored([{ key: "rate", label: "Rate", value: "$200 an hour", checkedAt: ago(48) }, { key: "capacity", label: "Capacity", value: "350", checkedAt: ago(24 * 60) }]);
check("availability decays in a day", Q.staleKeys(stored([{ key: "open", label: "Open", value: "yes", checkedAt: ago(25) }]), now).join() === "open" && Q.staleKeys(stored([{ key: "open", label: "Open", value: "yes", checkedAt: ago(20) }]), now).length === 0);
check("prices last two weeks, capacity three months", Q.staleKeys(fresh, now).length === 0 && Q.staleKeys(stored([{ key: "rate", label: "Rate", value: "$200", checkedAt: ago(15 * 24) }]), now).join() === "rate");
check("a field with no readable check time counts as stale", Q.staleKeys(stored([{ key: "rate", label: "Rate", value: "$200", checkedAt: "" }]), now).join() === "rate");
let reads = 0;
const r1 = await Q.freshForShow(fresh, async () => { reads++; return null; }, now);
check("nothing stale: shown as is, no re-read", reads === 0 && r1.find === fresh && r1.rechecked.length === 0);
const old = stored([{ key: "rate", label: "Rate", value: "$200 an hour", checkedAt: ago(20 * 24) }, { key: "open", label: "Open", value: "yes", checkedAt: ago(30) }, { key: "capacity", label: "Capacity", value: "350", checkedAt: ago(24) }]);
const r2 = await Q.freshForShow(old, async () => { reads++; return { gone: false, fields: [{ key: "rate", label: "Rate", value: "$240 an hour", checkedAt: now.toISOString() }] }; }, now);
check("stale fields trigger a re-read before showing", reads === 1 && r2.rechecked.join() === "rate,open");
check("a re-read value replaces the stale one, with the new check time", r2.find?.fields.find((f) => f.key === "rate")?.value === "$240 an hour" && r2.find?.fields.find((f) => f.key === "rate")?.checkedAt === now.toISOString());
check("a stale field the re-read couldn't confirm is unknown, never the old value", r2.find?.fields.find((f) => f.key === "open")?.value === null);
check("a fresh field is left alone", r2.find?.fields.find((f) => f.key === "capacity")?.value === "350" && r2.find?.fields.find((f) => f.key === "capacity")?.checkedAt === ago(24));
const r3 = await Q.freshForShow(old, async () => null, now);
check("a failed re-read: every stale field unknown", r3.find?.fields.filter((f) => f.key !== "capacity").every((f) => f.value === null));
const r4 = await Q.freshForShow(old, async () => ({ gone: true, fields: [] }), now);
check("a page that's gone: the find isn't shown at all", r4.find === null);
check("a re-sent brief runs every find through the re-check", /if \(p\.again\) \{[\s\S]{0,300}Q\.freshForShow\(f,/.test(src("services/researchBrief.ts")));

// ---- 4. outcomes feed ranking
const find = (url: string, rate: string) => ({ type: "venue" as const, url, fields: [{ key: "rate", label: "Rate", value: rate, checkedAt: at }, { key: "capacity", label: "Capacity", value: "60 people", checkedAt: at }] });
const A = find("https://www.foreigncinema.com/x", "$450 an hour"), B = find("https://giggster.com/listing/y", "$120 an hour");
check("features: site, price level, size", JSON.stringify(Q.findFeatures(A)) === JSON.stringify(["type:venue", "site:foreigncinema.com", "price:high", "size:medium"]), Q.findFeatures(A));
const none = { stats: {}, reactions: 0 };
check("no signal anywhere: the order they came in", Q.rankFinds([B, A], none, {}).map((f) => f.url).join() === [B.url, A.url].join());
const likedHigh = Q.featureStats(Array.from({ length: 8 }, () => ({ features: Q.findFeatures(A), outcome: "yes" as const })).concat(Array.from({ length: 4 }, () => ({ features: Q.findFeatures(B), outcome: "not_like_that" as const }))));
check("their yeses and 'not like that's reorder the next finds", Q.rankFinds([B, A], { stats: likedHigh, reactions: 12 }, {}).map((f) => f.url).join() === [A.url, B.url].join());
const globalLikesB = Q.featureStats(Array.from({ length: 20 }, () => ({ features: Q.findFeatures(B), outcome: "yes" as const })));
check("a new member (little signal) ranks by everyone's", Q.rankFinds([A, B], { stats: Q.featureStats([{ features: Q.findFeatures(A), outcome: "yes" }]), reactions: 1 }, globalLikesB)[0].url === B.url);
check("enough of their own signal outweighs everyone's", Q.rankFinds([B, A], { stats: likedHigh, reactions: 12 }, globalLikesB)[0].url === A.url);
check("'not like that' counts against harder than 'no', and 'ignored' only lightly", Q.OUTCOME_WEIGHT.not_like_that < Q.OUTCOME_WEIGHT.no && Q.OUTCOME_WEIGHT.no < Q.OUTCOME_WEIGHT.ignored && Q.OUTCOME_WEIGHT.ignored < 0 && Q.OUTCOME_WEIGHT.yes > 0);
check("ranking orders, never drops", Q.rankFinds([A, B, A], { stats: likedHigh, reactions: 12 }, {}).length === 3);
const qsrc = src("services/researchQuality.ts");
check("an outcome is recorded only on a find shown to that member", /WHERE user_id = \$1 AND id = \$2 AND shown_at IS NOT NULL AND \(outcome IS NULL OR outcome = 'ignored'\)/.test(qsrc));
check("unreacted finds become 'ignored' after 72 hours, on the task cron", Q.IGNORED_AFTER_HOURS === 72 && /markIgnoredFinds\(\)/.test(src("jobs/index.ts")));
check("every find shown is recorded when the brief goes, and ranked before it's built", /if \(sent\) await Q\.recordShownFinds\(/.test(src("services/researchBrief.ts")) && /Q\.rankFinds\(/.test(src("services/researchBrief.ts")));
check("Cue records reactions through its own tool, matched to an option it actually sent", /findReaction: tool\(/.test(tool) && /recentShownFinds\(ctx\.userId\)/.test(tool) && /doesn't match an option you showed them/.test(tool));
const caps = src("services/capabilities.ts");
check("the reaction tool is in Cue's registry", /id: "find_reaction"[\s\S]{0,400}tool: "findReaction"/.test(caps));
check("their passes and likes go into their next query", /outcome IN \('yes','no','not_like_that'\)/.test(qsrc) && /likes: reacted\.rows/.test(qsrc) && /passes: reacted\.rows/.test(qsrc));

// ---- point A to point B: a yes moves toward the booking, on sourced facts only
const picked = { name: "The Interval", url: "https://longnow.org/interval/book/", fields: [{ key: "capacity", label: "Capacity", value: "Up to 75 guests", checkedAt: at }, { key: "rate", label: "Rate", value: null, checkedAt: at }] };
const yes = Q.nextStepAfterReaction("yes", picked);
check("a yes points Cue at the inquiry and following it to an answer", /draft the inquiry/.test(yes) && /draftEmail/.test(yes) && /task/.test(yes) && /their date, headcount and budget/.test(yes));
check("a yes rests only on the option's sourced fields (an unknown isn't passed on as a fact)", /Capacity: Up to 75 guests \(checked 2026-10-07\)/.test(yes) && !/Rate:/.test(yes) && /Nothing else about price or availability/.test(yes));
check("'not like that' widens the search, never argues", /look again/.test(Q.nextStepAfterReaction("not_like_that", picked)) && /Don't argue/.test(Q.nextStepAfterReaction("not_like_that", picked)));
check("the reaction tool hands Cue the option and its next step", /next: Q\.nextStepAfterReaction\(input\.reaction, hit\)/.test(tool));
console.log(`search quality: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
