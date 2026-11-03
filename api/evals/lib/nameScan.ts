// The rename sweep (Royce, 2026-10-14: the agent is Cue, the company Noise, and Mo is gone): finds "Co", "Mo" or "CoPatible" in
// what a member sees or a model reads. Used by evals/capabilities/nameSweep.ts (layer 1) and golden cases 53 and 54.
//
// Scanned: every string and template literal in the running code (api/src, co-test/src), the dashboard's pages, and the prompt
// files. Comments, identifiers, file and table names are internal and never scanned ("co_facts", "coTasks" stay). Regex literals
// are matchers, not text, so they aren't scanned either: readers of old rows keep matching "Co replied:" and "[to Mo]".
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// The old names as words. "Co-" before a letter is a real compound ("Co-working"), never the agent.
export const OLD_NAME = /\bCo\b(?!-[A-Za-z])|\bMo\b|\bCoPatible\b/;

// The only places the old names may stay, each for a reason. An entry is a file and the exact text allowed there; the text is
// removed from a literal before it is scanned, so anything else in the same literal is still caught.
// exact: the whole literal is that word (a list entry), not text inside a sentence.
export const ALLOWED: { file: string; text: string; why: string; exact?: true }[] = [
  // The stored transcript prefix: rows in co_memories already say "Co replied:", and every SQL and code reader matches it. New
  // rows keep it, so readers never split across two forms (the rename's choice). Cue is told these lines are its own (CO_VOICE).
  ...["api/src/agent/artifactTools.ts", "api/src/agent/conversationReply.ts", "api/src/agent/conversationTools.ts", "api/src/agent/deckTools.ts", "api/src/agent/loopTools.ts", "api/src/agent/pageTools.ts", "api/src/harness/devReview.ts", "api/src/harness/failureCount.ts", "api/src/harness/intake.ts", "api/src/harness/proactive.ts", "api/src/harness/proactiveRegistry.ts", "api/src/harness/replyGrounding.ts", "api/src/routes/sendblue.ts", "api/src/scripts/simulateInboundText.ts", "api/src/services/askRetire.ts", "api/src/services/callContext.ts", "api/src/services/callTools.ts", "api/src/services/conversationClose.ts", "api/src/services/documentDelivery.ts", "api/src/services/engagementRhythm.ts", "api/src/services/eventScoring.ts", "api/src/services/eventUnmatchedFollowUp.ts", "api/src/services/followUps.ts", "api/src/services/gateGuard.ts", "api/src/services/messageRouter.ts", "api/src/services/networkIntroNudge.ts", "api/src/services/roomMatching.ts", "api/src/services/turnFailure.ts", "api/src/services/coFacts.ts", "api/src/services/ledgerSources.ts", "co-test/src/routes/api.ts"].map((file) => ({ file, text: "Co replied:", why: "the stored transcript prefix (co_memories), written and read as is" })),
  // The other stored prefixes, matched by SQL readers (LIKE 'Co is looking:%', 'Co initiated call%', 'Co called % Followed up%').
  { file: "api/src/agent/loopTools.ts", text: "Co is looking:", why: "stored prefix of a search note" },
  { file: "api/src/routes/sendblue.ts", text: "Co is looking:", why: "stored prefix of a search note" },
  { file: "api/src/services/engagementRhythm.ts", text: "Co is looking:", why: "SQL reader of the stored search-note prefix" },
  { file: "api/src/services/callTrigger.ts", text: "Co initiated call to ", why: "stored marker row of a call attempt, read by SQL elsewhere" },
  ...["api/src/harness/callGate.ts", "api/src/harness/proactive.ts", "api/src/jobs/index.ts", "api/src/services/claims.ts", "api/src/services/elevenLabsCalls.ts", "api/src/services/memoryCompaction.ts", "api/src/services/firstCall.ts"].map((file) => ({ file, text: "Co initiated call", why: "SQL reader of the stored call-attempt marker" })),
  ...["api/src/harness/callGate.ts", "api/src/routes/co.ts"].map((file) => ({ file, text: "Co called ", why: "stored call note and the gate's internal reason, parsed by SQL and services/callReasons.ts" })),
  { file: "api/src/services/roomMatching.ts", text: "content LIKE 'Co %'", why: "SQL reader of every stored agent line" },
  // Readers of old rows Mo wrote before it was removed (2026-10-14): they keep those rows fenced out.
  { file: "api/src/routes/sendblue.ts", text: "content LIKE 'Mo replied:%'", why: "old rows: a Mo reply counted as answered" },
  { file: "api/src/services/askLifecycle.ts", text: "content NOT LIKE '%[to Mo]%'", why: "old rows: their texts to Mo stay out of the ask read" },
  { file: "api/src/services/turnFailure.ts", text: "Mo replied:", why: "old rows: a Mo reply counted as answered" },
  // The alias (services/agentName.ts CO_ALIAS_UNTIL): Cue is told its old name so "hey co" is answered as Cue.
  { file: "api/src/services/agentName.ts", text: "Co", exact: true, why: "OLD_AGENT_NAME, the alias itself" },
  { file: "api/src/services/coVoice.ts", text: "Your name used to be Co.", why: "the alias, told to the model" },
  { file: "api/src/services/coVoice.ts", text: "members may still call you Co out of habit (\"hey co\")", why: "the alias, told to the model" },
  { file: "api/src/services/coVoice.ts", text: "Lines in your history marked Co (\"Co replied:\", \"Co called\")", why: "the stored prefixes, explained to the model" },
  { file: "api/prompts/co-system-prompt.md", text: "Your name used to be Co, and until January 31, 2027 they may still call you Co out of habit", why: "the alias, in the call's voice layer" },
  { file: "api/src/services/elevenLabsCalls.ts", text: "your old name, Co, which some still use,", why: "the call brain is told how its old name gets misheard during the alias" },
  { file: "api/src/services/elevenLabsCalls.ts", text: "CoPatible", exact: true, why: "speech keyword during the alias: members may still say the old name" },
  ...["Co", "CoPatible"].map((text) => ({ file: "api/src/services/sweepQuery.ts", text, exact: true as const, why: "old names scrubbed out of search queries (goals written before the rename)" })),
  ...["Co", "Co's"].map((text) => ({ file: "api/src/services/followThrough.ts", text, exact: true as const, why: "words that are never a member's name, old name included" })),
  // Out of scope until the November pass (Royce's spec, item 6): the Luma calendar is still named "Co Presents".
  ...["api/src/otpActions.ts", "api/src/agent/calendarFollowReachOut.ts", "api/src/harness/proactiveRegistry.ts"].map((file) => ({ file, text: "Co Presents", why: "the Luma calendar's real name, renamed in the November pass" })),
];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      // Installed packages, recorded model answers and the archived Circles code are not sources.
      if (["node_modules", "recordings", "_archive"].includes(f)) continue;
      walk(p, out);
    } else if (/\.(ts|mts|js|html|md)$/.test(f) && !f.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// Every string and template literal in a source file; the whole text of a page or a prompt file.
export function literalsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  if (!/\.(ts|mts|js)$/.test(file)) return [text.replace(/<!--[\s\S]*?-->/g, "")];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent))) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// The member-facing and model-facing sources. In co-test/public only the pages and the committed login.js: the other bundles there
// are uncommitted build output of co-test/src/client, which is scanned as source.
export function sourceFiles(repo: string): string[] {
  const pub = path.join(repo, "co-test/public");
  return [
    ...walk(path.join(repo, "api/src")),
    ...walk(path.join(repo, "api/prompts")),
    ...walk(path.join(repo, "co-test/src")),
    ...fs.readdirSync(pub).filter((f) => f.endsWith(".html") || f === "login.js").map((f) => path.join(pub, f)),
  ];
}

// Every old name left in those sources, outside the allowed places: "file: the literal".
export function oldNameHits(repo: string): string[] {
  const hits: string[] = [];
  for (const f of sourceFiles(repo)) {
    const rel = path.relative(repo, f);
    const allowed = ALLOWED.filter((a) => a.file === rel);
    for (const lit of literalsOf(f)) {
      if (allowed.some((a) => a.exact && a.text === lit)) continue;
      let t = lit;
      for (const a of allowed) if (!a.exact) t = t.split(a.text).join("");
      if (OLD_NAME.test(t)) hits.push(`${rel}: ${lit.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return hits;
}

// Allowed entries whose text is gone from their file (stale): each must be removed, so the list never outlives its reason.
export function staleAllowances(repo: string): string[] {
  return ALLOWED.filter((a) => !literalsOf(path.join(repo, a.file)).some((l) => (a.exact ? l === a.text : l.includes(a.text)))).map((a) => `${a.file}: ${a.text}`);
}

// Pure: the old names in one piece of text a member would see (a reply, a rendered page).
export function oldNamesIn(text: string): string[] {
  return [...String(text ?? "").matchAll(/\bCo\b(?!-[A-Za-z])|\bMo\b|\bCoPatible\b/g)].map((m) => m[0]);
}
