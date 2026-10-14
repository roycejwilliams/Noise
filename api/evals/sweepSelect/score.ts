// Score a sweep-selection replay against Royce's blind marks (Royce,
// 2026-10-02). The pass bar was set before any results were seen:
//   1. Co's picks get more "wow" and fewer "no" marks than the old rules'.
//   2. On days Co sent nothing, the pool held nothing he'd have wanted.
//   3. Of the things he actually engaged with that were in a pool, Co sends
//      at least all but one, no later than the old rules queued them.
//
//   npx tsx evals/sweepSelect/score.ts <run dir> [marks.json]
// (marks.json defaults to <run dir>/marks.json)
import { readFileSync } from "fs";
import { join } from "path";
import type { ReplayDay } from "./replay.js";

type Marks = Record<string, { items?: Record<string, "wow" | "fine" | "no">; pref?: "A" | "B" | "same" | "neither"; wanted?: string[] }>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function score(days: ReplayDay[], key: Record<string, "A" | "B">, marks: Marks, reacted: { name: string; result: string }[]) {
  const tally = { new: { wow: 0, fine: 0, no: 0, unmarked: 0 }, old: { wow: 0, fine: 0, no: 0, unmarked: 0 } };
  const prefs = { new: 0, old: 0, same: 0, neither: 0, unpicked: 0 };
  const silentMisses: { day: string; wanted: string[] }[] = [];
  for (const d of days) {
    const m = marks[d.day] ?? {};
    const sends = d.judgments.filter((j) => j.verdict === "send").map((j) => j.key);
    for (const [side, keys] of [["new", sends], ["old", d.oldPick]] as const) for (const k of keys) tally[side][m.items?.[k] ?? "unmarked"]++;
    const p = m.pref;
    if (!p) prefs.unpicked++;
    else if (p === "same" || p === "neither") prefs[p]++;
    else prefs[p === key[d.day] ? "new" : "old"]++;
    if (!sends.length && (m.wanted ?? []).length) silentMisses.push({ day: d.day, wanted: m.wanted!.map((k) => d.pool.find((x) => x.key === k)?.name ?? k) });
  }
  // Engagement recall: things they reacted to that showed up in a pool.
  const recall = reacted.map((r) => {
    const n = norm(r.name);
    const match = (name: string) => norm(name).includes(n) || n.includes(norm(name));
    const inPool = days.find((d) => d.pool.some((p) => match(p.name)));
    const newDay = days.find((d) => d.judgments.some((j) => j.verdict === "send" && match(j.name)))?.day ?? null;
    const oldDay = days.find((d) => d.oldPick.some((k) => match(d.pool.find((p) => p.key === k)?.name ?? "")))?.day ?? null;
    return { name: r.name, result: r.result, inPool: !!inPool, newDay, oldDay };
  });
  const inPool = recall.filter((r) => r.inPool);
  const caught = inPool.filter((r) => r.newDay && (!r.oldDay || r.newDay <= r.oldDay));
  const pass = {
    moreWowFewerNo: tally.new.wow > tally.old.wow && tally.new.no < tally.old.no,
    quietDaysRight: silentMisses.length === 0,
    keepsWhatWorked: caught.length >= inPool.length - 1,
  };
  return { tally, prefs, silentMisses, recall, caught: caught.length, inPool: inPool.length, pass };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: score.ts <run dir> [marks.json]");
  const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8"));
  const marks = JSON.parse(readFileSync(process.argv[3] ?? join(dir, "marks.json"), "utf8"));
  const s = score(results.days, key, marks, results.reacted);
  console.log(`model ${results.model}, ${results.days.length} days\n`);
  console.log(`marks   new: wow ${s.tally.new.wow}, fine ${s.tally.new.fine}, no ${s.tally.new.no} (unmarked ${s.tally.new.unmarked})`);
  console.log(`        old: wow ${s.tally.old.wow}, fine ${s.tally.old.fine}, no ${s.tally.old.no} (unmarked ${s.tally.old.unmarked})`);
  console.log(`days    rather have new ${s.prefs.new}, old ${s.prefs.old}, same ${s.prefs.same}, neither ${s.prefs.neither}, not picked ${s.prefs.unpicked}`);
  console.log(`quiet days with something you wanted: ${s.silentMisses.length ? s.silentMisses.map((x) => `${x.day} (${x.wanted.join("; ")})`).join(", ") : "none"}`);
  console.log(`things you engaged with that were in a pool: ${s.inPool}; Cue sent ${s.caught} no later than the old rules`);
  for (const r of s.recall) console.log(`  ${r.inPool ? "" : "(not in any pool) "}${r.name} [${r.result}]: new ${r.newDay ?? "never"}, old ${r.oldDay ?? "never"}`);
  console.log(`\nPASS BAR  more wow, fewer no: ${s.pass.moreWowFewerNo ? "yes" : "NO"} | quiet days right: ${s.pass.quietDaysRight ? "yes" : "NO"} | keeps what worked: ${s.pass.keepsWhatWorked ? "yes" : "NO"}`);
}
