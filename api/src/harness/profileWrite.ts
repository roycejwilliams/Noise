// Layer 4 harness: writes to co_profiles, co_profiles.intent, ask_checkins.
//
// gather   open asks (text + embedding) and what's on file
// propose  captureIntent / assessResolvedItems / extractPsychographicProfile
// gate     decideAskWrite (dedup restated asks), gateResolutions (a retired
//          item needs a quoted line that really appears in the conversation),
//          sanitizeExtractedProfile (enums and ranges)
// record   recordDecision(layer 4, "profile.write")
//
// The pure functions here are what evals/profile runs without a DB or model.
//
// HOOK FOR THE REPLY SECTION (routes/sendblue.ts, owned by the Layer 3 agent):
// the ask written this turn used to be invisible to anything reading
// co_profiles in the same turn, because captureIntent ran fire-and-forget
// after the reply. Call
//
//   const turnAsk = await captureIntentForTurn(user.id, textTranscript, { timeoutMs: 2500 });
//
// before building the reply facts. It returns { ask, askId, deduped } from
// the synchronous capture (or null on timeout / nothing captured) and the
// capture keeps running to completion in the background either way, so
// nothing is lost. Prefer turnAsk.ask over getActiveSeekingAsk(profile.intent)
// for this turn. Don't also call captureIntent separately for the same text.
import type { GateCheck } from "./core.js";
import { MODELS } from "../models.js";

// Local copy so this file (and its eval) doesn't pull in a DB-backed module.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Judgment calls with side effects (retiring items, deciding borderline
// "same ask") use Sonnet 5 per Royce's model policy.
export const PROFILE_JUDGMENT_MODEL = MODELS.sonnet;

// Embedding similarity at or above this is the same ask restated; between
// the two thresholds the model decides; below LOW it's a new ask. Measured
// with text-embedding-3-small on evals/profile: real paraphrases scored as
// low as 0.72 while different asks reached 0.78, so the model owns the
// whole 0.65-0.90 band (run evals/profile/sims.ts to re-check).
export const SAME_ASK_HIGH = 0.9;
export const SAME_ASK_LOW = 0.65;

export type OpenAsk = { askId: string; text: string; embedding: number[] | null };

// ---- intent entries ----------------------------------------------------------
//
// One entry in co_profiles.intent. captureIntent writes an entry whenever a
// conversation produced anything at all, which includes the case where it
// found preferences/wants/availability but NO ask — that entry has no text
// and no type, only `status: "active"`. Those are legitimate preference
// records, but they are not asks, and 2026-09-20 one real profile carried
// three of them being counted as open asks downstream. Everything that reads
// co_profiles.intent for asks goes through these predicates so "is this an
// ask" means one thing everywhere.

export type IntentEntry = {
  id?: string;
  text?: string | null;
  type?: string | null;
  status?: string | null;
  wants?: string[] | null;
  concrete_preferences?: string[] | null;
  availability?: string | null;
  embedding?: number[] | null;
  created_at?: string | null;
};

// An entry is an ask only when it actually carries ask text. Whitespace is
// not text.
export function hasAskText(entry: unknown): boolean {
  const text = (entry as IntentEntry | null)?.text;
  return typeof text === "string" && text.trim().length > 0;
}

export function isOpenAsk(entry: unknown): boolean {
  return hasAskText(entry) && (entry as IntentEntry).status === "active";
}

export function askEntries(intent: unknown): IntentEntry[] {
  return Array.isArray(intent) ? (intent as IntentEntry[]).filter(isOpenAsk) : [];
}

// The operative ask, newest last — captureIntent appends, so the last open
// ask entry wins. A text-less entry written after it no longer hides it.
export function latestAskEntry(intent: unknown): IntentEntry | null {
  const asks = askEntries(intent);
  return asks.length ? asks[asks.length - 1] : null;
}

// What the cleanup script (src/scripts/stripTextlessIntent.ts) writes back,
// and the guard any writer can run before storing an intent array. Idempotent:
// running it on an already-clean array returns the same entries.
export function stripTextlessIntent(intent: unknown): IntentEntry[] {
  return Array.isArray(intent) ? (intent as IntentEntry[]).filter((e) => hasAskText(e)) : [];
}

