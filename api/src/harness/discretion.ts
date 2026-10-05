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
  // Neutral, for when they're waiting on Co's own offer and a confidence would hint at a secret.
  "That's as far as I can take that one. What I can do is go from what you've told me.",
  "That one stays where it is. I can tell you what I know about you and what I can do next.",
] as const;

// Marks a turn where a block tripped, so the reply grounding knows to hold the
// reply to these rules. Part of the instruction, never said aloud.
export const DISCRETION_MARK = "[discretion]";
// The mark of a turn where the member is waiting on Co's own offer: only the neutral lines fit.
export const NEUTRAL_MARK = "[discretion neutral]";
export const NEUTRAL_LINES = DISCRETION_LINES.slice(-2);

const list = () => DISCRETION_LINES.map((l) => `- ${l}`).join("\n");

// Handed to the reply model when a gate has tripped this turn (texts).
export function discretionInstruction(situation: string, opts: { neutral?: boolean } = {}): string {
  return `\n${opts.neutral ? NEUTRAL_MARK : DISCRETION_MARK} ${situation}
This is a matter of discretion, and Co has done nothing wrong, so there is nothing to apologize for. Reply with exactly ONE of these lines, word for word, and nothing about why:
${(opts.neutral ? NEUTRAL_LINES : DISCRETION_LINES).map((l) => `- ${l}`).join("\n")}
You may add one short sentence after it, only from what you know about them or what you can actually do next. Never apologize, never say anything fell through, isn't available, was a mistake or a false start, never explain or hint at a reason, never mention privacy, rules, permission or a check, and never name, describe or guess anything about the other person.`;
}

// What the reply model reads on every text, and the call prompt carries, for
// when someone asks Co to speak for another member.
export const DISCRETION_GUIDE = `Discretion: you never speak for another member of Co. If they ask what another member thinks, wants, said or feels, whether a member you know through Co is interested in them, or who a member is beyond what you've been told to share, answer with one of these lines, word for word, then say what you do know about them:
${list()}
This is only about members of Co. People in their own life (their boss, a date, family, a friend you've never matched them with) you talk about freely. Never apologize for keeping a confidence, never say you aren't allowed or that something is blocked, restricted or private, and never explain why. Discretion is just how you are, not a rule you're following.`;

// ---------- checks

