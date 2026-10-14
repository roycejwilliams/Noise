// The call-memory gap (Royce, 2026-10-11; audit item 10): a call reads the same member record as a text. Zero tokens, no database.
//   1. The call's context carries the room they want, how sends landed, the stop-suggesting list, when they're free (limit vs leaning)
//      and what still holds, from the record's own sections, stripped like every other call line.
//   2. "No more X" and "a room where I can drop my guard", said on a call, are saved (steerAwayFrom, noteRoomTaste on the call's tools).
//   3. Mid-call: the stop-suggesting list rides each turn after the cache breakpoint, re-read after a tool acts.
//   4. A kind named only to rule it out never lifts the rule ("stop sending me crypto stuff"), and live searches judge it on this turn.
//   npx tsx evals/calls/memory.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
process.env.ELEVENLABS_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const CC = await import("../../src/services/callContext.js");
const CT = await import("../../src/services/callTools.js");
const L = await import("../../src/services/memberLimits.js");
const AV = await import("../../src/services/availability.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 700)}` : ""}`); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
const at = "2026-10-10T12:00:00Z";

// ---------------------------------------------------------------- 1. the call reads the record's fit sections
const RG = await import("../../src/harness/replyGrounding.js");
const NOW = new Date("2026-10-11T18:00:00Z");
{
  check("the call loads preferences, limits and claims with everything it already read", ["goals", "asks", "corrections", "exchanges", "lessons", "delivered", "carrying", "restraint", "preferences", "limits", "claims"].every((s) => (CC.CALL_KNOWLEDGE as readonly string[]).includes(s)));
  const claim = (text: string, day: string, o: any = {}) => ({ text, provenance: "user_said", kind: "plan", quote: null, expiresOn: null, saidOn: day, verifiedAt: `${day}T12:00:00.000Z`, ...o });
  // Eight they said (Jan..Oct, oldest first, the way the layer returns them), one Co inferred, one a correction retired.
  const months = ["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-09-05", "2026-10-09"];
  const claims = [
    ...months.map((d, n) => claim(n === 7 ? "in Austin next week" : `older plan ${n + 1}`, d, n === 7 ? { kind: "plan", expiresOn: "2026-10-19" } : { kind: "identity" })),
    claim("exploring a move to Austin", "2026-10-08", { provenance: "co_inferred", kind: "plan" }),
    claim("lives in Oakland", "2026-10-07", { kind: "identity" }),
  ];
  const k: any = {
    identity: { firstName: "Jordan", city: "San Francisco", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: NOW.toISOString() },
    preferences: [{ text: "wants a room where they can drop their guard; avoids performative events", source: "stated", verifiedAt: at }, { text: "small dinners got a yes; a big expo was ignored", source: "taste", verifiedAt: at }],
    limits: { avoid: ["hackathons", "crypto events"], availability: "weeknights only", verifiedAt: at },
    claims,
  };
  const lines = CC.callFitLines(k, (t) => !/Oakland/.test(t), AV.availabilityIsLimit, (kk) => RG.heldClaimsFrom(kk, NOW)).join("\n\n");
  check("the room they want, in their words, with how to use it (one heading)", /Their room taste, newest first \(when you suggest anything, lean this way, and never pitch what clashes with it\):\n- wants a room where they can drop their guard/.test(lines), lines);
  check("how what Cue sent has landed", /How what you've sent them has landed: small dinners got a yes/.test(lines));
  check("never suggest what they ruled out (and their own ask reopens it)", /Never suggest these kinds of things: they asked you to stop \("hackathons", "crypto events"\)/.test(lines) && /If they bring one up themselves/.test(lines));
  check("availability says whether it's a limit or a leaning", /"weeknights only" \(a limit/.test(lines) && /a leaning, not a limit/.test(CC.callFitLines({ ...k, claims: [], limits: { avoid: [], availability: "more flexible on weekends" } }, () => true, AV.availabilityIsLimit).join("\n")));
  const said = lines.split("What they've told you that still holds")[1]?.split("\n\n")[0] ?? "";
  check("review #1: the newest claims, not the oldest (the newest is in; the oldest are left past the limit)", /in Austin next week/.test(said) && !/older plan 1\b/.test(said) && !/older plan 2\b/.test(said) && (said.match(/^- /gm) ?? []).length === CC.CALL_CLAIMS_LIMIT, said);
  check("review #2: Cue's guesses are never under what they said, and are labeled as Cue's read", !/exploring a move/.test(said) && /Cue's own reads of them \(guesses, not things they told you: never say they said these\):\n- exploring a move to Austin \(Cue's read, Oct 8\)/.test(lines), lines.slice(-400));
  check("review #3: an end date is the day it ends, not the day after", /in Austin next week \(they said, Oct 9, until Oct 18\)/.test(said), said);
  check("a claim a correction retired is left out", !/Oakland/.test(lines));
  check("nothing on file, no sections (no empty headings)", CC.callFitLines({ ...k, preferences: [], limits: { avoid: [], availability: null }, claims: [] }).length === 0 && CC.callFitLines({ ...k, preferences: [], limits: null, claims: [] }).length === 0);
  const cc = src("services/callContext.ts");
  check("they go into the call's context after what they're looking for, through the call's own strip, claims by the text path's renderer", /const fitLines = await strip\(callFitLines\(k, \(t, at\) => keep\(t, at\), availabilityIsLimit, \(kk\) => heldClaimsFrom\(kk, now\)\)\);/.test(cc) && /What they're looking for right now:[\s\S]{0,80}\.\.\.fitLines,/.test(cc));
}

// ---------------------------------------------------------------- 2. saved when said on a call
{
  check("the call can save a kind they rule out and the room they want", (CT.CALL_TOOL_NAMES as readonly string[]).includes("steerAwayFrom") && (CT.CALL_TOOL_NAMES as readonly string[]).includes("noteRoomTaste"));
  check("on a call, the taste quote can be anything they said on the call (not only this turn)", /ctx\.isVoice \? String\(ctx\.turn\?\.message \?\? ""\) : ""/.test(src("agent/conversationTools.ts")));
  check("a kind ruled out on a call clears what's waiting too (the same steerAwayFrom as texts)", /W\.exitAvoidedFinds\(userId, k,/.test(src("agent/conversationTools.ts")));
}

// ---------------------------------------------------------------- 3. mid-call freshness, after the cache breakpoint
{
  check("the turn note carries the stop-suggesting list as it stands now", /never to suggest "crypto events"/.test(CT.avoidNote(["crypto events"]) ?? "") && CT.avoidNote([]) === null && CT.avoidNote(undefined) === null);
  check("it goes in the turn note (past the cache breakpoint), never the cached system prompt", /turnFacts: \{ turnWords: i\.turnWords, tasks: i\.member\.tasks, avoid: i\.member\.avoid, canWriteTasks: !!picked\.updateTask \}/.test(src("services/callTools.ts")) && /\[t\.canWriteTasks \? taskFactNote\(t\.turnWords, t\.tasks\) : null, avoidNote\(t\.avoid\)\]/.test(src("brain/index.ts")) && /if \(decision\.turnNote\) req\.messages\[req\.messages\.length - 1\]\.content\.push/.test(src("services/callLlmProxy.ts")));
  check("re-read after any tool acts, from the record's one reader", /realKnowledgeDeps\.limits\(userId\)/.test(src("services/callTools.ts")) && /if \(userId\) memberOnCall\(callKey, userId, true\)/.test(src("routes/callLlm.ts")));
}

// ---------------------------------------------------------------- 4. naming a kind to rule it out never lifts the rule
{
  const av = ["hackathons", "crypto events", "mixers"];
  const keeps = (t: string, kind: string) => L.avoidFor(av, t).includes(kind);
  check("'no more', 'stop sending', 'don't send', 'tired of', 'anything but' keep the rule", keeps("no more hackathons please", "hackathons") && keeps("stop sending me crypto stuff", "crypto events") && keeps("don't send hackathons", "hackathons") && keeps("tired of crypto events", "crypto events") && keeps("anything but crypto events", "crypto events"));
  check("a negated list stays negated (review #4)", keeps("not into mixers or crypto events", "crypto events") && keeps("never again with crypto events and hackathons", "hackathons") && keeps("find me crypto events, not hackathons", "hackathons") && keeps("tech events but no crypto", "crypto events"));
  check("asking for it lifts it for that ask", !keeps("find me a hackathon this month", "hackathons") && !keeps("any good hackathons?", "hackathons") && !keeps("I'm not into hackathons but any crypto events?", "crypto events"));
  check("review #4: 'I don't mind', 'don't forget to look for', 'less talking more' ask for it", !keeps("I don't mind hackathons", "hackathons") && !keeps("don't forget to look for hackathons", "hackathons") && !keeps("less talking more hackathons", "hackathons"));
  const lt = src("agent/loopTools.ts");
  check("review #5/#6: an ask is judged on a text's message (with what it replies to) or a call's last three lines, never the whole call", /const askWords = \(\) => \(ctx\.isVoice \? String\(ctx\.turn\?\.message \?\? ""\)\.split\("\\n"\)\.filter\(\(l\) => l\.trim\(\)\)\.slice\(-3\)\.join\("\\n"\) \|\| ctx\.resolvedContent : theirWords\(\)\);/.test(lt) && /avoidHits\(query, avoidFor\(l\.avoid, askWords\(\)\)\)/.test(lt) && /lim, \{ askText: askWords\(\) \}\)/.test(lt));
  check("review #5: the refusal doesn't push a permanent undo for a one-off ask", /it lifts for this once when their own words ask for it; only use steerAwayFrom with undo if they say they're open to it again in general/.test(lt));
}

// ---------------------------------------------------------------- review of #139: the turn note
{
  check("review #10: the note says it's Cue's, not their words, and needn't be mentioned", /^\(Cue's note, not their words: /.test(CT.avoidNote(["mixers"]) ?? "") && /No need to mention it\.\)$/.test(CT.avoidNote(["mixers"]) ?? ""));
  check("review #9: a failed limits read keeps the last good list mid-call (never an empty one)", /avoid: lim \? lim\.avoid : undefined/.test(src("services/callTools.ts")) && /if \(x\.avoid !== undefined\) lastAvoid\.set\(key, \{ at: Date\.now\(\), avoid: x\.avoid \}\);/.test(src("routes/callLlm.ts")) && /const LAST_AVOID_MS = 60 \* 60_000;/.test(src("routes/callLlm.ts")));
}

console.log(`call memory: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
