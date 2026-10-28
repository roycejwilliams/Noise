// A draft that speaks for the member is checked before they see it (Royce, 2026-10-27: Cue checks its work first; the member isn't QA
// for a wrong date or headcount). 2026-10-28, Royce: the check is a meaning-based judge against the original evidence
// (services/draftFacts.ts), not the regex comparison; these replace the regex tests. Layer 1: the real draftEmail with a fake send
// and a stubbed judge, zero tokens.
//   npx tsx evals/review/drafts.ts
const { default: pool } = await import("../../src/db/db.js");
const ME = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000009";
// Every query the tool makes, and what it was keyed by. A query for anyone but ME is answered with the other member's words, so a
// source that wasn't keyed to this member would carry them into the evidence.
const queries: { sql: string; params: unknown[] }[] = [];
(pool as any).query = async (sql: string, params: unknown[] = []) => {
  queries.push({ sql, params });
  const mine = params.includes(ME);
  if (/FROM co_memories/.test(sql)) {
    return mine
      ? { rows: [
          { memory_type: "text_exchange", content: "User said: thinking dinner at 7 on saturday, 8 of us", created_at: "2026-10-26T02:00:00Z" },
          { memory_type: "call_transcript", content: "Cue: who's coming?\nUser: my sister flies in from nyc", created_at: "2026-10-25T18:00:00Z" },
        ] }
      : { rows: [{ memory_type: "text_exchange", content: "User said: OTHERMEMBER Napa trip for 40", created_at: "2026-10-26T02:00:00Z" }] };
  }
  if (/FROM users/.test(sql)) return { rows: [mine ? { first_name: "Jordan", last_name: "Lee", phone_number: "+14155550123", email: "jordan92@example.com" } : { first_name: "OTHERMEMBER", phone_number: "+19998887777", email: "other@example.com" }] };
  // Cue's own notes: never evidence for Cue's own draft.
  if (/FROM search_briefs/.test(sql)) return { rows: [{ brief: { kind: "venue", what: "BRIEFTOKEN dinner", headcount: 99, city: "BRIEFCITY", when: null, budget: null, area: null, vibe: null, summary: "", queries: [], sites: [], ask: null } }] };
  return { rows: [] };
};
const LT = await import("../../src/agent/loopTools.js");
const DF = await import("../../src/services/draftFacts.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `  :: ${JSON.stringify(detail).slice(0, 300)}` : ""}`); } };

const prompts: string[] = [];
const facts: string[] = [];
const run = async (body: string, judge: (p: string) => Promise<any>, pages: [string, string][] = []) => {
  DF.setDraftFactsJudgeForTest(async (p) => { prompts.push(p); return judge(p); });
  const state = { sent: false, sentMessages: [] as string[] };
  const loop = LT.newLoopState();
  for (const [u, t] of pages) loop.pages.set(u, t);
  const ctx: any = {
    userId: ME, phoneNumber: "+14155550123", firstName: "Jordan",
    resolvedContent: "can you write the venue a note asking about the back room?", turn: { message: "" }, dryRun: true,
    facts: { add: (_k: string, t: string) => facts.push(t), text: () => "" },
    sendCoReply: async () => true,
  };
  const errs: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = () => {};
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    const r: any = await LT.loopTools(ctx, state, loop, () => {}).draftEmail.execute({ subject: "Back room on Saturday", body, why: "they asked" } as any, { toolCallId: "t", messages: [] });
    return { r, sent: state.sentMessages, errs };
  } finally {
    console.log = log;
    console.error = err;
  }
};
const VENUE: [string, string] = ["https://thebackroom.example/private", "The Back Room. Private room seats up to 14. Open 5pm to 11pm. Contact events@thebackroom.example"];

