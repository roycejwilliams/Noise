import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { goalEntries, isOpenAsk } from "../harness/profileWrite.js";
import { parseModelJson } from "./modelJson.js";

// Model policy (Royce, 2026-09-14): scoring decides who gets introduced to
// whom, so it runs on Sonnet 5.
const SCORING_MODEL = MODELS.sonnet;

// Co Loop Stage 3 — "identify relevance." Judges whether a candidate
// satisfies someone's stated ask. Used standalone by relevance.ts's network
// sweep — the only active caller right now, per the current build priority
// (Stages 1/2/3/5/6).

// One entry from co_profiles.intent, as written by captureIntent
// (profileExtraction.ts) — embedding is whatever was computed from the ask
// text at capture time, reused here rather than re-embedding.
export type StatedIntent = {
  id?: string;
  text?: string;
  type?: "seeking" | "offering";
  status?: string;
  embedding?: number[] | null;
  // The member said Co may mention this ask when introducing them. Default (missing) is private.
  shareable?: boolean | null;
};

// captureIntent appends asks over time as calls happen — take the most
// recent active "seeking" one as the operative filter. "offering" asks
// describe what the person can give others, not who they want to be matched
// with, so those are left alone.
function getActiveSeekingAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const seeking = (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i?.type === "seeking");
  return seeking.length ? seeking[seeking.length - 1] : null;
}

// Same as getActiveSeekingAsk but any type (seeking OR offering) — used to
// read a CANDIDATE's own most recent ask for the two-way/mutual check in
// scoreAgainstStatedAsk below. A candidate's "offering" is exactly the kind
// of thing that could plausibly satisfy someone else's ask, so unlike
// getActiveSeekingAsk this deliberately doesn't filter type out.
function getActiveAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const active = (intent as StatedIntent[]).filter(isOpenAsk);
  return active.length ? active[active.length - 1] : null;
}

// Mirror of getActiveSeekingAsk for the reverse direction — "I have
// something to offer, who in the network wants it?" (relevance.ts's
// sweepOfferingAgainstNetwork). Without this, an "offering" ask only ever
// gets surfaced as a side-effect of someone ELSE's seeking sweep finding the
// offerer as a candidate — it never proactively searches for the people who
// might actually want it.
function getActiveOfferingAsk(intent: unknown): StatedIntent | null {
  if (!Array.isArray(intent)) return null;
  const offering = (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i?.type === "offering");
  return offering.length ? offering[offering.length - 1] : null;
}

export type AskScore<T> = {
  candidate: T;
  score: number;
  reason: string;
  // The only reason that may ever be shown to a person (the asker, the
  // candidate, an intro email). `reason` is built from the candidate's
  // profile line (formatCandidateDigest) and stays internal. Empty = nothing
  // shareable, so the match must not be surfaced to anyone.
  shareReason: string;
  mutual: boolean;
};

type ScorableCandidate = {
  user_id: string;
  goals?: string[];
  blockers?: string[];
  activity_preferences?: string[];
  intent?: unknown;
};

