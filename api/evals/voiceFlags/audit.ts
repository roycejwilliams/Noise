// Audit of the live voice-flag test (evals/voiceFlags/live.ts): every run and
// every flag co-test logged for those calls, kept or dropped, scored against
// what each acted moment should (or shouldn't) raise. Read only.
//   npx tsx evals/voiceFlags/audit.ts
import "dotenv/config";
import { readFileSync } from "fs";
import pool from "../../src/db/db.js";

const dir = new URL("../voice-emotion-pilot/synthetic/data2/", import.meta.url);
const runs: { name: string; conversationId: string | null; heard: string[] }[] = JSON.parse(readFileSync(new URL("live-runs.json", dir), "utf8"));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const overlap = (a: string, b: string) => {
  const A = words(a);
  const B = new Set(words(b));
  return A.length ? A.filter((w) => B.has(w)).length / A.length : 0;
};

const client = await pool.connect();
await client.query("BEGIN READ ONLY");
let should = 0, caught = 0, cueRight = 0, shouldnt = 0, falseKept = 0, offMoment = 0, dropped = 0;
const byCue: Record<string, [number, number]> = {};
for (const r of runs.filter((x) => x.conversationId)) {
  const { expect } = JSON.parse(readFileSync(new URL(`calls/${r.name}.json`, dir), "utf8"));
  const run = (await client.query(`SELECT status, flags, kept, ms, audio_bytes, error, created_at < NOW() - INTERVAL '15 minutes' AS stale FROM voice_flag_runs WHERE conversation_id = $1`, [r.conversationId])).rows[0];
  const flags = (await client.query(`SELECT at_secs, quote, cue, feeling, reading, confidence, kept, drop_reason FROM voice_flags WHERE conversation_id = $1 ORDER BY at_secs`, [r.conversationId])).rows;
  if (run?.status === "running" && run.stale) run.status = "ABANDONED (still running after 15 min)";
  console.log(`\n${r.name} (${r.conversationId}): ${run ? `${run.status}, ${run.flags ?? 0} raised, ${run.kept ?? 0} kept, ${run.ms} ms${run.error ? `, error: ${run.error}` : ""}` : "NO RUN LOGGED"}`);
  for (const f of flags) console.log(`  ${f.kept ? "KEPT" : "drop"} ${f.cue} @${Math.round(f.at_secs ?? -1)}s conf ${f.confidence} "${f.quote}" (${f.feeling}: ${f.reading})${f.drop_reason ? ` — ${f.drop_reason}` : ""}`);
  dropped += flags.filter((f: any) => !f.kept).length;
  for (const e of expect) {
    const mine = flags.filter((f: any) => f.kept && overlap(f.quote, e.quote) >= 0.6);
    if (e.cue) {
      should++;
      byCue[e.cue] ??= [0, 0];
      byCue[e.cue][1]++;
      if (mine.length) {
        caught++;
        byCue[e.cue][0]++;
        if (mine.some((f: any) => f.cue === e.cue)) cueRight++;
      }
    } else {
      shouldnt++;
      if (mine.length) falseKept++;
    }
  }
  offMoment += flags.filter((f: any) => f.kept && !expect.some((e: any) => overlap(f.quote, e.quote) >= 0.6)).length;
}
await client.query("ROLLBACK");
client.release();
await pool.end();
console.log(`\nshould flag: ${caught}/${should} caught (${cueRight} with the expected cue)`);
for (const [cue, [c, n]] of Object.entries(byCue)) console.log(`  ${cue}: ${c}/${n}`);
console.log(`false flags (words already said it, or calm voice): ${falseKept}/${shouldnt}`);
console.log(`kept flags on anything else (Co's lines, other words): ${offMoment}`);
console.log(`dropped by the checks: ${dropped}`);