// 1. What the judge reads: their own words verbatim and what was read, never the brief.
{
  prompts.length = 0;
  queries.length = 0;
  await run("Hi, could we book the back room for 8 people this Saturday at 7? Thanks, Jordan Lee, (415) 555-0123", async () => ({ unestablished: [] }), [VENUE]);
  const p = prompts[0] ?? "";
  check("the judge reads their message this turn, verbatim", p.includes("can you write the venue a note asking about the back room?"), p.slice(0, 200));
  check("... and their earlier texts and their side of calls, verbatim and dated", /\[\w{3} \w{3} \d{1,2}\] thinking dinner at 7 on saturday, 8 of us/.test(p) && p.includes("my sister flies in from nyc") && !p.includes("who's coming?"));
  check("... and the page read this turn, as it was", p.includes("Private room seats up to 14. Open 5pm to 11pm."));
  check("... and their own name, phone and email on file, as theirs", /Their own details on file: name: Jordan Lee; phone: \+14155550123; email: jordan92@example\.com/.test(p));
  check("... and the draft itself, whole: their phone isn't cut out first, so a number beside it can't be swallowed with it (review of #286)", p.includes("for 8 people this Saturday at 7? Thanks, Jordan Lee, (415) 555-0123"));
  check("never Cue's brief: its own notes can't back its own draft", !/BRIEFTOKEN|BRIEFCITY|"headcount"|99/.test(p));
  check("the rule for am/pm is stated: a bare time never establishes the part of the day", p.includes(`"Dinner at 7" establishes 7pm; "at 7" alone does not.`));
  check("today's date and their zone are given, with a calendar to read weekdays off", /Today is \w+day, \w+ \d{1,2}, 20\d\d in the member's time zone/.test(p) && /\(today\)/.test(p));
}

// 2. What the judge finds is what's enforced, as it said it; nothing it passes is refused by code.
{
  const held = await run("Hi, could we book the back room for 8 people this Saturday at 7pm, in the Marina? Thanks", async () => ({ unestablished: [{ words: "7pm", kind: "time", why: "they said 7, never pm" }, { words: "in the Marina", kind: "place", why: "no place named" }] }), [VENUE]);
  check("a draft with details the judge names is held, naming each in its words and why", held.r?.ok === false && /"7pm" \(they said 7, never pm\)/.test(held.r.error) && /"in the Marina"/.test(held.r.error), held.r);
  check("... and nothing of it reached them", held.sent.length === 0, held.sent);
  const passes = await run("Hi, could we book the back room for eight on Saturday, October 31 at 7 PM? Thanks", async () => ({ unestablished: [] }), [VENUE]);
  check("a draft the judge finds fully established goes (no code check second-guesses 'eight' or 'October 31')", passes.r?.ok === true && passes.sent.some((s) => s.includes("for eight on Saturday, October 31")), passes.r);
  const dup = await DF.checkDraftFacts("x", { thisTurn: "", earlier: "", own: {}, read: [] }, new Date(), "America/Los_Angeles", async () => ({ unestablished: [{ words: " 12 ", kind: "count", why: "" }, { words: "12", kind: "count", why: "again" }, { words: "", kind: "other", why: "" }] }));
  check("findings are deduped and trimmed, empty ones dropped", dup.ran === true && dup.gaps.length === 1 && dup.gaps[0].words === "12", dup);
}

// 3. A judge that can't answer never blocks the draft, and nothing says it was checked.
{
  facts.length = 0;
  const down = await run("Hi, could we book the back room for 8 this Saturday? Thanks", async () => { throw new Error("timeout"); }, [VENUE]);
  check("a failed judge call lets the draft go to them", down.r?.ok === true && down.sent.length > 0, down.r);
  check("... recorded as not run in the log", down.errs.some((e) => /fact check didn't run \(timeout\)/.test(e)), down.errs);
  check("... and nothing claims it was checked", !/check/i.test(JSON.stringify(down.r)) && !facts.some((f) => /check/i.test(f)), { r: down.r, facts });
  const odd = await run("Hi, back room for 8 this Saturday?", async () => ({ nope: true }), [VENUE]);
  check("an answer in the wrong shape is a check that didn't run, not a pass", odd.r?.ok === true && odd.errs.some((e) => /didn't run/.test(e)), odd);
  const direct = await DF.checkDraftFacts("x", { thisTurn: "", earlier: "", own: {}, read: [] }, new Date(), "America/Los_Angeles", async () => { throw new Error("boom"); });
  check("checkDraftFacts says ran: false when the judge throws", direct.ran === false && /boom/.test((direct as any).error), direct);
}

// 4. Nothing from another member enters the evidence: every read is keyed to this member.
{
  prompts.length = 0;
  queries.length = 0;
  await run("Hi, back room for 8 this Saturday?", async () => ({ unestablished: [] }), [VENUE]);
  const p = prompts[0] ?? "";
  check("no other member's words or details reach the judge", !/OTHERMEMBER|Napa|9998887777|other@example/.test(p));
  const reads = queries.filter((q) => /\bSELECT\b/i.test(q.sql));
  const ids = reads.flatMap((q) => q.params.filter((x) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x)));
  check("every read the draft check makes is keyed to this member", reads.length > 0 && ids.length > 0 && ids.every((x) => x === ME), reads.map((q) => [q.sql.slice(0, 60), q.params]));
}

// 5. Pure parts: the evidence limits, and the dated words.
{
  const L = DF.DRAFT_EVIDENCE_LIMITS;
  const b = DF.boundEvidence({ thisTurn: "t".repeat(L.thisTurn + 50), earlier: `old line\n${"e".repeat(L.earlier)}\nnewest`, own: {}, read: ["p".repeat(L.perSource + 10), "q".repeat(L.perSource), "r".repeat(L.perSource), "s".repeat(10)] });
  check("evidence is held to its limits, earlier texts keeping the newest", b.thisTurn.length === L.thisTurn && b.earlier.length <= L.earlier && b.earlier.endsWith("newest") && b.read[0].length === L.perSource && b.read.join("").length <= L.read, b.read.map((x) => x.length));
  const cal = DF.calendarLines(new Date("2026-10-28T18:00:00Z"), "America/Los_Angeles");
  check("the calendar reads weekdays off a list (Oct 31 2026 is a Saturday; today marked)", cal.includes("Sat Oct 31 2026") && cal.includes("Wed Oct 28 2026 (today)"), cal.slice(0, 120));
  const { loadTheirWords } = await import("../../src/services/documentDelivery.js");
  const plain = await loadTheirWords(ME);
  const dated = await loadTheirWords(ME, { zone: "America/Los_Angeles" });
  check("their words dated in their zone for the draft check, unchanged for documents", dated.includes("[Sun Oct 25] thinking dinner at 7") && !/\[/.test(plain), { plain, dated });
}

DF.setDraftFactsJudgeForTest(null);
console.log(`drafts: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