// What the scorer may read about each candidate (Royce, 2026-10-18; outbound inventory, matching rows). A matching prompt is
// made for one member and carries up to 40 others, and it goes to Anthropic (and Langfuse) under the asking member's trace. So
// each candidate's line is built from a short list of labelled fields only, never from rows:
//   - asks they agreed to share (the only words the double opt-in flow ever shows another member), each clipped
//   - goals and activity likes from their profile, each clipped
//   - the people graph's internal hint (short wants/offers labels, no names), when the caller passes one
//   - a HIDDEN part: their private asks and their blockers (Royce, 2026-10-18: "It should never be mentioned to another user
//     what that person is going through"). The scorer may use it to judge fit and is told never to mention or cite it; code
//     acts on the scorer's own report that it isn't the only basis (shareReasonFor: hidden_only must be false and a reason
//     given, or there is no share reason and nothing is proposed). That is the scorer's word, not an independent check: on the
//     network path nothing else checks it yet (rooms add the value gate, which sees only the other member's shared asks). Code
//     does make sure no intro text echoes the hidden part (harness/matchGate.ts hiddenEcho, on share reasons, value lines, drafts and
//     the network intro email). On every path, rooms included: the room path passes its private asks in `hidden`, since it
//     scores on intent with private asks taken out (roomMatching.ts matchableIntent). The Jev prune reads lines without the
//     hidden part: a fit only the hidden part supports can never be proposed, so the prune needs nothing of it.
// Never on the line: any co_memories row (call transcripts, text exchanges, Cue's own records), and no field outside the list.
// An item that names another person in the same prompt is left out (nameFinder below: whole word, any case, accents folded).
// Caps: each item is clipped to DIGEST_ITEM_CHARS, the hidden part to DIGEST_HIDDEN_CHARS; each line holds
// DIGEST_CANDIDATE_CHARS; a prompt's lines share DIGEST_PROMPT_CHARS, so a big room gets shorter lines, never fewer candidates
// (each line keeps DIGEST_MIN_CANDIDATE_CHARS, enough for one clipped shared ask: above 88 candidates that floor is what bounds
// the prompt). A line fills in this order until it is full: shared asks newest first, then the hint, then goals, then the hidden
// part (private asks newest first, then blockers), then likes. Whole items only.
export const DIGEST_ITEM_CHARS = 120;
export const DIGEST_HIDDEN_CHARS = 200;
export const DIGEST_CANDIDATE_CHARS = 400;
export const DIGEST_PROMPT_CHARS = 16_000;
export const DIGEST_MIN_CANDIDATE_CHARS = 180;
const DIGEST_HINT_CHARS = 220;
export const HIDDEN_LABEL = "hidden, to judge fit only (never mention, never cite):";

// Pure: one item, whitespace folded, cut at a word near the cap.
export function clipItem(s: unknown, max = DIGEST_ITEM_CHARS): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

const firstNameOf = (c: ScorableCandidate) => String((c as { first_name?: unknown }).first_name ?? "").trim();
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Accents folded and lowercased, so "Zoë", "ZOE" and "zoe" are one name.
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

