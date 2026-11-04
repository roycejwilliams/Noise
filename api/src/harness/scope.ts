// The purpose boundary (Royce, 2026-11-04, permanent). One pure check, no model, no I/O: is a piece of work Cue's to do?
//
// IN: understanding who a member wants to meet and why; finding relevant people, events and communities; preparing for a
// conversation; consent-based introductions; follow-through that helps a connection go somewhere. A job change gets people and rooms
// (recruiting events and job fairs are rooms), never a job-search assistant.
// OUT: concierge work (a dentist, a laptop, travel), generic research projects, broad job-board monitoring, funding and investor
// searches, venue and vendor research for the member's OWN event, research on a named person that isn't preparing a conversation.
//
// The pass is deterministic. "ambiguous" means neither side is clear: the caller's own model read (the turn that chose to start the
// work, or the wake that is about to run it) already judged it, so ambiguous work goes ahead. No new model call is made here.
// Mixed ("hard out" and a connection ask in the same text): the connection part starts, the rest is declined; a caller that is about
// to start ONE piece of work is told to start only the connection part.
//
// Used at the single place every task starts (services/coTasks.ts startTask), when queued work resumes (services/taskTurn.ts
// runDueTask, followups, goal check-ins), and by the sweeps that read an ask or a goal (services/dailySweep.ts, goalEdges.ts).

export type OutKind = "errand" | "shopping" | "travel" | "admin" | "generic_research" | "job_board" | "funding" | "host_vendor" | "person_research" | "document";
export type Scope = { scope: "in" | "out" | "mixed" | "ambiguous"; kind: OutKind | null; why: string };

// Clear connection work: people, rooms, communities, conversations, intros.
const IN = new RegExp(
  [
    "\\bintro(?:s|duc\\w*)?\\b",
    "\\bmeet(?:ing)? (?:people|someone|a few|other|new|founders?|investors?|operators?|builders?|folks)\\b",
    "\\bmeet\\b",
    "\\bpeople (?:to|who|in|working|building)\\b",
    "\\b(?:events?|dinners?|mixers?|meet-?ups?|conferences?|summits?|panels?|workshops?|hackathons?|salons?|socials?|happy hours?|demo days?|fairs?|expos?|gatherings?|rooms? (?:of|full of|with)|the room)\\b",
    "\\bcommunit(?:y|ies)\\b",
    "\\b(?:cohorts?|fellowships?|accelerators?|incubators?)\\b",
    "\\bnetwork(?:ing)?\\b",
    "\\bprep(?:are|aring)?\\b[^.?!]{0,40}\\b(?:call|conversation|coffee|chat|meeting|talk|intro|dinner|event)\\b",
    "\\b(?:before|ahead of) (?:i|we) (?:meet|talk|speak|chat|get coffee|call)\\b",
    "\\b(?:coffee|call|chat|conversation|lunch) with\\b",
    "\\btalking points\\b",
    "\\bfollow(?:ing)?[- ]up with\\b",
  ].join("|"),
  "i",
);

