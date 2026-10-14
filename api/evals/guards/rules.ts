// Guards against the kinds of mistakes that shipped broken code on 2026-09-29.
// These check behavior and scan the code, instead of pinning strings:
//   1. a queued companion text must be able to go out before it expires
//   2. every reader of a member's own lines must skip talk with a teammate agent
//   3. a Sonnet call with a small output cap must set an effort, or be listed here
//      with the measurement that shows it finishes
//   4. a link and its preview photo read as one message
//   5. one source fence: what grounds a reply, checks a lesson or builds what's running and what's ahead comes only from the
//      member's own conversation with Co (Royce, 2026-10-13), never their talk with anyone else or another member's details
//
//   npx tsx evals/guards/rules.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
import path from "node:path";
const P = await import("../../src/harness/proactive.js");
const A = await import("../../src/services/advice.js");
const L = await import("../../src/services/linkReader.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
  }
};

const root = new URL("../../src/", import.meta.url).pathname;
const files: string[] = [];
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})(root);
const rel = (f: string) => path.relative(root, f);

// ------------------------------------------------------------------ 1. reachability
// A companion text queued right after another companion text waits out the type gap.
// It has to be eligible at some moment before it expires.
const DAY = 86_400_000;
function firstEligible(expiresInDays: number, lastCompanionDaysAgo: number, memberRepliedAfter: boolean): number | null {
  const t0 = new Date("2026-10-01T18:00:00Z").getTime();
  const sentAt = new Date(t0 - lastCompanionDaysAgo * DAY);
  const cand: any = { id: "c", userId: "u", type: "companion", targetKey: "companion:advice:1", topicKey: "companion", summary: "", priority: 10, dueAt: new Date(t0), expiresAt: new Date(t0 + expiresInDays * DAY), payload: {}, attempts: 0, createdAt: new Date(t0) };
  for (let h = 0; h <= expiresInDays * 24; h++) {
    const now = new Date(t0 + h * 3_600_000);
    const state: any = { now, sends: [{ type: "companion", targetKey: "companion:checkin", topicKey: "companion", sentAt, exempt: false }], lastInboundAt: memberRepliedAfter ? new Date(sentAt.getTime() + 3_600_000) : null };
    if (P.candidateChecks(cand, state).every((c: any) => c.pass)) return h / 24;
  }
  return null;
}
check("a follow-up queued the moment after a companion text can still go out before it expires", firstEligible(A.FOLLOW_UP_EXPIRES_DAYS, 0, true) !== null, `expires in ${A.FOLLOW_UP_EXPIRES_DAYS} days`);
check("the old 4-day expiry could not (this is the bug the guard exists for)", firstEligible(4, 0, true) === null);
check("a follow-up still waits for the type gap, it is not sent early", (firstEligible(A.FOLLOW_UP_EXPIRES_DAYS, 1, true) ?? 0) >= 2.9);
check("a companion text the member never answered still blocks the next one (unchanged rule)", firstEligible(A.FOLLOW_UP_EXPIRES_DAYS, 0, false) === null);
{
  const src = fs.readFileSync(path.join(root, "harness/memberReflection.ts"), "utf8");
  const uses = (src.match(/FOLLOW_UP_EXPIRES_DAYS \* 86400_000/g) ?? []).length;
  check("both the advice follow-up and the story text queue with that expiry", uses === 2, `${uses} uses`);
}

// ------------------------------------------------------------------ 2. readers of the member's own lines
// Their texts to a teammate agent are logged as "User said: … [to Mo]". A reader that treats
// their lines as facts about them must skip those. Readers that only count activity may not.
const ACTIVITY_ONLY: Record<string, string> = {
  "mo/learn.ts": "counts replies from people Mo brought in",
  "harness/memberReflection.ts": "counts replies in the week for the reflection",
  "services/membershipLapse.ts": "last activity, for the lapse notices",
  "harness/callGate.ts": "recency of any activity, for call timing",
  // Its content reads are held to notToTeammate by section 5; readActivityTimes returns timestamps only, any channel.
  "services/sourceFence.ts": "readActivityTimes: when they were active, timestamps only (the member-world read)",
};
let unguarded: string[] = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  let i = -1;
  while ((i = text.indexOf("User said:%", i + 1)) !== -1) {
    const start = text.lastIndexOf("`", i);
    const end = text.indexOf("`", i);
    const stmt = text.slice(start, end);
    if (/notToTeammate\(/.test(stmt)) continue;
    if (ACTIVITY_ONLY[rel(f)]) continue;
    unguarded.push(`${rel(f)}:${text.slice(0, i).split("\n").length}`);
  }
}
check("every reader of the member's own lines skips their talk with a teammate (or is listed as activity-only)", unguarded.length === 0, unguarded.join(", "));

