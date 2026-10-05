// Discretion (Royce, 2026-10-04, brand fix 1): when a privacy or consent block
// stops Co from saying something, the member should see discretion working,
// never the machinery. Before this a tripped reveal gate told the reply model to
// "say so briefly and honestly", and Co improvised an explanation and an apology;
// the claim check then cut the explanation and left the apology on its own
// (2026-10-03, real: "Turns out that one's not available anymore, so I can't put
// you two in touch. Sorry for the false start." went out as "Sorry for the false
// start.").
//
// What it is now:
//   - a small approved set of lines, in Co's voice, that claim nothing and
//     explain nothing ("that's theirs to tell, not mine; I can speak to what I
//     know about you");
//   - a guide the reply model reads (texts) and the call prompt carries (calls),
//     and an instruction a tripped gate hands the reply model, so the model
//     chooses a line itself;
//   - checks in code that a privacy block can never produce an apology for
//     nothing, a false start, a fragment, or the machinery's own words;
//   - the same checks as a backstop in the reply grounding, which falls back to
//     an approved line itself if the model's reply fails them.
// A block never calls for an apology: Co did nothing wrong by keeping a
// confidence.

// Each one stands alone, makes no claim about the other person, about what Co
// did or will do, and gives no reason. A reply may add one short sentence that
// only uses what Co knows about the member.
export const DISCRETION_LINES = [
  "That one's theirs to tell, not mine. What I can speak to is what you've told me, and what I can do with it.",
  "I keep what people tell me to myself. What I can say is what I know about you, and I'm glad to start there.",
  "I won't speak for them. What I can say comes from your side: what you've asked me for.",
  "What someone else has shared stays with them. I can tell you what I know about you.",
  "I don't speak for people who aren't in the conversation. Here's what I can say without speaking for them: I know what you're after, and that's what I go on.",
  "That's theirs to share when they choose. From my side, I can tell you what I know about you and what I can do next.",
  "I'd rather let them speak for themselves. What I can do is go from what you've told me.",
  "Some things stay with the person who said them. I can tell you what I know about you.",
] as const;

// Marks a turn where a block tripped, so the reply grounding knows to hold the
// reply to these rules. Part of the instruction, never said aloud.
export const DISCRETION_MARK = "[discretion]";

const list = () => DISCRETION_LINES.map((l) => `- ${l}`).join("\n");

// Handed to the reply model when a gate has tripped this turn (texts).
export function discretionInstruction(situation: string): string {
  return `\n${DISCRETION_MARK} ${situation}
This is a matter of discretion, and Co has done nothing wrong, so there is nothing to apologize for. Reply with exactly ONE of these lines, word for word, and nothing about why:
${list()}
You may add one short sentence after it, only from what you know about them or what you can actually do next. Never apologize, never say anything fell through, isn't available, was a mistake or a false start, never explain or hint at a reason, never mention privacy, rules, permission or a check, and never name, describe or guess anything about the other person.`;
}

// What the reply model reads on every text, and the call prompt carries, for
// when someone asks Co to speak for another member.
export const DISCRETION_GUIDE = `Discretion: you never speak for another member. If they ask what someone else thinks, wants, said or feels, whether someone is interested in them, or who someone is beyond what you've been told to share, answer with one of these lines, word for word, then say what you do know about them:
${list()}
Never apologize for keeping a confidence, never say you aren't allowed or that something is blocked, restricted or private, and never explain why. Discretion is just how you are, not a rule you're following.`;

// ---------- checks

// An apology, or a retraction of what was just said. A block calls for neither.
const APOLOGY = /\b(?:sorry|apolog\w*|my bad|oops|my mistake|false start|scratch that|never ?mind that|forgive me|excuse me|i misspoke|i shouldn'?t have|let me (?:redo|rephrase|start over|try that again)|(?:that|this) was a mistake|turns out)\b/i;
// The machinery: why something was held back, in the system's words.
const MACHINERY =
  /\b(?:privacy|policy|policies|permission|consent|filter(?:ed)?|blocked?|gate|guardrails?|restrict(?:ed|ion|ions)?|not allowed|aren'?t allowed|isn'?t allowed|can'?t share|cannot share|unable to|not able to|my system|the system|my rules|programmed|safeguards?|compliance|confidential|not available|isn'?t available|no longer available|fell through|didn'?t go through|couldn'?t go through)\b/i;
// The flat dead end the grounding falls to.
const DEAD_END = /not sure on that one|don'?t have an answer|nothing confirmed|i can'?t help with that|i can'?t do that/i;

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const sentences = (s: string) => (s.match(/[^.!?\n]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 0);

export function usesApprovedLine(text: string): boolean {
  const t = norm(text);
  return DISCRETION_LINES.some((l) => t.includes(norm(l)));
}

// Pure: why a reply to a tripped block can't be sent, or [] when it's discreet.
export function discretionProblems(text: string, opts: { otherNames?: string[] } = {}): string[] {
  const out: string[] = [];
  const t = text.trim();
  if (!t) return ["empty"];
  if (t.split(/\s+/).length < 6) out.push("a fragment");
  const apology = t.match(APOLOGY);
  if (apology) out.push(`an apology or a retraction ("${apology[0]}")`);
  const machine = t.match(MACHINERY);
  if (machine) out.push(`the machinery's words ("${machine[0]}")`);
  if (DEAD_END.test(t)) out.push("a dead end");
  for (const n of opts.otherNames ?? []) if (n && new RegExp(`\\b${n.replace(/[^\w]/g, "")}\\b`, "i").test(t)) out.push(`names the other person (${n})`);
  if (!usesApprovedLine(t)) out.push("not one of the approved lines");
  return out;
}

// Pure: what is left is only an apology or a retraction, the residue of a cut
// (2026-10-03: "Sorry for the false start." was all that remained).
export function apologyOnly(text: string): boolean {
  const ss = sentences(text);
  if (!ss.length) return false;
  return ss.every((s) => APOLOGY.test(s) && s.split(/\s+/).length <= 9);
}

// Pure: an approved line, never the one used last time when there is another.
export function pickDiscretion(seed: string, last: string | null = null): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const fresh = DISCRETION_LINES.filter((l) => l !== last);
  return fresh[h % fresh.length];
}

// Pure: whether a turn is one where a block tripped (the gate marked it).
export function isDiscreetTurn(instructions: string[]): boolean {
  return instructions.some((i) => i.includes(DISCRETION_MARK));
}

// Pure: on a blocked turn, what actually goes out: the model's reply if it is
// discreet, else an approved line. `replaced` says which, and why.
export function discreetFinal(final: string, seed: string, otherNames: string[] = []): { final: string; replaced: boolean; problems: string[] } {
  const problems = discretionProblems(final, { otherNames });
  return problems.length ? { final: pickDiscretion(seed), replaced: true, problems } : { final, replaced: false, problems };
}