// An apology, or a retraction of what was just said. A block calls for neither.
const APOLOGY = /\b(?:sorry(?! to hear| for your| you'?re| you had| that you| about your)|apolog\w*|my bad|oops|my mistake|my error|false start|scratch that|never ?mind (?:that|my last|what i said)|forgive me|excuse me|i misspoke|i shouldn'?t have|spoke too soon|jumped the gun|ignore (?:my|that|the) last|mix-?up|i was wrong|unfortunately|let me (?:redo|rephrase|start over|try that again)|(?:that|this) was a mistake|turns out[^.!?]*\b(?:not|isn'?t|aren'?t|won'?t|can'?t|couldn'?t|no longer|anymore|fell|wrong|mistake)\b)/i;
// The machinery: why something was held back, in the system's words.
const MACHINERY =
  /\b(?:privacy|policy|policies|consent|guardrails?|safeguards?|compliance|confidential|not available|isn'?t available|no longer available|fell through|fell apart|didn'?t go through|couldn'?t go through|didn'?t work out|didn'?t pan out|(?:it'?s|that'?s|this is|got|been) blocked|blocked (?:by|that|this|it)|my filter|the filter|(?:got |was |is )filtered|restricted|restriction|(?:not|n'?t) allowed|(?:can'?t|cannot|unable to|not able to|won'?t be able to) (?:share|reveal|disclose|go (?:further|there)|(?:say|tell|give)(?: you)? (?:that|this|who|what|anything|more|much|any|about))|my system|the system (?:won'?t|doesn'?t|can'?t|blocked|says|flagged|prevents)|my rules|programmed|off limits|that'?s not possible|i shouldn'?t say|i'?d get in trouble|(?:no|without|lack(?:ing)?|don'?t have|waiting on) (?:the )?permission)\b/i;
// The flat dead end the grounding falls to.
const DEAD_END = /not sure on that one|don'?t have an answer|nothing confirmed|i can'?t help with that one|(?:can'?t|cannot|won'?t|not going to) (?:put you(?: two)? in touch|put you two|introduce you|connect you(?: two)?)|that (?:intro|introduction) (?:won'?t|isn'?t|is not|can'?t)|it'?s not happening|no longer an option|(?:got|was|been) cancel+ed/i;
// Claims about the other member: what they said, decided or feel. Never Co's to make.
const CLAIMS_OTHER = /\b(?:they|he|she)(?:'d|'re|'s)?\s+(?:said no|decided (?:not|against)|passed(?: on)?\b|declined|turned (?:it|you|this|that) down|(?:would )?rather(?: not)?|prefer(?:s)? not|(?:don'?t|doesn'?t) want to (?:meet|be introduced|connect|talk)|(?:isn'?t|aren'?t|wasn'?t|weren'?t|is not|are not|not) (?:open|interested|keen|up for|ready)(?= to| in| for| about|\.|,|$)|no longer (?:interested|open|available|keen))|something came up on (?:their|his|her) (?:end|side)/i;

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const sentences = (s: string) => (s.match(/[^.!?\n]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 0);

export function usesApprovedLine(text: string, lines: readonly string[] = DISCRETION_LINES): boolean {
  const t = norm(text);
  return lines.some((l) => t.includes(norm(l)));
}

// Pure: why a reply to a tripped block can't be sent, or [] when it's discreet.
// requireLine: the first reply on a blocked turn must be an approved line; a later
// reply (the member asked something else too) only has to be free of the rest.
export function discretionProblems(text: string, opts: { otherNames?: string[]; requireLine?: boolean; lines?: readonly string[] } = {}): string[] {
  const out: string[] = [];
  // Curly apostrophes read the same as straight ones (the patterns are written with straight).
  const t = text.trim().replace(/[’‘]/g, "'");
  if (!t) return ["empty"];
  const requireLine = opts.requireLine ?? true;
  if (requireLine && t.split(/\s+/).length < 6) out.push("a fragment");
  const apology = t.match(APOLOGY);
  if (apology) out.push(`an apology or a retraction ("${apology[0]}")`);
  const machine = t.match(MACHINERY);
  if (machine) out.push(`the machinery's words ("${machine[0]}")`);
  if (DEAD_END.test(t)) out.push("a dead end");
  const other = t.match(CLAIMS_OTHER);
  if (other) out.push(`a claim about the other person ("${other[0]}")`);
  for (const n of opts.otherNames ?? []) {
    const parts = n.split(/[^\w]+/).filter(Boolean);
    if (parts.length && new RegExp(`\\b${parts.join("[-\\s]?")}\\b`, "i").test(t)) out.push(`names the other person (${n})`);
  }
  if (requireLine && !usesApprovedLine(t, opts.lines)) out.push("not one of the approved lines");
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
export function pickDiscretion(seed: string, last: string | null = null, lines: readonly string[] = DISCRETION_LINES): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const fresh = lines.filter((l) => l !== last);
  return fresh[h % fresh.length];
}

// Pure: whether a turn is one where a block tripped (the gate marked it).
export function isDiscreetTurn(instructions: string[]): boolean {
  return instructions.some((i) => i.includes(DISCRETION_MARK) || i.includes(NEUTRAL_MARK));
}
export function isNeutralTurn(instructions: string[]): boolean {
  return instructions.some((i) => i.includes(NEUTRAL_MARK));
}

// Pure: on a blocked turn, what actually goes out: the model's reply if it is
// discreet, else an approved line. `replaced` says which, and why.
export function discreetFinal(final: string, seed: string, otherNames: string[] = [], requireLine = true, neutral = false): { final: string; replaced: boolean; problems: string[] } {
  const lines = neutral ? NEUTRAL_LINES : DISCRETION_LINES;
  const problems = discretionProblems(final, { otherNames, requireLine, lines });
  // A later reply on the same turn that fails is dropped, not repeated as the same line.
  if (problems.length && !requireLine) return { final: "", replaced: true, problems };
  return problems.length ? { final: pickDiscretion(seed, null, lines), replaced: true, problems } : { final, replaced: false, problems };
}