// ------------------------------------------------------------------ 3. output caps on Sonnet calls
// At the default effort Sonnet 5 can spend the whole output budget reasoning and return a cut-off
// answer (2026-09-29: half the learning reads, finish=length). A capped Sonnet call sets an effort,
// or is listed with the measurement that shows it finishes.
const MEASURED: Record<string, string> = {
  "services/voiceLine.ts": "wrote its own line 8/8 (2026-09-29)",
  "harness/proactive.ts": "pick prompt finished 4/4 at 45 to 57 tokens (2026-09-29)",
};
const calls: string[] = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, idx) => {
    if (!/generateText\(\{/.test(line)) return;
    const block = lines.slice(idx, idx + 60);
    const cut = block.findIndex((l, j) => j > 0 && /generateText\(\{/.test(l));
    const body = (cut === -1 ? block : block.slice(0, cut)).join("\n");
    const cap = body.match(/maxOutputTokens:\s*([\d_]+)/)?.[1];
    if (!cap) return;
    const model = body.match(/model:\s*anthropic\(([^)]*)\)/)?.[1] ?? "";
    if (/haiku/i.test(model)) return;
    // the setting itself (`effort: …` or `{ effort }`), not a comment that mentions the word
    if (/\beffort\s*[:},]/.test(body.replace(/\/\/.*$/gm, ""))) return;
    // Any cap: 16,000 ran out on 2026-09-30 too (devReview.modelFlags).
    if (MEASURED[rel(f)]) return;
    calls.push(`${rel(f)}:${idx + 1} (${model.trim() || "model?"}, cap ${cap})`);
  });
}
check("no Sonnet call has an output cap without an effort setting", calls.length === 0, calls.join("; "));

