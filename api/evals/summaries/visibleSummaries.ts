// Daily notes in what Cue knows (services/whatCoKnows.ts, services/daySummaries.ts; Royce 2026-11-06, ruling 5: visible knowledge is
// all of it, ruling B: removed = the text deleted, the fingerprint kept). Layer 1: one fake database that answers the statements the
// code issues (filtered by the member it is given), a stubbed removal read, zero tokens. Invented members: Jordan (the member) and
// Priya (another member, whose notes and name must never reach Jordan).
//   TZ=UTC npx tsx evals/summaries/visibleSummaries.ts
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
delete process.env.MONITORING_ENABLED;
delete process.env.DEV_REVIEW;
const { default: pool } = await import("../../src/db/db.js");
const D = await import("../../src/services/daySummaries.js");
const W = await import("../../src/services/whatCoKnows.js");
// Which lines a message asks to remove is its own read (services/theirYes.ts judgeRemoval, evals/forget/removalLines.ts): here every
// line Cue picked is one they asked for, so the checks are about what the removal does.
(await import("../../src/services/theirYes.js")).setRemovalJudgeForTests(async (r) => ({ read: true, answers: r.lines.map(() => "yes" as const) }));

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => {
  total++;
  if (!ok) { failed++; console.log(`FAIL ${label}${detail !== "" ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); }
};

const JORDAN = "00000000-0000-4000-8000-00000000a101";
const PRIYA = "00000000-0000-4000-8000-00000000b202";
type Mem = { id: string; user_id: string; memory_type: string; content: string; created_at: Date };
type Sum = { id: string; user_id: string; day: string; zone: string | null; summary: string; status: string; source_ids: string[]; source_stamp: string; model: string };
const mems: Mem[] = [];
const sums: Sum[] = [];
const corrections: { user_id: string; field: string; old_value: string; new_value: string | null; item_ref: string; removed: boolean }[] = [];
const said: { sql: string; args: any[] }[] = [];
let seq = 0, sumSeq = 0;
const longText = (s: string) => `${s} ${"and we talked it over for a while, ".repeat(9)}`;
const mem = (user_id: string, at: string, content: string) => { const m = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, user_id, memory_type: "text_exchange", content, created_at: new Date(at) }; mems.push(m); return m; };
// A stored note built from its rows the way the job builds one (no guards on file when it was written).
const note = (user_id: string, day: string, summary: string, src: Mem[], status = "ok", stamp?: string) => {
  sums.push({ id: `sum-${++sumSeq}`, user_id, day, zone: "America/Los_Angeles", summary, status, source_ids: src.map((m) => m.id), source_stamp: stamp ?? D.stampOf(src, []), model: "haiku" });
};

const handle = async (sqlIn: string, args: any[] = []) => {
  const sql = String(sqlIn);
  said.push({ sql, args });
  const u = args[0];
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };
  // Another member's first name, as a name Jordan was told (the strip removes it from every line shown to Jordan).
  if (sql.includes("WITH my_pairs AS")) return { rows: u === JORDAN ? [{ first_name: "Priya" }] : [], rowCount: 0 };
  if (/FROM profile_corrections/.test(sql)) return { rows: corrections.filter((c) => c.user_id === u).reverse().map((c) => ({ field: c.field, old_value: c.old_value, new_value: c.new_value, item_ref: c.item_ref, removed: String(c.removed) })), rowCount: 0 };
  if (/INSERT INTO profile_corrections/.test(sql)) { corrections.push({ user_id: u, field: args[1], old_value: args[2], new_value: args[3], item_ref: args[5], removed: args[6] }); return { rows: [{ id: String(corrections.length) }], rowCount: 1 }; }
  if (/member_day_summaries/.test(sql)) {
    const mine = () => sums.filter((s) => s.user_id === u);
    if (/^\s*UPDATE member_day_summaries SET summary = ''/.test(sql)) {
      const hit = mine().filter((s) => s.day === args[1] && s.status === "ok");
      for (const s of hit) { s.summary = ""; s.status = "removed"; s.source_ids = []; }
      return { rows: [], rowCount: hit.length };
    }
    if (/^\s*DELETE FROM member_day_summaries/.test(sql)) {
      let n = 0;
      for (let i = sums.length - 1; i >= 0; i--) if (sums[i].user_id === u && (args[1] as string[]).includes(sums[i].id)) { sums.splice(i, 1); n++; }
      return { rows: [], rowCount: n };
    }
    if (/^\s*INSERT INTO member_day_summaries/.test(sql)) {
      const [user_id, day, zone, summary, status, source_ids, source_stamp, model] = args;
      if (!sums.some((s) => s.user_id === user_id && s.day === day)) sums.push({ id: `sum-${++sumSeq}`, user_id, day, zone, summary, status, source_ids, source_stamp, model });
      return { rows: [], rowCount: 1 };
    }
    if (/FROM users u\s+WHERE u\.archived_at/.test(sql)) {
      const ids = [...new Set(mems.filter((m) => +m.created_at >= +args[0] && +m.created_at < +args[1]).map((m) => m.user_id))].sort();
      return { rows: ids.map((user_id) => ({ user_id })), rowCount: 0 };
    }
    if (/^\s*SELECT 1 FROM member_day_summaries/.test(sql)) return { rows: mine().slice(0, 1).map(() => ({ x: 1 })), rowCount: 0 };
    // Every read of the table: its own member's rows, with the filters the statement says.
    let out = mine();
    if (/status = 'ok'/.test(sql)) out = out.filter((s) => s.status === "ok");
    if (/status <> 'removed'/.test(sql)) out = out.filter((s) => s.status !== "removed");
    if (/btrim\(summary\) <> ''/.test(sql)) out = out.filter((s) => s.summary.trim() !== "");
    if (/day < \$2::date/.test(sql)) out = out.filter((s) => s.day < args[1]);
    return { rows: [...out].sort((a, b) => b.day.localeCompare(a.day)), rowCount: 0 };
  }
  if (/FROM co_memories WHERE user_id = \$1 AND id = ANY/.test(sql)) return { rows: mems.filter((m) => m.user_id === u && (args[1] as string[]).includes(m.id)), rowCount: 0 };
  if (/FROM co_memories\s+WHERE user_id = \$1 AND memory_type IN \('text_exchange', 'call_transcript'\) AND created_at >= \$2/.test(sql)) {
    return { rows: mems.filter((m) => m.user_id === u && +m.created_at >= +args[1] && +m.created_at < +args[2]).sort((a, b) => +a.created_at - +b.created_at), rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};
(pool as any).query = handle;
(pool as any).connect = async () => ({ query: handle, release: () => {} });

// Jordan: two notes that stand, one blank record, one 'ok' row with nothing in it, one note whose source line changed since (stale),
// one that names another member. Priya: her own note.
const j1 = [mem(JORDAN, "2026-11-01T17:00:00Z", longText("User said: the studio lease renewal wants eighteen percent more"))];
const j2 = [mem(JORDAN, "2026-11-02T18:00:00Z", longText("User said: the kiln delivery came today and I am thrilled"))];
const j3 = [mem(JORDAN, "2026-11-03T18:00:00Z", longText("User said: errands all day, nothing much"))];
const j4 = [mem(JORDAN, "2026-10-31T18:00:00Z", longText("User said: the pottery market stall application"))];
const j5 = [mem(JORDAN, "2026-10-30T18:00:00Z", longText("User said: planning the open studio night"))];
const j6 = [mem(JORDAN, "2026-10-29T18:00:00Z", longText("User said: a quiet day at the wheel"))];
note(JORDAN, "2026-11-01", "They were weighing the studio lease renewal and planned to push back in writing.", j1);
note(JORDAN, "2026-11-02", "Their kiln was delivered and they were glad of it.", j2);
note(JORDAN, "2026-11-03", "", j3, "blank");
note(JORDAN, "2026-10-29", "   ", j6);
note(JORDAN, "2026-10-31", "They applied for a stall at the pottery market.", j4, "ok", "0000000000000000");
note(JORDAN, "2026-10-30", "They planned an open studio night with Priya.", j5);
const p1 = [mem(PRIYA, "2026-11-01T17:00:00Z", longText("User said: PRIYA-ONLY the glaze recipe for the spring show"))];
note(PRIYA, "2026-11-01", "PRIYA-ONLY: they worked on a glaze recipe for the spring show.", p1);
note(PRIYA, "2026-09-01", "PRIYA-ONLY: they priced the spring show.", [mem(PRIYA, "2026-09-01T17:00:00Z", longText("User said: PRIYA-ONLY pricing the spring show"))]);
// A note the strip rewrites into a false line ("Cue introduced them to Priya, another member"): never used anywhere.
note(JORDAN, "2026-10-27", "Cue offered to introduce them to Priya Shah at the pottery market.", [mem(JORDAN, "2026-10-27T18:00:00Z", longText("User said: who should I meet at the pottery market"))]);
// Ten older notes, so the member has more than the 8 lines a group usually shows.
for (let d = 1; d <= 10; d++) {
  const day = `2026-10-${String(d).padStart(2, "0")}`;
  note(JORDAN, day, `Older note ${d}: they worked on studio pieces for the fall.`, [mem(JORDAN, `${day}T18:00:00Z`, longText(`User said: studio pieces, day ${d}`))]);
}

const notesOf = async (who: string) => {
  const got = await W.whatCoKnows(who);
  return { got, lines: got.view.groups.find((g) => g.title === "Daily notes")?.lines ?? [], all: JSON.stringify(got) };
};

// ---- 1. entries appear
{
  const { got, lines } = await notesOf(JORDAN);
  const g = got.view.groups.find((x) => x.group === "notes");
  check("view: a 'Daily notes' group is shown", !!g && g.title === "Daily notes", got.view.groups.map((x) => x.title));
  check("view: each note is one line, '<date>: <summary>', newest first", lines.map((l) => l.text).slice(0, 2).join(" | ") === "2026-11-02: Their kiln was delivered and they were glad of it. | 2026-11-01: They were weighing the studio lease renewal and planned to push back in writing.", lines.map((l) => l.text));
  check("view: each note's ref is summary:<day>, and it can be removed or corrected", lines.every((l) => l.refs.length === 1 && /^summary:\d{4}-\d{2}-\d{2}$/.test(l.refs[0]) && l.canCorrect));
  check("view: the reply's fact line carries the notes (so text and calls both see them, the one tool both use)", W.knownFact(got.view).includes("Daily notes: 2026-11-02: Their kiln was delivered"));
}

// ---- 2. blank rows hidden, stale ones too
{
  const { lines } = await notesOf(JORDAN);
  const days = lines.map((l) => l.refs[0].slice("summary:".length));
  check("blank: a 'blank' record (a paid attempt that came back empty) is never a line", !days.includes("2026-11-03"), days);
  check("blank: an 'ok' row with nothing in it is never a line", !days.includes("2026-10-29") && lines.every((l) => /^\d{4}-\d{2}-\d{2}: \S/.test(l.text)), lines.map((l) => l.text));
  check("stale: a note whose source line changed since it was written is not shown", !days.includes("2026-10-31"), days);
  check("pure: knownItems never makes a line of a blank summary", W.knownItems({ profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], daySummaries: [{ day: "2026-11-04", summary: "  " }, { day: "2026-11-05", summary: "" }] }).length === 0);
}

// ---- 3. isolation across members, their side only
{
  const { lines, all } = await notesOf(JORDAN);
  check("isolation: Jordan never sees Priya's note", !/PRIYA-ONLY|glaze/.test(all));
  check("their side only: a note naming another member never shows that name", !/Priya/.test(lines.map((l) => l.text).join("\n")), lines.map((l) => l.text));
  const p = await notesOf(PRIYA);
  check("isolation: Priya sees only her own note", p.lines.length === 2 && p.lines.every((l) => /^\d{4}-\d{2}-\d{2}: PRIYA-ONLY/.test(l.text)) && !/kiln|lease/.test(p.all), p.lines.map((l) => l.text));
  const reads = said.filter((q) => /member_day_summaries/.test(q.sql));
  check("isolation: every read of the notes is scoped to one member (user_id = $1)", reads.length > 0 && reads.every((q) => /user_id = \$1/.test(q.sql) && (q.args[0] === JORDAN || q.args[0] === PRIYA)), reads.map((q) => q.sql.slice(0, 90)));
}

// ---- 3b. the view and the reply/call block make ONE decision: every note the block can use is a line the member can see
{
  const { lines } = await notesOf(JORDAN);
  const viewText = new Set(lines.map((l) => l.text.replace(/^\d{4}-\d{2}-\d{2}: /, "")));
  const strip = await (await import("../../src/services/memberSafeMemories.js")).memberSafeLine(JORDAN);
  const guards = await W.forgottenRows(JORDAN, { query: handle }, { all: true });
  const NOW = new Date("2026-11-06T18:00:00Z");
  const blockAt = async (windowOldest?: Date) => (await D.earlierSummaryBlock(JORDAN, { strip, guards, zone: "America/Los_Angeles", now: NOW, windowOldest }, { query: handle })).split("\n").slice(1).map((l) => l.replace(/^- [^:]*\): /, ""));
  const recent = await blockAt();
  const older = await blockAt(new Date("2026-10-07T18:00:00Z"));
  check("one decision: the block (recent window) uses notes, all of them lines in the view", recent.length >= 2 && recent.every((t) => viewText.has(t)), { recent, view: [...viewText] });
  check("one decision: the block (an older window, past the newest 8) uses only notes the view lists", older.length >= 3 && older.every((t) => viewText.has(t)), { older });
  check("all of it: more than 8 notes are all listed (every note the block could use is visible)", lines.length >= 12 && lines.some((l) => l.text.startsWith("2026-10-01: Older note 1")), lines.length);
  check("strip-changed: a note naming a member is in neither the view nor the block", ![...viewText, ...recent, ...older].some((t) => /Priya|another member|open studio night|introduce/.test(t)), { recent, older });
  // The pure decision itself: a note the strip would change in any way is skipped, never passed on as the rewrite.
  const rows = [{ id: "a", day: "2026-10-20", summary: "They planned an open studio night with Priya.", source_ids: [], source_stamp: D.stampOf([], []), status: "ok" }, { id: "b", day: "2026-10-21", summary: "They glazed mugs.", source_ids: [], source_stamp: D.stampOf([], []), status: "ok" }];
  const u = D.usableSummaries(rows, [], [], strip);
  check("one decision (pure): only the note the strip leaves whole is usable", u.usable.map((x) => x.id).join() === "b", u);
}

// ---- 4. a removal deletes the text, keeps the fingerprint, and blocks the day from being written again
{
  const before = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01")!;
  const stamp = before.source_stamp;
  const msg = "please remove your note about Nov 1";
  const r = await W.applyKnowledgeChanges(JORDAN, [{ action: "remove", refs: ["summary:2026-11-01"] }], { message: msg, theirWords: msg });
  const row = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01");
  check("remove: one gesture through applyKnowledgeChanges applies it", r.ok && r.applied.length === 1 && r.applied[0].source === "summary" && r.applied[0].now === null, r);
  check("remove: the note's text is deleted", !!row && row.summary === "" && row.status === "removed", row);
  check("remove: the day's fingerprint (its stamp) is kept", !!row && row.source_stamp === stamp);
  const c = corrections.find((x) => x.item_ref === "summary:2026-11-01");
  check("remove: recorded in the corrections record, as removed, holding the day and never the note's text", !!c && c.removed === true && c.new_value === null && !/lease|eighteen|writing/.test(c.old_value) && /2026-11-01/.test(c.old_value), c);
  const { lines } = await notesOf(JORDAN);
  check("remove: it is gone from what Cue knows at once", !lines.some((l) => l.refs.includes("summary:2026-11-01")) && lines.some((l) => l.refs.includes("summary:2026-11-02")), lines.map((l) => l.refs));
  check("remove: Priya's note on the same day is untouched", sums.find((s) => s.user_id === PRIYA && s.day === "2026-11-01")?.summary.startsWith("PRIYA-ONLY") === true);

  // The nightly job, over the same database: the removed day has sources enough to be written, but it is never paid for again. A day
  // with no record yet is written (the job did run), and the fingerprint survives its prune (its stamp no longer matches anything).
  const n1 = [mem(JORDAN, "2026-10-28T18:00:00Z", longText("User said: glazing tests for the new mugs"))];
  const asked: string[] = [];
  const deps: import("../../src/services/daySummaries.js").JobDeps = {
    db: { query: handle },
    now: new Date("2026-11-06T18:00:00Z"),
    summarize: async (userId, i) => { asked.push(`${userId}:${i.day}`); return { text: `They spent ${i.day} on studio work.`, inputTokens: 900, outputTokens: 60 }; },
    fenceFor: async () => ({ strip: (s: string) => s }),
    guardsFor: async (u) => W.forgottenRows(u, { query: handle }, { all: true }),
    zoneFor: async () => "America/Los_Angeles",
  };
  const res = await D.runDaySummaries(deps);
  check("regenerate: the removed day is never summarized again", !asked.includes(`${JORDAN}:2026-11-01`), asked);
  check("regenerate: a day with no record yet is written in the same run (the job ran)", asked.includes(`${JORDAN}:2026-10-28`) && sums.some((s) => s.user_id === JORDAN && s.day === "2026-10-28" && s.status === "ok"), { asked, n1: n1[0].id });
  const still = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01");
  check("regenerate: the fingerprint survives the job's prune and stays empty", !!still && still.status === "removed" && still.summary === "" && still.source_stamp === stamp, still);
  const again = await D.runDaySummaries(deps);
  check("regenerate: and not on the next run either", !asked.slice(-again.modelCalls).includes(`${JORDAN}:2026-11-01`) && sums.filter((s) => s.user_id === JORDAN && s.day === "2026-11-01").length === 1);
  check("spend log: the run counts its model calls and tokens", res.modelCalls === asked.length - again.modelCalls && res.inputTokens === 900 * res.modelCalls && res.outputTokens === 60 * res.modelCalls && res.modelCalls >= 1, res);
  check("spend log: the run's line carries counts, tokens and cost only", /^day summaries: \d+ model call\(s\), \d+ input \+ \d+ output tokens \(~\$\d+\.\d{4}\)/.test(D.runLogLine(res, { input: 0.1, output: 0.5 })) && !/studio|2026|0000/.test(D.runLogLine(res, { input: 0.1, output: 0.5 })), D.runLogLine(res, { input: 0.1, output: 0.5 }));
  // The removed day later gets a new line of conversation (a late-synced call, a backfilled text): the day is still never written again.
  mem(JORDAN, "2026-11-01T20:00:00Z", longText("User said: one more thing about the lease, the landlord called back"));
  const late = await D.runDaySummaries(deps);
  check("regenerate: a new source line on a removed day does not bring the note back", !asked.includes(`${JORDAN}:2026-11-01`) && sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-01")?.status === "removed" && sums.filter((s) => s.user_id === JORDAN && s.day === "2026-11-01").length === 1, { late, asked });
  // A removal of the other member's note, by ref, from Jordan's side: not one of Jordan's items, nothing changes.
  const pr = await W.applyKnowledgeChanges(JORDAN, [{ action: "remove", refs: ["summary:2026-09-01"] }], { message: "remove that", theirWords: "remove that" });
  check("isolation: a ref that is not one of their own notes is refused and changes nothing", !pr.ok && pr.refused.length === 1 && sums.filter((s) => s.status === "removed").length === 1, pr);
}

// ---- 5. a correction ("not that") drops the note through the existing correction path
{
  const msg = "not that, the kiln was a loan from the studio";
  const r = await W.applyKnowledgeChanges(JORDAN, [{ action: "correct", refs: ["summary:2026-11-02"], now: "the kiln was a loan from the studio" }], { message: msg, theirWords: msg });
  const row = sums.find((s) => s.user_id === JORDAN && s.day === "2026-11-02");
  check("correct: applied through applyKnowledgeChanges", r.ok && r.applied[0]?.source === "summary" && r.applied[0]?.now === "the kiln was a loan from the studio", r);
  check("correct: the note is dropped (text deleted, fingerprint kept)", !!row && row.status === "removed" && row.summary === "" && /^[0-9a-f]{16}$/.test(row.source_stamp), row);
  const c = corrections.find((x) => x.item_ref === "summary:2026-11-02");
  check("correct: the correction is recorded in the corrections record with what is true now", !!c && c.removed === false && c.new_value === "the kiln was a loan from the studio" && !/delivered|glad/.test(c.old_value), c);
  const g = await W.forgottenRows(JORDAN, { query: handle }, { all: true });
  check("correct: the note's record guards nothing else (a line about the kiln reads as it was)", W.guardText("User said: the kiln delivery came today", g) === "User said: the kiln delivery came today");
}

// ---- 6. both mediums: a call reaches the same view and the same removal (the texting tools themselves, services/callTools.ts)
{
  const C = await import("../../src/services/callTools.js");
  check("calls: the call's tools include whatCoKnows and correctWhatCoKnows (the same view and the same one-gesture removal)", C.CALL_TOOL_NAMES.includes("whatCoKnows") && C.CALL_TOOL_NAMES.includes("correctWhatCoKnows"));
}

// ---- 7. one run at a time across processes (the dev database is shared; api and co-test both register the jobs)
{
  // A fake database's session advisory locks: one holder per key, released by unlock or by the connection going away.
  let holder: number | null = null;
  let conn = 0;
  const destroyed: number[] = [];
  let failUnlock = false;
  const lockPool: import("../../src/services/daySummaries.js").LockPool = {
    connect: async () => {
      const me = ++conn;
      return {
        query: async (sql: string, args?: unknown[]) => {
          if (/pg_try_advisory_lock\(hashtext\(\$1\)\)/.test(sql) && args?.[0] === D.RUN_LOCK_KEY) { if (holder === null) { holder = me; return { rows: [{ ok: true }] }; } return { rows: [{ ok: false }] }; }
          if (/pg_advisory_unlock\(hashtext\(\$1\)\)/.test(sql)) { if (failUnlock) throw new Error("connection lost"); if (holder === me) holder = null; return { rows: [{ pg_advisory_unlock: true }] }; }
          throw new Error(`unexpected: ${sql}`);
        },
        release: (destroy?: boolean) => { if (destroy) { destroyed.push(me); if (holder === me) holder = null; } },
      };
    },
  };
  let runs = 0;
  let finish!: () => void;
  const first = D.runLocked(lockPool, () => new Promise<string>((res) => { runs++; finish = () => res("first"); }));
  await new Promise((r) => setImmediate(r));
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  let second: string | null;
  try { second = await D.runLocked(lockPool, async () => { runs++; return "second"; }); } finally { console.log = realLog; }
  check("lock: a second run while one holds the lock is skipped (no model call, nothing paid twice)", second === null && runs === 1, { second, runs });
  check("lock: the skip is logged", logged.some((l) => /day summaries: another run holds the lock; this run is skipped/.test(l)), logged);
  finish();
  check("lock: the holder's run completes", (await first) === "first" && holder === null);
  check("lock: once released, the next run goes ahead", (await D.runLocked(lockPool, async () => "third")) === "third" && holder === null);
  failUnlock = true;
  await D.runLocked(lockPool, async () => "fourth");
  check("lock: a connection that can't unlock is destroyed, which releases the lock", destroyed.length === 1 && holder === null, { destroyed, holder });
  failUnlock = false;
  let threw = false;
  try { await D.runLocked(lockPool, async () => { throw new Error("run failed"); }); } catch { threw = true; }
  check("lock: a run that fails still releases the lock", threw && holder === null);
}

console.log(`visible summaries: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