// Out, by kind. "hard" kinds never ride on a connection ask in the same text (mixed); "soft" kinds yield to it because a room or a
// community is what the connection ask is about ("investor dinners" is a room; "find me investors" is a funding search).
const OUT: { kind: OutKind; hard: boolean; own?: boolean; re: RegExp }[] = [
  {
    kind: "errand",
    hard: true,
    re: /\b(?:dentists?|dental|orthodontist|dermatologist|pediatrician|optometrist|chiropractor|plumber|electrician|handyman|locksmith|mechanic|dry[- ]clean\w*|barber|hair (?:salon|stylist|appointment)|massage|nail salon|veterinarian|movers?|cleaners?|house ?cleaning|landscaper|contractor|babysitter|nanny|pharmacy|doctor'?s? (?:appointment|visit)|(?:book|schedule|make|find|get)\b[^.?!]{0,30}\b(?:appointment|reservation|table|haircut|checkup))\b/i,
  },
  {
    kind: "shopping",
    hard: true,
    re: /\b(?:laptops?|macbook|headphones?|mattress|phone plans?|cell(?:ular)? plans?|wireless plans?|data plans?|internet plans?|(?:get|buy|find|compare|switch|shop(?:ping)? for|apply for)\b[^.?!]{0,20}\b(?:insurance|credit cards?|mortgage|loan)|(?:best|cheapest|compare|which)\b[^.?!]{0,30}\b(?:phones?|cars?|tvs?|vacuums?|blenders?|printers?|routers?|bikes?|cameras?|tablets?|ipad|couch|sofa|desk chairs?)\b|(?:buy|purchase|shop(?:ping)? for|price compar\w*|compare prices)\b[^.?!]{0,40}\b(?:for me|a new|the best|under \$|on sale|deals?))\b/i,
  },
  {
    kind: "travel",
    hard: true,
    re: /\b(?:itinerar(?:y|ies)|plan(?:ning)?\s+(?:a|my|the|our|this|next|his|her)?\s*(?:\w+\s+){0,2}(?:trip|vacation|holiday|honeymoon|getaway|road ?trip)|(?:book|find|compare|search(?: for)?|look up|get)\b[^.?!]{0,30}\b(?:flights?|hotels?|airbnbs?|rental cars?|train tickets?|cruises?)|(?:cheap\w*|best|lowest|low-cost) (?:flights?|airfare|fares?)|visa (?:requirements?|application)|travel (?:plans?|planning|arrangements?|insurance))\b/i,
  },
  {
    kind: "admin",
    hard: true,
    re: /\b(?:taxes|tax (?:return|filing|prep)|expense reports?|(?:clean|sort|organi[sz]e|triage|go through|summari[sz]e|read)\b[^.?!]{0,20}\b(?:my )?(?:inbox|e-?mails?|gmail)|reimbursements?|invoices?|bookkeeping|payroll|file (?:my|a) (?:taxes|return)|renew (?:my )?(?:passport|license|registration))\b/i,
  },
  {
    kind: "generic_research",
    hard: true,
    re: /\b(?:(?:research|compare|investigate|look into|dig into|deep[- ]dive on|write up|report on|summari[sz]e)\b[^.?!]{0,50}\b(?:tools?|software|apps?|crm|products?|vendors?|providers?|prices?|pricing|reviews?|options for|the best|alternatives|market size|competitors?|industry|trends?|studies|papers?|statistics)\b|(?:best|top|recommend\w*)\b[^.?!]{0,20}\b(?:crm|software|saas|tools?|apps?|platforms?)\b|(?:pros and cons|price comparison|comparison) of\b|(?:literature|market|competitive) (?:review|analysis|research)|research (?:project|report|paper))\b/i,
  },
  {
    kind: "document",
    hard: true,
    re: /\b(?:(?:draft|write|compose)\b[^.?!]{0,40}\b(?:e-?mails?|inquir(?:y|ies)|cold outreach|cover letters?|resumes?|essays?|blog posts?|memos?|one-?pagers?)|(?:update|rewrite|tailor|polish|improve)\b[^.?!]{0,20}\b(?:my )?(?:resume|cv|cover letter|linkedin)|plan sheet|one-?page(?:r)? (?:plan|sheet|itinerary))\b/i,
  },
  {
    kind: "job_board",
    hard: false,
    re: /\b(?:(?:watch|monitor|track|scan|scrape|alert|notify|keep (?:an )?eye|keep checking|look out|search|check)\b[^.?!]{0,50}\b(?:job (?:listings?|postings?|boards?|openings?|ads?)|job-?boards?|openings for|roles? (?:at|for|in)|open (?:roles|positions)|hiring (?:posts?|pages?)|careers? pages?|recruiting season|hiring season)|job (?:listings?|postings?|boards?)\b[^.?!]{0,30}\b(?:watch|monitor|track|scan|alert)|apply (?:to|for) (?:jobs|roles|positions)|(?:find|get) (?:me )?(?:a )?(?:new )?jobs?\b(?! fairs?))\b/i,
  },
  {
    kind: "funding",
    hard: false,
    re: /\b(?:(?:find|search(?: for)?|look(?:ing)? for|research|list|hunt for|source|identify|track|monitor|watch|scan)\b[^.?!]{0,40}\b(?:investors?|vcs?|venture (?:capital|funds?)|angels?|funders?|funding (?:rounds?|sources?|opportunit\w+)|grants? (?:deadlines?|cycles?|to apply)|sponsors?|term sheets?|lps?)|(?:application|funding|grant) (?:cycle|deadline|window)s?\b[^.?!]{0,30}\b(?:watch|monitor|track|alert|open)|(?:watch|monitor|track) (?:the )?(?:application|funding|grant)\b)\b/i,
  },
  {
    kind: "host_vendor",
    hard: false,
    own: true,
    re: /\b(?:venue research|(?:find|book|research|look for|look up|search for|compare|scout|recommend|get quotes? (?:for|from)|price)\b[^.?!]{0,45}\b(?:venues?|event spaces?|caterers?|catering|djs?|photograph(?:er|ers)|videograph\w+|florists?|bartenders?|decor(?:ators?)?|av (?:rental|equipment)|rental (?:company|companies)|vendors?|a space for|a room for|a restaurant for)|\b(?:venues?|event spaces?|caterers?|catering|djs?|photograph\w+|florists?|bartenders?)\b[^.?!]{0,40}\bfor (?:my|our|a|an|the|\d{2,4})\b|(?:dinner|party|launch|event|gathering|mixer|offsite|retreat) for \d{2,4}\b[^.?!]{0,30}\b(?:venue|space|room|restaurant|spots?)|options? for (?:a|my) (?:dinner|party|launch|event|gathering|offsite)|(?:host|throw|organi[sz]e|plan)\b[^.?!]{0,20}\b(?:my|our) (?:own )?(?:launch|party|dinner|event|gathering|offsite)\b[^.?!]{0,50}\b(?:venues?|space|catering|vendors?))\b/i,
  },
];

// Researching a named person: only to prepare for a planned conversation or an intro. Case-sensitive on the name, so it's tested apart.
const PERSON = /\b(?:[Rr]esearch|[Ll]ook up|[Dd]ig up|[Dd]ig into|[Ff]ind out about|[Bb]ackground (?:check )?on|[Dd]ossier on|[Ee]verything (?:you can find )?(?:on|about)|[Ll]earn about)\s+(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/;
const PREP = /\b(?:prep(?:are|aring)?|before (?:i|we) (?:meet|talk|speak|chat|call|get coffee|have)|ahead of|intro(?:duc\w*)?|conversation|coffee|call with|meeting with|talking points|going to meet|about to meet|meeting (?:them|him|her)|dinner with|lunch with|connect(?:ing)? with)\b/i;

export function classifyScope(text: string): Scope {
  const t = String(text ?? "");
  if (!t.trim()) return { scope: "ambiguous", kind: null, why: "nothing to read" };
  const inHit = IN.test(t) || (PERSON.test(t) && PREP.test(t));
  const outs = OUT.filter((o) => o.re.test(t));
  if (PERSON.test(t) && !PREP.test(t)) outs.push({ kind: "person_research", hard: false, re: PERSON });
  if (!outs.length) return inHit ? { scope: "in", kind: null, why: "about people, rooms or communities" } : { scope: "ambiguous", kind: null, why: "neither clearly connection work nor clearly outside it" };
  // Venue and vendor research for their OWN event is out whatever else the text says ("a venue for my dinner" mentions a dinner).
  const own = outs.find((o) => o.own);
  if (own) return { scope: "out", kind: own.kind, why: "venue or vendor research for their own event" };
  const hard = outs.find((o) => o.hard);
  if (hard) return inHit ? { scope: "mixed", kind: hard.kind, why: `a connection ask together with ${hard.kind} work` } : { scope: "out", kind: hard.kind, why: `${hard.kind} work` };
  // Soft kinds: a room, an event or a community in the same text is what the ask is about (investor dinners, a job fair).
  const soft = outs[0];
  return inHit ? { scope: "in", kind: null, why: `a room or community ask (not ${soft.kind.replace("_", " ")} work)` } : { scope: "out", kind: soft.kind, why: `${soft.kind.replace("_", " ")} work` };
}

// The text the check reads for a piece of work Cue would do: what it is (its goal and steps), never the whole message it came from,
// so an aside in the member's message ("write an email to my landlord ugh. anyway, any founder dinners?") doesn't block the dinners.
export function workText(w: { goal?: string | null; steps?: unknown; firstPlan?: string | null; planNext?: string | null }): string {
  const steps = Array.isArray(w.steps) ? w.steps.map((s) => (typeof s === "string" ? s : String((s as any)?.text ?? ""))).join(". ") : "";
  return [w.goal, steps, w.firstPlan ?? w.planNext].filter(Boolean).join("\n");
}

// The ask that closes honestly, in words for the model (guidance, not a message): tone only, fresh words every time, never a forced intro.
export const OUT_OF_SCOPE_GUIDANCE = "That isn't something Cue does. Say so briefly and naturally in your own words, fresh every time (never a stock line, never the same wording twice), only as much as the moment needs. Don't force an unrelated introduction as a redirect and don't apologise at length. Never say or imply you started, did, found or will do it. If the message also had a connection part (who to meet, an event, a community, preparing for a conversation), help with that part on its own.";
export const MIXED_GUIDANCE = "This bundles a connection ask with something Cue doesn't do. Start work for ONLY the connection part (who to meet, an event, a community, preparing for a conversation), written as its own goal, and tell them briefly, in your own fresh words, that the rest isn't something Cue does. Never say or imply you'll do the rest.";

export function startRefusal(s: Scope): string {
  return s.scope === "mixed" ? MIXED_GUIDANCE : OUT_OF_SCOPE_GUIDANCE;
}