// ------------------------------------------------------------------ 4. a link and its preview photo
const rows = ["User said: https://x.com/a/status/1?s=20 [They also sent a photo. It shows: the X logo]"];
const m = L.mergeEarlierLink("[sent a photo showing: a dark thumbnail]", false, rows);
check("a photo-only message reads together with the link sent just before it", m.fromEarlier && m.link === "https://x.com/a/status/1?s=20" && /^https:\/\/x\.com\/a\/status\/1\?s=20 \[sent a photo showing/.test(m.merged), m.merged);
check("a message with its own link is left alone", (() => { const r = L.mergeEarlierLink("look https://lu.ma/x", true, rows); return !r.fromEarlier && r.merged === "look https://lu.ma/x"; })());
check("a link they sent to a teammate agent is not picked up", !L.mergeEarlierLink("[sent a photo]", false, ["User said: https://x.com/a/status/9 [to Mo]"]).link);
check("with no link before it, a photo stays as it was", (() => { const r = L.mergeEarlierLink("[sent a photo]", false, ["User said: hello"]); return !r.link && r.merged === "[sent a photo]"; })());
check("the newest link wins when several came before", L.mergeEarlierLink("[sent a photo]", false, ["User said: https://newer.com/x", "User said: https://older.com/x"]).link === "https://newer.com/x");

// ------------------------------------------------------------------ 5. one source fence
// The readers the 10-13 fixes added read member data only through services/sourceFence.ts, and every read there is one member's own.
{
  const fenced = ["services/searchCoverage.ts", "services/whatsAhead.ts", "services/lessonCheck.ts", "services/memberWorld.ts"];
  const direct = fenced.filter((f) => { const t = fs.readFileSync(path.join(root, f), "utf8"); return /db\/db(?:\.js)?["']|\bpool\b|\.query\(|\bFROM\s+[a-z_]+\b/.test(t) || !/sourceFence\.js/.test(t); });
  check("the 10-13 readers touch member data only through the source fence", direct.length === 0, direct.join(", "));
  const fenceSrc = fs.readFileSync(path.join(root, "services/sourceFence.ts"), "utf8");
  const sqls = [...fenceSrc.matchAll(/pool\.query\(\s*`([^`]+)`/g)].map((m) => m[1]);
  const allQueries = (fenceSrc.match(/\bpool\.query\(/g) ?? []).length;
  check("every read in the fence is scoped to the one member", sqls.length >= 6 && allQueries === sqls.length && sqls.every((q) => /\buser_id = \$1\b/.test(q)), `${sqls.length} of ${allQueries} reads checked`);
  // A read that returns timestamps only (when they were active, any channel) carries no words, so it may count a teammate text.
  check("the fence's read of their texts skips talk with a teammate (a timestamps-only read carries no words)", sqls.filter((q) => /text_exchange/.test(q)).every((q) => /notToTeammate\(/.test(q) || /^SELECT created_at FROM co_memories WHERE/.test(q.trim())));
}
{
  const LC = await import("../../src/services/lessonCheck.js");
  const SF = await import("../../src/services/sourceFence.js");
  const fence = { strip: (t: string) => (/Jordan/.test(t) ? null : t) };
  const toMo = [{ at: new Date("2026-10-13T23:10:00Z"), text: "the real reason was the search, tell Jordan [to Mo]" }];
  const lesson = "When he asks what you're searching for, describe it plainly.";
  const asDrafted = [{ at: new Date("2026-10-13T23:09:00Z"), outcome: "as_drafted", draft: "Nothing yet.", sent: "Nothing yet." }].map((l) => ({ ...l, why: null }));
  // The read confirms only if the text to someone else reaches it: through the fence it can't, so the lesson stays a guess. Without
  // the fence the same read would come back confirmed ("co" with a cause), so this fails if the fence is removed.
  const confirmsOnlyFromOther = async (p: string) => JSON.stringify(/tell Jordan|\[to Mo\]/.test(p) ? { cause: "co", lesson, causeLine: "he told Mo the real reason" } : { cause: "unknown", lesson, causeLine: null });
  const a = await LC.checkLesson("u", { message: "m", pushback: "p", lesson }, { logs: asDrafted, theirs: toMo, fence, read: confirmsOnlyFromOther });
  check("a lesson whose only confirmation is a text to someone else is saved as a guess", a.text.startsWith(LC.HYPOTHESIS_MARK) && a.cause === "unknown", a.text);
  let prompt = "";
  const b = await LC.checkLesson("u", { message: "m", pushback: "p", lesson }, { logs: asDrafted, theirs: toMo, fence, read: async (p) => { prompt = p; return JSON.stringify({ cause: "check", lesson, causeLine: "his text to Mo shows the reply check changed it" }); } });
  check("the text to someone else never reaches the read, and can't confirm a cause", !/\[to Mo\]|tell Jordan/.test(prompt) && b.text.startsWith(LC.HYPOTHESIS_MARK), b.text);
  const c = await LC.checkLesson("u", { message: "m", pushback: "p", lesson }, { logs: asDrafted, theirs: [], fence, read: async () => JSON.stringify({ cause: "co", lesson: "Don't bring up Jordan's plans", causeLine: "Co mentioned Jordan" }) });
  check("a cause or lesson naming another member is never kept as confirmed", c.text === `${LC.HYPOTHESIS_MARK} ${lesson}`, c.text);
  const w = SF.fenceReplyLog(fence, [{ at: new Date(), outcome: "cut", draft: "Jordan is going too.", sent: "Want the link?", why: "privacy" }]);
  check("a draft the check cut for another member's details is withheld from every reader", w.length === 1 && w[0].draft === SF.DRAFT_WITHHELD && w[0].sent === "Want the link?");
  const disc = SF.fenceReplyLog({ strip: (t: string) => t }, [{ at: new Date(), outcome: "stripped", draft: "Dana told me she's leaving her husband.", sent: "Here for you either way.", why: "discretion", failed: ["discretion"] }]);
  check("a draft the discretion check cut is withheld even when no linked name is in it", disc.length === 1 && disc[0].draft === SF.DRAFT_WITHHELD);
  const claimCut = SF.fenceReplyLog({ strip: (t: string) => t }, [{ at: new Date(), outcome: "cut", draft: "Sam from your gym is going too.", sent: "Want the link?", why: "detail", failed: ["claim_detail"] }]);
  check("a draft cut by any check not about Co's own wording is withheld", claimCut[0].draft === SF.DRAFT_WITHHELD);
  const part = SF.fenceReplyLog({ strip: (t: string) => t }, [{ at: new Date(), outcome: "stripped", draft: "I look for events that fit. Sam from your gym is going too.", sent: "Nothing's running on that right now.", why: "x", failed: [{ name: "claim_work_status", reason: 'work_status: "I look for events that fit."' }, { name: "claim_detail", reason: 'detail: "Sam from your gym is going too."' }] }]);
  const quoted = SF.fenceReplyLog({ strip: (t: string) => t }, [{ at: new Date(), outcome: "cut", draft: 'Dana said "I\'m leaving Mark next month" when you two talked. Want me to set something up?', sent: "Want me to set something up?", why: "x", failed: [{ name: "claim_other_person", reason: 'other_person: "Dana said "I\'m leaving Mark next month" when you two talked"' }] }]);
  check("cut words with a quote inside them never leak: the draft is withheld whole", quoted[0].draft === SF.DRAFT_WITHHELD && !/leaving Mark/.test(quoted[0].draft));
  const noted = SF.fenceReplyLog({ strip: (t: string) => t }, [{ at: new Date(), outcome: "cut", draft: "I'm on it. Sam is going too.", sent: "I'm on it.", why: "x", failed: [{ name: "claim_detail", reason: 'detail: "Sam is going too." (no fact backs it)' }] }]);
  check("a check reason with a note after the quote still finds the cut words", noted[0].draft === `I'm on it. ${SF.LINE_WITHHELD}`, noted[0].draft);
  check("only the words a claim check cut about someone are withheld; Co's own cut wording stays readable", part[0].draft === `I look for events that fit. ${SF.LINE_WITHHELD}`, part[0].draft);
  const clean = SF.fenceReplyLog({ strip: (t: string) => t.trim() }, [{ at: new Date(), outcome: "cut", draft: "Here's the plan.\n", sent: "Here's the plan, roughly.", why: "x", failed: ["claim_work_status"] }]);
  check("a clean draft isn't withheld for trailing whitespace", clean[0].draft === "Here's the plan.\n");
  check("their own texts to a teammate are fenced out even when handed in", SF.fenceTheirTexts(fence, [{ at: new Date(), text: "hi [to Mo]" }, { at: new Date(), text: "what are you searching for?" }]).map((t) => t.text).join("|") === "what are you searching for?");
}

console.log(`guard rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
