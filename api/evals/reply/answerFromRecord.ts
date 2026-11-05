// Answering from the record (2026-11-04, Royce's own thread): "Where is that one located?" about Founder Table (sent Oct 30, San Francisco,
// needs host approval) got "nothing on file", and "What day did you send that" got "no worries, easy to miss". Plus the #389 review:
// referents first under the caps, resolved once and filled with no window, the removal filter on every referent path, no made-up gap, and
// a plain answer-from-the-stored-facts note (no regex veto of the draft).
// Layer 1: zero tokens, no database (the stored-offer and by-name reads take a fake db). Whether the model words the answer well is
// unverified until a paid run.
//   npx tsx evals/reply/answerFromRecord.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";

const T = await import("../../src/services/turnContext.js");
const C = await import("../../src/services/callContext.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; process.stdout.write(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}\n`); }
};
type Item = import("../../src/services/turnContext.js").SentItem;

const NOW = new Date("2026-11-04T18:00:00.000Z");
const ZONE = "America/Los_Angeles";
const FT_URL = "https://lu.ma/founder-table";
const details = { startAt: "2026-11-03T18:00:00-08:00", endAt: null, timezone: ZONE, online: false, venue: null, address: null, city: "San Francisco", hosts: [], price: null, spotsRemaining: null, requiresApproval: true, soldOut: null, guestCount: null, description: "A small dinner for YC founders." };
const item = (name: string, url: string, daysAgo: number, extra: any = {}): Item => ({ key: `name:${name.toLowerCase()}`, name, kind: "event", url, sentAt: new Date(NOW.getTime() - daysAgo * 86_400_000), reaction: null, details: null, postText: null, ...extra });
const founder = item("Founder Table", FT_URL, 5.2, { details, city: "San Francisco" });
const sent = [item("Salon Night", "https://lu.ma/salon", 2), item("Rooftop Supper", "https://lu.ma/rooftop", 3), founder];
const lastCo = "Hey, did you end up making it into Founder Table?";

