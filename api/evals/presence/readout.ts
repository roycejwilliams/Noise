// The partner readout (services/partnerReadout.ts). Model-free: the category step is swapped for a fake, the database for a fake.
//   npx tsx evals/presence/readout.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const R = await import("../../src/services/partnerReadout.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`); } };

check("a count under 3 is shown as a few, 0 as none, 3 and up as the number", R.cell(0) === "none" && R.cell(1) === "a few" && R.cell(2) === "a few" && R.cell(3) === "3" && R.cell(40) === "40");
const folded = R.foldThemes({ "Investors or funding": 6, "Hiring or talent": 2, "Cofounders or partners": 1, "Customers or clients": 3, "Something else": 0 });
check("a category with fewer than 3 people is folded into something else", folded.some((r) => r.theme === "Investors or funding" && r.n === 6) && folded.some((r) => r.theme === "Customers or clients" && r.n === 3) && !folded.some((r) => r.theme === "Hiring or talent" || r.theme === "Cofounders or partners") && folded.some((r) => r.theme === "Something else" && r.n === 3));
check("a folded remainder under 3 is dropped, not shown", !R.foldThemes({ "Hiring or talent": 2, "Venues or events": 0, "Investors or funding": 4 }).some((r) => r.theme === "Something else"));
check("the categories are a fixed list", R.THEMES.length === 8 && R.THEMES.includes("Something else"));

const base: any = { eventName: "Founders Night", registered: 24, arrived: 18, walkins: 2, briefs: 20, nudged: 14, interested: 9, intros: 4, debriefReplies: 11, metSomeone: 8, conversationsTold: 13, followThroughMembers: 5, askCount: 16, themes: { "Investors or funding": 6, "Hiring or talent": 4, "Cofounders or partners": 2, "Something else": 4 } };
const d = R.describe(base);
check("it says how many came, the conversations told, what landed, and what the room wanted", d.lines.some((l) => /about 25 members were registered and about 20 arrived/.test(l)) && d.lines.some((l) => /13 people were named/.test(l)) && d.lines.some((l) => /4 introductions/.test(l)) && d.lines.some((l) => /investors or funding \(6\)/.test(l)));
check("small counts become a few everywhere", R.describe({ ...base, intros: 2, interested: 1, metSomeone: 2, conversationsTold: 1 }).lines.join(" ").match(/\b(a few)\b/g)!.length >= 3 && !/\b(1|2) (people|introductions)\b/.test(R.describe({ ...base, intros: 2, conversationsTold: 1 }).lines.join(" ")));
check("headcounts are rounded, and under 10 is only 'fewer than 10', so the host can't subtract to find a no-show", R.approx(4) === "fewer than 10" && R.approx(9) === "fewer than 10" && R.approx(10) === "about 10" && R.approx(24) === "about 25" && R.approx(18) === "about 20" && !/\b(24|18)\b/.test(R.describe(base).lines.join(" ")));
check("a small room gets no readout at all (any number would point at people)", R.describe({ ...base, registered: 5 }).lines.length === 1 && /too small a room|too small/.test(R.describe({ ...base, registered: 5 }).lines[0]) && !/\d/.test(R.describe({ ...base, registered: 5 }).lines[0]));
check("the 'people named' figure is hidden unless at least 3 different members contributed (else it is one member's own number)", !/people were named/.test(R.describe({ ...base, followThroughMembers: 2, conversationsTold: 4 }).lines.join(" ")) && /people were named/.test(R.describe({ ...base, followThroughMembers: 3 }).lines.join(" ")));
const homog = R.foldThemes({ "Investors or funding": 8 });
check("a room where everyone wants the same thing shows no pattern (it would tell the host each person's category)", homog.length === 0 && R.foldThemes({ "Investors or funding": 9, "Hiring or talent": 0 }).length === 0 && R.foldThemes({ "Investors or funding": 8, "Hiring or talent": 1 }).length === 0 && R.foldThemes({ "Investors or funding": 6, "Hiring or talent": 4 }).length === 2);
const few = R.describe({ ...base, askCount: 7, themes: { "Investors or funding": 4, "Hiring or talent": 3 } });
check("with too few asks no pattern is shown at all", few.lines.some((l) => /Too few members shared/.test(l)) && !few.lines.some((l) => /looking for, by category/.test(l)));
// What the room was thin on: only when Cue knows what most of the room can offer (Royce, 2026-10-14: "when Cue can't back a claim,
// it says nothing. Silence over false signal").
const thin = { ...base, themes: { "Investors or funding": 6, "Hiring or talent": 4, "Something else": 6 }, offerThemes: { "Hiring or talent": 5 } };
const thinLine = (x: any) => R.describe(x).lines.find((l) => /thin on/.test(l));
check("thin on: named when most of the room has a known offer and nobody offered it", /thin on: investors or funding\./.test(thinLine({ ...thin, offerKnown: 15, offerPool: 18 }) ?? ""));
check("thin on: silent when Cue doesn't know what most of the room can offer (101 asks vs 2 offers on dev, 2026-10-14)", !thinLine({ ...thin, offerKnown: 2, offerPool: 18 }) && !thinLine({ ...thin, offerKnown: 14, offerPool: 18 }) && !thinLine({ ...thin }) && !thinLine({ ...thin, offerKnown: 0, offerPool: 0 }));
// Review of #208: 9 asks, all investors, offers known for 11 of 12: the themes line holds the pattern back, so "thin on" must too.
const allOne = { ...base, askCount: 9, themes: { "Investors or funding": 9 }, offerThemes: { "Hiring or talent": 11 }, offerKnown: 11, offerPool: 12 };
check("thin on: never says what the themes line held back (a room where nearly everyone sought the same thing)", !thinLine(allOne) && !thinLine({ ...allOne, themes: { "Investors or funding": 8, "Hiring or talent": 1 } }) && R.describe(allOne).lines.some((l) => /Too few members shared/.test(l)));
check("thin on: never 'something else', never a category fewer than 3 looked for, never one somebody offered", R.thinOn({ "Something else": 9, "Venues or events": 2, "Hiring or talent": 5 }, { "Hiring or talent": 1 }).length === 0);
const text = R.renderText(base);
check("nothing in it names or quotes anyone", !/@|https?:\/\/|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b|Maya|Jordan|Priya/.test(text) && !/Maya|Jordan|Priya/.test(R.renderHtml(base)));
check("it says it is aggregate and what is hidden", /carries nothing any member told Cue/.test(text) && /nothing about who talked to whom/.test(text) && /carries nothing any member told Cue/.test(R.renderHtml(base)));