export function normalizeAskText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(a|an|the|some|any|to|for|i'?m|im|looking|find|me|my|please|really|just)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AskWriteDecision =
  | { action: "update_existing"; askId: string; similarity: number; checks: GateCheck[]; reason: string }
  | { action: "needs_judgment"; askId: string; similarity: number; checks: GateCheck[]; reason: string }
  | { action: "open_new"; checks: GateCheck[]; reason: string };

export function decideAskWrite(newAsk: { text: string; embedding: number[] | null }, openAsks: OpenAsk[]): AskWriteDecision {
  const norm = normalizeAskText(newAsk.text);
  const exact = openAsks.find((a) => normalizeAskText(a.text) === norm);
  if (exact) {
    return {
      action: "update_existing",
      askId: exact.askId,
      similarity: 1,
      checks: [{ name: "no_duplicate_ask", pass: true, reason: "same text as an open ask" }],
      reason: `restates open ask "${exact.text}"`,
    };
  }

  let best: { ask: OpenAsk; sim: number } | null = null;
  if (newAsk.embedding?.length) {
    for (const a of openAsks) {
      if (!a.embedding?.length) continue;
      const sim = cosineSimilarity(newAsk.embedding, a.embedding);
      if (!best || sim > best.sim) best = { ask: a, sim };
    }
  }

  if (best && best.sim >= SAME_ASK_HIGH) {
    return {
      action: "update_existing",
      askId: best.ask.askId,
      similarity: best.sim,
      checks: [{ name: "no_duplicate_ask", pass: true, reason: `similarity ${best.sim.toFixed(3)}` }],
      reason: `near-duplicate of "${best.ask.text}"`,
    };
  }
  if (best && best.sim >= SAME_ASK_LOW) {
    return {
      action: "needs_judgment",
      askId: best.ask.askId,
      similarity: best.sim,
      checks: [{ name: "borderline_similarity", pass: true, reason: `similarity ${best.sim.toFixed(3)}` }],
      reason: `may restate "${best.ask.text}"`,
    };
  }
  return {
    action: "open_new",
    checks: [{ name: "no_duplicate_ask", pass: true, reason: best ? `closest ${best.sim.toFixed(3)}` : "no open asks to compare" }],
    reason: "different from every open ask",
  };
}

// ---- resolutions -------------------------------------------------------------

export type ProposedResolution = { kind: "goal" | "blocker" | "ask"; item: string; quote: string };

function squash(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

// A resolution only goes through when the item is really on file and the
// supporting quote is (a) at least a few words, (b) actually present in the
// transcript, and (c) said by the person, not by Co.
export function gateResolutions(
  proposals: ProposedResolution[],
  onFile: { goals: string[]; blockers: string[]; asks: { id: string; text: string }[] },
  transcript: string,
): { accepted: ProposedResolution[]; rejected: { proposal: ProposedResolution; reason: string }[]; checks: GateCheck[] } {
  const accepted: ProposedResolution[] = [];
  const rejected: { proposal: ProposedResolution; reason: string }[] = [];
  // Only the person's own lines can support retiring something; Co's lines
  // ("Co replied:", "assistant:") are excluded.
  const isCoLine = (l: string) => /^\s*(co replied:|assistant:|co:)/i.test(l);
  const lines = transcript.split("\n");
  const hay = squash(lines.join(" "));
  const theirs = squash(lines.filter((l) => !isCoLine(l)).join(" "));

  for (const p of proposals) {
    const exists =
      p.kind === "goal"
        ? onFile.goals.includes(p.item)
        : p.kind === "blocker"
          ? onFile.blockers.includes(p.item)
          : onFile.asks.some((a) => a.id === p.item);
    const q = squash(p.quote ?? "");
    let reason: string | null = null;
    if (!exists) reason = "item isn't on file";
    else if (q.split(" ").filter(Boolean).length < 3) reason = "no real supporting quote";
    else if (!hay.includes(q)) reason = "quote isn't in the conversation";
    else if (!theirs.includes(q)) reason = "quote is something Co said, not them";
    if (reason) rejected.push({ proposal: p, reason });
    else accepted.push(p);
  }
  const checks: GateCheck[] = rejected.map((r) => ({
    name: "resolution_supported",
    pass: false,
    reason: `${r.proposal.kind} "${r.proposal.item}": ${r.reason}`,
  }));
  if (accepted.length) checks.push({ name: "resolution_supported", pass: true, reason: `${accepted.length} accepted` });
  return { accepted, rejected, checks };
}

// ---- extracted profile values ------------------------------------------------

export const ALLOWED_LIFE_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
export const ALLOWED_CONNECTION_STYLES = ["small_group", "medium_group", "large_social"];
const MAX_LIST_ITEMS = 25;
const MAX_ITEM_CHARS = 200;

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= MAX_ITEM_CHARS),
    ),
  ].slice(0, MAX_LIST_ITEMS);
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t && t.length <= max ? t : undefined;
}

export type SanitizedProfile = {
  life_chapters: string[];
  social_energy?: number;
  connection_style?: string;
  activity_preferences: string[];
  goals: string[];
  blockers: string[];
  availability_pattern?: string;
  city?: string;
  emotional_state?: string;
  long_term_direction?: string;
};

export function sanitizeExtractedProfile(raw: Record<string, unknown> | null | undefined): { profile: SanitizedProfile; checks: GateCheck[] } {
  const r = raw ?? {};
  const checks: GateCheck[] = [];
  const chaptersIn = Array.isArray(r.life_chapters) ? (r.life_chapters as unknown[]) : [];
  const life_chapters = chaptersIn.filter((c): c is string => typeof c === "string" && ALLOWED_LIFE_CHAPTERS.includes(c));
  if (life_chapters.length !== chaptersIn.length) checks.push({ name: "life_chapters_enum", pass: false, reason: "dropped values outside the allowed list" });

  let social_energy: number | undefined;
  if (r.social_energy !== undefined && r.social_energy !== null && r.social_energy !== "") {
    const n = Number(r.social_energy);
    if (Number.isFinite(n) && n >= 0 && n <= 100) social_energy = Math.round(n);
    else checks.push({ name: "social_energy_range", pass: false, reason: `"${String(r.social_energy)}" is outside 0-100` });
  }

  let connection_style: string | undefined;
  if (typeof r.connection_style === "string" && r.connection_style) {
    if (ALLOWED_CONNECTION_STYLES.includes(r.connection_style)) connection_style = r.connection_style;
    else checks.push({ name: "connection_style_enum", pass: false, reason: `"${r.connection_style}" isn't allowed` });
  }

  const emotional = cleanText(r.emotional_state, 40);
  const emotional_state = emotional && /^[a-z-]+$/i.test(emotional) ? emotional.toLowerCase() : undefined;
  if (emotional && !emotional_state) checks.push({ name: "emotional_state_one_word", pass: false, reason: "not a single word" });

  return {
    profile: {
      life_chapters,
      social_energy,
      connection_style,
      activity_preferences: cleanList(r.activity_preferences),
      goals: cleanList(r.goals),
      blockers: cleanList(r.blockers),
      availability_pattern: cleanText(r.availability_pattern, 200),
      city: cleanText(r.city, 100),
      emotional_state,
      long_term_direction: cleanText(r.long_term_direction, 600),
    },
    checks,
  };
}
