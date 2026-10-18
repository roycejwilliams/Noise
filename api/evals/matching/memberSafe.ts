// What the matching scorer may read about other members (Royce, 2026-10-18; outbound inventory, matching rows): a prompt made
// for one member carries other members' shareable asks and short, clipped profile items only. Never a co_memories row (a call
// transcript, a text exchange, Cue's own record), never a private ask, never another person in the same prompt by name.
// Zero tokens: the database is an in-memory fake that WOULD hand back transcripts and Cue-written rows if anything asked, Anthropic
// is a fake that records each prompt, Jev is the injected gateway. Invented people only.
//   npx tsx evals/matching/memberSafe.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "ci";
process.env.SENDBLUE_API_API_SECRET ||= "ci";
process.env.ANTHROPIC_API_KEY ||= "ci";
process.env.OPENAI_API_KEY ||= "ci";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.JEV_PRUNE = "off";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- the fake store
// Words that must never reach a prompt about someone else.
const SECRET = {
  transcript: "TRANSCRIPT-LINE my divorce is final and I am moving out of the loft on Friday",
  cueWritten: "CUE-WRITTEN Cue suggested Noor to Ellis because Noor is quietly leaving her job",
  longMemory: `LONG-MEMORY ${"they talked for an hour about the studio lease and the landlord ".repeat(40)}`,
  privateAskB: "PRIVATE-ASK-B a new job without my cofounder knowing",
  privateAskC: "PRIVATE-ASK-C a fertility clinic someone trusts",
  extraField: "EXTRA-FIELD long term direction and notes nobody shares",
};
const vec = new Array(8).fill(0.1);
const B = {
  user_id: "00000000-0000-4000-8000-00000000000b",
  first_name: "Ellis",
  goals: ["raise a seed round for a grid storage startup", "reconnect with Noor about the studio space"],
  blockers: ["no technical cofounder yet"],
  activity_preferences: ["trail running"],
  intent: [
    { id: "b1", type: "offering", status: "active", kind: "ask", shareable: true, text: "intros to climate hardware investors", embedding: vec },
    { id: "b2", type: "seeking", status: "active", kind: "ask", shareable: false, text: SECRET.privateAskB, embedding: vec },
  ],
  // Fields a caller might carry along: nothing outside the list above may be read onto the line.
  long_term_direction: SECRET.extraField,
  memories: [SECRET.transcript],
  notes: SECRET.extraField,
};
const C = {
  user_id: "00000000-0000-4000-8000-00000000000c",
  first_name: "Noor",
  goals: [`open a ceramics studio ${"with a kiln, a shop front, classes for kids and a members' wall ".repeat(12)}`],
  blockers: [],
  activity_preferences: ["wheel throwing"],
  intent: [
    { id: "c1", type: "seeking", status: "active", kind: "ask", shareable: false, text: SECRET.privateAskC },
    { id: "c2", type: "seeking", status: "active", kind: "ask", shareable: true, text: "a seed investor for a ceramics studio" },
  ],
};
const D = { user_id: "00000000-0000-4000-8000-00000000000d", first_name: "Sarah Hao", goals: [], blockers: [], activity_preferences: [], intent: [] };
const MEMORY_ROWS = [
  { memory_type: "call_transcript", content: `Call transcript:\nUser: hi\nCue: hi\n${SECRET.transcript}` },
  { memory_type: "recommendation", content: SECRET.cueWritten },
  { memory_type: "text_exchange", content: SECRET.longMemory },
];

const sqls: string[] = [];
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, params?: any[]) => {
  sqls.push(String(sql));
  // Anything that reads co_memories for the candidates gets their transcript, Cue's record and a long memory back.
  if (/co_memories/.test(sql)) {
    const ids: string[] = (Array.isArray(params?.[0]) ? params![0] : [params?.[0]]).filter(Boolean);
    const rows = ids.flatMap((user_id) => MEMORY_ROWS.map((r) => ({ user_id, ...r })));
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: 0 };
};
(pool as any).connect = async () => ({ query: (pool as any).query, release: () => {} });

