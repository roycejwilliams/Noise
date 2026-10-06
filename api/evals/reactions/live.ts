// Live check of the missed-reaction safety net (services/reactionCatchup.ts).
// Real model, no DB: reactions must be read, look-alikes must not.
//
//   npx tsx evals/reactions/live.ts [runs]
import "../lib/requireMeter.js";
const { readReaction, sentNamedIn } = await import("../../src/services/reactionCatchup.js");
const sent = [{ name: "Rooftop evening" }, { name: "Mahjong After Dark" }, { name: "AgentFi demo day at The Avalon" }];
const cases: [string, string | null][] = [
  ["going to the rooftop evening thursday", "going"],
  ["that rooftop evening was honestly amazing", "went_liked"],
  ["the rooftop thing isn't really my scene tbh", "not_for_me"],
  ["ooh mahjong after dark looks fun, might check it out", "interested"],
  ["went to agentfi, kind of a bust", "went_disliked"],
  ["how do I get to the rooftop evening?", null],
  ["what time does mahjong start", null],
  ["did you ever send me the agentfi thing?", null],
  ["is the rooftop evening outdoors?", null],
];
// Inline replies: a bare "I'm in" threaded under Co's text names nothing itself.
const threaded: [string, string, string | null][] = [
  ["I'm in", "Rooftop evening, Thursday 7pm on Market St: https://lu.ma/roof-evening", "going"],
  ["eh pass", "Mahjong After Dark, Friday: https://lu.ma/mahjongafterdark", "not_for_me"],
  ["what time?", "Rooftop evening, Thursday on Market St: https://lu.ma/roof-evening", null],
];
const runs = Number(process.argv[2] ?? 3);
let ok = 0, total = 0;
for (let r = 0; r < runs; r++)
  for (const [msg, want] of cases) {
    const named = sentNamedIn(msg, sent);
    const got = named.length ? await readReaction(msg, named) : null;
    const pass = (got?.reaction ?? null) === want || (want === "interested" && got?.reaction === "going");
    total++;
    if (pass) ok++;
    else console.log(`MISS "${msg}": want ${want}, got ${got?.reaction ?? null}`);
  }
for (let r = 0; r < runs; r++)
  for (const [msg, quoted, want] of threaded) {
    const named = sentNamedIn(`${msg} ${quoted}`, sent);
    const got = named.length ? await readReaction(msg, named, quoted) : null;
    total++;
    if ((got?.reaction ?? null) === want) ok++;
    else console.log(`MISS threaded "${msg}": want ${want}, got ${got?.reaction ?? null}`);
  }
console.log(`reaction catch-up: ${ok}/${total}`);