// 1. The stored fields, with the send date and the link; the gap said only when it is true.
{
  const facts = T.sentFindFacts(founder, NOW, ZONE).join(" ");
  check("1. Founder Table facts carry San Francisco, the link and the day Cue sent it (Oct 30)", /San Francisco/.test(facts) && facts.includes(FT_URL) && /on Oct 30/.test(facts), facts);
  check("1. it needs approval, so the address gap is said as that (after the host approves)", /once the host approves/.test(facts) && !/nothing on file/i.test(facts) && !/only shown to registered guests/.test(facts), facts);
  const open = T.sentFindFacts(item("Open House", "https://lu.ma/open", 6, { details: { ...details, requiresApproval: false } }), NOW, ZONE).join(" ");
  check("6. a find that does NOT need approval never gets 'after approval': the address is plainly not stored", !/approves|approval/i.test(open.replace(/Registration needs host approval\./, "")) && /street address isn't stored/.test(open), open);
  const bare = T.sentFindFacts(item("Bare", "https://lu.ma/bare", 6, { city: "Oakland" }), NOW).join(" ");
  check("1. a find with only its stored city and no page still says the city and the link", /Oakland/.test(bare) && bare.includes("https://lu.ma/bare"), bare);
}
// 7. Referent resolution.
{
  const ref = (message: string, extra: any = {}) => T.referredSent(sent, { message, coTexts: [lastCo], ...extra }).map((x) => x.name);
  check("7. 'Where is that one located?' after the debrief resolves to Founder Table, not the newer finds", ref("Where is that one located?").join() === "Founder Table", ref("Where is that one located?"));
  check("7. 'u send that when' (no question mark) resolves too", ref("u send that when").join() === "Founder Table");
  check("7. a thing they name that Cue never sent resolves to nothing (the pottery class)", ref("Where is that pottery class?").length === 0 && ref("where is the pottery class").length === 0);
  check("7. 'Did you send me anything?' does not resolve to one old find", ref("Did you send me anything?").length === 0);
  check("7. a lowercase word in a sentence is not a find named 'Coffee'", T.referredSent([item("Coffee", "https://lu.ma/c", 3)], { message: "where should I get coffee near here", coTexts: [] }).length === 0);
  check("7. ...but the whole name as words does resolve", T.referredSent([item("Coffee", "https://lu.ma/c", 3)], { message: "where is Coffee?" }).length === 1);
  const two = ["Salon Night is Friday, and Founder Table is Monday: https://lu.ma/salon", "older text"];
  const pick = T.referredSent(sent, { message: "where is that one", coTexts: [`Founder Table is Monday, and ${"Salon Night"} is Friday`, ...two] }).map((x) => x.name);
  check("7. when Cue's last text names two finds, the one mentioned last wins", pick.join() === "Salon Night", pick);
  const walk = T.referredSent(sent, { message: "what day did you send that", coTexts: ["Sounds good, talk soon.", "Ha, fair enough.", lastCo] }).map((x) => x.name);
  check("7. it walks back past texts that name no find to the last one that does", walk.join() === "Founder Table", walk);
  const meant = T.referredSent(sent, { message: "what day did you send that", meantUrl: FT_URL, coTexts: [] }).map((x) => x.name);
  check("7. the turn read's meant (its link) resolves it with no pointing text", meant.join() === "Founder Table");
  // same name, two cities: found by link, not by name
  const sf = item("Founder Table", FT_URL, 5), ny = item("Founder Table", "https://lu.ma/founder-table-nyc", 20, { city: "New York" });
  const merged = T.mergeSent([], [{ m: { name: "Founder Table", url: FT_URL, city: "San Francisco", details }, decided_at: sf.sentAt }, { m: { name: "Founder Table", url: "https://lu.ma/founder-table-nyc", city: "New York" }, decided_at: ny.sentAt }], []);
  check("7. two events of one name with different links stay two", merged.length === 2, merged.map((m) => m.url));
  check("7. ...and the link the turn read gave picks the right one", T.referredSent(merged, { message: "where is that", meantUrl: "https://lu.ma/founder-table-nyc" })[0]?.city === "New York");
  const dup = T.mergeSent([{ item_key: "event:abc", item_name: "Founder Table", kind: "event", url: FT_URL, sent_at: sf.sentAt }], [{ m: { name: "Founder Table", url: FT_URL + "?utm=x", city: "San Francisco", event_api_id: "abc", details }, decided_at: sf.sentAt }], []);
  check("7. the same find from two sources (the link with a tracking tail) still merges into one", dup.length === 1 && !!dup[0].details, dup.length);
}
// 2 + 8. Resolve once, fill once, no window.
{
  const sqls: { sql: string; args: unknown[] }[] = [];
  const stored = { name: "Founder Table", url: FT_URL, city: "San Francisco", event_api_id: "evt-ft", details };
  const db = { query: async (sql: string, args: unknown[] = []) => (sqls.push({ sql, args }), { rows: /event_offer_pending/.test(sql) ? [{ content: JSON.stringify({ match: { ...stored, name: "Founder Table", url: "https://lu.ma/other-ft", event_api_id: "x" } }) }, { content: JSON.stringify({ match: stored }) }] : [] }) };
  const bare = item("Founder Table", FT_URL, 9);
  const turn = { sent: [item("A", "https://lu.ma/a", 1), item("B", "https://lu.ma/b", 2), bare], message: "where is that" };
  const got = await T.resolveReferents("u1", turn as any, { message: "Where is that one located?", coTexts: [lastCo], db, fill: async () => {}, keep: async (i) => i });
  check("2. resolved once: one referent, its stored details filled from the offer matched by link (not the same-name one with another link)", got.length === 1 && got[0] === bare && bare.details?.city === "San Francisco" && bare.city === "San Francisco", { got: got.length, city: bare.city });
  const lines = T.sentFindFacts(bare, NOW, ZONE).join(" ");
  check("2. ...so the facts have the city and no contradictory 'page hasn't been read' line", /San Francisco/.test(lines) && !/hasn't been read/.test(lines), lines);
  const q = sqls.filter((s) => /event_offer_pending/.test(s.sql));
  check("8. the stored-offer read is one query, by link, with no time window, this member only", q.length === 1 && !/INTERVAL|make_interval/i.test(q[0].sql) && q[0].args[0] === "u1" && /ANY/.test(q[0].sql), q);
  // a name not in the recent list: found by name over all time (word boundary), still this member only
  const sqls2: { sql: string; args: unknown[] }[] = [];
  const db2 = { query: async (sql: string, args: unknown[] = []) => (sqls2.push({ sql, args }), { rows: /FROM revealed_offers/.test(sql) ? [{ item_key: "name:old fest", item_name: "Old Fest", kind: "event", url: "https://lu.ma/oldfest", sent_at: new Date("2026-08-01"), reaction: null }] : [] }) };
  const old = await T.resolveReferents("u1", { sent: [], message: "" } as any, { message: "Where was Old Fest again?", coTexts: [], db: db2, fill: async () => {}, keep: async (i) => i });
  check("8. a find named in their words but older than the recent list is found by name, no window", old[0]?.name === "Old Fest" && sqls2.filter((s) => /~\*/.test(s.sql)).length >= 3 && sqls2.every((s) => s.args[0] === "u1" && !/INTERVAL|make_interval/i.test(s.sql)), sqls2.map((s) => s.sql.slice(0, 80)));
}
// 1 + 10. Referents first under the call cap; zone passed.
{
  const big = "x".repeat(520);
  const recent = [1, 2, 3].map((n) => item(`Recent ${n}`, `https://lu.ma/r${n}`, n * 0.5, { details: { ...details, description: big } }));
  const ft = item("Founder Table", FT_URL, 9, { details });
  const sentAll = [...recent, ft];
  const named = T.sentNamedIn(sentAll, [lastCo]);
  check("1. the 9-day-old find Cue's text named is picked out", named.length === 1 && named[0].name === "Founder Table");
  const lines = T.sentDetailLines({ sent: sentAll }, 7, NOW, { also: named, zone: ZONE });
  check("1. ...and its lines come FIRST, before the three recent detailed finds", /Founder Table/.test(lines[0]) && /San Francisco/.test(lines[0]) && /Oct 26/.test(lines[0]), lines[0]);
  const summary = C.assembleCallSummary({ lessons: [], sentLines: lines, threads: [], base: "Base.", sentMax: C.CALL_SENT_MAX });
  check("1. under the 1800-char cap on a call the referent survives and the oldest recent send is what is cut", /Founder Table/.test(summary) && /San Francisco/.test(summary) && lines.join("").length > C.CALL_SENT_MAX, { len: lines.join("").length });
  const long = item("Founder Table", FT_URL, 9, { details: { ...details, description: "z".repeat(4000) } });
  const longLines = T.sentDetailLines({ sent: [long, ...recent] }, 7, NOW, { also: [long], zone: ZONE, referentMax: C.CALL_SENT_MAX - 400 });
  const longSummary = C.assembleCallSummary({ lessons: [], sentLines: longLines, threads: [], base: "Base.", sentMax: C.CALL_SENT_MAX });
  check("1. a referent with a very long page text is cut to fit under the cap, not dropped", longLines[0].length <= C.CALL_SENT_MAX - 400 && /Founder Table/.test(longSummary) && /San Francisco/.test(longSummary), longLines[0].length);
  check("10. the call's lines carry the send date in the member's zone", /on Oct 26/.test(T.sentDetailLines({ sent: sentAll }, 14, NOW, { also: named, zone: "Pacific/Auckland" }).join(" ")) || /on Oct 27/.test(T.sentDetailLines({ sent: sentAll }, 14, NOW, { also: named, zone: "Pacific/Auckland" }).join(" ")));
  check("1. nothing named in the thread means no extra finds", T.sentNamedIn(sentAll, ["How was your week?"]).length === 0);
  check("7. calls rank by how recently a text named them and use whole words", T.sentNamedIn(sentAll, ["Recent 2 is nice", "Founder Table was fun"], 2).map((x) => x.name).join() === "Recent 2,Founder Table");
}
// 3. Forgotten finds never resolve (blocker A), on every referent path.
{
  const W = await import("../../src/services/whatCoKnows.js");
  const MK = await import("../../src/services/memberKnowledge.js");
  const rows = W.liveGuards([{ field: "sent", old: "Founder Table", now: null, ref: "sent:ft", removed: true }]);
  const keep = async (items: Item[]) => MK.withoutRemovedSent(items, rows, W);
  const stored = { name: "Founder Table", url: FT_URL, city: "San Francisco", event_api_id: "evt-ft", details };
  const dbFor = () => ({ query: async (sql: string) => ({ rows: /FROM revealed_offers/.test(sql) ? [{ item_key: "event:evt-ft", item_name: "Founder Table", kind: "event", url: FT_URL, sent_at: new Date("2026-08-01"), reaction: null }] : /event_offer_pending/.test(sql) ? [{ content: JSON.stringify({ match: stored }) }] : [] }) });
  // by name, older than the recent list
  const byName = await T.resolveReferents("u1", { sent: [], message: "" } as any, { message: "Where was Founder Table again?", coTexts: [], db: dbFor(), fill: async () => {}, keep });
  check("3. a forgotten find asked about by name (older than the recent list) resolves to nothing: no details", byName.length === 0, byName.map((x) => x.name));
  const byNameKept = await T.resolveReferents("u1", { sent: [], message: "" } as any, { message: "Where was Founder Table again?", coTexts: [], db: dbFor(), fill: async () => {}, keep: async (i) => i });
  check("3. ...and the same ask with nothing forgotten does resolve it (the check can fail)", byNameKept.length === 1 && byNameKept[0].city === "San Francisco");
  // pointed at, from the recent list and Cue's text
  const pointed = await T.resolveReferents("u1", { sent: [founder], message: "" } as any, { message: "Where is that one located?", coTexts: [lastCo], db: dbFor(), fill: async () => {}, keep });
  check("3. a forgotten find pointed at (recent list, Cue's last text) resolves to nothing", pointed.length === 0);
  // the real default fails closed when the removals can't be read (no database in layer 1)
  const closed = await T.dropRemoved("u1", [founder]);
  check("3. when the removals can't be read, nothing resolves (fails closed)", closed.length === 0);
  const T_src = fs.readFileSync(new URL("../../src/services/turnContext.ts", import.meta.url), "utf8");
  check("3. every path of resolveReferents goes through keep (the referred list and each by-name load)", (T_src.match(/await keep\(/g) ?? []).length >= 2 && /const keep = o\.keep \?\? /.test(T_src));
  const cc = fs.readFileSync(new URL("../../src/services/callContext.ts", import.meta.url), "utf8");
  check("3. the call's referents go through the same filter", (cc.match(/dropRemoved\(userId/g) ?? []).length >= 2);
}
// 4. Pointing at a find with a noun for it (blocker B).
{
  const nine = item("Founder Table", FT_URL, 9, { details, city: "San Francisco" });
  const list = [item("Salon Night", "https://lu.ma/salon", 2), nine];
  const ref = (m: string) => T.referredSent(list, { message: m, coTexts: [lastCo] }).map((x) => x.name).join();
  check("4. 'where is that event located?' resolves to the 9-day-old Founder Table", ref("where is that event located?") === "Founder Table", ref("where is that event located?"));
  check("4. 'where was that dinner' resolves to it", ref("where was that dinner") === "Founder Table", ref("where was that dinner"));
  check("4. 'where was that dinner party' and 'where's the place' too", ref("where was that dinner party") === "Founder Table" && ref("where's the place") === "Founder Table");
  check("4. a descriptor still names a different thing: 'that pottery class' resolves to nothing", ref("where is that pottery class") === "" && ref("where was that rooftop party") === "");
}
// 5. The reply gets the plain instruction with the facts; no code veto exists.
{
  const note = T.answerFromRecordNote([founder]) ?? "";
  check("5. the note names the find and says answer from the stored facts, say a missing field and give the link, never 'not sure'", /Founder Table/.test(note) && /Answer from its stored facts/.test(note) && /give the link/.test(note) && /Never say/.test(note), note);
  check("5. nothing resolved means no note", T.answerFromRecordNote([]) === null);
  check("5. the reveal read isn't repeated for the same find (link or event id, either Luma host)", T.isSameFind(founder, { url: "https://luma.com/founder-table/" }) && T.isSameFind({ url: null, key: "event:abc" }, { event_api_id: "abc" }) && !T.isSameFind(founder, { url: "https://lu.ma/other" }));
  const ms = fs.readFileSync(new URL("../../src/harness/moveCheck.ts", import.meta.url), "utf8");
  const ct = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("5. no regex veto: non_answer is gone from the move check and the send path", !/non_answer|nonAnswer/.test(ms + ct));
  const rg = fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("5. the reply facts carry the note when they ask about a resolved find, and skip the reveal repeat", /answerFromRecordNote\(opts\.turn\.referents/.test(rg) && /isSameFind\(r, match\)/.test(rg));
  const cc = fs.readFileSync(new URL("../../src/services/callContext.ts", import.meta.url), "utf8");
  check("5. a call gets the same note, first, with the same fill (loadStoredMatch through fillReferents)", /answerFromRecordNote\(named, \{ asking: false \}\)/.test(cc) && /fillReferents\(userId, named\)/.test(cc) && /loadSentNamed\(userId/.test(cc));
}
// 6. Luma links under either host are one find.
{
  const m = T.mergeSent([{ item_key: "name:ft", item_name: "Founder Table", kind: "event", url: "https://lu.ma/founder-table/", sent_at: NOW, reaction: null }], [{ m: { name: "Founder Table!", url: "https://luma.com/founder-table?utm_source=x", city: "San Francisco", details }, decided_at: NOW }], []);
  check("6. lu.ma and luma.com (trailing slash, query) merge into one find with the details", m.length === 1 && !!m[0].details, m.length);
  const two = T.mergeSent([{ item_key: "name:a", item_name: "A", kind: "event", url: "https://lu.ma/one", sent_at: NOW, reaction: null }, { item_key: "name:a", item_name: "A", kind: "event", url: "https://luma.com/two", sent_at: NOW, reaction: null }], [], []);
  check("6. different Luma events stay two", two.length === 2);
}
// 7. Calls: the note and the core facts line always fit (900-char description, three recent finds).
{
  const big = "x".repeat(900);
  const ft = item("Founder Table", FT_URL, 9, { details: { ...details, description: big }, city: "San Francisco" });
  const recent = [1, 2, 3].map((n) => item(`Recent ${n}`, `https://lu.ma/r${n}`, n * 0.5, { details: { ...details, description: big } }));
  const note = T.answerFromRecordNote([ft], { asking: false }) ?? "";
  check("7. the call note is short and says 'if they ask', not 'they are asking'", note.length < 420 && /^If they ask/.test(note) && !/They are asking/.test(note), note);
  for (const n of [1, 2, 3]) {
    const named = [ft, ...[1, 2].slice(0, n - 1).map((k) => item(`Other ${k}`, `https://lu.ma/o${k}`, 8 + k, { details: { ...details, description: big }, city: "Oakland" }))];
    const nt = T.answerFromRecordNote(named, { asking: false });
    const share = Math.max(320, Math.floor((C.CALL_SENT_MAX - C.SENT_HEADER.length - (nt?.length ?? 0) - 12 * (named.length + 1)) / named.length));
    const lines = [nt!, ...T.sentDetailLines({ sent: [...recent, ...named] }, 7, NOW, { also: named, zone: ZONE, referentMax: share })];
    const summary = C.assembleCallSummary({ lessons: [], sentLines: lines, threads: [], base: "Base.", sentMax: C.CALL_SENT_MAX });
    const ftLine = summary.split("\n").find((l) => /Founder Table" on/.test(l)) ?? "";
    check(`7. with ${n} referent(s), a 900-char description and 3 recent finds, Founder Table keeps its city, send date, start and link`, /San Francisco/.test(ftLine) && /Oct 26/.test(ftLine) && ftLine.includes(FT_URL) && /Tuesday|November 3/.test(ftLine), ftLine.slice(0, 400));
  }
}
// 8. A place that isn't a find stops the walk back; a place word picks between same-name finds.
{
  const ft = item("Founder Table", FT_URL, 9, { details, city: "San Francisco" });
  const list = [item("Salon Night", "https://lu.ma/salon", 2), ft];
  const stop = T.referredSent(list, { message: "where is that place?", coTexts: ["Want to grab dinner? Bix on Gold Street is great.", lastCo] });
  check("8. 'where is that place?' after a text naming Bix on Gold Street resolves nothing (no walk back to Founder Table)", stop.length === 0, stop.map((x) => x.name));
  const still = T.referredSent(list, { message: "where is that place?", coTexts: ["Sounds good.", lastCo] });
  check("8. ...but past a text that names nothing it still finds the find", still.map((x) => x.name).join() === "Founder Table");
  // Texts sent before the find (newer in coTexts) that name days, months and people are not places: the walk goes on to the find.
  const findText = "Founder Table looks like a fit: https://lu.ma/ft";
  const ftl = item("Founder Table", "https://lu.ma/ft", 3, { city: "San Francisco" });
  for (const t of ["Have a good time on Friday!", "Say hi to Jordan for me", "Good luck in March", "Talk soon", "See you at Founder Table, bring Jordan"]) {
    const got = T.referredSent([ftl], { message: "where is that place?", coTexts: [t, findText] }).map((x) => x.name).join();
    check(`8. after "${t}" the walk back still reaches Founder Table`, got === "Founder Table", got);
  }
  check("8. 'at Bix' (a capitalized name after 'at') stops the walk; 'at Friday' (a day) does not", T.referredSent([ftl], { message: "where is that place?", coTexts: ["Meet me at Bix", findText] }).length === 0 && T.referredSent([ftl], { message: "where is that place?", coTexts: ["Free at Friday?", findText] }).length === 1);
  const sf = item("Founder Table", FT_URL, 9, { city: "San Francisco" }), oak = item("Founder Table", "https://lu.ma/founder-table-oak", 4, { city: "Oakland" });
  const both = [oak, sf];
  const pick = (m: string, co: string[] = [lastCo]) => T.referredSent(both, { message: m, coTexts: co }).map((x) => x.city).join();
  check("8. 'the one in Oakland' with two same-name finds picks Oakland", pick("where is the one in Oakland?") === "Oakland", pick("where is the one in Oakland?"));
  check("8. 'Founder Table in San Francisco' picks San Francisco", pick("where is the Founder Table in San Francisco?") === "San Francisco");
  check("8. no place word: both stay candidates (nothing guessed)", T.referredSent(both, { message: "where is Founder Table?" }).length === 2);
}
// 9. The note lists only stored fields and says which are not.
{
  const bare = item("Bare", "https://lu.ma/bare", 3);
  const n = T.answerFromRecordNote([bare]) ?? "";
  check("9. a find whose page hasn't been read: city and date/time are listed as not stored, the link as stored", /not stored: its city, its date and time/.test(n) && /stored: the day Cue sent it, its link;/.test(n) && /give the link/.test(n), n);
  const full = T.answerFromRecordNote([founder]) ?? "";
  check("9. a read find lists its city and date/time as stored", /stored: the day Cue sent it, its link, its city, its date and time/.test(full) && /not stored: its street address/.test(full), full);
  const noUrl = T.answerFromRecordNote([item("NoLink", null as any, 3)]) ?? "";
  check("9. a find with no link doesn't promise one", /its link/.test(noUrl.split("not stored")[1] ?? "") && !/give the link/.test(noUrl), noUrl);
}
// 5 + 9. Source checks for what can't run without a database.
{
  const ct = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("5. listSentOffers names the city once", (ct.match(/\$\{x\.city \? `, in \$\{x\.city\}` : ""\}/g) ?? []).length === 1);
  const cc = fs.readFileSync(new URL("../../src/services/callContext.ts", import.meta.url), "utf8");
  check("9. the widened call suggestions go through forgottenRows and guardBlock", /W\.guardBlock\(String\(safeRecommendation\[i\]\), forgotten\)/.test(cc) && /W\.forgottenRows\(userId\)/.test(cc));
  const sb = fs.readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("2. the referent is resolved once, before the facts are gathered (not after them)", sb.indexOf("T.resolveReferents(") > 0 && sb.indexOf("T.resolveReferents(") < sb.indexOf("await gatherReplyFacts(user.id") && (sb.match(/resolveReferents\(/g) ?? []).length === 1);
  const rg = fs.readFileSync(new URL("../../src/harness/replyGrounding.ts", import.meta.url), "utf8");
  check("2. the reply facts read the one result (turn.referents) and never resolve again", /also: opts\.turn\.referents/.test(rg) && !/referredSent\(/.test(rg) && !/addStoredOfferFacts/.test(rg));
  check("10. the call builds with the member's zone", /sentDetailLines\(\{ sent \}, 7, new Date\(\), \{ also: named, zone, referentMax: share \}\)/.test(cc));
}
console.log(`answer from record: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
