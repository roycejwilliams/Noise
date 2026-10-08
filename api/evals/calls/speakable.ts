// Making Co's words speakable (services/speakable.ts). Layer 1: pure, no model, no network.
//   npx tsx evals/calls/speakable.ts
// Replays what Co really said on the 10/6 call (Haiku, dashes and 30-word sentences) through the cleaner, whole and as a stream.
import fs from "node:fs";
const S = await import("../../src/services/speakable.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/call-2026-10-06.json", import.meta.url), "utf8"));
const coLines: string[] = fixture.turns.filter((t: any) => t.role === "agent").map((t: any) => String(t.message));

// Fed as a model streams it: a few characters at a time.
const streamed = (text: string, size: number) => {
  const st = new S.SpeakableStream();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...st.push(text.slice(i, i + size)));
  out.push(...st.end());
  return out;
};

// ---- the rules, one at a time
check("an unspaced dash becomes a stop and a capital", S.speakable("That's smart—keeping it warm first.") === "That's smart. Keeping it warm first.");
check("a spaced dash and a double hyphen do too", S.speakable("Do it now - then rest.") === "Do it now. Then rest." && S.speakable("Do it now -- then rest.") === "Do it now. Then rest.");
check("a hyphen inside a word is left alone", S.speakable("A well-known low-key fair.") === "A well-known low-key fair.");
check("a semicolon is a plain stop", S.speakable("It is free; come and go as you like.") === "It is free. Come and go as you like.");
check("parentheses are plain stops, no brackets reach the voice", !/[()]/.test(S.speakable("The fair (it is free) runs Sunday.")) && S.speakable("The fair (it is free) runs Sunday.") === "The fair. It is free. Runs Sunday.");
check("a line break is a stop, and a paragraph's last words get one", S.speakable("Got it\n\nThat works") === "Got it. That works.");
check("a voice cue stays at the front of its sentence and does not count as a word", S.speakable("[softly] A long day like that will drain you.") === "[softly] A long day like that will drain you.");
check("abbreviations and decimals are not sentence ends", S.speakable("It starts at 3 p.m. Dr. Lee hosts it, about 3.5 hours.") === "It starts at 3 p.m. Dr. Lee hosts it, about 3.5 hours.");
check("a word like iPhone is never capitalized by a break", S.speakable("Try this—iPhone only.") === "Try this. iPhone only.");

