// Mo is gone (Royce, 2026-10-14: "we want to get rid of all of Mo's functionality. It won't be used."). Model-free checks that
// nothing a member sees or a model reads mentions Mo, that nothing imports the removed api/src/mo, and that the readers of the
// old stored rows still fence Mo's lines out. The full code is on branch archive/mo-backup-2026-10-14.
//
//   npx tsx evals/capabilities/moRemoved.ts
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
};

const api = new URL("../../", import.meta.url).pathname;
const repo = path.join(api, "..");
const SELF = path.join(api, "evals/capabilities/moRemoved.ts");
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      // Recorded model answers, installed packages and the archived Circles code are not sources.
      if (["node_modules", "recordings", "_archive"].includes(f)) continue;
      walk(p, out);
    } else if (/\.(ts|mts|mjs|js|html|md)$/.test(f) && !f.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(repo, p);

// ------------------------------------------------------------------ 1. the code is gone, and nothing reaches for it
check("api/src/mo is gone", !fs.existsSync(path.join(api, "src/mo")));
check("routes/mo.ts is gone", !fs.existsSync(path.join(api, "src/routes/mo.ts")));
const sources = [...walk(path.join(api, "src")), ...walk(path.join(api, "evals")), ...walk(path.join(repo, "co-test/src")), ...walk(path.join(repo, "co-test/public"))].filter((f) => f !== SELF);
const importsMo = sources.filter((f) => /from\s+["'][^"']*\/mo\/[^"']*["']|import\(\s*["'`][^"'`]*\/mo\/|["'`](\.\.\/)*src\/mo\/|src\("mo\//.test(fs.readFileSync(f, "utf8")));
check("nothing imports or reads from api/src/mo", importsMo.length === 0, importsMo.map(rel));

// ------------------------------------------------------------------ 2. no member-facing string or prompt says Mo
// Every string and template literal in the running code (api/src, co-test/src), the dashboard pages, and the prompt files.
// Comments are not scanned: nobody outside the code reads them.
// The only strings allowed to say Mo read OLD stored rows, so those rows keep being treated as the team lines they were. Each is
// pinned by its exact text, so a new one can't hide behind it.
const READERS_OF_OLD_ROWS: Record<string, string[]> = {
  // Whether the member was answered: an old "Mo replied:" line in their thread counts, as it did when it was written.
  "api/src/routes/sendblue.ts": ["content LIKE 'Mo replied:%'", "r.content LIKE 'Mo replied:%'"],
  // The ask lifecycle's conversation read leaves out their old texts to Mo.
  "api/src/services/askLifecycle.ts": ["content NOT LIKE '%[to Mo]%'"],
  // A turn already answered by an old "Mo replied:" line is not reported as unfinished.
  "api/src/services/turnFailure.ts": ["Mo replied:"],
};
const hits: string[] = [];
function literals(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  if (!/\.(ts|mts|mjs|js)$/.test(file)) return [text];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const running = [...walk(path.join(api, "src")), ...walk(path.join(repo, "co-test/src")), ...walk(path.join(repo, "co-test/public")), ...walk(path.join(api, "prompts"))];
for (const f of running) {
  const allowed = READERS_OF_OLD_ROWS[rel(f)] ?? [];
  for (const lit of literals(f)) {
    let t = lit;
    for (const a of allowed) t = t.split(a).join("");
    if (/\bMo\b/.test(t)) hits.push(`${rel(f)}: ${lit.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}
check("no string in the running code, the dashboard or the prompts names Mo (old-row readers aside)", hits.length === 0, hits);
for (const [f, allowed] of Object.entries(READERS_OF_OLD_ROWS)) {
  const lits = literals(path.join(repo, f)).join("\n");
  check(`${f}: each allowed old-row reader is still there (or its entry goes)`, allowed.every((a) => lits.includes(a)));
}

// What Co reads about itself, built at runtime: no Mo, no handoff, no teammate.
const C = await import("../../src/services/capabilities.js");
const G = await import("../../src/harness/replyGrounding.js");
const said = [
  ...C.capabilitySheet({ team: true }),
  ...C.capabilitySheet(),
  ...C.capabilityMenu("text").here.map((h) => h.line),
  ...C.capabilityMenu("call").here.map((h) => h.line),
  ...C.capabilityMenu("call").byText,
  ...C.ABILITIES.flatMap((a) => [a.can, a.use ?? ""]),
  ...C.LIMITS,
  ...G.baseReplyFacts().facts.map((f) => f.text),
].join("\n");
check("Co's sheet, menu, tool descriptions and base facts never name Mo", !/\bMo\b/.test(said));
check("no handing off to a teammate, and no asking one", !/\bteammate\b|handToTeammate|askTeammate/i.test(said));
check("no tool or ability is Mo's", !C.ABILITIES.some((a) => /^mo_|Mo(?![a-z])/.test(`${a.id} ${a.tool ?? ""}`)));
const { createConversationTools } = await import("../../src/agent/conversationTools.js");
const base = { userId: "u", phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true };
const toolNames = [...Object.keys(createConversationTools(base as any).tools), ...Object.keys(createConversationTools({ ...base, isTeam: true } as any).tools)];
check("neither a member nor the team gets a Mo or teammate tool", !toolNames.some((t) => /Mo(?![a-z])|Teammate/.test(t)), toolNames.filter((t) => /Mo(?![a-z])|Teammate/.test(t)));
const { PROACTIVE_PURPOSE } = await import("../../src/harness/proactivePurpose.js");
const { PAYLOAD_FIRST_EXEMPT } = await import("../../src/harness/payloadFirst.js");
check("no proactive kind is Mo's", !Object.keys(PROACTIVE_PURPOSE).some((k) => k.startsWith("mo_")) && ![...PAYLOAD_FIRST_EXEMPT].some((k) => k.startsWith("mo_")));
const registrySrc = fs.readFileSync(path.join(api, "src/harness/proactiveRegistry.ts"), "utf8") + fs.readFileSync(path.join(api, "src/harness/proactive.ts"), "utf8");
check("the proactive registry and its types have no Mo kind", !/\bmo_member_\w+/.test(registrySrc));
check("a queued row of a kind the registry no longer has is never picked", /candRows\.map\(rowToCandidate\)\.filter\(\(c\) => c\.type in registry\)/.test(fs.readFileSync(path.join(api, "src/harness/proactive.ts"), "utf8")));

// ------------------------------------------------------------------ 3. Mo's switches are not read
const envReads = running.filter((f) => /\.(ts|mts|mjs|js)$/.test(f)).flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/\b(?:process\.)?env\.((?:MO|X_MO)_[A-Z_]+)/g)].map((m) => `${rel(f)}: ${m[1]}`));
// The opt-out link in invitation emails already sent is still checked with the secret it was signed with (routes/emailOptOut.ts).
check("no Mo switch or Mo key is read, except the secret the sent opt-out links were signed with", envReads.every((r) => r.endsWith(": MO_UNSUBSCRIBE_SECRET")), envReads);

// ------------------------------------------------------------------ 4. old rows stay fenced (a privacy guard)
const TL = await import("../../src/services/teamLines.js");
check(
  "old team lines are dropped from what any read sees: their texts to Mo, Mo's replies, Co's tag",
  TL.withoutTeammateLines("User said: hi\nUser said: pause the outreach [to Mo]\nMo replied: paused\nMo said: done\nCo tagged Mo: @Mo\nCo replied: sure") === "User said: hi\nCo replied: sure",
);
check("the SQL fence still leaves out a line ending [to Mo]", TL.notToTeammate().includes(String.raw`\[to [A-Za-z]+\]$`));
const SF = await import("../../src/services/sourceFence.js");
const fence = { strip: (t: string) => t };
check("an old text to Mo is never the member's own words", SF.fenceTheirTexts(fence, [{ at: new Date(), text: "tell Jordan the plan [to Mo]" }]).length === 0);
check("an old Mo line never enters the fenced exchange", SF.fenceExchange(fence, [{ at: new Date(), content: "Mo replied: paused" }, { at: new Date(), content: "User said: ok [to Mo]" }, { at: new Date(), content: "Co replied: hi" }]).map((l) => l.text).join("|") === "hi");
const { exchangeFromTranscript } = await import("../../src/services/askSplit.js");
const ex = await exchangeFromTranscript("User said: find me a caterer\nMo replied: on it");
check("an old Mo line in a transcript is never read as the member's message", ex.message === "find me a caterer", ex);

// ------------------------------------------------------------------ 5. the opt-out link in emails already sent still works
const O = await import("../../src/routes/emailOptOut.js");
const { createHmac } = await import("node:crypto");
const id = "11111111-2222-3333-4444-555555555555";
const sig = createHmac("sha256", "s").update(`mo-unsub:${id}`).digest("hex").slice(0, 32);
check("a real opt-out link is accepted", O.optOutTokenMatches(id, sig, { MO_UNSUBSCRIBE_SECRET: "s" } as any));
check("a forged or malformed one is not", !O.optOutTokenMatches(id, "0".repeat(32), { MO_UNSUBSCRIBE_SECRET: "s" } as any) && !O.optOutTokenMatches("x", sig, { MO_UNSUBSCRIBE_SECRET: "s" } as any) && !O.optOutTokenMatches(id, sig, {} as any));
const optSrc = fs.readFileSync(path.join(api, "src/routes/emailOptOut.ts"), "utf8");
check("the opt-out writes only the decision log, never an outreach table", !/pool\.query|mo_\w+/.test(optSrc.replace(/mo-unsub/g, "")));

console.log(`mo removed: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
