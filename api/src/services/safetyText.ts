// What Co says and watches for when someone may not be safe
// (services/safety.ts). Dependency-free, so model-free checks and the
// capability registry can read it without a database.
export const CRISIS_RESOURCES =
  "In the US, the 988 Suicide & Crisis Lifeline is free and open 24/7: call or text 988, or chat at 988lifeline.org. Anyone in immediate danger should call 911.";

// Unmistakable only: wide enough to catch the obvious, narrow enough that
// "this commute is killing me" or "I'd die for a good bagel" never trips it.
const SIGNALS: RegExp[] = [
  /\b(kill|hurt|harm|cut) (myself|my self)\b/i,
  /\bsuicid(e|al)\b/i,
  /\b(want|wanna|going|plan(ning)?) to (die|end my life|not be here|disappear forever)\b/i,
  // "end it" only on its own or as "end it all", never "end it with my cofounder".
  /\b(want|wanna|going|plan(ning)?) to end it( all\b|\s*($|[.!?,]))/i,
  /\b(end(ing)?|take|taking) my (own )?life\b/i,
  /\bdon'?t want to (be alive|live|wake up|exist)( anymore)?\b/i,
  /\b(no|not any) (reason|point) (to|in) (live|living|being alive|going on)\b/i,
  /\b(better off|world would be better) (dead|without me)\b/i,
  /\bnot (safe|going to be safe) (with|around) myself\b/i,
  /\b(overdose|od) (on|tonight)\b/i,
];

export function soundsLikeCrisis(text: string): boolean {
  return SIGNALS.some((p) => p.test(text));
}

export const SAFETY_INSTRUCTION = `What they just said may mean they're thinking about hurting themselves or aren't safe. This comes before anything else in this reply: no events, offers, searches or tapbacks. Stay with them, warmly and plainly, in your own voice. Say you're glad they told you. Ask directly whether they're safe right now. Share the resource in Co's facts (988, and 911 if they're in immediate danger) once, simply, without sounding like a script. Don't argue with how they feel, don't diagnose, don't promise things will be fine, and don't hand them off and leave: keep the door open to keep talking. Call flagSafetyConcern.`;

// Self-harm wording (moved here from services/heavyMoment.ts so pure readers can share it).
export const SELF_HARM = /\b(?:suicid\w*|kill(?:ing)? (?:my|him|her|them)self|end(?:ing)? (?:it all|my life)|take my own life|hurt(?:ing)? myself|cut(?:ting)? myself|overdos\w+|self[- ]?harm|disappear|better off without me|(?:want|wanted|wanna) (?:to )?die|(?:can'?t|cannot) go on|no (?:point|reason) (?:in )?(?:living|going on|being here)|don'?t want to (?:be here|wake up|live|exist))\b/i;

// Pure: a line that carries a safety signal (crisis wording or self-harm wording). Such a line is never filtered, cut or rewritten
// by anything that tidies what Co reads (services/whatCoKnows.ts guardText): the safety read must always see it whole.
export function safetySignal(text: string): boolean {
  return soundsLikeCrisis(text) || SELF_HARM.test(text);
}
