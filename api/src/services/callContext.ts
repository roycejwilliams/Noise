import { notToTeammate } from "./teamLines.js";
import * as memberSafeModule from "./memberSafeMemories.js";
import { renderCorrections } from "../harness/profileWrite.js";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import pool from "../db/db.js";
import { writeMemory } from "./memory.js";
import { MODELS } from "../models.js";
import { getEmotionalContext, renderEmotionalContext } from "../harness/emotion.js";
import { getPersonSnapshot, renderSnapshot } from "../harness/personSnapshot.js";
import { latestAskEntry } from "../harness/profileWrite.js";

// A 1-2 sentence call summary: narrow work, Haiku.
const SUMMARY_MODEL = MODELS.haiku;

// Builds a compact summary of everything already known about a person —
// from a prior call's extracted profile/intent AND recent text exchanges —
// so a new call's opening can pick up from it instead of a cold generic
// greeting every time, regardless of which channel the prior context came
// from.
//
// Bug fix, 2026-09-01 (Royce, diagnosing a real memory-continuity gap live
// with Co: "earlier parts of what you told me didn't come through
// cleanly"): this used to hard-truncate to 600 characters and pull only the
// last 6 raw text_exchange rows (3 conversational turns), justified by a
// comment claiming the result "gets passed as a URL query param on the
// Twilio bridge connect URL." That mechanism doesn't exist anywhere in the
// current code — every actual caller (the call agent's variables in
// services/elevenLabsCalls.ts, postCallFollowUp.ts and sendblue.ts's LLM
// prompt interpolation) treats this as plain in-process text with no URL
// involved. The cap was real, it just wasn't protecting anything anymore —
// it was silently discarding real context on every call and every text
// reply, which is exactly the gap Co and Royce were diagnosing. Raised to a
// generous bound (still a bound, not unlimited — a defensive sanity check
// against a genuinely pathological profile, not a real constraint anyone
// should ever hit) and 20 rows (10 turns) of raw history instead of 3.
// recap (Royce, 2026-09-01: "go ahead and have that built") — the
// distilled, corrected running narrative services/memoryCompaction.ts
// maintains. Led with here since it's the durable, weighted-toward-recent
// picture; the raw recent-text line below still carries this-week's exact
// specifics the recap's own cadence hasn't folded in yet.
export async function buildContextSummary(userId: string): Promise<string> {
  try {
    const [profileResult, recentTextResult, recapResult, recentRecommendationResult, emotional, ownWordsResult, openAsksResult, snapshot, correctionsResult] = await Promise.all([
      pool.query(
        `SELECT life_chapters, goals, blockers, availability_pattern, city, emotional_state, intent
         FROM co_profiles WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT content, memory_type FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange'
         ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT content, memory_type FROM co_memories
         WHERE user_id = $1 AND memory_type = 'recap'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      ),
      // Real gap found 2026-09-07: Co asked "what did you find me?" on a
      // fresh call had no way to answer — this summary read profile/text/
      // recap only, never what Co itself actually surfaced. One bounded,
      // recency-limited line (not the full pending/resolved offer machinery
      // sendblue.ts owns for text) covers the common "did I miss what you
      // found me" case without growing every call's opening context.
      pool.query(
        `SELECT content, memory_type FROM co_memories
         WHERE user_id = $1 AND memory_type = 'recommendation' AND created_at > NOW() - INTERVAL '3 days'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      ),
      // Emotion loop: the same read of how they've been feeling that texts
      // use, so a call opens knowing what the texts showed and vice versa.
      getEmotionalContext(userId),
      // What they've told Co themselves in the last 48 hours, first: newer
      // facts beat an older recap or profile (2026-09-15 call opened as if he
      // were still pre-seed, after he'd texted he's Series A with a $35M deal).
      pool.query(
        `SELECT content, memory_type FROM co_memories
         WHERE user_id = $1 AND memory_type = 'text_exchange' AND (content LIKE 'User said:%' OR content LIKE '[Call]%') AND ${notToTeammate()}
           AND created_at > NOW() - INTERVAL '48 hours'
         ORDER BY created_at DESC LIMIT 25`,
        [userId],
      ),
      pool.query(`SELECT ask_text FROM ask_checkins WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 4`, [userId]),
      // The one model of them (services/personModel.ts); Co's action record
      // is added separately on calls (buildCallKnowledge), so it's left out here.
      import("./personModel.js").then((m) => m.personModelParts(userId)).catch(() => null),
      // Their dated corrections (harness/profileWrite.ts), newest first.
      pool
        .query(
          `SELECT field, old_value, new_value, corrected_at FROM profile_corrections
           WHERE user_id = $1 AND corrected_at > NOW() - INTERVAL '90 days'
           ORDER BY corrected_at DESC LIMIT 8`,
          [userId],
        )
        .catch(() => ({ rows: [] as any[] })),
    ]);
    const emotionalLine = renderEmotionalContext(emotional);

    // Another member's details never reach this summary; intro history stays
    // (services/memberSafeMemories.ts).
    const { memberSafe, linkedMemberNames, namesInRecords } = memberSafeModule;
    const linked = await linkedMemberNames(userId);
    // A Tier 0 pick names someone their recap or texts may describe too.
    const names = [...linked, ...namesInRecords(recentRecommendationResult.rows)];
    // Their call summaries ([Call] lines, which Co writes) too; their own
    // "User said:" lines pass through unchanged.
    const [safeRecap, safeRecommendation, safeTexts, safeOwnWords] = await Promise.all([memberSafe(userId, recapResult.rows, names), memberSafe(userId, recentRecommendationResult.rows, names), memberSafe(userId, recentTextResult.rows, names), memberSafe(userId, ownWordsResult.rows, names)]);
    const profile = profileResult.rows[0] ?? null;
    // The stated ask comes from the newest entry that actually has ask text;
    // wants come from the newest entry of any kind, because a call that found
    // no ask still writes wants (2026-09-20 — a text-less entry written last
    // was hiding the real ask from the call prompt).
    const latestAsk = latestAskEntry(profile?.intent);
    const latestIntent = Array.isArray(profile?.intent) && profile.intent.length
      ? profile.intent[profile.intent.length - 1]
      : null;

    const ownWords = safeOwnWords.map((c) => String(c).replace(/^User said: /, "- ")).reverse();
    const openAsks = openAsksResult.rows.map((r: any) => `- ${r.ask_text}`);
    // The person model is model-written (snapshot, threads, loops): it gets the
    // same strip, so another member's details never reach a call or reply.
    const rawPicture = snapshot ? (await import("./personModel.js")).renderPersonModel({ ...snapshot, did: [] }) : renderSnapshot(null);
    const picture = rawPicture ? ((await memberSafe(userId, [{ content: rawPicture, memory_type: "person_model" }], names))[0] ?? "") : rawPicture;
    const corrections = renderCorrections(correctionsResult.rows);
    const lines = [
      corrections
        ? `Things they've corrected (the corrected version wins over anything below; never state the old one as true, and if they ask what you had or when it changed, say it plainly with the date):\n${corrections}`
        : null,
      picture ? `What you know about them right now:\n${picture}` : null,
      ownWords.length ? `What they've told you in the last two days (newest facts win over anything below):\n${ownWords.join("\n")}` : null,
      openAsks.length ? `What they're looking for right now:\n${openAsks.join("\n")}` : null,
      safeRecap[0] ? `Ongoing summary: ${safeRecap[0]}` : null,
      profile?.life_chapters?.length ? `Life chapter: ${profile.life_chapters.join(", ")}` : null,
      profile?.city ? `City: ${profile.city}` : null,
      emotionalLine ? `How they've been feeling:\n${emotionalLine}` : null,
      profile?.goals?.length ? `Goals: ${profile.goals.slice(0, 3).join("; ")}` : null,
      profile?.blockers?.length ? `Blockers: ${profile.blockers.slice(0, 2).join("; ")}` : null,
      !openAsks.length && latestAsk?.text ? `Stated ask: ${latestAsk.text}` : null,
      latestIntent?.wants?.length ? `Wants: ${latestIntent.wants.slice(0, 2).join(", ")}` : null,
      safeRecommendation[0] ? `Most recent thing Co suggested: ${safeRecommendation[0]}` : null,
    ].filter(Boolean);

    const recentTextLine = safeTexts.length
      ? `Recent texts: ${[...safeTexts].reverse().join(" / ")}`
      : null;
    if (recentTextLine) lines.push(recentTextLine);

    // Newest and most important sections come first, so the bound drops the
    // oldest, least important lines whole instead of cutting mid-sentence.
    const MAX = 4500;
    let summary = "";
    for (const line of lines as string[]) {
      const next = summary ? `${summary}\n\n${line}` : line;
      if (next.length > MAX) break;
      summary = next;
    }
    return summary;
  } catch (err: any) {
    console.error("callContext: buildContextSummary failed (non-fatal, calling with no prior context):", err?.message ?? err);
    return "";
  }
}

