// What counts as a hard stretch (2026-11-09). A member calmly working through a business decision on a call got three medium negative
// reads and, with them, a hard-day state that held finds and offers for up to 48 hours. The read now says what it understood: whose
// feeling it is, whether it's felt now (not recounted or an if), distress or a concern they're working through (or unsure), and when
// they've said they're okay. Only the member's own distress, felt now, is a hard read (harness/emotion.ts isHardRead).
//
// Model-free: every classification here is a STUB, the answer the model is asked to give. These checks prove the code does the right
// thing with each answer (parsing, storing, reading back, the state handed on). Whether the model actually gives these answers for these
// messages is only verifiable by a paid quality run.
//   npx tsx evals/emotion/hardStretch.ts
import { readFileSync } from "fs";
import { execSync } from "child_process";
import pool from "../../src/db/db.js";
import {
  callEmotionMoments,
  EMOTION_READ_GUIDE,
  getEmotionalContext,
  hardStretchSince,
  isHardRead,
  recordEmotionSignals,
  renderEmotionalContext,
  summarizeSignals,
  withReadFields,
  type EmotionSignal,
  type TextEmotion,
} from "../../src/harness/emotion.js";
import { moodHold } from "../../src/services/moodHold.js";
import { parseTurnRead, turnReadAddendum } from "../../src/services/readTurn.js";
import { safetySignal } from "../../src/services/safetyText.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
};

const NOW = new Date("2026-11-09T16:00:00Z");
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
type Sig = EmotionSignal;
const sig = (o: Partial<Sig> & Pick<Sig, "emotion" | "intensity" | "valence">, hoursAgo: number): Sig => ({ source: "text", about: null, quote: null, target: "life", ...o, at: ago(hoursAgo) });
// The router's own required fields, so parseTurnRead reads the rest (as evals/reply/wholeExchange.ts does).
const RB = { reason: "r", answers: null, ambiguousBetween: [], call: "none", wantsRecommendation: false, confidence: "high" };
const turn = (o: object) => parseTurnRead({ ...RB, ...o }, []);
const state = (signals: Sig[], lastInboundH: number | null = null) => {
  const e = summarizeSignals(signals, NOW);
  return { e, hold: moodHold(e, { now: NOW, lastInboundAt: lastInboundH === null ? null : ago(lastInboundH) }) };
};

