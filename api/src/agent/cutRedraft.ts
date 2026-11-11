// When the fact check cuts the substance of a reply, the whole reply is written again once, with the reason, instead of sending what's
// left (Royce, 2026-11-11, approved: "go with your suggestions"). From that morning's turn: "best option for me this week?" drafted a
// pick with its comparison, the check cut the comparison and only "Tonight's SGLang x NVIDIA meetup is probably it." went; "the details
// and why it fits?" drafted the page's details, the check cut them all, and the honest line went with an unrelated follow-up promise.
// The same once-a-turn redraft the finds guard uses (agent/findGuards.ts findsRedraftNote, conversationTools.ts state.findsNudged):
// one redraft, then the existing behaviour (what the check leaves goes out). Never on a turn that touches their safety, never when a
// promise the check kept rides in what's left (its task is bound to that text: services/promises.ts).

// What the send step reads about the check's last run (agent/conversationReply.ts passes the last groundReply result).
export type CutRead = {
  draft: string;
  final: string;
  outcome: string;
  notSure?: boolean;
  checks: { name: string; pass: boolean; reason?: string | null }[];
  keptPromise?: boolean;
};

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
// Checks whose failure never means a claim was cut: style is logged only (prefTopics.ts PREF_STYLE); discretion swaps the line itself.
const NOT_A_CUT = new Set(["pref_style", "discretion", "night_care", "world_line", "share_repair"]);

// Pure: the check cut substance, not a word or a filler line. A cut that took most of a real answer (8 or more words and 30% or more of
// the draft), or a reply stripped all the way to the honest "not sure" line. A redraft by the check itself, what passed as drafted, a
// cut that emptied the reply (the send step's own empty path), and a kept promise are never this.
export function cutLostSubstance(g: CutRead | null | undefined): boolean {
  if (!g || g.keptPromise) return false;
  if (!g.checks.some((c) => !c.pass && !NOT_A_CUT.has(c.name))) return false;
  if (!g.final.trim()) return false;
  if (g.outcome === "stripped") return g.notSure === true;
  if (g.outcome !== "cut") return false;
  const before = words(g.draft);
  const removed = before - words(g.final);
  return removed >= 8 && removed / Math.max(1, before) >= 0.3;
}

// The redraft's note (model-facing; shown before/after in the PR for Royce's approval). Names what the check couldn't back, from its own
// reasons, so the next draft keeps every detail a fact states and drops only those.
export function cutRedraftNote(g: CutRead): string {
  const reasons = [...new Set(g.checks.filter((c) => !c.pass && !NOT_A_CUT.has(c.name)).map((c) => String(c.reason ?? c.name).slice(0, 200)))].slice(0, 4);
  return `Not sent: the fact check couldn't back part of that reply (${reasons.join("; ")}), and what was left didn't answer them. Write the whole reply again and send it once with sendReply, answering everything they asked. Keep each detail a fact above states, in its words, as of when it was read (an event's host, format and who it's for, as its find or page gives them). Leave out or soften only what those reasons name, and say plainly what you don't know. Never send part of the answer, and never put a promise or a check-in in its place.`;
}