// What a call starts with (Royce, 2026-09-28, "On calls: what should carry
// over"): the text side's one picture (services/turnContext.ts
// assembleContext), so on a call Co also knows what it sent them with the
// times and places on file, their open asks, what they're in the middle of,
// and the lessons from times they corrected Co by text. Without it the Grok
// Bot "no start time" answer could happen again by voice.
//
// Returns the spoken-context summary plus the same knowledge split for the
// after-call audit: facts (what Co sent and what's on file, Co's own record,
// their asks in their words) and impressions (summaries and read-outs Co's
// models wrote), which never count as proof of a specific fact.
export type CallKnowledge = { summary: string; facts: string; impressions: string };

// Room for the whole picture (about 2,000 tokens): 4,500 was spent mostly on the sent events, and the
// build stopped at the first section that didn't fit, so the background that
// lets Co pick up where they left off (what they told it lately, the ongoing
// recap, recent texts, how they've been feeling) was cut (2026-10-04: a call
// opened with "what's happening these days?" while holding a 4,227-character
// summary that ended after the first of those sections).
export const CALL_CONTEXT_MAX = 8000;
// What was sent lately matters for facts (times, places on file), but it is the
// longest block and the least about them: whole lines, capped.
export const CALL_SENT_MAX = 1800;

// Pure: the call's context from its parts, most important first, within `max`.
//   1. how to be with them (corrections to Co's manner; short)
//   2. what they're in the middle of
//   3. the normal summary's sections in their own order (what they told Co
//      lately, open asks, the ongoing recap, how they've been feeling, recent
//      texts, ...)
//   4. what was sent lately, last and bounded, with the facts on file
// A section that doesn't fit is skipped, not the end of the build, so a long
// one can't take every later short one with it.
export function assembleCallSummary(o: { lessons: string[]; sentLines: string[]; threads: { text: string }[]; base: string; max?: number; sentMax?: number }): string {
  const max = o.max ?? CALL_CONTEXT_MAX;
  const sentMax = o.sentMax ?? CALL_SENT_MAX;
  const lessons = o.lessons.length ? `How to be with them, from times they corrected you (keep to these):\n${o.lessons.map((l) => `- ${l}`).join("\n")}` : null;
  const threads = o.threads.length ? `What they're in the middle of:\n${o.threads.slice(0, 5).map((t) => `- ${t.text}`).join("\n")}` : null;
  const header = "What you sent them lately and what's on file for each (these are the facts; if a time or place isn't listed here, you don't have it, so say so plainly):\n";
  const kept: string[] = [];
  let used = header.length;
  for (const l of o.sentLines) {
    const line = `- ${l}`;
    if (used + line.length + 1 > sentMax && kept.length) break;
    if (used + line.length + 1 > sentMax) continue;
    kept.push(line);
    used += line.length + 1;
  }
  const sent = kept.length ? `${header}${kept.join("\n")}` : null;
  const reserve = sent ? sent.length + 2 : 0;
  const parts = [lessons, threads, ...o.base.split("\n\n")].filter((x): x is string => !!x);
  let summary = "";
  for (const part of parts) {
    const next = summary ? `${summary}\n\n${part}` : part;
    if (next.length + reserve > max) continue;
    summary = next;
  }
  return sent ? (summary ? `${summary}\n\n${sent}` : sent) : summary;
}
// A call can't wait on slow page reads: whatever details are on file by then are used.
const CALL_CONTEXT_WAIT_MS = 3000;

