// Model-free checks for dated corrections (harness/profileWrite.ts and its
// wiring). No network.
//
//   npx tsx evals/corrections/rules.ts
import { readFileSync } from "fs";
import { applyCorrections, gateCorrections, mightBeCorrection, renderCorrections, type OnFile } from "../../src/harness/profileWrite.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const onFile: OnFile = {
  city: "San Francisco",
  life_chapters: ["founder building a startup", "new to the city"],
  goals: ["find a cofounder"],
  activity_preferences: ["running"],
};
const said = "haha no I'm not a founder, I'm a product designer at a startup. and I live in Oakland now";

// ---------------------------------------------------------------- the cheap first pass
check("first pass: a real correction gets checked", mightBeCorrection(said) && mightBeCorrection("I moved to Oakland last month") && mightBeCorrection("I don't really run anymore") && mightBeCorrection("weeknights are tough now, weekends are better for me"));
check("first pass: plain news skips the model", !mightBeCorrection("had a great run this morning!") && !mightBeCorrection("see you thursday"));

// ---------------------------------------------------------------- the gate
const g = gateCorrections(
  [
    { field: "life_chapters", old: "founder building a startup", new: "product designer at a startup", quote: "I'm not a founder, I'm a product designer" },
    { field: "city", old: "San Francisco", new: "Oakland", quote: "I live in Oakland now" },
    { field: "goals", old: "find a cofounder", new: null, quote: "not looking for a cofounder" }, // not what they said
    { field: "city", old: "Berlin", new: "Oakland", quote: "I live in Oakland now" }, // not on file
    { field: "emotional_state", old: "calm", new: "stressed", quote: "I'm a product designer" }, // not correctable
    { field: "activity_preferences", old: "running", new: null, quote: "no" }, // too short
  ],
  onFile,
  said,
);
check("gate: supported corrections pass", g.accepted.length === 2 && g.accepted[0].new === "product designer at a startup" && g.accepted[1].field === "city");
check("gate: a quote they didn't say is rejected", g.rejected.some((r) => r.proposal.field === "goals" && r.reason === "quote isn't in what they just said"));
check("gate: an old value that isn't on file is rejected", g.rejected.some((r) => r.proposal.old === "Berlin" && r.reason === "old value isn't on file"));
check("gate: only profile fields can be corrected", g.rejected.some((r) => r.proposal.field === "emotional_state"));
check("gate: a one-word quote isn't enough", g.rejected.some((r) => r.proposal.quote === "no"));
{
  const co = gateCorrections([{ field: "city", old: "San Francisco", new: "Oakland", quote: "you live in Oakland now" }], onFile, "Co replied: so you live in Oakland now?\nuser: yep");
  check("gate: Cue's own words never count as their correction", co.accepted.length === 0);
}

// ---------------------------------------------------------------- applying
const applied = applyCorrections({ ...onFile }, g.accepted);
check("apply: the old list item comes off and the new one goes first", JSON.stringify(applied.life_chapters) === JSON.stringify(["product designer at a startup", "new to the city"]));
check("apply: a single field is replaced", applied.city === "Oakland");
check("apply: untouched fields stay", JSON.stringify(applied.goals) === JSON.stringify(["find a cofounder"]));
{
  const dropped = applyCorrections({ activity_preferences: ["running", "climbing"] }, [{ field: "activity_preferences", old: "running", new: null, quote: "I don't run anymore" }]);
  check("apply: 'that's wrong' with nothing new just removes it", JSON.stringify(dropped.activity_preferences) === JSON.stringify(["climbing"]));
}

// ---------------------------------------------------------------- what Co sees
const shown = renderCorrections([
  { field: "city", old_value: "San Francisco", new_value: "Oakland", corrected_at: "2026-09-23T18:00:00Z" },
  { field: "activity_preferences", old_value: "running", new_value: null, corrected_at: "2026-09-20T18:00:00Z" },
]);
check("context: old, new and the date", shown.includes(`you had "San Francisco"; they corrected it to "Oakland" on Sep 23`));
check("context: a removal says it was wrong, with the date", shown.includes(`you had "running"; they said that's wrong on Sep 20`));

// ---------------------------------------------------------------- wiring
const pe = src("services/profileExtraction.ts");
check("the profile write checks for corrections alongside resolutions", /assessCorrections\(onFile, opts\.newWords \?\? transcript, transcript, user_id\)/.test(pe));
check("corrections are stored with their date", /INSERT INTO profile_corrections/.test(pe) && /corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/.test(src("db/migrations.ts")));
check("a corrected fact can't be put back by a later extraction", /wasCorrectedAway/.test(pe) && /recentlyCorrected\(user_id\)/.test(pe));
// Through the turn's one learning read now (services/turnLearning.ts, 2026-09-28).
check("texts pass only what they just said as new", /message: resolvedContent,/.test(src("routes/sendblue.ts")) && /storeProfile\(input\.userId, learned\.profile as any, transcript, \{\s*newWords: input\.message,/.test(src("services/turnLearning.ts")) && /mightBeCorrection\(input\.message\)/.test(src("services/turnLearning.ts")));
check("Cue sees corrections first, with the rule to never state the old one", /Things they've corrected .*never state the old one as true/.test(src("services/callContext.ts")));
check("a correction is a Sonnet judgment, logged", /model: anthropic\(PROFILE_JUDGMENT_MODEL\),\n\s+prompt: buildCorrectionPrompt/.test(pe) && /decision: "profile\.correct"/.test(pe));

console.log(`correction rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