// Pure: which of these names a text carries, as whole words in any case, accents folded. A local stand-in: PR #248's
// nameFinder (services/memberSafeMemories.ts, unmerged) can replace it once it lands.
export function nameFinder(names: string[]): (text: string) => string[] {
  const ns = [...new Set(names.map((n) => fold(String(n ?? "").trim())).filter((n) => n.length >= 2))].sort((x, y) => y.length - x.length);
  if (!ns.length) return () => [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ns.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return (text: string) => [...new Set([...fold(String(text ?? "")).matchAll(re)].map((m) => m[0]))];
}

// Pure: a member's open asks they did not mark shareable (private by default).
export function privateAskTexts(intent: unknown): string[] {
  return (Array.isArray(intent) ? (intent as StatedIntent[]) : []).filter((i) => isOpenAsk(i) && i.shareable !== true).map((i) => String(i.text));
}

// Pure: one candidate's line, within budget.
function candidateLine(c: ScorableCandidate, budget: number, named: (item: string) => boolean, hint: string | null | undefined, extraHidden: string[], withHidden: boolean): string {
  const safe = (xs: unknown, max = DIGEST_ITEM_CHARS) => (Array.isArray(xs) ? xs : []).map((x) => clipItem(x, max)).filter((x) => x && !named(x));
  // A shared ask that names someone else in the prompt is left off the line too; its label then can't be a share reason
  // (runAskScoring reads only labels the line showed).
  const shared = shareableAsks(c.intent)
    .map((a, k) => ({ k, ask: clipItem(a.text), text: `[S${k + 1}] ${a.type ?? "seeking"} "${clipItem(a.text)}"` }))
    .filter((x) => x.ask && !named(x.ask));
  const privateAsks = [...new Set([...privateAskTexts(c.intent), ...extraHidden])].reverse();
  const hiddenItems = withHidden ? [...safe(privateAsks).map((x) => `private ask "${x}"`), ...safe(c.blockers).map((x) => `going through "${x}"`)] : [];
  const facts: string[] = [];
  const likes: string[] = [];
  const hidden: string[] = [];
  const keptShared: { k: number; ask: string; text: string }[] = [];
  let keptHint: string | null = null;
  const hiddenPart = () => (hidden.length ? `${HIDDEN_LABEL} ${hidden.join("; ")}` : null);
  const render = () =>
    [
      facts.length || likes.length ? [...facts, ...likes].join("; ") : null,
      keptShared.length ? `asks they agreed to share: ${[...keptShared].sort((x, y) => x.k - y.k).map((x) => x.text).join(" / ")}` : null,
      keptHint,
      hiddenPart(),
    ]
      .filter(Boolean)
      .join(" | ");
  const tryAdd = (add: () => void, undo: () => void, fits: () => boolean = () => true) => {
    add();
    if (render().length > budget || !fits()) undo();
  };
  // Newest shared ask first: it is what a share reason most likely rests on. One clipped ask always fits the smallest budget.
  for (const x of [...shared].reverse()) tryAdd(() => keptShared.push(x), () => keptShared.pop());
  if (hint && !named(hint)) tryAdd(() => (keptHint = clipItem(hint, DIGEST_HINT_CHARS)), () => (keptHint = null));
  for (const g of safe(c.goals)) tryAdd(() => facts.push(g), () => facts.pop());
  for (const h of hiddenItems) tryAdd(() => hidden.push(h), () => hidden.pop(), () => (hiddenPart() ?? "").length <= DIGEST_HIDDEN_CHARS + HIDDEN_LABEL.length + 1);
  for (const l of safe(c.activity_preferences)) tryAdd(() => likes.push(l), () => likes.pop());
  return render() || "(nothing on file)";
}

// Pure: each candidate's line, in order, without its list number.
// hidden: private asks the caller took out of a candidate's intent (the room path), put back in the hidden part.
// withHidden false: no hidden part at all (the Jev prune).
// askerFirstName: the member the prompt is made for. Their name is left out of every candidate's items (another member's
// "dating Jordan from the club" never reaches Jordan's prompt).
export function candidateLines<T extends ScorableCandidate>(candidates: T[], hints?: Map<string, string>, hidden?: Map<string, string[]>, opts: { withHidden?: boolean; askerFirstName?: string } = {}): string[] {
  const budget = Math.max(DIGEST_MIN_CANDIDATE_CHARS, Math.min(DIGEST_CANDIDATE_CHARS, Math.floor(DIGEST_PROMPT_CHARS / Math.max(1, candidates.length))));
  // Everyone in this call with a first name (the room, partner and network paths carry one). One pattern screens every item;
  // an item naming anyone but the candidate themself is left out.
  const asker = fold(String(opts.askerFirstName ?? "").trim());
  const find = nameFinder([...candidates.map(firstNameOf), ...(asker.length >= 2 ? [String(opts.askerFirstName)] : [])]);
  return candidates.map((c) => {
    const own = fold(firstNameOf(c));
    const named = (item: string) => find(item).some((n) => n !== own || n === asker);
    return candidateLine(c, budget, named, hints?.get(c.user_id), hidden?.get(c.user_id) ?? [], opts.withHidden !== false);
  });
}

// Pure: the numbered list the scorer reads, exported for evals/matching.
// hints: the people graph's internal read of an overlap (peopleGraph.ts edgeHint), for the scorer only.
export function formatCandidateDigest<T extends ScorableCandidate>(candidates: T[], hints?: Map<string, string>, hidden?: Map<string, string[]>, askerFirstName?: string): string {
  return candidateLines(candidates, hints, hidden, { askerFirstName })
    .map((l, i) => `${i}. ${l}`)
    .join("\n");
}

// The scorer's rule for the hidden part, in every scoring prompt.
export const HIDDEN_RULE = `A candidate's "${HIDDEN_LABEL}" part is what they told Cue in confidence: an ask they did not agree to share, or something they're going through. Use it only to judge fit. Never mention, quote or paraphrase it, not even in "reason". It can raise a match but never be its only basis: share_ask must still name a shared ask that supports the fit without it.`;
const HIDDEN_FIELDS = `hidden_only: true when the fit rests on the hidden part alone (no shared ask supports it without the hidden part); then share_ask must be "". false otherwise.`;

// Shared prompt-call/parse logic for both scoring directions below — only
// the prompt text itself actually differs between "who satisfies my ask"
// and "who wants my offering".
// The open asks a member said Co may mention when introducing them, in intent order. An ask is private unless marked.
export function shareableAsks(intent: unknown): StatedIntent[] {
  if (!Array.isArray(intent)) return [];
  return (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i.shareable === true);
}

// The words another person may see: the ONE shareable ask the scorer said the match rests on ("S1", "S2"...), in the
// member's own words. No label, an unknown label, a private or closed ask: nothing. Never their newest ask by default.
export function shareReasonFromOwnAsk(intent: unknown, label?: unknown): string {
  const n = typeof label === "string" ? Number(label.trim().replace(/^\[?S/i, "").replace(/\]$/, "")) : NaN;
  if (!Number.isInteger(n) || n < 1) return "";
  const ask = shareableAsks(intent)[n - 1];
  if (!ask?.text) return "";
  return ask.type === "offering" ? `what they've said they can offer: "${ask.text}"` : `what they've said they're looking for: "${ask.text}"`;
}

// Pure: the share reason for one scored candidate. Only a shared ask the scorer named, and only when the scorer gave a reason
// and said the fit doesn't rest on the hidden part alone (Royce, 2026-10-18): no reason, no intro; hidden alone, no intro.
export function shareReasonFor(intent: unknown, r: { reason?: unknown; share_ask?: unknown; hidden_only?: unknown }): string {
  if (typeof r?.reason !== "string" || !r.reason.trim()) return "";
  // Fails closed: only an explicit "not on the hidden part alone" lets a share reason through.
  if (r.hidden_only !== false) return "";
  return shareReasonFromOwnAsk(intent, r.share_ask);
}

// The words stored in place of an internal reason that echoes a candidate's hidden part (relevance_edges.match_reason, the
// room's ranked reasons). Never member text.
export const REASON_WITHHELD = "[withheld]";

// Pure: the labels ("S1"...) a line actually showed, so a share reason can rest only on what the scorer saw.
export function shownLabels(line: string): Set<string> {
  const visible = line.split(HIDDEN_LABEL)[0];
  return new Set([...visible.matchAll(/\[(S\d+)\] /g)].map((m) => m[1]));
}

// Pure: a candidate's hidden texts (private asks in their intent or handed in, and blockers).
export function hiddenTextsOf(c: ScorableCandidate, hidden?: Map<string, string[]>): string[] {
  return [...new Set([...privateAskTexts(c.intent), ...(hidden?.get(c.user_id) ?? []), ...(Array.isArray(c.blockers) ? c.blockers.map(String) : [])])];
}

async function runAskScoring<T extends ScorableCandidate>(
  functionId: string,
  prompt: string,
  candidates: T[],
  lines: string[],
  hidden?: Map<string, string[]>,
): Promise<AskScore<T>[]> {
  try {
    const { hiddenEcho } = await import("../harness/hiddenEcho.js");
    const { SENSITIVE } = await import("../harness/matchGate.js");
    const { text: raw } = await generateText({
      model: anthropic(SCORING_MODEL),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt,
    });

    const parsed = parseModelJson(raw);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return results
      .filter((r: any) => Number.isInteger(r.index) && r.index >= 0 && r.index < candidates.length)
      .map((r: any) => {
        const c = candidates[r.index];
        const said = typeof r.reason === "string" ? r.reason.trim() : "";
        // The internal reason is stored (relevance_edges, the room's rankings): one that echoes the candidate's hidden part is
        // stored as REASON_WITHHELD instead.
        const reason = said && hiddenEcho(said, hiddenTextsOf(c, hidden), shareableAsks(c.intent).map((a) => String(a.text)), [], SENSITIVE) ? REASON_WITHHELD : said;
        const num = typeof r.share_ask === "string" ? Number(r.share_ask.trim().replace(/^\[?S/i, "").replace(/\]$/, "")) : NaN;
        const label = Number.isInteger(num) && num > 0 ? `S${num}` : "";
        return {
          candidate: c,
          score: typeof r.score === "number" ? Math.max(0, Math.min(100, Math.round(r.score))) : 0,
          reason,
          // The model only names WHICH shared ask the match rests on; the words shown to people are that ask, in their own
          // words, and only if they marked it shareable. Nothing private or inferred (e.g. "actively fundraising") can leak.
          // A fit resting on the hidden part alone, or with no reason at all, gets no share reason: nothing is proposed.
          shareReason: shownLabels(lines[r.index] ?? "").has(label) ? shareReasonFor(c.intent, { ...r, reason: said }) : "",
          mutual: Boolean(r.mutual),
        };
      });
  } catch (err) {
    // Fail closed — an explicit stated requirement that we can't verify is
    // treated as unmet, same as any other hard filter falling short, rather
    // than silently ignoring what the person asked for.
    console.error(`${functionId} failed, treating as no matches (non-fatal):`, err);
    return [];
  }
}

// A stated ask ("find founders with experience at Google") is the strongest,
// most explicit signal a user can give about who's relevant to them. This
// grades every candidate 0-100 instead of a hard yes/no, and returns a
// one-line grounded reason plus a mutual flag (does the candidate's OWN
// stated ask/offering also plausibly point back at the asker) — so a "no
// strong match" result is distinguishable from "three people were close",
// and relevance_edges ends up with something a human can actually read
// instead of a bare count. askerContext (optional) is a short summary of the
// asker's own goals/blockers/long-term direction, given only so the model
// can judge mutuality — it does not affect the one-directional score.
// Deliberately generic: judges whatever's actually on file rather than any
// fixed set of attributes, so it works the same whether the ask is about a
// career background, a hobby, or a life circumstance.
export async function scoreAgainstStatedAsk<T extends ScorableCandidate>(
  ask: StatedIntent,
  candidates: T[],
  askerContext?: string,
  hints?: Map<string, string>,
  opts: { askerFirstName?: string } = {},
): Promise<AskScore<T>[]> {
  if (!candidates.length || !ask.text) return [];

  // A big room: Jev rules out the clear no's first and Claude scores who is
  // left (services/jevMatching.ts). Dropped candidates score 0, as Claude
  // gives "nothing on file supports it". Any Jev problem keeps everyone.
  let toScore = candidates;
  let dropped: T[] = [];
  const { PRUNE_MIN_CANDIDATES, pruneEnabled } = await import("./jevMatching.js");
  if (candidates.length >= PRUNE_MIN_CANDIDATES && pruneEnabled()) {
    try {
      const started = Date.now();
      const { jevMatchScores, keepAfterPrune } = await import("./jevMatching.js");
      const ps = await jevMatchScores(ask.text, candidates);
      const keep = new Set(keepAfterPrune(ps));
      toScore = candidates.filter((_, i) => keep.has(i));
      dropped = candidates.filter((_, i) => !keep.has(i));
      const { recordDecision } = await import("../harness/core.js");
      void recordDecision({
        layer: 5,
        decision: "jev.prune.matching",
        userId: null,
        outcome: "act",
        action: `kept ${toScore.length} of ${candidates.length}`,
        proposal: { candidates: candidates.length, keptForClaude: toScore.length, unread: ps.filter((p) => p === null).length, ms: Date.now() - started },
      }).catch(() => {});
    } catch (err: any) {
      console.error("matching: Jev prune failed, scoring everyone (non-fatal):", err?.message ?? err);
      toScore = candidates;
      dropped = [];
    }
  }
  if (!toScore.length) return dropped.map((c) => ({ candidate: c, score: 0, reason: "", shareReason: "", mutual: false }) as AskScore<T>);
  const lines = candidateLines(toScore, hints, undefined, { askerFirstName: opts.askerFirstName });
  const digest = lines.map((l, i) => `${i}. ${l}`).join("\n");
  const scored = await runAskScoring("matching.scoreAgainstStatedAsk", buildStatedAskPrompt(ask.text, digest, askerContext), toScore, lines);
  return [...scored, ...dropped.map((c) => ({ candidate: c, score: 0, reason: "", shareReason: "", mutual: false }) as AskScore<T>)];
}

export function buildStatedAskPrompt(askText: string, digest: string, askerContext?: string): string {
  return `Someone wants to be connected with people who match this: "${askText}"
${askerContext ? `\nWhat's known about the person asking (use ONLY to judge "mutual" below, never to inflate the score itself): ${askerContext}\n` : ""}
Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how well they satisfy the ask, based only on what's listed — never assume or infer facts that aren't present. ${HIDDEN_RULE}

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "share_ask": "", "hidden_only": false, "mutual": false}, ...]}