// ---------------------------------------------------------------- the fake scorer
const prompts: string[] = [];
const promptOf = (init: any): string => {
  try {
    const b = JSON.parse(init?.body ?? "{}");
    return (b.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(""))).join("\n");
  } catch {
    return "";
  }
};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input));
  if (url.host !== "api.anthropic.com") throw new Error(`memberSafe eval: refused outside call to ${url.host}`);
  const prompt = promptOf(init);
  prompts.push(prompt);
  const n = (digestOf(prompt).match(/^\d+\. /gm) ?? []).length;
  const results = Array.from({ length: n }, (_, index) => ({ index, score: 80, reason: "internal", share_ask: "S1", mutual: false }));
  const body = { id: "msg_stub", type: "message", role: "assistant", model: "stub", content: [{ type: "text", text: JSON.stringify({ results }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

function digestOf(prompt: string): string {
  return prompt.split("one per line:\n")[1]?.split("\n\nFor each candidate")[0] ?? "";
}
const linesOf = (prompt: string) => digestOf(prompt).split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ""));

const M = await import("../../src/services/matching.js");
const { setJevGatewayForTests } = await import("../../src/services/jevGateway.js");
const secretsIn = (s: string) => Object.entries(SECRET).filter(([, v]) => s.includes(v.slice(0, 30))).map(([k]) => k);
const ask = { id: "a1", type: "seeking" as const, status: "active", text: "a seed investor for climate hardware", embedding: vec };

// ---------------------------------------------------------------- 1. every scoring path, member A asking about B, C, D
{
  prompts.length = 0;
  sqls.length = 0;
  const stated = await M.scoreAgainstStatedAsk(ask, [B, C, D], "goals: build climate hardware");
  const offering = await M.scoreOfferingAgainstCandidates({ ...ask, type: "offering", text: "seed checks for hardware founders" }, [B, C, D]);
  const frame = { asks: [{ ...ask, shareable: true }], goal: { id: "g", type: "seeking" as const, status: "active", text: "a climate hardware company", embedding: vec } };
  const hints = new Map([[B.user_id, 'likely overlap: the asker wants "climate investors" and this person offers "climate investor intros"']]);
  const room = await M.scoreAgainstRoomFrame(frame, [B, C, D], "goals: build climate hardware", hints);
  check("three scoring prompts were sent (stated ask, offering, room frame)", prompts.length === 3, prompts.length);
  for (const [i, p] of prompts.entries()) {
    const label = ["stated ask", "offering", "room frame"][i];
    check(`${label}: no transcript, Cue-written row, long memory, private ask or extra field reaches the prompt`, secretsIn(p).length === 0, secretsIn(p));
    check(`${label}: no "mentioned:" memory lines and no private-ask label`, !/mentioned:|private asks|never shareable/i.test(p));
    const lines = linesOf(p);
    check(`${label}: one line per candidate`, lines.length === 3, lines);
    check(`${label}: every line within the per-candidate cap (${M.DIGEST_CANDIDATE_CHARS})`, lines.every((l) => l.length <= M.DIGEST_CANDIDATE_CHARS), lines.map((l) => l.length));
    check(`${label}: B's shareable ask is on B's line`, lines[0].includes('[S1] offering "intros to climate hardware investors"'), lines[0]);
    check(`${label}: B's goals, blocker and like are on B's line`, ["raise a seed round for a grid storage startup", "no technical cofounder yet", "trail running"].every((x) => lines[0].includes(x)), lines[0]);
    check(`${label}: C's shareable ask is on C's line as S1 (numbered over shareable asks only)`, lines[1].includes('[S1] seeking "a seed investor for a ceramics studio"'), lines[1]);
    check(`${label}: C's long goal is clipped to ${M.DIGEST_ITEM_CHARS} chars`, lines[1].includes("open a ceramics studio with a kiln") && lines[1].split("; ").every((x) => x.length <= M.DIGEST_ITEM_CHARS + 40) && lines[1].includes("…"), lines[1]);
    check(`${label}: D has nothing on file`, lines[2] === "(nothing on file)", lines[2]);
    check(`${label}: B's goal naming Noor (another person in this prompt) is left out`, !lines[0].includes("reconnect with Noor"), lines[0]);
  }
  check("room frame: the people graph hint still reaches the scorer", linesOf(prompts[2])[0]?.includes("likely overlap: the asker wants"), linesOf(prompts[2])[0]);
  check("stated ask: mutual no longer asks the model about private asks", !/shared or private/.test(prompts[0]));
  check("no scoring path read co_memories", !sqls.some((q) => /co_memories/.test(q)), sqls.filter((q) => /co_memories/.test(q)).map((q) => q.slice(0, 80)));
  // What a member may see is unchanged: the share reason is still the candidate's own shareable ask, from their real intent.
  const bStated = stated.find((s) => s.candidate.user_id === B.user_id);
  check("share reason unchanged: B's own shareable ask, word for word", bStated?.shareReason === `what they've said they can offer: "intros to climate hardware investors"`, bStated?.shareReason);
  check("the candidate handed back is the caller's own object (intent untouched)", bStated?.candidate === B && (B.intent as any[]).length === 2);
  const cRoom = room.find((s) => s.candidate.user_id === C.user_id);
  check("share reason for C rests on C's shareable ask, never the private one", cRoom?.shareReason === `what they've said they're looking for: "a seed investor for a ceramics studio"`, cRoom?.shareReason);
  check("D, with nothing shareable, has no share reason", room.find((s) => s.candidate.user_id === D.user_id)?.shareReason === "");
  void offering;
}

// ---------------------------------------------------------------- 2. caps: per candidate and per prompt
{
  const many = (n: number, sharedLen = 100) =>
    Array.from({ length: n }, (_, i) => ({
      user_id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
      goals: Array.from({ length: 6 }, (_, g) => `goal ${g} ${"word ".repeat(30)}`),
      blockers: Array.from({ length: 4 }, (_, g) => `blocker ${g} ${"word ".repeat(30)}`),
      activity_preferences: Array.from({ length: 5 }, (_, g) => `like ${g}`),
      intent: [
        { type: "seeking", status: "active", kind: "ask", shareable: true, text: `older shared ${i} ${"x".repeat(sharedLen)}` },
        { type: "offering", status: "active", kind: "ask", shareable: true, text: `newest shared ${i} ${"y".repeat(sharedLen)}` },
      ],
    }));
  const forty = M.candidateLines(many(40));
  check("40 full candidates: every line within the per-candidate cap", forty.every((l) => l.length <= M.DIGEST_CANDIDATE_CHARS), Math.max(...forty.map((l) => l.length)));
  check("40 full candidates: the prompt's lines within the per-prompt cap", forty.reduce((a, l) => a + l.length, 0) <= M.DIGEST_PROMPT_CHARS, forty.reduce((a, l) => a + l.length, 0));
  const eighty = M.candidateLines(many(80));
  check("80 candidates: every candidate kept, lines shrink to share the prompt cap", eighty.length === 80 && eighty.reduce((a, l) => a + l.length, 0) <= M.DIGEST_PROMPT_CHARS, eighty.reduce((a, l) => a + l.length, 0));
  check("80 candidates: each still carries its newest shared ask, with its own label", eighty.every((l, i) => l.includes(`[S2] offering "newest shared ${i} `)), eighty[0]);
  const crowd = M.candidateLines(many(150, 150));
  check("150 candidates with long asks: every line keeps one clipped shared ask within the floor", crowd.length === 150 && crowd.every((l) => /\[S2\] offering "newest shared/.test(l) && l.length <= M.DIGEST_MIN_CANDIDATE_CHARS), Math.max(...crowd.map((l) => l.length)));
  const one = M.candidateLines([{ user_id: "x", goals: ["g ".repeat(500)], intent: [{ type: "seeking", status: "active", shareable: true, text: "z ".repeat(500) }] }])[0];
  check("one oversized ask and goal are clipped, not passed whole", one.length <= M.DIGEST_CANDIDATE_CHARS && one.includes("…"), one.length);
  check("clipItem folds whitespace and cuts near the cap", M.clipItem("a  b\n\nc") === "a b c" && M.clipItem("word ".repeat(100)).length <= M.DIGEST_ITEM_CHARS);
}

// ---------------------------------------------------------------- 3. the Jev prune reads the same lines
{
  process.env.AI_GATEWAY_API_KEY = "x";
  process.env.JEV_MEMBER = "on";
  delete process.env.JEV_PRUNE;
  const states: any[] = [];
  setJevGatewayForTests(async (state, questions) => {
    states.push(state);
    return Object.fromEntries(Object.keys(questions).map((k) => [k, 0.9]));
  });
  const fill = Array.from({ length: 6 }, (_, i) => ({ user_id: `00000000-0000-4000-8000-${String(2000 + i).padStart(12, "0")}`, goals: [`goal ${i}`], intent: [] }));
  prompts.length = 0;
  sqls.length = 0;
  await M.scoreAgainstStatedAsk(ask, [B, C, D, ...fill], "goals: build climate hardware");
  const listed = JSON.stringify(states.map((s) => s?.candidates ?? {}));
  check("Jev prune ran (7+ candidates)", states.length === 1, states.length);
  check("Jev prune: no private ask, memory or extra field in what goes to the gateway", secretsIn(listed).length === 0, secretsIn(listed));
  check("Jev prune: B's shareable ask is what it reads", listed.includes("intros to climate hardware investors"));
  check("Jev prune: each candidate's line is the one Claude reads", states[0]?.candidates?.c0 === M.candidateLines([B, C, D, ...fill])[0], states[0]?.candidates?.c0);
  check("Claude's prompt after the prune: still none of it", prompts.every((p) => secretsIn(p).length === 0) && prompts.length === 1);
  setJevGatewayForTests(null);
  process.env.JEV_PRUNE = "off";
}

// ---------------------------------------------------------------- 4. pins: no code path puts memory rows on a candidate's line
{
  const m = src("src/services/matching.ts");
  const j = src("src/services/jevMatching.ts");
  check("matching.ts never reads co_memories", !/co_memories/.test(m.replace(/^\s*\/\/.*$/gm, "")));
  check("matching.ts has no database handle at all (it scores what the caller hands it)", !/from "\.\.\/db\/db\.js"/.test(m) && !/\bpool\./.test(m));
  check("jevMatching.ts never reads co_memories or the database", !/co_memories|\bpool\./.test(j.replace(/^\s*\/\/.*$/gm, "")) && !/db\/db\.js/.test(j));
  check("the Jev prune builds its lines with candidateLines, nothing of its own", /candidateLines\(candidates\)/.test(j) && !/formatCandidateDigest|\.intent\b/.test(j.replace(/^\s*\/\/.*$/gm, "")));
  const body = m.slice(m.indexOf("function candidateLine("), m.indexOf("export function candidateLines"));
  const reads = [...new Set([...body.matchAll(/\bc\.(\w+)/g)].map((x) => x[1]))].sort();
  check("a candidate's line reads only goals, blockers, activity likes and intent (through shareableAsks)", JSON.stringify(reads) === JSON.stringify(["activity_preferences", "blockers", "goals", "intent"]), reads);
  check("intent reaches the line only through shareableAsks", /shareableAsks\(c\.intent\)/.test(body) && (body.match(/c\.intent/g) ?? []).length === 1);
  check("formatCandidateDigest takes the candidates and hints only (no memory map)", /export function formatCandidateDigest<T extends ScorableCandidate>\(candidates: T\[\], hints\?: Map<string, string>\): string/.test(m));
  check("every scorer builds its digest with formatCandidateDigest", (m.match(/const digest = formatCandidateDigest\(/g) ?? []).length === 3 && !/const digest = (?!formatCandidateDigest)/.test(m));
}

console.log(`matching member-safe: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