export async function buildCallKnowledge(userId: string): Promise<CallKnowledge> {
  const { assembleContext, loadSentItems, sentDetailLines } = await import("./turnContext.js");
  const [base, turn] = await Promise.all([
    buildContextSummary(userId),
    Promise.race([
      assembleContext(userId, "").catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CALL_CONTEXT_WAIT_MS)),
    ]),
  ]);
  // Slow page reads: the sent list with whatever details were saved with it.
  const sent = turn?.sent ?? (await loadSentItems(userId).catch(() => []));
  // Another member's details stripped from every call-only part too
  // (memberSafeMemories.ts; 2026-10-01 call review: these bypassed it).
  const { memberSafe } = memberSafeModule;
  const strip = async (xs: string[]) => (xs.length ? memberSafe(userId, xs.map((content) => ({ content, memory_type: "call_context" }))) : []);
  const sentLines = await strip(sentDetailLines({ sent }, 7));
  const lessons = await strip(turn?.lessons ?? []);
  const threads = (await strip((turn?.threads ?? []).map((t: any) => String(t.text ?? "")))).map((text) => ({ text }));
  const asks = turn?.asks ?? [];
  const ledger = turn?.ledger.lines ?? [];

  const summary = assembleCallSummary({ lessons, sentLines, threads, base });

  const facts = [
    ...sentLines,
    ...ledger,
    ...asks.slice(0, 8).map((a) => `They've asked Co for (their words): "${a.text}"`),
  ].join("\n");
  return { summary, facts, impressions: base };
}

