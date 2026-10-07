// Real finds only (Royce, 2026-10-06): Co names an event, a place or a time only when a source row backs it. A call's brain can
// compose a plausible event from nothing; on a call nobody can check the text first. So every sentence Co is about to say that
// offers or places an event is checked against what the call was GIVEN (its context, the finds list, the clock) and what the
// member has said. A name or a time with no source in those is not said.
//
// Pure. The source corpus never includes Co's own earlier lines (a made-up name, once said, must not source itself).
const EVENT_WORDS = /\b(events?|workshops?|fairs?|pop-?ups?|concerts?|panels?|meet-?ups?|mixers?|dinners?|parties|party|classes|class|festivals?|launch(?:es)?|demo days?|hackathons?|retreats?|happening|going on|gatherings?|sessions?|tournaments?|markets?|screenings?|exhibits?|reception)\b/i;
const TIME = /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b/gi;
const MONTHS_DAYS = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "));
// Capitalized words that are not names of anything.
const NOT_NAMES = new Set(["i", "i'm", "i'll", "i've", "i'd", "co", "ok", "okay", "yes", "no", "sure", "so", "and", "but", "or", "that", "this", "it", "it's", "that's", "there", "there's", "here", "if", "when", "what", "who", "where", "why", "how", "want", "would", "could", "should", "do", "does", "did", "are", "is", "was", "can", "will", "you", "you're", "your", "we", "they", "he", "she", "the", "a", "an", "both", "either", "maybe", "right", "good", "great", "got", "just", "now", "then", "also", "one", "two", "three", "some", "any", "all", "not", "nothing", "something", "everything", "anything", "talk", "text", "let", "let's", "talking", "thanks", "thank", "hey", "hi", "hello"]);

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type Mention = { text: string; kind: "name" | "time" };

// The names (capitalized runs after the sentence's first word) and clock times a sentence puts forward.
export function mentionsIn(sentence: string): Mention[] {
  const clean = sentence.replace(/\[[a-z][a-z ]*\]\s*/gi, "");
  const out: Mention[] = [];
  for (const m of clean.match(TIME) ?? []) out.push({ text: m, kind: "time" });
  const words = clean.split(/\s+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => { if (run.length) out.push({ text: run.join(" "), kind: "name" }); run = []; };
  words.forEach((w, i) => {
    const bare = w.replace(/^[("'“]+|[)"'”.,!?;:]+$/g, "");
    const lower = bare.toLowerCase();
    if (i === 0) return; // a capital at the start of a sentence says nothing
    if (/^[A-Z]/.test(bare) && !NOT_NAMES.has(lower) && !MONTHS_DAYS.has(lower)) {
      run.push(bare);
      if (/[.,!?;:]$/.test(w)) flush();
      return;
    }
    if (run.length && /^(of|the|at|for|and|&|de|la)$/i.test(bare)) { run.push(bare); return; }
    flush();
  });
  flush();
  // A run that ended on a joiner ("... of") is just the name before it.
  return out.map((m) => (m.kind === "name" ? { ...m, text: m.text.replace(/(?:\s+(?:of|the|at|for|and|&|de|la))+$/i, "") } : m)).filter((m) => m.text.length > 1);
}

// The sentence offers or places an event (the only sentences this checks: "Jacqueline's leading that one" is not one).
export const placesAnEvent = (sentence: string) => EVENT_WORDS.test(sentence) || new RegExp(TIME.source, "i").test(sentence);

// Whether every name and time in an event sentence is backed by the source text. Returns what was not.
export function unsourced(sentence: string, source: string): Mention[] {
  if (!placesAnEvent(sentence)) return [];
  const hay = norm(source);
  const flat = squash(source);
  return mentionsIn(sentence).filter((m) => {
    if (m.kind === "time") return !flat.includes(squash(m.text).replace(/m$/, "m"));
    const n = norm(m.text.replace(/['’]s$/i, ""));
    if (hay.includes(n)) return false;
    // A name the sentence only shortens or re-cases ("Sequent" for "Sequent AI") still has a source.
    const parts = n.trim().split(" ").filter((p) => p.length > 2);
    return !(parts.length && parts.every((p) => hay.includes(` ${p} `) || hay.includes(` ${p}'s `) || hay.includes(` ${p}s `)));
  });
}

// What the call was given and what the member said: system text, the member's own lines, tool results. Never Co's lines.
export function sourceCorpus(parts: { system?: string; theirLines?: string[]; toolResults?: string[] }): string {
  return [parts.system ?? "", ...(parts.theirLines ?? []), ...(parts.toolResults ?? [])].join("\n");
}

export const SAFE_LINE = "I'll look into that after the call and text it over.";

// Pure: the sentences of a finished call that name something nothing backs. The call's own dynamic variables (context, finds, clock)
// and the member's lines are the source; Co's lines never are. ElevenLabs' own grader can't see the finds list, so this is the grade.
export function unsourcedInCall(turns: { role?: string; message?: string | null }[], given: { firstName?: string; contextSummary?: string; findsNow?: string; rightNow?: string }): { sentence: string; names: string[] }[] {
  const theirs = turns.filter((t) => t.role === "user" && t.message).map((t) => String(t.message));
  const source = sourceCorpus({ system: [given.firstName, given.contextSummary, given.findsNow, given.rightNow].filter(Boolean).join("\n"), theirLines: theirs });
  const out: { sentence: string; names: string[] }[] = [];
  for (const t of turns.filter((x) => x.role === "agent" && x.message)) {
    for (const s of String(t.message).replace(/\[[a-z][a-z ]*\]\s*/gi, "").split(/(?<=[.!?])\s+/)) {
      const bad = unsourced(s, source);
      if (bad.length) out.push({ sentence: s.slice(0, 240), names: bad.map((m) => m.text) });
    }
  }
  return out;
}

export async function recordOfferSourceCheck(userId: string, conversationId: string, turns: { role?: string; message?: string | null }[], given: Parameters<typeof unsourcedInCall>[1]): Promise<number> {
  try {
    const flagged = unsourcedInCall(turns, given);
    const { recordDecision } = await import("../harness/core.js");
    await recordDecision({
      layer: 8,
      decision: "call.offer_source",
      userId,
      outcome: flagged.length ? "skip" : "act",
      action: flagged.length ? "unsourced_named" : "all_sourced",
      proposal: { conversationId, flagged: flagged.slice(0, 8) },
      reason: flagged.length ? `${flagged.length} sentence(s) named an event, place or time nothing backed` : null,
    });
    return flagged.length;
  } catch (err: any) {
    console.error("offerGuard: recording the source check failed (non-fatal):", err?.message ?? err);
    return 0;
  }
}