score: 0-100. 0 means nothing on file supports it, 100 means they clearly satisfy it. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate. Internal only, never shown to anyone.
share_ask: the label (like "S1") of the ONE ask listed under "asks they agreed to share" that is the reason this candidate fits. Only that ask can ever be said to other people. Empty string if none of their shared asks supports the match, even when something else on file does. Never pick a shared ask that is unrelated to the match.
mutual: true only if one of the candidate's own asks (any listed, the hidden part included) also plausibly points back at what's known about the asker above. false if the candidate has no ask listed, or it doesn't plausibly connect.
${HIDDEN_FIELDS}`;
}

// Reverse direction of scoreAgainstStatedAsk — "I have something to offer,
// who in the network would actually want it?" Without this, an "offering"
// ask never gets proactively matched to anyone; it only ever surfaces as a
// side-effect of someone ELSE's seeking ask happening to find the offerer as
// a candidate. mutual here means the reverse of scoreAgainstStatedAsk's:
// true only when the candidate's own stated ask is a "seeking" that
// plausibly wants this specific offering.
export async function scoreOfferingAgainstCandidates<T extends ScorableCandidate>(
  offering: StatedIntent,
  candidates: T[],
  opts: { askerFirstName?: string } = {},
): Promise<AskScore<T>[]> {
  if (!candidates.length || !offering.text) return [];

  const lines = candidateLines(candidates, undefined, undefined, { askerFirstName: opts.askerFirstName });
  const digest = lines.map((l, i) => `${i}. ${l}`).join("\n");

  const prompt = `Someone has this to offer others: "${offering.text}"

Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how much they would likely want or benefit from this offering, based only on what's listed — never assume or infer facts that aren't present. ${HIDDEN_RULE}

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "share_ask": "", "hidden_only": false, "mutual": false}, ...]}