// ---- long sentences: the break mechanics, pinned to a 15-word limit (the live limit is MAX_SENTENCE_WORDS, 24 since 2026-10-08)
const split15 = (x: string) => S.splitLong(x, 15);
const long = "So Jacqueline's already connected with him, and you're thinking dinners or lunch to see what actually makes sense to do together";
const split = split15(long + ".");
check("a long sentence closes at a comma (not a later 'or'), dropping the 'and' that only joined", split.length === 2 && split[0] === "So Jacqueline's already connected with him." && /^You're thinking dinners or lunch/.test(split[1]), split);
check("every piece is within 15 words", split.every((p) => S.wordCount(p) <= 15), split);
check("a bare conjunction is never a break: it can sit inside a phrase (\"you and Jacqueline\")", !split15("I'd want to know what matters to you and Jacqueline when you both sit down with them next week.").some((p) => /\byou\.$/.test(p)));
check("with nothing to break on it still never leaves a sentence past 15 words", split15("Honestly the entire arrival experience for everybody walking into the room matters far more than anything else we could possibly decide today.").every((p) => S.wordCount(p) <= 15));
check("a short sentence is untouched", split15("That makes sense.").join("|") === "That makes sense.");

// ---- how the breaks sound (the cases from the live replay that read wrong)
{
  const q = split15("Have you two landed on what you'd want to get out of that meal, or are you still figuring that part out?");
  check("a question's first half stays a question", q.length === 2 && /meal\?$/.test(q[0]) && /^Or are you still figuring that part out\?$/.test(q[1]), q);
  const eo = S.splitLong("You thinking you'd do it on their phones before they walk in or someone talking to them as they walk in the door?");
  check("either/or with no comma stays one question (a bare 'or' is not a break)", eo.length === 1 && /\?$/.test(eo[0]), eo);
  const intro = split15("So you want me to find the real overlap so when you go into that dinner or lunch, you've got something concrete to talk about.");
  check("never cut after an introductory 'when' clause (its main clause is still to come)", intro.every((p) => !/lunch\.$/.test(p)), intro);
  const mid = split15("Then inside, they text you when they want an intro, and you've already got the depth.");
  check("a 'when' in the middle of a sentence does not stop a comma break", mid.length === 2 && mid.every((p) => S.wordCount(p) <= 15), mid);
  check("'before ...' is a clause, not a preposition to cut at", !split15("That's a sharp angle you're already seeing how Co fits into their event before you even sit down with them.").some((p) => /^Before /.test(p)));
  const stream = streamed("Are you looking to do that before November or does it make sense to wait until closer to the launch?", 4).join("");
  check("streamed: a question past the limit still arrives as questions, never a dangling statement", /\?\s*$/.test(stream) && !/November\.\s/.test(stream), stream);
  const lead = split15("Before I dig into what alignment might look like with them, I want to make sure I understand what you are asking me for.");
  check("a long lead-in with nowhere else to break still closes within the limit (at its comma, the last resort)", lead.every((p) => S.wordCount(p) <= 15), lead);
  const shortLead = split15("Before I close, let me check I have this right about the November plan and where you are with Sequent.");
  check("never cut after a short lead-in ('Before I close,')", !shortLead.some((p) => /^Before I close\.$/.test(p)), shortLead);
  const whole = "Here's who else is in the room that matters to you based on what you do.";
  check("a sentence only a little over the limit with no natural break is left whole, not broken mid-phrase", split15(whole).length === 1 && S.wordCount(whole) <= 18);
  const long2 = "Honestly the entire arrival experience for everybody walking into the room matters far more than anything else we could possibly decide today.";
  const out2 = split15(long2);
  check("a longer one with no natural break still closes, never on a dangling word", out2.every((p) => S.wordCount(p) <= 15) && !out2.some((p, i) => i < out2.length - 1 && /\b(a|an|the|to|of|in|on|at|for|with|that|based)\.$/.test(p)), out2);
  check("'and' with no comma before it is dropped at the break: no 'And see...' fragment", !split15("You're thinking dinner or lunch to keep the door open and see what makes sense down the line from there.").some((p) => /^And /.test(p)));
}

// ---- replay: what Co really said on the call
const raw = coLines.join(" ");
const before = S.speechStats(raw);
check("the real call had dashes and long sentences (the fixture is the failure)", before.dashes >= 10 && before.over >= 8, before);
const whole = S.speakable(raw, { maxReplyWords: 100000 });
const after = S.speechStats(whole);
check("replay, whole: zero dashes", after.dashes === 0 && after.semicolons === 0 && after.parens === 0, after);
check("replay, whole: zero sentences past the limit", after.over === 0, after);
check("replay, whole: shorter on average", after.avg < before.avg, { before: before.avg, after: after.avg });
for (const size of [1, 3, 7, 20]) {
  const chunks = coLines.flatMap((l) => streamed(l, size));
  const joined = chunks.join("");
  const st = S.speechStats(joined);
  check(`replay, streamed ${size} chars at a time: zero dashes, zero sentences past the limit`, st.dashes === 0 && st.over === 0 && st.semicolons === 0, st);
  check(`replay, streamed ${size} at a time: every chunk is a complete sentence (ends in . ! or ?)`, chunks.every((c) => /[.!?]["')\]]*\s$/.test(c)), chunks.filter((c) => !/[.!?]["')\]]*\s$/.test(c)).slice(0, 3));
  check(`replay, streamed ${size} at a time: no words lost or glued`, joined.replace(/[^a-z0-9']+/gi, " ").toLowerCase().split(" ").filter(Boolean).length >= raw.replace(/[^a-z0-9']+/gi, " ").toLowerCase().split(" ").filter(Boolean).length - 40);
}

// ---- the first sentence reaches the voice as soon as it is complete, not when the reply is
{
  const toks = ["That", "'s", " smart", ".", " Keep", " it", " warm", " first", ".", " What", " would", " you", " want", " out", " of", " it", "?"];
  const st = new S.SpeakableStream();
  let firstAt = -1, count = 0;
  toks.forEach((t, i) => { const out = st.push(t); if (out.length && firstAt < 0) firstAt = i; count += out.length; });
  check("the first sentence is out by the token that starts the second, long before the reply ends", firstAt === 4 && count === 2, { firstAt, count });
}
{
  // A sentence that runs long is closed early at its comma instead of waiting for a stop that may be thirty words away.
  const st = new S.SpeakableStream();
  const words = "So you want me to dig into Sequent AI, what they are building and who they are targeting and what their whole launch looks like for everybody in the room".split(" ");
  let firstAt = -1;
  words.forEach((w, i) => { const out = st.push((i ? " " : "") + w); if (out.length && firstAt < 0) firstAt = i; });
  check("a long unfinished sentence is closed at a comma before its end arrives", firstAt > 0 && firstAt < words.length - 1, { firstAt, of: words.length });
}

// ---- long replies are cut at a sentence, keeping the closing question
{
  const body = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} says one small thing here.`).join(" ");
  const out = S.speakable(`${body} What do you think?`, { maxReplyWords: 40 });
  check("a reply past the cap is cut at a sentence boundary", S.wordCount(out) <= 40 + 8 && /\.$|\?$/.test(out) && !/number 19/.test(out), out);
  check("and its closing question is kept", /What do you think\?$/.test(out), out);
  const noQ = S.speakable(body, { maxReplyWords: 40 });
  check("without a question it just stops at the cap", S.wordCount(noQ) <= 40 + 8 && /\.$/.test(noQ));
}


// ---- the 2026-10-08 call's fragments, at the live limit
{
  const today = [
    ["From where I sit, the most useful role at an event is helping people find the right person in the room before they've talked to anyone.", /^From where I sit\.$/],
    ["When we hang up, I'll set up a task to draft a planning doc, a launch plan for the Sequin AI event, covering how Co shows up there.", /^When we hang up\.$/],
    ["Do you want me to hold onto this so the next time we talk, we pick up from the cost split?", /talk\.$/],
    ["Where does it get hard when you and Jacqueline sit down with them next week to talk it through?", /\byou\.$/],
  ] as const;
  for (const [line, frag] of today) check(`2026-10-08 call: no fragment from "${line.slice(0, 40)}..."`, !S.speakable(line).split(/(?<=[.?!])\s+/).some((p) => frag.test(p)), S.speakable(line));
  check("a very long run-on still closes where two clauses join", S.splitLong("We could start with the guest list for the November night at House of AI, and then we can work out how Co shows up for each person once they walk into the room and start talking.").length >= 2);
}
console.log(`speakable: ${total - failed}/${total} checks`);
if (failed) process.exit(1);
