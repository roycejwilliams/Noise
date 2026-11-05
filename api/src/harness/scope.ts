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
  { kind: "errand", re: /\b(?:dentists?|dental|orthodontist|dermatologist|pediatrician|optometrist|chiropractor|plumber|electrician|handyman|locksmith|mechanic|dry[- ]clean\w*|barber|hair (?:salon|stylist|appointment)|massage therapist|nail salon|veterinarian|house ?cleaning|landscaper|doctor'?s? (?:appointment|visit)|(?:book|schedule|make)\b[^.?!]{0,30}\b(?:appointment|reservation|a table|haircut|checkup))\b/i },
  { kind: "shopping", re: /\b(?:(?:phone|cell(?:ular)?|wireless|mobile|data|internet|cable) (?:plans?|carriers?|providers?)|(?:verizon|t-?mobile|at&t|comcast|xfinity|spectrum|sprint|cricket|mint mobile)\b[^.?!]{0,30}\b(?:plans?|bills?|deals?)|(?:switch|change)\w*\s+(?:my\s+)?(?:phone\s+)?carrier|(?:compare|buy|purchase|shop(?:ping)? for|find|get|best|cheapest|which)\b[^.?!]{0,30}\b(?:laptops?|macbooks?|headphones?|mattress(?:es)?|tvs?|vacuums?|blenders?|printers?|routers?|ipad|couch|sofa)\b)\b/i },
  { kind: "travel", re: /\b(?:itinerar(?:y|ies)|plan(?:ning)?\s+(?:a|my|the|our|this|next)?\s*(?:[\w']+\s+){0,2}(?:trip|vacation|holiday|honeymoon|getaway|road ?trip)|(?:book|find|compare|search(?: for)?|look up|get)\b[^.?!]{0,30}\b(?:flights?|hotels?|airbnbs?|rental cars?|train tickets?|cruises?)|(?:cheap\w*|best|lowest) (?:flights?|airfare|fares?)|visa (?:requirements?|application))\b/i },
  { kind: "job_board", re: /\b(?:(?:watch|monitor|track|scan|scrape|alert|notify)\w*|keep (?:an )?eye|keep checking|send\s+\w+|text\s+\w+|email\s+\w+|ping\s+\w+)\b[^.?!]{0,50}\b(?:job (?:listings?|postings?|boards?|openings?|ads?)|jobs\b|job-?boards?|open (?:roles|positions)|hiring (?:posts?|pages?)|careers? pages?|recruiting season|hiring season)|\bjob[- ](?:boards?|listings?|postings?)\b/i },
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
export const MIXED_GUIDANCE = "This bundles a connection ask with something Cue doesn't do. Start work for ONLY the connection part (who to meet, an event, a community, preparing for a conversation), written as its own goal and steps (start it again with scope \"in\"), and tell them briefly, in your own fresh words, that the rest isn't something Cue does. Never say or imply you'll do the rest.";
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
