// Review of #319, round 2 (2026-10-30): the reviewer's probes (rv2-319 probe1-4) as layer-1 cases, and the round's fixes.
//   1 HIGH   real finds got "taken back": a find's day, time or venue said in Cue's own words had no source, because the offer source
//            check and the audit never saw what searchEvents found mid-call. Finds now carry when and venue (callLedger FoundOnCall),
//            feed unsourcedInCall and the audit prompt; the real invented line is no longer crowded out of the cap of two.
//   2 MED-HI one shared word excused an invented event. A correction is excused only when it names the thing: most of its distinctive
//            words (about 60%), whole words, never a day, time, city or kind of event alone.
//   3 MED    the reply path still corrected real things: an unread ledger writes no corrections; a row the follow-up finds is about
//            something done or found is retired and never feeds a reply.
//   4 MED-LO no double correction: Cue replied since the call, so the follow-up doesn't carry it.
//   5 LOW    the follow-up's done list is this call's own window.
// Layer 1: pure functions and the real reads on a fake store. Zero tokens, no DB, nothing sent.
//   npx tsx evals/calls/correctionProbes.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { default: pool } = await import("../../src/db/db.js");
const G = await import("../../src/harness/callGrounding.js");
const L = await import("../../src/services/callLedger.js");
const O = await import("../../src/services/offerGuard.js");
const PC = await import("../../src/jobs/postCallFollowUp.js");
const CT = await import("../../src/services/callTools.js");
const { callKey } = await import("../../src/services/callKey.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const quiet = <T>(fn: () => Promise<T>): Promise<T> => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; return fn().finally(() => { console.error = e; console.log = l; }); };

const send = (name: string, url: string) => ({ kind: "send", label: `the link to ${name} (${url})`, names: [name], urls: [url] });
const jazz = send("Rooftop Jazz Night at The Chapel", "https://lu.ma/jazz");
const supper = { name: "Founders Supper at Tartine Manufactory", url: "https://lu.ma/fs" };

// ================================================================ probe1 (a): real things are never "corrected"
{
  const refused = (label: string, v: string | null) => check(`probe1 ${label}: refused (it was done or found)`, !!v, v);
  refused("a1 a sent claim naming part of what was sent", G.correctionDoneOnCall({ quote: "I sent you the rooftop jazz one" }, [jazz]));
  refused("a2 most of the sent item's words, venue in the specifics", G.correctionDoneOnCall({ quote: "There's a jazz thing at the Chapel Friday", specifics: ["Chapel", "Friday"] }, [jazz]));
  refused("a3 its link without the scheme", G.correctionDoneOnCall({ quote: "it's at lu.ma/jazz", specifics: ["lu.ma/jazz"] }, [jazz]));
  refused("a4 its link, from the owed-send line", G.correctionDoneOnCall({ quote: "I texted you https://lu.ma/jazz", specifics: [] }, ["sent the link https://lu.ma/jazz right after the call"]));
  refused("a5b a deck by its title", G.correctionDoneOnCall({ quote: "Your Seed Pitch deck is done", specifics: ["Seed Pitch"] }, ['the link to their deck "Seed Pitch v3" (https://cue.page/d/abc)']));
  refused("a9 a find by its name", G.correctionDoneOnCall({ quote: "There's a founders supper at Tartine Manufactory on Thursday", specifics: ["Tartine Manufactory", "Thursday"] }, [], [supper]));
  refused("a12 a sent claim against the owed-send line", G.correctionDoneOnCall({ quote: "I texted you the jazz link", specifics: ["jazz"] }, ["sent the link https://lu.ma/jazz right after the call"]));
  const deck = G.doneItemFromLine('the link to their deck "Seed Pitch v3" (https://cue.page/d/abc)');
  check("probe1 a5 a deck's label parses to its title and link", deck.names[0] === "Seed Pitch v3" && deck.urls[0] === "https://cue.page/d/abc", deck);
  const parens = G.doneItemFromLine("the link to Jazz (Live) at Chapel (https://lu.ma/x)");
  check("probe1 a6 a name with parentheses keeps them", parens.names[0] === "Jazz (Live) at Chapel" && parens.urls[0] === "https://lu.ma/x", parens);
  const wiki = G.doneItemFromLine("the link to Foo (https://en.wikipedia.org/wiki/Foo_(bar))");
  check("probe1 a7 a link with parentheses keeps them", wiki.urls[0] === "https://en.wikipedia.org/wiki/Foo_(bar)" && wiki.names[0] === "Foo", wiki);
  const bare = G.doneItemFromLine("the link https://lu.ma/x");
  check("probe1 a8 a nameless label parses to its link", bare.kind === "send" && bare.urls[0] === "https://lu.ma/x", bare);
  // Known limit (in the PR): a one-word or loose paraphrase of a real find is not excused by code (the audit, which now sees the finds,
  // is what reads it as real); excusing on one word is what let invented events through (item 2).
  check("probe1 a10/a11 a loose paraphrase or one word of a find is not excused by code (known limit)", G.correctionDoneOnCall({ quote: "that supper at Tartine is worth going to", specifics: null }, [], [supper]) === null && G.correctionDoneOnCall({ quote: "the Tartine thing", specifics: ["Tartine"] }, [], [supper]) === null);
}

// ================================================================ probe1 (b) and probe4: invented things are corrected, never excused on one word
{
  const found = [{ name: "San Francisco Startup Mixer", url: "https://lu.ma/sfm" }, { name: "Rooftop Jazz Night", url: "https://lu.ma/j" }, { name: "Parkside Social Club", url: "https://lu.ma/p" }, { name: "Mixer", url: "https://lu.ma/m" }];
  const corrected = (label: string, v: string | null) => check(`${label}: corrected (nothing real names it)`, v === null, v);
  corrected("probe1 b1 a city shared with a find", G.correctionDoneOnCall({ quote: "There's a San Francisco founders dinner Thursday at 7", specifics: ["San Francisco", "Thursday", "7"] }, [], found));
  corrected("probe1 b2 one genre word shared with a find", G.correctionDoneOnCall({ quote: "Zeitgeist has a jazz brunch Sunday", specifics: ["Zeitgeist", "Jazz", "Sunday"] }, [], found));
  corrected("probe1 b3 a word inside another ('Park' in 'Parkside')", G.correctionDoneOnCall({ quote: "Meet at the park on Sunday", specifics: ["Park", "Sunday"] }, [], found));
  corrected("probe1 b4 a find named only by a kind of event ('Mixer')", G.correctionDoneOnCall({ quote: "There's a designer mixer at Soho House tomorrow", specifics: ["Soho House", "tomorrow"] }, [], found));
  corrected("probe1 b5 'Night' shared with a find", G.correctionDoneOnCall({ quote: "The Night Market in Oakland is Saturday", specifics: ["Night Market", "Oakland", "Saturday"] }, [], found));
  corrected("probe1 b5b 'night' alone", G.correctionDoneOnCall({ quote: "There's a comedy night Saturday", specifics: ["night", "Saturday"] }, [], found));
  corrected("probe1 b7 a sent claim for something that wasn't sent", G.correctionDoneOnCall({ quote: "I've texted you the gallery opening link", specifics: ["gallery opening"] }, [jazz]));
  const task = { kind: "did", label: "took on a task for them: book the private room at Tartine", names: [], urls: [] };
  corrected("probe1 b8 a capability claim beside a task taken on", G.correctionDoneOnCall({ quote: "I can book the private room for you", specifics: null }, [task]));
  corrected("probe1 b9 a promise it can't keep beside a task taken on", G.correctionDoneOnCall({ quote: "I'll book the private room before the weekend", specifics: null }, [task]));
  corrected("probe1 b10 a search's query label", G.correctionDoneOnCall({ quote: "I found a jazz night Friday at Black Cat", specifics: ["Black Cat", "Friday"] }, [{ kind: "read", label: "jazz, Friday", names: [], urls: [] }]));
  corrected("a different kind of event than the one sent ('Founders Dinner' vs the Founders Breakfast link)", G.correctionDoneOnCall({ quote: "There's a Founders Dinner on Thursday.", specifics: ["Founders Dinner"] }, [send("Founders Breakfast", "https://lu.ma/fb")]));
  check("the same kind and name is still the real send", !!G.correctionDoneOnCall({ quote: "The Founders Breakfast is the one I meant.", specifics: ["Founders Breakfast"] }, [send("Founders Breakfast", "https://lu.ma/fb")]));
  const found4 = [{ name: "Thursday Night Jazz at Black Cat", url: "https://lu.ma/t" }, { name: "Oakland First Fridays", url: "https://lu.ma/o" }];
  corrected("probe4 an invented dinner sharing a day with a find", G.correctionDoneOnCall({ quote: "There's a founders dinner at Nopa on Thursday at 7.", specifics: ["Nopa", "Thursday", "7"] }, [], found4));
  corrected("probe4 an invented rooftop sharing a city and a day", G.correctionDoneOnCall({ quote: "Oakland has a rooftop mixer Friday.", specifics: ["Oakland", "Friday"] }, [], found4));
  const plan = G.planCallAudit([{ quote: "There's a founders dinner at Nopa on Thursday at 7.", type: "invented_fact", what: "no source", specifics: ["Nopa", "Thursday", "7"] }], "assistant: There's a founders dinner at Nopa on Thursday at 7.\nuser: cool", { knownBefore: "", records: "", tasks: [], doneOnCall: [], foundOnCall: found4 });
  check("probe4 the audit saves it", plan.corrections.length === 1 && !plan.refused.length, plan);
  // A real find, a wrong day: listed for Friday, said Saturday. Corrected when the listing says when; excused when it doesn't (limit).
  const listed = [{ name: "Rooftop Jazz Night", url: "https://lu.ma/j", when: '"Rooftop Jazz Night" starts Friday, October 31 at 8:00 PM and ends 11:00 PM (America/Los_Angeles).', venue: null }];
  check("probe1 b6 a real find's wrong day, its listing known: corrected", G.correctionDoneOnCall({ quote: "Rooftop Jazz Night is Saturday", specifics: ["Saturday"] }, [], listed) === null);
  check("a real find's listed day and time: excused", !!G.correctionDoneOnCall({ quote: "Rooftop Jazz Night is Friday at 8pm", specifics: ["Friday", "8pm"] }, [], listed));
  check("probe1 b6 its listing unknown: excused (known limit)", !!G.correctionDoneOnCall({ quote: "Rooftop Jazz Night is Saturday", specifics: ["Saturday"] }, [], found));
}

// ================================================================ probe2: a find's own day, time and venue, said by Cue, are sourced; the invented swap is caught
{
  const turns = [
    { role: "user", message: "Anything fun this weekend? I love live music." },
    { role: "agent", message: "Let me look. I found Rooftop Jazz Night at The Chapel. It's on Friday at 8pm, and tickets are twenty dollars. Want me to text you the link?" },
    { role: "user", message: "Yes please." },
    { role: "agent", message: "Done, it's in your texts. The show runs till 11pm." },
    { role: "agent", message: "There's also a vinyl swap at Amoeba on Saturday at 2pm." },
  ];
  // What searchEvents returned on the call, as services/eventDetails.ts renders a listing.
  const result = { events: [{ name: "Rooftop Jazz Night at The Chapel", link: "https://lu.ma/jazz", details: ['"Rooftop Jazz Night at The Chapel" starts Friday, October 31 at 8:00 PM and ends 11:00 PM (America/Los_Angeles).', '"Rooftop Jazz Night at The Chapel" is at The Chapel, 777 Valencia St.', "$20."] }] };
  const fi = CT.foundIn(result);
  check("a find keeps its when and venue from the listing", fi.length === 1 && /starts Friday, October 31 at 8:00 PM and ends 11:00 PM/.test(fi[0].when ?? "") && /is at The Chapel/.test(fi[0].venue ?? ""), fi);
  const found = fi.map((f) => ({ name: f.name, url: f.url, when: f.when, venue: f.venue }));
  // Through the ledger and back, as the audit reads it.
  const ledger = L.ledgerFromRows([{ decision: "call.done_on_call", action: "searchEvents", proposal: { kind: "read", labels: ["live music, this weekend"], urls: [], names: [], found }, created_at: new Date() }]);
  check("the ledger keeps the find's when and venue", JSON.stringify(L.foundOnCall(ledger)) === JSON.stringify(found), L.foundOnCall(ledger));
  const lines = L.foundLines(found);
  check("the find as a source line carries its spoken times", /\[8pm, 8 pm, 11pm, 11 pm\]/.test(lines[0]) && /The Chapel/.test(lines[0]), lines);
  const given = { firstName: "Jordan", contextSummary: "", findsNow: "", rightNow: "" };
  const before = O.unsourcedInCall(turns, given);
  check("without the finds (the bug): the find's own time and end time read as made up", before.some((f) => /8pm/.test(f.sentence)) && before.some((f) => /11pm/.test(f.sentence)), before);
  const flags = O.unsourcedInCall(turns, { ...given, foundOnCall: lines.join("\n") });
  check("with the finds: only the invented swap is flagged", flags.length === 1 && /Amoeba/.test(flags[0].sentence), flags);
  const transcript = turns.map((t) => `${t.role === "agent" ? "assistant" : "user"}: ${t.message}`).join("\n");
  const done = [send("Rooftop Jazz Night at The Chapel", "https://lu.ma/jazz"), { kind: "read", label: "live music, this weekend", names: [], urls: [] }];
  const plan = G.planCallAudit([], transcript, { knownBefore: "", records: "", tasks: [], doneOnCall: done, foundOnCall: found, offerFlags: flags });
  check("the audit saves only the swap", plan.corrections.length === 1 && /Amoeba/.test(plan.corrections[0].quote), plan.corrections.map((c) => c.quote));
  // The cap of two never crowds the invented one out: the invented sentence comes third on the call, after two about the real find.
  // Before the fix all three were saved and the first two filled the cap; now only the swap is saved, and it rides. A row naming the
  // find saved before this fix is retired at the follow-up, never carried.
  const key = "k-probe2";
  const toRow = (id: string, c: { quote: string; specifics?: string[] | null }) => G.parseCallCorrection({ id, content: JSON.stringify({ quote: c.quote, type: "invented_fact", note: "no source", call_key: key, source: "offer_source", specifics: c.specifics ?? [] }) })!;
  const before3 = G.planCallAudit([], transcript, { knownBefore: "", records: "", tasks: [], doneOnCall: done, foundOnCall: [], offerFlags: before });
  check("the bug, for the record: without the finds the swap came third, behind two about the real find", before3.corrections.length === 3 && /Amoeba/.test(before3.corrections[2].quote), before3.corrections.map((c) => c.quote));
  const rows = [toRow("old", { quote: "Rooftop Jazz Night at The Chapel runs till 11pm.", specifics: ["Rooftop Jazz Night at The Chapel", "11pm"] }), ...plan.corrections.map((c, i) => toRow(`r${i}`, c))];
  const p = G.planCarry(rows, key, [], (s) => s, { items: done, found });
  check("the invented sentence third: it rides; the real-find row is retired", p.carry.length === 1 && /Amoeba/.test(p.carry[0].quote) && p.retire.map((r) => r.id).join() === "old", p);
  check("the audit prompt lists the finds with when and where", /What Cue's searches found DURING the call[\s\S]*Rooftop Jazz Night at The Chapel[\s\S]*8:00 PM[\s\S]*The Chapel/.test(G.callAuditPrompt(transcript, "", undefined, done, found)));
  check("no finds: the audit prompt is today's, word for word", G.callAuditPrompt(transcript, "", undefined, done, []) === G.callAuditPrompt(transcript, "", undefined, done));
}

// ================================================================ 3, 4, 5: retire, held, no double correction, the call's window
type Mem = { id: string; user_id: string; memory_type: string; content: string };
const mem: Mem[] = [];
const decisions: any[] = [];
let seq = 0;
const answer = async (sql: string, params: any[] = []) => {
  const q = String(sql).trim().replace(/\s+/g, " ");
  if (/^INSERT INTO co_memories \(user_id, memory_type, content\)/i.test(q)) { const id = `m${++seq}`; mem.push({ id, user_id: params[0], memory_type: params[1], content: params[2] }); return { rows: [{ id }] }; }
  if (/^UPDATE co_memories SET content = \$3 WHERE id = \$1 AND user_id = \$2 AND memory_type = 'call_correction'/i.test(q)) { const r = mem.find((m) => m.id === params[0] && m.user_id === params[1]); if (r) r.content = params[2]; return { rows: [], rowCount: r ? 1 : 0 }; }
  if (/^INSERT INTO harness_decisions/i.test(q)) { decisions.push(params); return { rows: [] }; }
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(q)) return { rows: [] };
  const mine = (u: string) => mem.filter((m) => m.user_id === u && m.memory_type === "call_correction");
  if (/id::text = ANY/i.test(q)) return { rows: mine(params[0]).filter((m) => (params[1] as string[]).includes(m.id)) };
  if (/AND content NOT LIKE '%"retired_at":%' ORDER BY created_at DESC LIMIT 3/i.test(q)) return { rows: mine(params[0]).filter((m) => !m.content.includes('"retired_at":')).reverse().slice(0, 3) };
  return { rows: [] };
};
const realQuery = pool.query;
(pool as any).query = answer;
try {
  const T = "assistant: There's a founders supper at Tartine Manufactory on Thursday at 7.\nuser: ok";
  const INV: G.CallClaim = { quote: "There's a founders supper at Tartine Manufactory on Thursday at 7.", type: "invented_fact", what: "no source", specifics: ["Tartine Manufactory", "Thursday"] };
  // 3a: the ledger unread: no correction is written, and the record says why.
  await quiet(() => G.auditCall("u-a", T, { facts: "", impressions: "" }, { claims: [INV], tasks: [], correctionsHeld: "the call's done list couldn't be read" }));
  check("3 the ledger unread: no correction written", !mem.some((m) => m.memory_type === "call_correction"), mem);
  check("3 and the record says they were held, and why", decisions.some((d) => JSON.stringify(d).includes("corrections_held") && JSON.stringify(d).includes("done list couldn't be read")), decisions.map((d) => JSON.stringify(d).slice(0, 200)));
  const cg = src("harness/callGrounding.ts");
  check("3 the promises are still kept when corrections are held (only the correction write is gated)", cg.indexOf("for (const p of plan.promises)") < cg.indexOf("for (const c of opts.correctionsHeld ? [] : corrections)") && !/correctionsHeld[^\n]*plan\.promises/.test(cg));
  // 3b: a row about a real find is retired and never feeds a reply.
  await quiet(() => G.auditCall("u-a", T, { facts: "", impressions: "" }, { claims: [INV], tasks: [] }));
  const rows = mem.filter((m) => m.memory_type === "call_correction").map((m) => G.parseCallCorrection(m)!);
  check("3 the row keeps the audit's specifics", JSON.stringify(rows[0]?.specifics) === JSON.stringify(["Tartine Manufactory", "Thursday"]), rows);
  check("3 before: the reply path has it", (await G.recentCallCorrections("u-a")).some((l) => /Tartine/.test(l)));
  const p = G.planCarry(rows, callKey(T), [], (s) => s, { items: [], found: [supper] });
  check("3 the follow-up finds it was a real find: retire, never carry", p.carry.length === 0 && p.retire.length === 1 && /found on the call/.test(p.retire[0].why), p);
  await G.retireCallCorrections("u-a", p.retire);
  check("3 retired: the reply path never gets it", !(await G.recentCallCorrections("u-a")).some((l) => /Tartine/.test(l)));
  check("3 retired rows are skipped, never carried again", G.planCarry(mem.filter((m) => m.memory_type === "call_correction").map((m) => G.parseCallCorrection(m)!), callKey(T), [], (s) => s, { items: [], found: [] }).carry.length === 0);
  check("3 another member's row is never retired by this one", (await G.retireCallCorrections("u-b", [{ id: rows[0].id, why: "x" }])) === 0);
  check("3 the done list unread at the follow-up: nothing carried, nothing retired", JSON.stringify(G.planCarry(rows, callKey(T), [], (s) => s, null)) === JSON.stringify({ carry: [], retire: [] }));
} finally {
  // Left on the fake store: the memory embeddings auditCall starts finish after this block (a dead database would log them).
  void realQuery;
}
{
  const end = new Date("2026-10-30T18:00:00Z");
  const at = (min: number) => new Date(end.getTime() + min * 60_000).toISOString();
  check("4 they texted and Cue replied since the call: the follow-up carries none", PC.repliedSinceCall([{ from: "member", call: false, verifiedAt: at(5) }, { from: "co", call: false, verifiedAt: at(6) }], end));
  check("4 only Cue's confirmation since the call: not a reply", !PC.repliedSinceCall([{ from: "co", call: false, verifiedAt: at(1) }], end));
  check("4 they texted, no reply yet: not a reply", !PC.repliedSinceCall([{ from: "member", call: false, verifiedAt: at(5) }], end));
  check("4 a reply before the call ended doesn't count", !PC.repliedSinceCall([{ from: "member", call: false, verifiedAt: at(-30) }, { from: "co", call: false, verifiedAt: at(-29) }], end));
  check("4 the call's own lines don't count", !PC.repliedSinceCall([{ from: "member", call: true, verifiedAt: at(1) }, { from: "co", call: true, verifiedAt: at(2) }], end));
  const pc = src("jobs/postCallFollowUp.ts");
  check("4 wired: no layer read or a reply since the call means none ride (code, no copy)", /if \(!k \|\| repliedSinceCall\(k\.exchanges, new Date\(callAt\.getTime\(\) - 2 \* 60_000\)\)\) return \[\];/.test(pc));
  const callAt = new Date("2026-10-30T18:00:00Z");
  check("5 no earlier call: three hours back", PC.callWindowStart(callAt, null).getTime() === callAt.getTime() - 3 * 3_600_000);
  check("5 an earlier call that day: just after its follow-up row", PC.callWindowStart(callAt, new Date("2026-10-30T17:10:00Z")).getTime() === new Date("2026-10-30T17:10:00Z").getTime() + 1);
  check("5 an earlier call long before: still three hours back", PC.callWindowStart(callAt, new Date("2026-10-30T09:00:00Z")).getTime() === callAt.getTime() - 3 * 3_600_000);
  check("5 wired: the ledger and owed sends are read from the window start", /const since = callWindowStart\(callAt, prev\[0\]\?\.at/.test(pc) && /readCallLedger\(userId, since,/.test(pc) && /\[userId, since, new Date\(callAt\.getTime\(\) \+ 30 \* 60_000\)\]/.test(pc));
}

console.log(`call correction probes (review round 2): ${total - failed}/${total} passed`);
if (failed) process.exit(1);
