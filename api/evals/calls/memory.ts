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
{
  check("the call loads preferences, limits and claims with everything it already read", ["goals", "asks", "corrections", "exchanges", "lessons", "delivered", "carrying", "restraint", "preferences", "limits", "claims"].every((s) => (CC.CALL_KNOWLEDGE as readonly string[]).includes(s)));
  const k: any = {
    preferences: [{ text: "wants a room where they can drop their guard; avoids performative events", source: "stated", verifiedAt: at }, { text: "small dinners got a yes; a big expo was ignored", source: "taste", verifiedAt: at }],
    limits: { avoid: ["hackathons", "crypto events"], availability: "weeknights only", verifiedAt: at },
    claims: [{ text: "traveling until Oct 20", provenance: "said", kind: "state", quote: "I'm traveling until the 20th", expiresOn: "2026-10-20", saidOn: "2026-10-10", verifiedAt: at }, { text: "lives in Oakland", provenance: "said", kind: "fact", quote: null, expiresOn: null, saidOn: "2026-09-01", verifiedAt: at }],
  };
  const lines = CC.callFitLines(k, (t) => !/Oakland/.test(t), AV.availabilityIsLimit).join("\n\n");
  check("the room they want, in their words, with how to use it", /The kind of room they've told you they want[\s\S]*never pitch what clashes with it\):\n- wants a room where they can drop their guard/.test(lines), lines);
  check("how what Co sent has landed", /How what you've sent them has landed: small dinners got a yes/.test(lines));
  check("never suggest what they ruled out (and their own mention reopens it)", /Never suggest these kinds of things: they asked you to stop \("hackathons", "crypto events"\)/.test(lines) && /If they bring one up themselves/.test(lines));
  check("availability says whether it's a limit or a leaning", /"weeknights only" \(a limit/.test(lines) && /a leaning, not a limit/.test(CC.callFitLines({ ...k, limits: { avoid: [], availability: "more flexible on weekends" } }, () => true, AV.availabilityIsLimit).join("\n")));
  check("what still holds, with its end date; a claim a correction retired is left out", /What they've told you that still holds:\n- traveling until Oct 20 \(until 2026-10-20\)/.test(lines) && !/Oakland/.test(lines));
  check("nothing on file, no sections (no empty headings)", CC.callFitLines({ preferences: [], limits: { avoid: [], availability: null }, claims: [] } as any).length === 0 && CC.callFitLines({ preferences: [], limits: null, claims: [] } as any).length === 0);
  const cc = src("services/callContext.ts");
  check("they go into the call's context after what they're looking for, through the call's own strip", /const fitLines = await strip\(callFitLines\(k, \(t, at\) => keep\(t, at\), availabilityIsLimit\)\);/.test(cc) && /What they're looking for right now:[\s\S]{0,80}\.\.\.fitLines,/.test(cc));
}

// ---------------------------------------------------------------- 2. saved when said on a call
{
  check("the call can save a kind they rule out and the room they want", (CT.CALL_TOOL_NAMES as readonly string[]).includes("steerAwayFrom") && (CT.CALL_TOOL_NAMES as readonly string[]).includes("noteRoomTaste"));
  check("on a call, the taste quote can be anything they said on the call (not only this turn)", /ctx\.isVoice \? String\(ctx\.turn\?\.message \?\? ""\) : ""/.test(src("agent/conversationTools.ts")));
  check("a kind ruled out on a call clears what's waiting too (the same steerAwayFrom as texts)", /W\.exitAvoidedFinds\(userId, k,/.test(src("agent/conversationTools.ts")));
}

// ---------------------------------------------------------------- 3. mid-call freshness, after the cache breakpoint
{
  check("the turn note carries the stop-suggesting list as it stands now", CT.avoidNote(["crypto events"]) === '(Right now they\'ve asked you never to suggest: "crypto events".)' && CT.avoidNote([]) === null && CT.avoidNote(undefined) === null);
  check("it goes in the turn note (past the cache breakpoint), never the cached system prompt", /turnNote: \[picked\.updateTask \? taskFactNote\(i\.turnWords, i\.member\.tasks\) : null, avoidNote\(i\.member\.avoid\)\]/.test(src("services/callTools.ts")) && /if \(co\.turnNote\) req\.messages\[req\.messages\.length - 1\]\.content\.push/.test(src("services/callLlmProxy.ts")));
  check("re-read after any tool acts, from the record's one reader", /realKnowledgeDeps\.limits\(userId\)/.test(src("services/callTools.ts")) && /if \(userId\) memberOnCall\(callKey, userId, true\)/.test(src("routes/callLlm.ts")));
}

// ---------------------------------------------------------------- 4. naming a kind to rule it out never lifts the rule
{
  const av = ["hackathons", "crypto events"];
  check("'no more', 'stop sending', 'don't', 'tired of' keep the rule", ["no more hackathons please", "stop sending me crypto stuff", "don't send hackathons", "tired of crypto events"].every((t) => L.avoidFor(av, t).length === 2));
  check("asking for it lifts it for that ask", L.avoidFor(av, "find me a hackathon this month").join() === "crypto events" && L.avoidFor(av, "any good hackathons?").join() === "crypto events");
  check("a negation stays in its own clause", L.avoidFor(av, "I'm not into hackathons but any crypto events?").join() === "hackathons");
  const lt = src("agent/loopTools.ts");
  check("live searches and shares judge the lift on this turn's words (a call's words are the whole call)", /avoidHits\(query, avoidFor\(l\.avoid, ctx\.resolvedContent\)\)/.test(lt) && /lim, \{ askText: ctx\.resolvedContent \}\)/.test(lt));
}

console.log(`call memory: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
