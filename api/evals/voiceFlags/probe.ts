// Live probe for voice flags (services/voiceFlags.ts): the real Gemini pass on
// pretend calls stitched from acted clips (evals/voice-emotion-pilot/synthetic,
// calls.py), each moment with the flag it should or shouldn't raise. Uses
// CO_GEMINI_KEY; no member audio, no database.
//   npx tsx evals/voiceFlags/probe.ts
import { readFileSync, readdirSync, writeFileSync } from "fs";
import "dotenv/config";
import { callerLines, checkFlags, listenForFlags, quoteFromCaller, transcriptForListening } from "../../src/services/voiceFlags.js";

const dir = new URL("../voice-emotion-pilot/synthetic/data2/calls/", import.meta.url);
const calls = readdirSync(dir).filter((f) => f.endsWith(".json"));
type Row = { call: string; quote: string; tone: string; kind: string; want: string | null; got: string | null; kept: boolean; reason: string | null; dropped: string[] };
const rows: Row[] = [];
const extra: { call: string; quote: string; cue: string; kept: boolean }[] = [];
for (const c of calls) {
  const { turns, expect } = JSON.parse(readFileSync(new URL(c, dir), "utf8"));
  const audio = { bytes: readFileSync(new URL(c.replace(".json", ".wav"), dir)), mime: "audio/wav" };
  const lines = callerLines(turns);
  const flags = checkFlags(await listenForFlags(audio, transcriptForListening(turns)), lines);
  for (const e of expect) {
    const mine = flags.filter((f) => quoteFromCaller(f.quote, [{ atSecs: null, text: e.quote }]));
    const kept = mine.find((f) => f.kept);
    rows.push({ call: c.replace(".json", ""), quote: e.quote.slice(0, 50), tone: e.tone, kind: e.kind, want: e.cue, got: kept?.cue ?? null, kept: !!kept, reason: kept?.reading ?? null, dropped: mine.filter((f) => !f.kept).map((f) => `${f.cue}: ${f.dropReason}`) });
  }
  for (const f of flags) if (!expect.some((e: any) => quoteFromCaller(f.quote, [{ atSecs: null, text: e.quote }]))) extra.push({ call: c, quote: f.quote, cue: f.cue, kept: f.kept });
  console.log(`${c}: ${flags.length} raised, ${flags.filter((f) => f.kept).length} kept`);
}
const should = rows.filter((r) => r.want);
const shouldnt = rows.filter((r) => !r.want);
const caught = should.filter((r) => r.kept);
console.log(`\nshould flag: ${caught.length}/${should.length} caught (${caught.filter((r) => r.got === r.want).length} with the expected cue)`);
for (const cue of ["sigh", "laugh", "sarcasm", "forced_cheer"]) {
  const x = should.filter((r) => r.want === cue);
  console.log(`  ${cue}: ${x.filter((r) => r.kept).length}/${x.length}`);
}
console.log(`false flags where the words already said it or the voice was calm: ${shouldnt.filter((r) => r.kept).length}/${shouldnt.length}`);
for (const r of shouldnt.filter((r) => r.kept)) console.log(`  FALSE ${r.call} [${r.kind}/${r.tone}] ${r.got}: "${r.quote}" — ${r.reason}`);
console.log(`flags on quotes that weren't a moment: ${extra.length}`);
console.log("\nmissed:");
for (const r of should.filter((r) => !r.kept)) console.log(`  ${r.call} want ${r.want} [${r.kind}/${r.tone}] "${r.quote}" ${r.dropped.length ? "(dropped: " + r.dropped.join("; ") + ")" : "(not raised)"}`);
writeFileSync(new URL("../probe-results.json", dir), JSON.stringify({ rows, extra }, null, 1));