score: 0-100. 0 means nothing on file suggests they'd want this, 100 means it clearly matches something they're after. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate. Internal only, never shown to anyone.
share_ask: the label (like "S1") of the ONE ask listed under "asks they agreed to share" that is the reason this candidate fits. Only that ask can ever be said to other people. Empty string if none of their shared asks supports the match, even when something else on file does. Never pick a shared ask that is unrelated to the match.
mutual: true only if one of the candidate's own asks (if listed) is a "seeking" ask that plausibly wants this specific offering. false if the candidate has no stated ask listed, or it doesn't plausibly connect.
${HIDDEN_FIELDS}`;

  return runAskScoring("matching.scoreOfferingAgainstCandidates", prompt, candidates, lines);
}

// ---------------------------------------------------------------- the room frame (2026-10-12 intelligence audit)
//
// A room is scored against everything a person is open to, not their newest ask: every open, people-shaped ask in both
// directions (what they need, and what they offer), de-duplicated, errands left out (services/peopleAsks.ts), with their
// newest goal as the frame when no ask is about people. The caller passes only what matching may read (roomMatching.ts
// matchableIntent: shareable asks only), so this changes nothing about what is private.
export type RoomFrame = { asks: StatedIntent[]; goal: StatedIntent | null };

export async function roomFrame(intent: unknown): Promise<RoomFrame | null> {
  const open = Array.isArray(intent) ? (intent as StatedIntent[]).filter(isOpenAsk) : [];
  const { peopleAsksOf } = await import("./peopleAsks.js");
  const asks = await peopleAsksOf(open);
  const goal = getGoalFrame(intent);
  return asks.length || goal?.text ? { asks, goal: goal?.text ? goal : null } : null;
}

// Pure: the one line the frame is quoted as (also what the stub scorer and the Jev prune read).
export function frameLine(f: RoomFrame): string {
  const parts = f.asks.map((a) => `${a.type === "offering" ? "can offer" : "looking for"}: ${a.text}`);
  if (f.goal?.text) parts.push(`headed toward: ${f.goal.text}`);
  return parts.join(" | ");
}

export function buildRoomFramePrompt(f: RoomFrame, digest: string, askerContext?: string): string {
  const lines = [
    ...f.asks.map((a) => `- ${a.type === "offering" ? "can offer" : "looking for"}: "${a.text}"`),
    ...(f.goal?.text ? [`- where they're headed: "${f.goal.text}"${f.asks.length ? " (the frame when none of the lines above is about people)" : ""}`] : []),
  ];
  return `Someone wants to be connected with people who match this: "${frameLine(f)}"

Everything they're open to, in their words (a candidate needs to fit only one line):
${lines.join("\n")}
Only lines about people count: someone to meet, hire, work with, learn from, back or be backed by, or something they can give a person. An errand (a place, a product, a booking, a plan, a recommendation) says nothing about who to meet: leave it out of the judgment.
${askerContext ? `\nWhat's known about the person asking (use it to judge what they can offer someone, and "mutual" below): ${askerContext}\n` : ""}
Here is what's known about each candidate, one per line:
${digest}

