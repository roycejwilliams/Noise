// The purpose boundary (Royce, 2026-11-04, permanent). One pure check, no model, no I/O: is a piece of work Cue's to do?
//
// IN: understanding who a member wants to meet and why; finding relevant people, events and communities; preparing for a
// conversation; consent-based introductions; follow-through that helps a connection go somewhere. A job change gets people and rooms
// (recruiting events and job fairs are rooms), never a job-search assistant.
// OUT: concierge work (a dentist, a laptop, travel), generic research projects, broad job-board monitoring, funding and investor
// searches, venue and vendor research for the member's OWN event, research on a named person that isn't preparing a conversation.
//
// Model judgment decides, code guards (Royce's standing rule). The verdict comes from a model read that already runs (the turn read, the
// model's own start-task call, classifyAsk) and is stored on the item. This file holds the narrow regex backstop for unmistakable cases
// (phone plans, a job-listings watch, a dentist, travel booking, shopping for a product) and never vetoes anything ambiguous or anything
// about meeting people: ambiguous means the model's verdict, and with none, going ahead. No model call is made here.
// Mixed (a connection ask and an outside one in one text): only the connection part starts or is searched. With no clean part, one short
// question and nothing runs on the whole text.
//
// Used at the single place every task starts (services/coTasks.ts startTask), when queued work resumes (services/taskTurn.ts
// runDueTask, followups, goal check-ins), and by the sweeps that read an ask or a goal (services/dailySweep.ts, goalEdges.ts).

export type OutKind = "errand" | "shopping" | "travel" | "job_board" | "model";
export type Scope = { scope: "in" | "out" | "mixed" | "ambiguous"; kind: OutKind | null; why: string; connection?: string | null };

// The model's verdict on a piece of work, from a read that was already running: the turn read (services/readTurn.ts "scope"), the
// start-task call the reply or the call's model made (its own "scope" field), or classifyAsk's read of a captured ask. Code does not
// re-judge it. in = about people, rooms, communities, a conversation to prepare for; out = concierge work; mixed = both, and then
// "connection" is the connection part as a short phrase.
export type ScopeVerdict = { scope: "in" | "out" | "mixed"; connection: string | null };
export function parseVerdict(v: unknown, connection?: unknown): ScopeVerdict | null {
  const o: any = v && typeof v === "object" ? v : { scope: v, connection };
  const s = typeof o.scope === "string" ? o.scope : typeof o.verdict === "string" ? o.verdict : "";
  const w = s.trim().toLowerCase();
  const scope = w === "in" || w === "out" || w === "mixed" ? w : null;
  if (!scope) return null;
  const c = typeof (o.connection ?? connection) === "string" ? String(o.connection ?? connection).replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { scope, connection: scope === "out" ? null : c.length >= 4 ? c : null };
}

// What makes a text about meeting people, going to a room or joining a community. When this is in the text, the backstop below never
// calls it out: a text about people is the model's call, always. Deliberately wide.
const CONNECTION = new RegExp(
  [
    "\\bintro(?:s|duc\\w*)?\\b", "\\bmeet(?:s|ing)?\\b", "\\bpeople\\b", "\\bpersons?\\b", "\\bsomeone\\b", "\\banyone\\b", "\\bwho\\b", "\\bfriends?\\b", "\\bcontacts?\\b", "\\bnetwork\\w*",
    "\\bcommunit(?:y|ies)\\b", "\\b(?:events?|dinners?|mixers?|meet-?ups?|conferences?|summits?|panels?|workshops?|hackathons?|salons?|socials?|happy hours?|demo days?|fairs?|expos?|gatherings?|rooms?|collectives?|clubs?|groups?|circles?)\\b",
    "\\b(?:founders?|investors?|mentors?|advisors?|operators?|builders?|folks|peers|cofounders?|colleagues|cohorts?)\\b",
    "\\b(?:coffee|call|chat|conversation|lunch|dinner) with\\b", "\\btalk(?:ing)? to\\b", "\\bconnect(?:ed|ing)? with\\b", "\\btalking points\\b", "\\bfollow(?:ing)?[- ]up with\\b", "\\bprep(?:are|aring)?\\b",
  ].join("|"),
  "i",
);