// ================================================================ 1. the five reads from the call (11-07 and 11-09), as concern
// As the model is asked to read them: the member's own feeling, felt now, working it through ("my gut is calm", "should I worry").
const royce: [string, string, number][] = [
  ["anxious", "unsure whether they made the right decision sending the email and accepting", 0.5],
  ["uneasy", "the collaborator's personality and whether they're a good fit", 0.5],
  ["wary", "a guy they've been describing; doubts he'll do the right thing", 0.5],
  ["concerned", "Jacqueline wanting to take the startup in a different direction", 20],
  ["uneasy", "co-founder disagreement and trusting Eli without a contract", 20],
];
const asConcern = royce.map(([emotion, about, h]) => sig({ source: "call", emotion, about, intensity: "medium", valence: "negative", readKind: "concern", feltBy: "member", framing: "own" }, h));
{
  const { e, hold } = state(asConcern);
  check("1a. the five reads as concern: not a hard stretch", !e.needsCare && !e.hardAt && !e.hardSince, e);
  check("1b. ... and no mood hold", hold.state === "none" && !hold.hold, hold);
  check("1c. each is not a hard read", asConcern.every((s) => !isHardRead(s)));
  // Intensity and valence are kept: tone still sees the concern, labelled for what it is.
  const r = renderEmotionalContext(e, NOW);
  check("1d. the state handed on still shows the concern, marked as working it through, and no hard-time line", /anxious \(medium\)/.test(r) && /\[working it through, holding steady\]/.test(r) && !/hard time/.test(r), r);
}
// The same five as old rows (no kind): medium reads without a kind are not hard, so existing false holds stop on deploy.
{
  const legacy = asConcern.map(({ readKind, feltBy, framing, ...rest }) => rest as Sig);
  const { e, hold } = state(legacy);
  check("1e. the same five as old rows (no kind, medium): not a hard stretch, no hold", !e.needsCare && hold.state === "none", e);
  check("1f. old rows render as before (no note)", !/\[/.test(renderEmotionalContext(e, NOW)));
}

// ================================================================ 2. real distress is a hard stretch
const distress: [string, string, "medium" | "high"][] = [
  ["I can't get out of bed since the breakup", "low", "medium"],
  ["everything's falling apart and I'm exhausted", "overwhelmed", "high"],
  ["my dad passed last week", "grieving", "high"],
  ["I'm panicking about rent and I can't sleep", "panicked", "high"],
];
for (const [quote, emotion, intensity] of distress) {
  const s = sig({ emotion, intensity, valence: "negative", quote, about: quote, readKind: "distress", feltBy: "member", framing: "own" }, 1);
  const { e, hold } = state([s], 1);
  check(`2. "${quote}" read as distress: a hard stretch, the hold reads it`, e.needsCare && !!e.hardAt && hold.state === "held", { e, hold });
  check(`2. "${quote}": the state handed on says distress and a hard time`, /\[distress\]/.test(renderEmotionalContext(e, NOW)) && /hard time/.test(renderEmotionalContext(e, NOW)));
}
// A concern earlier doesn't hide later distress, and distress isn't hidden by a newer concern.
{
  const { e } = state([sig({ emotion: "grieving", intensity: "high", valence: "negative", readKind: "distress", feltBy: "member", framing: "own" }, 5), sig({ emotion: "uneasy", intensity: "medium", valence: "negative", readKind: "concern" }, 1)]);
  check("2e. a newer concern doesn't clear an earlier distress read", e.needsCare && e.hardAt!.getTime() === ago(5).getTime(), e);
}

// ================================================================ 3. a crisis always holds; safety untouched
{
  const crisis = sig({ emotion: "hopeless", intensity: "high", valence: "negative", readKind: "distress", feltBy: "member", framing: "own", quote: "I don't want to be here anymore" }, 0.2);
  check("3a. a crisis read (distress, high) is a hard stretch", state([crisis]).e.needsCare);
  const legacyHigh = sig({ emotion: "hopeless", intensity: "high", valence: "negative" }, 0.2);
  check("3b. a high negative read with no kind (old row, or the model gave none) still counts", isHardRead(legacyHigh) && state([legacyHigh]).e.needsCare);
  // Safety runs on the words themselves, never on a feeling read (services/safetyText.ts), so no read can weaken it.
  check("3c. the crisis backstop still fires on the words, whatever the read", safetySignal("honestly I want to end it all") && safetySignal("I've been thinking about killing myself"));
  let changed = "";
  try {
    changed = execSync("git diff --name-only origin/test -- src/services/safety.ts src/services/safetyText.ts", { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8" });
  } catch {
    changed = "";
  }
  check("3d. safety.ts and safetyText.ts are unchanged by this work", changed.trim() === "", changed);
  const safety = readFileSync(new URL("../../src/services/safety.ts", import.meta.url), "utf8") + readFileSync(new URL("../../src/services/safetyText.ts", import.meta.url), "utf8");
  check("3e. safety reads no emotion state", !/emotion|needsCare|isHardRead|readKind/.test(safety));
}

// ================================================================ 4. high stakes, calm: concern
{
  const s = sig({ emotion: "worried", intensity: "high", valence: "negative", about: "might lose the company", quote: "I might lose my company over this, but I'm thinking it through", readKind: "concern", feltBy: "member", framing: "own" }, 0.5);
  const { e, hold } = state([s], 0.5);
  check("4a. 'I might lose my company over this, but I'm thinking it through' as concern, even high: not hard, no hold", !isHardRead(s) && !e.needsCare && hold.state === "none", e);
  check("4b. ... and the state handed on shows it as concern", /\[working it through, holding steady\]/.test(renderEmotionalContext(e, NOW)));
}

// ================================================================ 5. who feels it, quoted, hypothetical, unsure
{
  const base = { intensity: "high" as const, valence: "negative" as const, readKind: "distress" as const };
  const other = sig({ ...base, emotion: "panicking", feltBy: "other", framing: "own", about: "my co-founder is panicking" }, 1);
  const quoted = sig({ ...base, emotion: "a wreck", feltBy: "member", framing: "quoted", about: "I was a wreck last year" }, 1);
  const ifSo = sig({ ...base, emotion: "crushed", feltBy: "member", framing: "hypothetical", about: "I'd be crushed if it fell through" }, 1);
  const unsure = sig({ emotion: "rattled", intensity: "high", valence: "negative", readKind: "unsure", feltBy: "member", framing: "own" }, 1);
  check("5a. someone else's feeling is not a hard read", !isHardRead(other) && !state([other]).e.needsCare);
  check("5b. a recounted feeling is not a hard read", !isHardRead(quoted) && !state([quoted]).e.needsCare);
  check("5c. a hypothetical one is not a hard read", !isHardRead(ifSo) && !state([ifSo]).e.needsCare);
  check("5d. an unsure read never starts a hard stretch on its own, even high", !isHardRead(unsure) && !state([unsure]).e.needsCare);
  const r = renderEmotionalContext(summarizeSignals([other], NOW), NOW);
  check("5e. the state handed on says whose feeling it is", /someone they described, not them/.test(r), r);
  check("5f. ... and says when it's recounted or an if", /recounted, not how they feel now/.test(renderEmotionalContext(summarizeSignals([quoted], NOW), NOW)) && /an if, not something happening/.test(renderEmotionalContext(summarizeSignals([ifSo], NOW), NOW)));
  check("5g. ... and when the read couldn't tell", /unclear whether it's distress/.test(renderEmotionalContext(summarizeSignals([unsure], NOW), NOW)));
  // Their worry for someone else is their own (the guide says so); read that way, it counts.
  const theirs = sig({ ...base, emotion: "terrified", feltBy: "member", framing: "own", about: "my son in the ICU" }, 1);
  check("5h. their own fear for someone else, read as theirs, counts", isHardRead(theirs));
}

// ================================================================ 6. their correction corrects the inference
{
  const hard = sig({ emotion: "anxious", intensity: "medium", valence: "negative", readKind: "distress", feltBy: "member", framing: "own" }, 3);
  // The text turn's read, stubbed: no feeling, says_okay true ("I'm fine, just thinking").
  const parsed = turn({ emotion: null, says_okay: true });
  check("6a. 'I'm fine, just thinking' (stub: says_okay, no feeling) is kept as a settled read", parsed.emotion?.readKind === "settled" && parsed.emotion?.intensity === "low" && parsed.emotion?.target === "life", parsed.emotion);
  const okay = sig({ ...(parsed.emotion as NonNullable<TextEmotion>), quote: "I'm fine, just thinking" }, 1);
  const { e, hold } = state([hard, okay], 1);
  check("6b. a settled read after a hard one clears the hard stretch", !e.needsCare && hold.state === "none" && e.saidOkayAt?.getTime() === ago(1).getTime(), e);
  const r = renderEmotionalContext(e, NOW);
  check("6c. the state handed on says they told Cue they're okay, and to take their word", /take their word over the earlier read/.test(r) && !/hard time/.test(r), r);
  // With a worry named alongside, says_okay still settles it, and the feeling stays for tone.
  const mixed = turn({ emotion: { emotion: "a bit anxious", intensity: "medium", valence: "negative", about: "the deal", target: "life", felt_by: "member", framing: "own", kind: "concern" }, says_okay: true });
  check("6d. says_okay with a named worry: settled, the feeling kept", mixed.emotion?.readKind === "settled" && mixed.emotion?.emotion === "a bit anxious" && mixed.emotion?.intensity === "medium");
  // Not believed ("fine" after bad news): the model says false, and nothing is corrected.
  const notOkay = turn({ emotion: null, says_okay: false });
  check("6e. says_okay false and no feeling: no read, the hard stretch stands", notOkay.emotion === null && state([hard]).e.needsCare);
  // A settled read BEFORE the hard one corrects nothing.
  const before = state([sig({ ...(parsed.emotion as NonNullable<TextEmotion>) }, 5), hard]);
  check("6f. a settled read before the hard one corrects nothing", before.e.needsCare);
  // The stretch breaks at their word: a hard read after it starts a new stretch.
  const since = hardStretchSince([sig({ emotion: "low", intensity: "high", valence: "negative", readKind: "distress" }, 10), sig({ ...(parsed.emotion as NonNullable<TextEmotion>) }, 8), sig({ emotion: "low", intensity: "high", valence: "negative", readKind: "distress" }, 2)], ago(2));
  check("6g. a stretch stops at their word that they were okay", since.getTime() === ago(2).getTime(), since);
}

// ================================================================ 7. on a call: the moment they say they're okay
{
  const transcript = [
    "assistant: How are you feeling about the email?",
    "user: I'm unsure whether I made the right decision sending the email and accepting",
    "assistant: What's your gut say?",
    "user: and I don't know if this guy will do the right thing honestly",
    "assistant: Should that worry you?",
    "user: my gut is calm, I don't feel anything bad will happen, should I worry about it",
  ].join("\n");
  const concern = (emotion: string): TextEmotion => ({ emotion, intensity: "medium", valence: "negative", about: "the decision", target: "life", readKind: "concern", feltBy: "member", framing: "own" });
  const settled = withReadFields(null, null, true);
  const fake = (m: Record<string, TextEmotion>) => async (message: string) => {
    for (const [k, v] of Object.entries(m)) if (message.includes(k)) return v;
    return null;
  };
  const moments = await callEmotionMoments(transcript, fake({ "right decision": concern("anxious"), "this guy": concern("wary"), "gut is calm": settled }));
  check("7a. the call keeps its worries and their later word that they're okay", moments.length === 3 && moments.filter((m) => m.readKind === "settled").length === 1 && moments.filter((m) => m.readKind === "concern").length === 2, moments);
  const at = ago(1);
  const { e } = state(moments.map((m) => ({ ...m, at })));
  check("7b. read back: no hard stretch, and their word is on record", !e.needsCare && e.saidOkayAt?.getTime() === at.getTime(), e);
  // Even if a line had been read as distress, the later settled line on the same call corrects it.
  const m2 = await callEmotionMoments(transcript, fake({ "right decision": { ...concern("anxious"), readKind: "distress" }, "gut is calm": settled }));
  check("7c. a distress line earlier in the call is corrected by their later word on the same call", !state(m2.map((m) => ({ ...m, at }))).e.needsCare, m2);
  // A worry after the okay: the okay isn't kept, so it can't correct what came after it.
  const later = transcript.replace("user: and I don't know if this guy", "user: placeholder line here").concat("\nuser: and I don't know if this guy will do the right thing honestly");
  const m3 = await callEmotionMoments(later, fake({ "this guy": { ...concern("scared"), readKind: "distress" }, "gut is calm": settled }));
  check("7d. an okay said before a later worry is not kept", !m3.some((m) => m.readKind === "settled") && state(m3.map((m) => ({ ...m, at }))).e.needsCare, m3);
}

// ================================================================ 8. parsing, storing and reading back the new fields
{
  const t = turn({ emotion: { emotion: "Anxious", intensity: "medium", valence: "negative", about: "the deal", target: "life", felt_by: "member", framing: "own", kind: "concern" }, says_okay: false });
  check("8a. the text turn parses who, framing and kind", t.emotion?.readKind === "concern" && t.emotion?.feltBy === "member" && t.emotion?.framing === "own", t.emotion);
  const bad = turn({ emotion: { emotion: "sad", intensity: "high", valence: "negative", target: "life", felt_by: "everyone", framing: "maybe", kind: "settled" } });
  check("8b. unknown values (and a model-chosen 'settled') parse to null: high with no kind still counts", bad.emotion?.readKind === null && bad.emotion?.feltBy === null && bad.emotion?.framing === null && isHardRead({ ...bad.emotion!, basis: null }));
  const pos = turn({ emotion: { emotion: "proud", intensity: "high", valence: "positive", target: "life", kind: "distress" } });
  check("8c. a positive feeling carries no kind", pos.emotion?.readKind === null);
  const co = turn({ emotion: { emotion: "frustrated", intensity: "medium", valence: "negative", target: "co", kind: "concern" }, says_okay: true });
  check("8d. says_okay never settles a feeling about Cue", co.emotion?.readKind === "concern");

  const realQuery = (pool as any).query;
  const seen: { sql: string; args: any[] }[] = [];
  (pool as any).query = async (sql: string, args: any[]) => {
    seen.push({ sql, args });
    if (/FROM emotion_signals/.test(sql) && /LIMIT 100\b/.test(sql)) {
      return { rows: [{ source: "call", emotion: "anxious", intensity: "medium", valence: "negative", about: null, quote: null, created_at: ago(1), read_kind: "concern", felt_by: "member", framing: "own", target: "life", basis: null }] };
    }
    return { rows: [] };
  };
  await recordEmotionSignals("u-1", [{ source: "text", emotion: "anxious", intensity: "medium", valence: "negative", about: "x", quote: "y", target: "life", readKind: "concern", feltBy: "member", framing: "own" }]);
  const ins = seen.find((q) => /INSERT INTO emotion_signals/.test(q.sql));
  const row = ins ? JSON.parse(ins.args[1])[0] : null;
  check("8e. the new fields are stored", !!ins && /read_kind, felt_by, framing/.test(ins.sql) && row?.read_kind === "concern" && row?.felt_by === "member" && row?.framing === "own", row);
  const ctx = await getEmotionalContext("u-1", NOW);
  check("8f. and read back: a stored concern is not a hard stretch", !ctx.needsCare && ctx.current?.readKind === "concern", ctx);
  (pool as any).query = realQuery;
}

// ================================================================ 9. no new block: the new state has only the consumers asked for
{
  const root = new URL("../../", import.meta.url).pathname;
  const users = execSync("grep -rlwE 'isHardRead|readKind|saidOkayAt|readNote' src --include='*.ts' || true", { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  // emotion.ts builds and renders it; the two heavy-moment readers narrow to it (review of #430); migrations.ts names it in a comment.
  const expected = ["src/db/migrations.ts", "src/harness/emotion.ts", "src/harness/replyGrounding.ts", "src/services/heavyMoment.ts"];
  check("9a. the new state is read only where the read is built and rendered, and by the two heavy-moment readers (no new gate on finds or offers)", users.join() === expected.join(), users);
  // The guide is the same words in both reads.
  check("9b. both reads carry the same guide", turnReadAddendum(null, null).includes(EMOTION_READ_GUIDE) && readFileSync(new URL("../../src/harness/emotion.ts", import.meta.url), "utf8").includes("${EMOTION_READ_GUIDE}"));
}

// ================================================================ 10. migrations: only the three emotion_signals columns are new
{
  const mig = readFileSync(new URL("../../src/db/migrations.ts", import.meta.url), "utf8");
  // Review of #430: a find-and-replace once renamed these to read_kind; every proactive send insert would fail on a fresh database.
  check("10a. ask_checkins still adds kind", /ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'find'/.test(mig));
  check("10b. co_tasks still adds kind", /ALTER TABLE co_tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'work'/.test(mig));
  check("10c. proactive_sends still adds kind", /ALTER TABLE proactive_sends ADD COLUMN IF NOT EXISTS kind TEXT`/.test(mig));
  const readKindLines = mig.split("\n").filter((l) => /\bread_kind\b|\bfelt_by\b|\bframing\b/.test(l) && /ADD COLUMN/.test(l));
  check("10d. read_kind, felt_by and framing are added to emotion_signals and nowhere else", readKindLines.length === 3 && readKindLines.every((l) => /ALTER TABLE emotion_signals ADD COLUMN IF NOT EXISTS (read_kind|felt_by|framing) TEXT`/.test(l)), readKindLines);
}

// ================================================================ 11. distress wins over "I'm fine" (review of #430)
{
  const masked = turn({ emotion: { emotion: "hopeless", intensity: "medium", valence: "negative", about: "the point of anything", target: "life", felt_by: "member", framing: "own", kind: "distress" }, says_okay: true });
  check("11a. 'I'm fine, I just don't see the point of anything' (stub: distress, says_okay): stays distress", masked.emotion?.readKind === "distress", masked.emotion);
  const m = sig({ ...(masked.emotion as NonNullable<TextEmotion>), quote: "I'm fine, I just don't see the point of anything" }, 0.5);
  check("11b. ... and keeps the hard stretch and the hold", state([m], 0.5).e.needsCare && state([m], 0.5).hold.state === "held");
  const okay = sig({ ...(withReadFields(null, null, true) as NonNullable<TextEmotion>) }, 1);
  const high = sig({ emotion: "devastated", intensity: "high", valence: "negative", readKind: "distress", feltBy: "member", framing: "own" }, 4);
  const hs = state([high, okay], 1);
  check("11c. a later 'I'm fine' never clears a high distress read the same day", hs.e.needsCare && hs.e.hardAt?.getTime() === ago(4).getTime(), hs.e);
  check("11d. ... and the state never says 'take their word' beside it", !hs.e.saidOkayAt && !/take their word/.test(renderEmotionalContext(hs.e, NOW)));
  const medium = sig({ emotion: "low", intensity: "medium", valence: "negative", readKind: "distress", feltBy: "member", framing: "own" }, 2);
  const mixedDay = state([high, medium, okay], 1);
  check("11e. their word clears a medium distress read but the day's high one still stands", mixedDay.e.needsCare && mixedDay.e.hardAt?.getTime() === ago(4).getTime(), mixedDay.e);
  const legacyHigh = sig({ emotion: "devastated", intensity: "high", valence: "negative" }, 3);
  check("11f. an old high read is not cleared by a later okay either", state([legacyHigh, okay], 1).e.needsCare);
}
{
  // On a call: a high distress line, then "I'm okay" later on the same call.
  const transcript = ["assistant: How are you?", "user: honestly everything is falling apart and I can't cope with any of it", "assistant: I'm here.", "user: anyway I'm fine, really, let's move on"].join("\n");
  const fake = (mm: Record<string, TextEmotion>) => async (message: string) => {
    for (const [k, v] of Object.entries(mm)) if (message.includes(k)) return v;
    return null;
  };
  const moments = await callEmotionMoments(transcript, fake({ "falling apart": { emotion: "overwhelmed", intensity: "high", valence: "negative", about: "everything", target: "life", readKind: "distress", feltBy: "member", framing: "own" }, "I'm fine": withReadFields(null, null, true) }));
  const at = ago(1);
  check("11g. a high distress line on a call is not cleared by a later 'I'm fine' on the same call", state(moments.map((x) => ({ ...x, at }))).e.needsCare, moments);
}

// ================================================================ 12. the heavy-moment readers use the same rule (review of #430)
{
  const { pickEpisode } = await import("../../src/services/heavyMoment.js");
  const { heavyMoment } = await import("../../src/harness/replyGrounding.js");
  const hs = (o: Partial<Sig>, h: number) => ({ source: "text" as const, emotion: "uneasy", intensity: "medium" as const, valence: "negative" as const, about: "the decision", quote: "should I worry about it", target: "life" as const, basis: null, ...o, at: ago(h) });
  const concernDay = royce.map(([emotion, about], i) => hs({ emotion, about, readKind: "concern", feltBy: "member", framing: "own" }, 2 + i));
  check("12a. the next-day care check-in: the five concern reads queue nothing", pickEpisode(concernDay, NOW, "America/Los_Angeles") === null);
  check("12b. ... nor do two old medium reads without a kind", pickEpisode([hs({}, 3), hs({}, 2)], NOW, "America/Los_Angeles") === null);
  const distressDay = [hs({ emotion: "low", about: "the breakup", quote: "I can't get out of bed since the breakup", readKind: "distress", feltBy: "member", framing: "own" }, 3), hs({ emotion: "exhausted", about: "everything", quote: "everything's falling apart", readKind: "distress", feltBy: "member", framing: "own" }, 2)];
  check("12c. two medium distress reads still make an episode", pickEpisode(distressDay, NOW, "America/Los_Angeles") !== null);
  check("12d. an old high read still makes an episode", pickEpisode([hs({ intensity: "high", emotion: "grieving", about: "my dad", quote: "my dad passed" }, 2)], NOW, "America/Los_Angeles") !== null);
  check("12e. someone else's feeling makes none", pickEpisode([hs({ intensity: "high", readKind: "distress", feltBy: "other", about: "my co-founder" }, 2)], NOW, "America/Los_Angeles") === null);
  check("12f. their later word that they're okay settles a medium episode", pickEpisode([...distressDay, hs({ emotion: "okay", intensity: "low", valence: "mixed", about: null, quote: null, readKind: "settled" }, 1)], NOW, "America/Los_Angeles") === null);
  check("12g. ... never one with a high distress read in it", pickEpisode([hs({ intensity: "high", readKind: "distress", feltBy: "member", framing: "own" }, 2), hs({ emotion: "okay", intensity: "low", valence: "mixed", about: null, quote: null, readKind: "settled" }, 1)], NOW, "America/Los_Angeles") !== null);
  // The self-harm bail sees every read in the window, never only the episode's (review of #430).
  const lostJob = hs({ intensity: "high", emotion: "devastated", about: "lost my job", quote: "I lost my job today", readKind: "distress", feltBy: "member", framing: "own" }, 3);
  check("12l. the probe: a distress read plus a self-harm line read as unsure: no care text is queued", pickEpisode([lostJob, hs({ emotion: "hopeless", about: null, quote: "honestly I want to end it all", readKind: "unsure", feltBy: "member", framing: "own" }, 2)], NOW, "America/Los_Angeles") === null);
  check("12m. an old medium self-harm row without a kind still bails", pickEpisode([lostJob, hs({ emotion: "hopeless", about: null, quote: "honestly I want to end it all" }, 2)], NOW, "America/Los_Angeles") === null);
  check("12n. a quoted self-harm line still bails (conservative)", pickEpisode([lostJob, hs({ emotion: "scared", about: null, quote: "she said she wanted to end it all", readKind: "distress", feltBy: "member", framing: "quoted" }, 2)], NOW, "America/Los_Angeles") === null);
  check("12o. someone else's self-harm line, or one read as positive or about Cue, still bails", [{ feltBy: "other" as const, readKind: "distress" as const }, { valence: "positive" as const }, { target: "co" as const }].every((o) => pickEpisode([lostJob, hs({ emotion: "x", about: null, quote: "I want to end it all", ...o }, 2)], NOW, "America/Los_Angeles") === null));
  check("12p. ... and without the self-harm line the same episode is queued (the bail is what stops it)", pickEpisode([lostJob], NOW, "America/Los_Angeles") !== null);
  const ctx = (current: Sig) => ({ ...summarizeSignals([], NOW), current });
  check("12h. heavyMoment: a high concern right now is not heavy", !heavyMoment(ctx(sig({ emotion: "worried", intensity: "high", valence: "negative", readKind: "concern" }, 0.5))));
  check("12i. heavyMoment: high distress right now is heavy", heavyMoment(ctx(sig({ emotion: "panicked", intensity: "high", valence: "negative", readKind: "distress" }, 0.5))));
  check("12j. heavyMoment: an old high read without a kind is heavy, as before", heavyMoment(ctx(sig({ emotion: "panicked", intensity: "high", valence: "negative" }, 0.5))));
  check("12k. heavyMoment: someone else's high distress is not", !heavyMoment(ctx(sig({ emotion: "panicked", intensity: "high", valence: "negative", readKind: "distress", feltBy: "other" }, 0.5))));
}

console.log(`hard stretch: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit();