For each candidate, judge how well they fit, based only on what's listed — never assume or infer facts that aren't present. ${HIDDEN_RULE} A fit runs either way: the candidate can meet one of the person's needs, or the candidate needs what the person offers or does (a founder who needs a product designer fits a product designer weighing freelance work). Judge by who the candidate is and what they do, not only by whether the candidate's own ask repeats the person's words.

Return ONLY valid JSON, no preamble:
{"results": [{"index": 0, "score": 0, "reason": "one short grounded sentence", "share_ask": "", "hidden_only": false, "mutual": false}, ...]}

score: 0-100. 0 means nothing on file supports a fit, 100 means a clear fit for one of their lines. Score every candidate, even a 0.
reason: one short sentence explaining the score, referencing only what's actually listed for that candidate. Internal only, never shown to anyone.
share_ask: the label (like "S1") of the ONE ask listed under "asks they agreed to share" that is the reason this candidate fits. Only that ask can ever be said to other people. Empty string if none of their shared asks supports the match, even when something else on file does. Never pick a shared ask that is unrelated to the match.
mutual: true only if one of the candidate's own asks also plausibly points back at the person (what they need, offer or do). false if the candidate has no ask listed, or it doesn't plausibly connect.
${HIDDEN_FIELDS}`;
}

// hidden: each candidate's private asks, taken out of their intent before the room was scored (eventScoring.ts, matchableIntent),
// for the line's hidden part only.
export async function scoreAgainstRoomFrame<T extends ScorableCandidate>(
  f: RoomFrame,
  candidates: T[],
  askerContext?: string,
  hints?: Map<string, string>,
  hidden?: Map<string, string[]>,
  opts: { askerFirstName?: string } = {},
): Promise<AskScore<T>[]> {
  if (!candidates.length || (!f.asks.length && !f.goal?.text)) return [];
  const line = frameLine(f);
  let toScore = candidates;
  let dropped: T[] = [];
  const { PRUNE_MIN_CANDIDATES, pruneEnabled } = await import("./jevMatching.js");
  if (candidates.length >= PRUNE_MIN_CANDIDATES && pruneEnabled()) {
    try {
      const { jevMatchScores, keepAfterPrune } = await import("./jevMatching.js");
      const keep = new Set(keepAfterPrune(await jevMatchScores(line, candidates)));
      toScore = candidates.filter((_, i) => keep.has(i));
      dropped = candidates.filter((_, i) => !keep.has(i));
    } catch (err: any) {
      console.error("matching: Jev prune failed, scoring everyone (non-fatal):", err?.message ?? err);
      toScore = candidates;
      dropped = [];
    }
  }
  const zero = dropped.map((c) => ({ candidate: c, score: 0, reason: "", shareReason: "", mutual: false }) as AskScore<T>);
  if (!toScore.length) return zero;
  const lines = candidateLines(toScore, hints, hidden, { askerFirstName: opts.askerFirstName });
  const digest = lines.map((l, i) => `${i}. ${l}`).join("\n");
  const scored = await runAskScoring("matching.scoreAgainstRoomFrame", buildRoomFramePrompt(f, digest, askerContext), toScore, lines, hidden);
  return [...scored, ...zero];
}

// Every active stated ask/offering text (the only profile text a person
// gave in order to be matched; see harness/matchGate.ts and introConsent.ts).
function getActiveAsks(intent: unknown): string[] {
  if (!Array.isArray(intent)) return [];
  return (intent as StatedIntent[]).filter(isOpenAsk).map((i) => String(i.text));
}

// Every open ask of one type, oldest first. The immediate sweep after a capture
// only needs the newest (getActiveSeekingAsk); the daily sweep covers them all.
function getOpenAsksOfType(intent: unknown, type: "seeking" | "offering"): StatedIntent[] {
  if (!Array.isArray(intent)) return [];
  return (intent as StatedIntent[]).filter((i) => isOpenAsk(i) && i?.type === type);
}

// When someone has no open ask, who is worth meeting is judged against where they are headed instead: the newest active goal is the frame
// (services/goalJourney.ts). A goal is only ever judged against here, never searched: it is never written to an ask list.
function getGoalFrame(intent: unknown): StatedIntent | null {
  const g = goalEntries(intent);
  return g.length ? ({ ...g[g.length - 1], type: "seeking" } as StatedIntent) : null;
}

export { getActiveAsk, getActiveAsks, getActiveSeekingAsk, getActiveOfferingAsk, getOpenAsksOfType, getGoalFrame };
