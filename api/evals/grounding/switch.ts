// Which "does this draft need a claim check?" switch is better: the word
// filter (needsClaimCheck) or a fast Jev read? (Royce, 2026-09-26: "only
// switch if Jev is at least as good".) On real Co replies, the answer key is
// a full claim read (Sonnet, forced on every reply): a reply needs checking
// when it has any claim at all. A switch that says "skip" on one of those
// lets it go out unread, so misses matter most; skips are saved time.
//
//   railway run --service co-test --environment dev -- npx tsx evals/grounding/switch.ts <replies.json>
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const RG = await import("../../src/harness/replyGrounding.js");
const { askJevZdr } = await import("../../src/services/jevGateway.js");

const replies: string[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
export const JEV_SWITCH_QUESTION =
  "Does this text claim anything that could be false: something Co did, sent, saved or will do later; a time, date, place, price, number or link; what another person said, wants or did; what Co can or can't do; or a prediction about what will happen? No for pure feelings, questions, opinions, advice or small talk.";

// Answer key, in parallel.
const truth: boolean[] = new Array(replies.length);
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < replies.length) {
      const i = next++;
      const c = await RG.claimChecksOnly(replies[i], RG.baseReplyFacts(), { message: "", recentConversation: "" }, { force: true }).catch(() => null);
      truth[i] = (c ?? []).length > 0;
    }
  }),
);
// The word filter.
const regex = replies.map((r) => RG.needsClaimCheck(r));
// Jev, 40 replies per request (the gateway's rate limit), timed per request.
const jev: (number | null)[] = new Array(replies.length).fill(null);
const jevMs: number[] = [];
for (let i = 0; i < replies.length; i += 40) {
  const idx = replies.slice(i, i + 40).map((_, j) => i + j);
  const state: Record<string, string> = {};
  const qs: Record<string, { type: "boolean"; instructions: string }> = {};
  for (const k of idx) {
    state[`r${k}`] = replies[k];
    qs[`r${k}`] = { type: "boolean", instructions: `For texts.r${k}: ${JEV_SWITCH_QUESTION}` };
  }
  const t0 = Date.now();
  const r = await askJevZdr({ texts: state }, qs, 20_000).catch(() => null);
  jevMs.push(Date.now() - t0);
  for (const k of idx) jev[k] = typeof r?.[`r${k}`] === "number" ? r[`r${k}`] : null;
}
// Single-reply latency, as it would run in a real turn.
const single: number[] = [];
for (const k of [0, 1, 2, 3, 4]) {
  const t0 = Date.now();
  await askJevZdr({ text: replies[k] }, { c: { type: "boolean", instructions: JEV_SWITCH_QUESTION } }, 5000).catch(() => null);
  single.push(Date.now() - t0);
}

const need = truth.filter(Boolean).length;
const score = (name: string, says: (i: number) => boolean) => {
  let missed = 0, skipped = 0, wasted = 0;
  replies.forEach((_, i) => {
    const check = says(i);
    if (!check) skipped++;
    if (truth[i] && !check) missed++;
    if (!truth[i] && check) wasted++;
  });
  console.log(`${name.padEnd(22)} missed ${missed}/${need} that needed a check; skipped ${skipped}/${replies.length}; checked ${wasted} that didn't need it`);
  return missed;
};
console.log(`${replies.length} real replies; ${need} have at least one claim (answer key)`);
score("word filter (today)", (i) => regex[i]);
const unread = jev.filter((p) => p === null).length;
for (const t of [0.1, 0.2, 0.3, 0.5]) score(`Jev at ${t} (unread=check)`, (i) => jev[i] === null || (jev[i] as number) >= t);
score("either (filter OR Jev≥0.2)", (i) => regex[i] || jev[i] === null || (jev[i] as number) >= 0.2);
console.log(`Jev unread: ${unread}; batch ms: ${jevMs.join(", ")}; single-reply ms: ${single.join(", ")}`);
const med = [...single].sort((a, b) => a - b)[2];
console.log(`single-reply median ${med}ms`);
for (let i = 0; i < replies.length; i++) if (truth[i] && !regex[i]) console.log(`  filter missed: ${replies[i].slice(0, 110)}`);
for (let i = 0; i < replies.length; i++) if (truth[i] && jev[i] !== null && (jev[i] as number) < 0.2) console.log(`  Jev@0.2 missed (${(jev[i] as number).toFixed(2)}): ${replies[i].slice(0, 110)}`);