// The summary a call opens with.
export async function buildCallContextSummary(userId: string): Promise<string> {
  try {
    return (await buildCallKnowledge(userId)).summary;
  } catch (err: any) {
    console.error("callContext: buildCallContextSummary failed (non-fatal, using the plain summary):", err?.message ?? err);
    return buildContextSummary(userId);
  }
}

// The other direction of the same bridge — closes a real gap (Royce,
// 2026-09-07: "anything overlapping that may cause confusion... between
// voice and text?"): routes/sendblue.ts's recentConversation, read by every
// text-reply classifier, only ever queries co_memories.text_exchange rows,
// never call_transcript — and the only other channel-bridging mechanism is
// memoryCompaction.ts's recap, which runs once a day at 4am. Without this, a
// text reply arriving the SAME DAY as a call had zero visibility into what
// was just discussed until the next day's recap. Written as its own
// text_exchange row (not call_transcript) specifically so it's picked up by
// that same existing query with no changes needed there. Best-effort,
// call-ending pipeline continues regardless — matches storeProfile's own
// non-blocking Step 7 siblings (captureIntent, extractPlannedEventMention).
// Exported for evals (2026-09-23): a real summary dropped both partnerships
// the member named (Lythe.ai, Sangria) and read a voice score as "may have
// wanted to continue" when their last words were "we can close out good".
export function callSummaryPrompt(transcript: string): string {
  return `Summarize what was actually discussed in this phone call transcript, in 2-3 plain sentences, third person, as if briefing someone on what just happened. Ground it only in what's actually in the transcript — no invented detail, no therapy-speak. Write the person on the call as {M} every time, never a pronoun for them (no he, she, they, his, her, their): "{M} is building...", "{M}'s cofounder". We fill in their name. Refer to anyone else by that person's own name (2026-09-22: summaries were calling a member "he" from their name alone).

Names of companies and people come from what THEY said (the "user:" lines), never from the assistant's lines: when the assistant says a different name than the member did ("Bumble" for the member's "Boardy"), the member's wins, because the assistant can mishear. A name the member said and speech-to-text garbled ("Boredy") is written as the real company when it is plain which one.

Lead with the concrete facts they gave: the names of companies, people, places, dates, and plans, spelled as they said them. Speech-to-text often spells names out letter by letter ("l y t h e dot a i" is lythe.ai); write the name, not the letters. Keep every named company and person they mentioned.

How the call ended comes only from what they said at the end, never from a voice reading. Don't say they wanted to keep talking unless they said so.

Transcript:
"${transcript}"
Return ONLY the summary, no preamble.`;
}