// The backstop: unmistakable out cases only, found by words, for a caller that has no model read in hand (an old queued row, a sweep over a
// captured ask, a code-started task). It never decides anything ambiguous and never anything about meeting people: ambiguous means the
// model's verdict (or, with none, going ahead). Phone and carrier plans; a watch on job listings; a consumer service (a dentist and the
// like); booking travel; shopping for a product.
const BACKSTOP: { kind: OutKind; re: RegExp }[] = [
  { kind: "errand", re: /\b(?:dentists?|dental|orthodontist|dermatologist|pediatrician|optometrist|chiropractor|plumber|electrician|handyman|locksmith|mechanic|dry[- ]clean\w*|barber|hair (?:salon|stylist|appointment)|massage therapist|nail salon|veterinarian|house ?cleaning|landscaper|doctor'?s? (?:appointment|visit)|taxes|tax (?:returns?|filing|prep\w*)|tax preparers?|(?:book|schedule|make)\b[^.?!]{0,30}\b(?:appointment|reservation|a table|haircut|checkup))\b/i },
  { kind: "shopping", re: /\b(?:(?:phone|cell(?:ular)?|wireless|mobile|data|internet|cable) (?:plans?|carriers?|providers?)|(?:verizon|t-?mobile|at&t|comcast|xfinity|spectrum|sprint|cricket|mint mobile)\b[^.?!]{0,30}\b(?:plans?|bills?|deals?)|(?:switch|change)\w*\s+(?:my\s+)?(?:phone\s+)?carrier|(?:compare|buy(?:ing)?|purchas\w+|shop(?:ping)? for|find|get|best|cheapest|which)\b[^.?!]{0,30}\b(?:laptops?|macbooks?|headphones?|mattress(?:es)?|tvs?|vacuums?|blenders?|printers?|routers?|ipad|couch|sofa)\b|\b(?:laptops?|macbooks?|headphones?|mattress(?:es)?|tvs?|vacuums?|blenders?|printers?|routers?|ipad|couch|sofa)\b[^.?!]{0,30}\b(?:to (?:buy|get|purchase)|deals?|prices?|under \$|comparison))\b/i },
  { kind: "travel", re: /\b(?:itinerar(?:y|ies)|plan(?:ning)?\s+(?:a|my|the|our|this|next)?\s*(?:[\w']+\s+){0,2}(?:trip|vacation|holiday|honeymoon|getaway|road ?trip)|(?:book|find|compare|search(?: for)?|look up|get)\b[^.?!]{0,30}\b(?:flights?|hotels?|airbnbs?|rental cars?|train tickets?|cruises?)|(?:cheap\w*|best|lowest) (?:flights?|airfare|fares?)|visa (?:requirements?|application))\b/i },
  { kind: "job_board", re: /\b(?:(?:watch|monitor|track|scan|scrape|alert|notify)\w*|keep (?:an )?eye|keep checking|send\s+\w+|text\s+\w+|email\s+\w+|ping\s+\w+)\b[^.?!]{0,50}\b(?:job (?:listings?|postings?|boards?|openings?|ads?)|jobs\b|job-?boards?|open (?:roles|positions)|hiring (?:posts?|pages?)|careers? pages?|recruiting season|hiring season)|\bjob[- ](?:boards?|listings?|postings?|openings?|ads?)\b/i },
];
const backstopKind = (t: string): OutKind | null => BACKSTOP.find((b) => b.re.test(t))?.kind ?? null;

export function classifyScope(text: string): Scope {
  const t = String(text ?? "");
  if (!t.trim()) return { scope: "ambiguous", kind: null, why: "nothing to read" };
  const kind = backstopKind(t);
  const people = CONNECTION.test(t);
  if (!kind) return people ? { scope: "in", kind: null, why: "about people, rooms or communities" } : { scope: "ambiguous", kind: null, why: "neither clearly connection work nor clearly outside it" };
  if (!people) return { scope: "out", kind, why: `${kind.replace("_", " ")} work` };
  // Both in one text: mixed only when the text splits into a clean connection clause and an unmistakable outside one. Otherwise it is
  // ambiguous, and the model's read decides; the backstop does not.
  const clauses = splitClauses(t);
  const outside = clauses.filter((c) => backstopKind(c) && !CONNECTION.test(c));
  const clean = clauses.filter((c) => !backstopKind(c) && CONNECTION.test(c));
  if (outside.length && clean.length) return { scope: "mixed", kind: backstopKind(outside[0]), why: `a connection ask together with ${backstopKind(outside[0])} work`, connection: clean.join(" and ") };
  return { scope: "ambiguous", kind: null, why: "mentions people and an errand together; the model's read decides" };
}
const splitClauses = (t: string) => t.split(/\s*(?:[,;]|\band\b|\balso\b|\bplus\b|\bthen\b|\bbut\b|\.\s+)\s*/i).map((c) => c.trim()).filter(Boolean);

// The scope of a piece of work: the model's verdict when there is one (it wins, including over the backstop), else the backstop.
export function judgeScope(text: string, verdict?: ScopeVerdict | null): Scope {
  if (!verdict) return classifyScope(text);
  // The backstop's unmistakable cases (a phone plan, a job-listings watch, a dentist, taxes, travel booking, product shopping) are guarded
  // by code whatever the verdict says: a model's "in" does not start them. Everything else is the model's.
  if (verdict.scope === "in") {
    const hard = classifyScope(text);
    if (hard.scope === "out") return hard;
  }
  if (verdict.scope === "out") return { scope: "out", kind: "model", why: "judged outside connections by the read that chose the work" };
  if (verdict.scope === "mixed") return { scope: "mixed", kind: "model", why: "judged as a connection ask bundled with something outside", connection: verdict.connection };
  return { scope: "in", kind: null, why: "judged connection work by the read that chose it" };
}

// The text the check reads for a piece of work Cue would do: what it is (its goal and steps), never the whole message it came from,
// so an aside in the member's message ("write an email to my landlord ugh. anyway, any founder dinners?") doesn't block the dinners.
export function workText(w: { goal?: string | null; steps?: unknown; firstPlan?: string | null; planNext?: string | null }): string {
  const steps = Array.isArray(w.steps) ? w.steps.map((s) => (typeof s === "string" ? s : String((s as any)?.text ?? ""))).join(". ") : "";
  return [w.goal, steps, w.firstPlan ?? w.planNext].filter(Boolean).join("\n");
}

// The ask that closes honestly, in words for the model (guidance, not a message): tone only, fresh words every time, never a forced intro.
export const OUT_OF_SCOPE_GUIDANCE = "That isn't something Cue does. Say so briefly and naturally in your own words, fresh every time (never a stock line, never the same wording twice), only as much as the moment needs. Don't force an unrelated introduction as a redirect and don't apologise at length. Never say or imply you started, did, found or will do it. If the message also had a connection part (who to meet, an event, a community, preparing for a conversation), help with that part on its own.";
export const MIXED_GUIDANCE = "This bundles a connection ask with something Cue doesn't do. Start work for ONLY the connection part (who to meet, an event, a community, preparing for a conversation), written as its own goal and steps (a separate call with scope \"in\" and just that part), and tell them briefly, in your own fresh words, that the rest isn't something Cue does. Never say or imply you'll do the rest.";
export const CLARIFY_GUIDANCE = "Part of this is something Cue doesn't do, and no clean connection part (who to meet, an event, a community, preparing for a conversation) could be pulled out of it. Start nothing. Ask ONE short question in your own words about the people or rooms they want, and nothing else. Never say or imply you started, did or will do the rest.";

export function startRefusal(s: Scope): string {
  if (s.scope !== "mixed") return OUT_OF_SCOPE_GUIDANCE;
  return s.connection ? `${MIXED_GUIDANCE} The connection part is: "${s.connection}".` : CLARIFY_GUIDANCE;
}

// The connection part of a mixed ask ("founder dinners in the Mission, and a dentist"): what a search or a task may run on. The model's
// own phrase when its verdict is mixed; else the clean clauses the backstop split out. Never the whole text of a mixed or an outside ask:
// when there is no clean part, null, and the caller asks one short question or searches nothing.
export function connectionPart(text: string, verdict?: ScopeVerdict | null): string | null {
  const t = String(text ?? "").trim();
  const sc = judgeScope(t, verdict);
  if (sc.scope === "out") return null;
  if (sc.scope === "mixed") return sc.connection && sc.connection.trim().length >= 4 ? sc.connection.trim() : null;
  return t || null;
}

// The verdict a piece of work is held to. A mixed turn read stays mixed: nothing starts on it, whatever the work says. The model starts only
// the connection part, as its own call with scope "in" and just that part; that call carries its own scope, so it is not held to the turn's.
export const workVerdict = (v: ScopeVerdict | null | undefined): ScopeVerdict | null => v ?? null;

// An ask the turn declined is never saved as an open ask (2026-11-06 live test: "make me a pitch deck", declined as outside, was
// captured as "seeking: a pitch deck for their startup"). The turn read's "out" skips every ask from that turn; under any read, an ask
// whose own words are an unmistakable out (the backstop: a dentist, travel booking) is skipped too. A mixed turn saves only the ask that
// is the connection part, judged against the model's own connection phrase (no word list: an ask that says the same thing as that phrase,
// by its text or its quote, stays; any other ask from that turn is the out part and is skipped). With no phrase there is no clean
// connection part, so none is saved (the reply asks one question). services/askKind.ts stores the phrase beside the ask.
// Same words, same thing (the shape of whatCoKnows.ts sameThing, kept local so this file keeps no imports): at least three quarters of the
// smaller side's content words are in the other, after a light stem.
const SAME_STOP = new Set("the and for but not you are was has had with that this what your have just like would want into some more they them their from about also then than over will this week".split(" "));
const sameWords = (a: string, b: string): boolean => {
  const w = (t: string) => new Set(String(t ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3 && !SAME_STOP.has(x)).map((x) => x.replace(/(ing|ed|es|s)$/, "")));
  const A = w(a), B = w(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size) >= 0.75;
};
export function askDeclinedForScope(turn: ScopeVerdict | null | undefined, askText: string, askQuote?: string | null): boolean {
  if (turn?.scope === "out" || classifyScope(askText).scope === "out") return true;
  if (turn?.scope !== "mixed") return false;
  const part = String(turn.connection ?? "").trim();
  if (!part) return true;
  return !(sameWords(askText, part) || (!!askQuote && sameWords(askQuote, part)));
}

// Model-facing guidance for the reply on a turn whose read is mixed: help with the connection part, set the rest aside briefly, promise
// nothing for it. Null for an in-scope turn (no added guidance) and for out (the out-of-scope guidance applies).
export const MIXED_REPLY_GUIDANCE = "This message bundles something Cue does (the connection part: who to meet, an event, a community, preparing for a conversation) with something it doesn't. Help with the connection part. Set the rest aside briefly, in fresh words of your own (never a stock line), and don't promise, offer or imply you'll do any of it. This holds when finds answer the connection part too: the finds go with shareFinds, and the set-aside still goes to them with sendReply, never left unsaid.";
export function replyScopeGuidance(v: ScopeVerdict | null | undefined): string | null {
  return !v || v.scope === "in" ? null : v.scope === "out" ? OUT_OF_SCOPE_GUIDANCE : MIXED_REPLY_GUIDANCE;
}

// A personal share: a member telling Cue something about their life (a loss, an illness, a hard stretch, news) without asking for
// anything. The companion listens (Royce, 2026-11-04: "don't turn every personal update into a matching opportunity or another
// question"); no path turns it into an ask, a look-out or a task.
// The turn read judges it (services/readTurn.ts "message_kind"): "share" (they tell Cue something and ask for nothing), "ask" (they ask Cue
// for something), "both" (they share and ask in one message: the ask is real and is worked as any ask), or "chat". Only a pure "share"
// is never captured. The word backstop below is used only where no turn read exists (a call's tool call that carries none), and it
// yields to any request in the text.
export type MessageKind = "share" | "ask" | "both" | "chat";
export function parseMessageKind(v: unknown): MessageKind | null {
  const w = typeof v === "string" ? v.trim().toLowerCase() : "";
  return w === "share" || w === "ask" || w === "both" || w === "chat" ? w : null;
}
const SHARE = new RegExp(
  [
    "\\b(?:my|our) (?:mom|mother|dad|father|grandma|grandmother|grandpa|grandfather|brother|sister|wife|husband|partner|dog|cat|friend|boyfriend|girlfriend|kid|son|daughter|baby)\\b[^.?!]{0,50}\\b(?:passed|died|is sick|was diagnosed|in the hospital|got sick|is dying|had surgery|left me|broke up)",
    "\\bI(?:'m| am| was| feel| felt| have been| 've been| keep feeling)\\b[^.?!]{0,30}\\b(?:exhausted|overwhelmed|anxious|depressed|lonely|burn(?:ed|t) out|grieving|heartbroken|struggling|scared|sad|stressed|tired|worried|ashamed|lost|numb)\\b",
    "\\b(?:passed away|funeral|miscarriage|my divorce|the breakup|broke up with me|got laid off|got fired|was diagnosed|my diagnosis|chemo|had surgery)\\b",
  ].join("|"),
  "i",
);
// Anything that reads as a request: a question, an ask for Cue to do or find something, a wish to meet or go.
const ASKS_FOR = /\?|\b(?:can you|could you|would you|will you|please|find me|find us|look for|looking for|look out|keep an eye|keep your eyes|let me know|send me|show me|know (?:anyone|of anyone|somebody|someone)|anyone (?:who|that|hiring)|any (?:\w+ ){0,2}(?:events|dinners|meetups|people|groups|clubs|communities|rooms|circles|classes|mixers|opportunities)|introduce|intro me|help me|where can i|who should i|i want to|i need to|i'd (?:still |really )?(?:like|love|want)|i would (?:still |really )?(?:like|love|want)|i (?:still |really )?want|i wanna|prep me|get me)\b/i;
export function sharedNotAsked(text: string): boolean {
  const t = String(text ?? "");
  return SHARE.test(t) && !ASKS_FOR.test(t);
}
// Whether this message is a pure share, never captured as an ask, look-out or task: the turn read's verdict when there is one (it decides,
// including "both"), else the word backstop.
export function isPureShare(kind: MessageKind | null | undefined, text: string): boolean {
  return kind ? kind === "share" : sharedNotAsked(text);
}
export const SHARED_NOT_ASKED_GUIDANCE = "They shared something about their life; they didn't ask for anything. Listen: answer what they feel, have a point of view, and let it be the whole reply. No ask, look-out or task comes out of it, no pivot to events or people, and no question just to keep it going.";