// The data step with a fake database: only counts and a fixed label leave it
const { default: pool } = await import("../../src/db/db.js");
const real = (pool as any).query;
const sqls: string[] = [];
let arrivedParams: any[] | null = null;
(pool as any).query = async (q: string, p: any[]) => {
  sqls.push(q);
  if (/FROM event_presence WHERE event_api_id/.test(q)) arrivedParams = p;
  if (/FROM co_profiles/.test(q)) return { rows: ["seed investors for my robotics startup Acme", "a designer", "an engineer", "angels", "VCs", "a lawyer", "a founding engineer", "investors", "a co-founder"].map((text) => ({ intent: [{ type: "seeking", status: "active", text }] })).concat([{ intent: [] }]).slice(0, (p?.[0] ?? []).length) };
  return { rows: [{ n: 5 }] };
};
const pe = await import("../../src/services/eventPresence.js");
try {
  const labels: string[] = [];
  const stats = await R.gatherStats("ev9", "Founders Night", async (ask) => { labels.push(ask); return /invest|angel|VC/i.test(ask) ? "Investors or funding" : /designer|engineer|lawyer/i.test(ask) ? "Hiring or talent" : "Something else"; }, async () => ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((user_id) => ({ user_id })));
  check("each attendee's ask is read only to give it a fixed label, and only the counts are kept", stats.askCount === 9 && stats.themes["Investors or funding"] === 4 && stats.themes["Hiring or talent"] === 4 && !JSON.stringify(stats).match(/robotics|Acme|designer|engineer|angels|lawyer/));
  const arrivedFirst = arrivedParams;
  {
    // A room where Cue knows what nearly everyone can offer: each offer labelled on the offer side, one count per person.
    const prev = (pool as any).query;
    const sides: string[] = [];
    (pool as any).query = async (q: string, p: any[]) => {
      if (/FROM co_facts/.test(q)) return { rows: (p[0] as string[]).flatMap((id) => [{ owner_user_id: id, object_label: "design work" }, { owner_user_id: id, object_label: "design reviews" }]) };
      return prev(q, p);
    };
    const backed = await R.gatherStats("ev9", "Founders Night", async (t, side) => { sides.push(side ?? "seeks"); return /design/.test(t) ? "Hiring or talent" : /invest|angel|VC/i.test(t) ? "Investors or funding" : "Something else"; }, async () => ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((user_id) => ({ user_id })));
    (pool as any).query = prev;
    check("offers: what Cue knows each attendee can offer is labelled on the offer side, one count per person", backed.offerKnown === 10 && backed.offerPool === 10 && backed.offerThemes?.["Hiring or talent"] === 10 && sides.includes("offers"));
    check("offers: the room is then thin on investors (asked for, nobody offered), and no offer text leaves the data step", /thin on: investors or funding/.test(R.renderText(backed)) && !JSON.stringify(backed).includes("design"));
  }
  const smallStats = await R.gatherStats("ev9", "Founders Night", async () => "Investors or funding", async () => [{ user_id: "a" }]);
  check("with fewer than eight asks the data step does not even label them", smallStats.askCount === 1 && Object.keys(smallStats.themes).length === 0);
  check("arrivals are counted only among the members of this event", Array.isArray((arrivedFirst as any)?.[1]) && (arrivedFirst as any)[1].length === 10 && /user_id = ANY\(\$2::uuid\[\]\)/.test(sqls.find((q) => /FROM event_presence WHERE event_api_id/.test(q)) ?? ""));
  // The introduced pairs' outcome evidence (no ids, no names, no notes) is read only to count (services/partnerReadout.ts pairRates).
  check("every database read is a count, the attendee's own open ask, what Cue knows they can offer, or the pairs' outcome evidence to count", sqls.every((q) => /COUNT\(|SUM\(|SELECT user_id, intent FROM co_profiles|SELECT owner_user_id, object_label FROM co_facts WHERE owner_user_id = ANY\(\$1::uuid\[\]\) AND relation = 'offers' AND retired_at IS NULL|^SELECT a_evidence, b_evidence FROM co_pairs WHERE event_id = \$1 AND intro_sent_at IS NOT NULL$/.test(q)));
  check("offers are not labelled when the room's offers are too thin to back the line", stats.offerKnown === 0 && Object.keys(stats.offerThemes ?? {}).length === 0 && !labels.some((l) => /offer/.test(l)));
} finally {
  (pool as any).query = real;
}
void pe;

// Structure: no member columns leave the file, and it can't send itself
const s = src("services/partnerReadout.ts").replace(/\/\/.*$/gm, "");
check("it selects no names, emails, phones or message text", !/first_name|last_name|phone_number|SELECT\s+(?:[^`()]*,\s*)?(?:content|email)\b/i.test(s.replace(/content::jsonb/g, "")));
check("it never sends itself: no mail or text code in the service", !/Resend|sendblue|emails\.send/i.test(s));
const script = src("scripts/partnerReadout.ts");
check("the script sends nothing itself: its preview stores and sends nothing, and a send goes only through sendReadout (approved readouts, evals/presence/readoutFlow.ts)", !/Resend|emails\.send|sendblue/i.test(script.replace(/\/\/.*$/gm, "")) && /Nothing was stored or sent/.test(script) && /R\.sendReadout\(eventId\)/.test(script));
check("its category call keeps prompts out of the trace store", /recordInputs: false, recordOutputs: false/.test(s));

console.log(`partner readout rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