// "They" for the member only, never for anyone else (code review,
// 2026-09-24, twice). Blanket neutralizing turned "Royce talked about Maya.
// She is leaving the company." into "They are leaving", pinning Maya's news
// on the member; a first fix guessed people from capital letters and
// keywords and got it wrong the other way. Now it follows who the summary is
// talking about, in order: the member (by name, and at the start), another
// named person, or a singular relation ("his cofounder", "her mom"). A
// gendered pronoun is rewritten only when the last person mentioned before
// it is the member; when unsure it's left alone, because a stray "he" about
// the member is a smaller harm than someone else's news said about them.
const NOT_A_NAME = new Set(
  "co hume i the a an they their them he she his her it its this that these those we you our and but so then also overall monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(" "),
);
const RELATION_ONE = /^(co-?founder|partner|wife|husband|girlfriend|boyfriend|fianc[eé]e?|mom|mother|dad|father|sister|brother|friend|boss|manager|colleague|coworker|son|daughter|roommate|investor|ceo|cto|founder|mentor|client|cousin|aunt|uncle)$/i;
// "her" before one of these is the object ("give her a call", "told her about it"), not "their".
const OBJECT_NEXT = /^\s+(a|an|the|to|for|in|on|at|about|up|out|back|some|any|one|this|that|it|with|from|into|over|and|or|but|so|if|when|how|what|why)\b/i;
// Common verbs a he/she took an -s on: "he loves it" becomes "they love it", not "they loves it".
const S_VERBS = "loves|likes|wants|needs|thinks|says|works|runs|plans|hopes|feels|sounds|starts|knows|believes|mentioned|builds|leads|helps|asks|tells|seems|looks|lives|gets|takes|makes|goes|wishes|prefers|enjoys|expects|worries|runs|owns|hosts|joins";
const SINGULAR_VERB = new RegExp(`\\b(they)\\s+(${S_VERBS})\\b`, "gi");
const PRONOUN = /\b(he|she)\s+(is|was|has)\b|\b(he|she)'s\b|\b(himself|herself)\b|\b(his|hers)\b|\bher(?=\s+[a-z])|\b(him|her)\b|\b(he|she)\b/gi;
function neutralOne(m: string): string {
  const out = m
    .replace(/^(he|she)\s+is$/i, "they are")
    .replace(/^(he|she)\s+was$/i, "they were")
    .replace(/^(he|she)\s+has$/i, "they have")
    .replace(/^(he|she)'s$/i, "they're")
    .replace(/^(himself|herself)$/i, "themself")
    .replace(/^(his|hers)$/i, "their")
    .replace(/^(him)$/i, "them")
    .replace(/^(he|she)$/i, "they");
  return m[0] === m[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out;
}
export function neutralMemberPronouns(text: string, memberFirstName: string | null): string {
  const memberParts = (memberFirstName ?? "").split(/\s+/).filter(Boolean).map((n) => n.toLowerCase());
  // Only a capitalised word names the member: "will" and "may" are verbs, not a member called Will or May.
  const isMember = (w: string) => /^[A-Z]/.test(w) && memberParts.includes(w.toLowerCase().replace(/'s$/, ""));
  // A capitalized word at the start of a sentence is only a person if it's
  // also capitalized somewhere mid-sentence ("Mentioned his startup..." isn't).
  const midSentenceCaps = new Set(
    [...text.matchAll(/(?<![.!?]\s*|^\s*)\b([A-Z][A-Za-z'-]*[a-z])\b/g)].map((m) => m[1].toLowerCase().replace(/'s$/, "")),
  );
  type Ref = { at: number; member: boolean };
  const refs: Ref[] = [];
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z'.-]*[A-Za-z]\b/g)) {
    const word = m[0];
    const bare = word.toLowerCase().replace(/'s$/, "");
    if (isMember(word)) refs.push({ at: m.index!, member: true });
    else if (RELATION_ONE.test(bare)) refs.push({ at: m.index!, member: false });
    else if (/^[A-Z]/.test(word) && !NOT_A_NAME.has(bare) && !/\./.test(word)) {
      const before = text.slice(0, m.index!);
      const atSentenceStart = /(^|[.!?]\s+)$/.test(before);
      // "at Sangria", "in San Francisco", "from Austin": places and companies.
      // Not "about/for/to/with", where people's names go.
      const placeOrCompany = /\b(at|in|from|near|into)\s+(the\s+)?([A-Z][\w'&-]*\s+)*$/.test(before);
      if ((!atSentenceStart || midSentenceCaps.has(bare)) && !placeOrCompany) refs.push({ at: m.index!, member: false });
    }
  }
  const aboutMemberAt = (i: number) => {
    let last: Ref | null = null;
    for (const r of refs) if (r.at < i) last = r;
    return last ? last.member : true; // a summary starts out about the member
  };
  return text.replace(PRONOUN, (m, ...args) => {
    const at = args[args.length - 2] as number;
    const full = args[args.length - 1] as string;
    if (!aboutMemberAt(at)) return m;
    if (/^her$/i.test(m)) {
      const next = full.slice(at + 3);
      const possessive = /^\s+[a-z]/.test(next) && !OBJECT_NEXT.test(next);
      const word = possessive ? "their" : "them";
      return m[0] === "H" ? word[0].toUpperCase() + word.slice(1) : word;
    }
    return neutralOne(m);
  }).replace(SINGULAR_VERB, (_m, they, verb) => `${they} ${verb.replace(/ies$/i, "y").replace(/(ches|shes|sses|xes|oes)$/i, (x: string) => x.slice(0, -2)).replace(/s$/i, "")}`);
}

// The member is written as {M} (second review, 2026-09-24: the model used
// "he" for the member despite being told not to, and no rule can reliably
// tell whose "he" it is once someone else is mentioned). With {M} for the
// member, a leftover he/she can only be someone else; the pronoun rule
// above stays as a backup for a summary that slipped.
export function fillMemberName(text: string, memberFirstName: string | null): string {
  // With no name on file, "The member" keeps the grammar ("The member is building...", "The member's cofounder"),
  // where a bare "They" gave "They is building".
  const name = memberFirstName?.trim() || "The member";
  const M = /\{\s*M\s*\}/gi;
  // "{M}self" came back as "Royceself" in testing; that one is "themself".
  const filled = text.replace(/\{\s*M\s*\}self\b/gi, "themself").replace(new RegExp(M.source + "('s)?", "gi"), (_m, poss) => (poss ? `${name}'s` : name));
  return neutralMemberPronouns(filled, memberFirstName);
}

export async function summarizeCallForTextContext(userId: string, transcript: string): Promise<void> {
  try {
    const { text: raw } = await generateText({
      model: anthropic(SUMMARY_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "callContext.summarizeCallForText" },
      prompt: callSummaryPrompt(transcript),
    });
    // The prompt already says "they"; the model still wrote "he" on all
    // three runs of a real call (2026-09-23), so it's enforced in code.
    const firstName = await pool
      .query(`SELECT first_name FROM users WHERE id = $1`, [userId])
      .then((r) => (r.rows[0]?.first_name as string | undefined) ?? null)
      .catch(() => null);
    const summary = fillMemberName(raw.trim(), firstName);
    if (!summary) return;
    await writeMemory(userId, "text_exchange", `[Call] ${summary}`);
  } catch (err: any) {
    console.error("summarizeCallForTextContext: failed (non-fatal):", err?.message ?? err);
  }
}
