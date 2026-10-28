// What the matching scorer may read about other members (Royce, 2026-10-18; outbound inventory, matching rows): a prompt made
// for one member carries other members' shareable asks and short, clipped profile items, and their private asks and blockers
// only inside a marked hidden part (never mentioned, never cited, never a match's only basis). Never a co_memories row (a call
// transcript, a text exchange, Cue's own record), never another person in the same prompt by name, in any case or accent.
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
  goals: ["raise a seed round for a grid storage startup", "reconnect with Noor about the studio space", "meet noor about her gallery"],
  blockers: ["no technical cofounder yet", "NOOR said yes"],
  activity_preferences: ["trail running", "lunch with zoe on fridays"],
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
const D = { user_id: "00000000-0000-4000-8000-00000000000d", first_name: "Zoë", goals: [], blockers: [], activity_preferences: [], intent: [] };
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
// What the fake scorer answers for each listed candidate; a test may replace it.
let answer = (index: number, _line?: string): Record<string, unknown> => ({ index, score: 80, reason: "internal", share_ask: "S1", hidden_only: false, mutual: false });
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
  const shownLines = linesOf(prompt);
  const results = Array.from({ length: n }, (_, index) => answer(index, shownLines[index] ?? ""));
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
// Rows and fields that never reach any prompt; private asks may, only inside a line's hidden part.
const NEVER = ["transcript", "cueWritten", "longMemory", "extraField"];
const neverIn = (s: string) => secretsIn(s).filter((k) => NEVER.includes(k));
const visible = (line: string) => (line.startsWith(M.HIDDEN_LABEL) ? "" : line.split(` | ${M.HIDDEN_LABEL}`)[0]);
const hiddenOf = (line: string) => (line.startsWith(M.HIDDEN_LABEL) ? line.slice(M.HIDDEN_LABEL.length) : line.split(` | ${M.HIDDEN_LABEL}`)[1] ?? "");
const ask = { id: "a1", type: "seeking" as const, status: "active", text: "a seed investor for climate hardware", embedding: vec };

// ---------------------------------------------------------------- 1. every scoring path, member A asking about B, C, D
{
  prompts.length = 0;
  sqls.length = 0;
  const stated = await M.scoreAgainstStatedAsk(ask, [B, C, D], "goals: build climate hardware");
  const offering = await M.scoreOfferingAgainstCandidates({ ...ask, type: "offering", text: "seed checks for hardware founders" }, [B, C, D]);
  const frame = { asks: [{ ...ask, shareable: true }], goal: { id: "g", type: "seeking" as const, status: "active", text: "a climate hardware company", embedding: vec } };
  const hints = new Map([[B.user_id, 'likely overlap: the asker wants "climate investors" and this person offers "climate investor intros"']]);
  // The room path scores on intent with private asks taken out, and hands them back in `hidden` (eventScoring.ts).
  const strip = (x: typeof B | typeof C | typeof D) => ({ ...x, intent: (x.intent as any[]).filter((i) => i.shareable === true) });
  const roomHidden = new Map([[B.user_id, [SECRET.privateAskB]], [C.user_id, [SECRET.privateAskC]]]);
  const room = await M.scoreAgainstRoomFrame(frame, [strip(B), strip(C), strip(D)], "goals: build climate hardware", hints, roomHidden);
  check("three scoring prompts were sent (stated ask, offering, room frame)", prompts.length === 3, prompts.length);
  for (const [i, p] of prompts.entries()) {
    const label = ["stated ask", "offering", "room frame"][i];
    const lines = linesOf(p);
    check(`${label}: no transcript, Cue-written row, long memory or extra field reaches the prompt`, neverIn(p).length === 0, neverIn(p));
    check(`${label}: no "mentioned:" memory lines and no old private-ask label`, !/mentioned:|private asks \(never shareable\)/i.test(p));
    check(`${label}: one line per candidate`, lines.length === 3, lines);
    check(`${label}: every line within the per-candidate cap (${M.DIGEST_CANDIDATE_CHARS})`, lines.every((l) => l.length <= M.DIGEST_CANDIDATE_CHARS), lines.map((l) => l.length));
    check(`${label}: B's shareable ask is on B's line`, visible(lines[0]).includes('[S1] offering "intros to climate hardware investors"'), lines[0]);
    check(`${label}: B's goal is on B's line`, visible(lines[0]).includes("raise a seed round for a grid storage startup"), lines[0]);
    check(`${label}: private asks and blockers appear only inside the marked hidden part`, secretsIn(lines.map(visible).join("\n")).length === 0 && !visible(lines[0]).includes("no technical cofounder yet"), lines.map(visible));
    if (i < 2) {
      // The network path (decided 2026-10-19, interim): no hidden part at all.
      check(`${label} (network path): no hidden part, no private ask, no blocker anywhere in the prompt`, !p.includes(`${M.HIDDEN_LABEL} `) && secretsIn(p).length === 0 && !p.includes("no technical cofounder yet"), lines);
    } else {
      check(`${label}: B's private ask and blocker are in B's hidden part`, hiddenOf(lines[0]).includes(`private ask "${SECRET.privateAskB}"`) && hiddenOf(lines[0]).includes('going through "no technical cofounder yet"'), lines[0]);
      check(`${label}: C's private ask is in C's hidden part`, hiddenOf(lines[1]).includes(SECRET.privateAskC), lines[1]);
    }
    check(`${label}: the hidden part is capped (${M.DIGEST_HIDDEN_CHARS})`, lines.every((l) => hiddenOf(l).length <= M.DIGEST_HIDDEN_CHARS + 1), lines.map((l) => hiddenOf(l).length));
    check(`${label}: C's shareable ask is on C's line as S1 (numbered over shareable asks only)`, lines[1].includes('[S1] seeking "a seed investor for a ceramics studio"'), lines[1]);
    check(`${label}: C's long goal is clipped to ${M.DIGEST_ITEM_CHARS} chars`, lines[1].includes("open a ceramics studio with a kiln") && lines[1].includes("…") && !lines[1].includes("members' wall ".repeat(3)), lines[1]);
    check(`${label}: D has nothing on file`, lines[2] === "(nothing on file)", lines[2]);
    check(`${label}: B's items naming Noor or Zoë (others in this prompt) are left out, in any case or accent`, !/noor|zoe/i.test(lines[0]), lines[0]);
    check(`${label}: the scorer is told never to mention or cite the hidden part, and asked for hidden_only`, p.includes(M.HIDDEN_RULE) && /"hidden_only": false/.test(p) && /hidden_only: true when the fit rests on the hidden part alone/.test(p));
  }
  check("room frame: the people graph hint still reaches the scorer", linesOf(prompts[2])[0]?.includes("likely overlap: the asker wants"), linesOf(prompts[2])[0]);
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

// ---------------------------------------------------------------- 1b. the name finder (memberSafeMemories.ts nameFinder: whole word, any case, accents folded)
{
  // What reaches the line: Ellis's items that name Noor, Zoë or Sarah Hao, in any case, are left out.
  const line = (items: string[]) => M.candidateLines([
    { user_id: "x", first_name: "Ellis", goals: [...items, "a gallery of my own"], intent: [] },
    { user_id: "n", first_name: "Noor", intent: [] }, { user_id: "z", first_name: "Zoë", intent: [] }, { user_id: "s", first_name: "Sarah Hao", intent: [] }, { user_id: "a", first_name: "Al", intent: [] },
  ])[0];
  check("finds a lowercase name ('meet noor about her gallery')", !/noor/i.test(line(["meet noor about her gallery"])));
  check("finds an uppercase name ('NOOR said yes')", !/noor/i.test(line(["NOOR said yes"])));
  check("finds a name without its accent ('zoe') and with it ('ZOË')", !/zo[eë]/i.test(line(["lunch with zoe", "ZOË called"])));
  check("whole words only ('Noorani', 'also', 'salt' are not names here)", line(["Noorani studio, also salt"]).includes("Noorani studio, also salt"));
  check("a two-word first name is found whole", !/sarah hao/i.test(line(["coffee with sarah hao"])));
  // Review of #274 (2026-10-27): a name that is also a word counts only where it stands for a person.
  const [, priya] = M.candidateLinesWithLabels([
    { user_id: "w", first_name: "Will", intent: [] },
    { user_id: "p", first_name: "Priya", intent: [{ id: "p1", text: "an engineer who will join early", type: "seeking", status: "active", kind: "ask", shareable: true }] as any },
  ]);
  check("a word-name ('Will') never drops another candidate's ask that only uses the word ('who will join early')", priya.line.includes("an engineer who will join early") && priya.labels.has("S1"), priya);
  const [, priya2] = M.candidateLinesWithLabels([
    { user_id: "w", first_name: "Will", intent: [] },
    { user_id: "p", first_name: "Priya", goals: ["coffee with Will about his studio"], intent: [] },
  ]);
  check("... and still drops one that names Will the person", !/Will about his studio/.test(priya2.line), priya2.line);
  // Review of #274's second read: a shorter name inside their own ("Sarah" in "Sarah Hao") is never someone else; an underscore splits.
  const [sh] = M.candidateLinesWithLabels([
    { user_id: "sh", first_name: "Sarah Hao", goals: ["sarah hao studio launch", "coffee with Sarah about her kiln"], intent: [] },
    { user_id: "s", first_name: "Sarah", intent: [] },
  ]);
  check("their own two-word name never reads as the shorter one beside it; naming the other Sarah still drops", sh.line.includes("sarah hao studio launch") && !/kiln/.test(sh.line), sh.line);
  const [sarah] = M.candidateLinesWithLabels([
    { user_id: "s", first_name: "Sarah", goals: ["coffee with Sarah Hao about her studio", "a gallery of my own"], intent: [] },
    { user_id: "sh", first_name: "Sarah Hao", intent: [] },
  ]);
  check("a longer name that holds their own ('Sarah Hao' beside 'Sarah') is still someone else: dropped", !/Hao/.test(sarah.line) && sarah.line.includes("a gallery of my own"), sarah.line);
  const [el] = M.candidateLinesWithLabels([{ user_id: "e", first_name: "Ellis", goals: ["collab with @noor_designs", "a gallery of my own"], intent: [] }, { user_id: "n", first_name: "Noor", intent: [] }]);
  check("an underscore splits a handle ('@noor_designs' names Noor)", !/noor_designs/.test(el.line) && el.line.includes("a gallery of my own"), el.line);
  const lines = M.candidateLines([
    { user_id: "x", first_name: "Ellis", goals: ["meet noor about her gallery", "a gallery of my own"], blockers: ["NOOR said yes"], intent: [] },
    { user_id: "y", first_name: "Noor", goals: ["noor's own goal stays on her line"], intent: [] },
  ]);
  check("an item naming someone else in the prompt is left out; the rest stays", !/noor/i.test(lines[0]) && lines[0].includes("a gallery of my own"), lines[0]);
  check("a candidate's own name never removes their own item", lines[1].includes("noor's own goal stays on her line"), lines[1]);
}

// ---------------------------------------------------------------- 1c. never the only basis, no reason no intro (code, not the prompt)
{
  const cands = [B, C];
  const run = async (a: (i: number) => Record<string, unknown>) => {
    answer = a;
    const r = await M.scoreAgainstStatedAsk(ask, cands as any);
    answer = (index) => ({ index, score: 80, reason: "internal", share_ask: "S1", hidden_only: false, mutual: false });
    return r;
  };
  const hiddenOnly = await run((index) => ({ index, score: 95, reason: "fits", share_ask: "S1", hidden_only: true, mutual: true }));
  check("a fit resting on the hidden part alone gets no share reason, so nothing is proposed", hiddenOnly.length === 2 && hiddenOnly.every((s) => s.shareReason === ""), hiddenOnly.map((s) => s.shareReason));
  const unsaid = await run((index) => ({ index, score: 95, reason: "fits", share_ask: "S1", mutual: true }));
  // With structured outputs (services/structuredJudge.ts) an answer missing a field never reaches the code: the whole answer is refused,
  // which fails closed harder than before (no match at all, so no share reason).
  check("hidden_only missing: the answer is refused (no match, no share reason)", unsaid.length === 0, unsaid);
  const noReason = await run((index) => ({ index, score: 95, reason: "  ", share_ask: "S1", hidden_only: false, mutual: false }));
  check("no reason: no share reason, no intro", noReason.every((s) => s.shareReason === ""));
  const noAsk = await run((index) => ({ index, score: 95, reason: "fits", share_ask: "", hidden_only: false, mutual: false }));
  check("no shared ask named: no share reason", noAsk.every((s) => s.shareReason === ""));
  const ok = await run((index) => ({ index, score: 95, reason: "fits", share_ask: "S1", hidden_only: false, mutual: false }));
  check("a shared ask, a reason, not hidden alone: the share reason is that shared ask word for word", ok[0]?.shareReason === `what they've said they can offer: "intros to climate hardware investors"` && ok[1]?.shareReason === `what they've said they're looking for: "a seed investor for a ceramics studio"`, ok.map((s) => s.shareReason));
  check("a share reason never carries a private ask or blocker, whatever the scorer names", [...hiddenOnly, ...ok].every((s) => !/PRIVATE-ASK|cofounder yet/.test(s.shareReason)));
  check("shareReasonFor: the rules in one place", M.shareReasonFor(B.intent, { reason: "x", share_ask: "S1", hidden_only: false }) !== "" && M.shareReasonFor(B.intent, { reason: "x", share_ask: "S2", hidden_only: false }) === "" && M.shareReasonFor(B.intent, { reason: "", share_ask: "S1", hidden_only: false }) === "" && M.shareReasonFor(B.intent, { reason: "x", share_ask: "S1", hidden_only: "false" }) === "");
}

// ---------------------------------------------------------------- 1d. review of #245: names in shared asks, the asker's own name, labels, stored reasons
{
  const E2 = { ...B, user_id: "00000000-0000-4000-8000-0000000000e2", first_name: "Remy", goals: ["dating Jordan from the club", "open a climate lab"], blockers: [], activity_preferences: [],
    intent: [{ id: "e1", type: "seeking", status: "active", kind: "ask", shareable: true, text: "find Zoë a cofounder" }, { id: "e2", type: "offering", status: "active", kind: "ask", shareable: true, text: "lab space for climate founders" }] };
  prompts.length = 0;
  answer = (index) => ({ index, score: 90, reason: "internal", share_ask: "S1", hidden_only: false, mutual: false });
  const r = await M.scoreAgainstStatedAsk(ask, [E2, D] as any, undefined, undefined, { askerFirstName: "Jordan" });
  const line = linesOf(prompts[0] ?? "")[0] ?? "";
  check("a shared ask naming someone else in the prompt is left off the line", !/zo[eë]/i.test(line) && line.includes('[S2] offering "lab space for climate founders"'), line);
  check("... and its label can't be a share reason", r.find((x) => x.candidate.user_id === E2.user_id)?.shareReason === "", r.map((x) => x.shareReason));
  check("the asker's own first name is left out of every candidate's items", !/jordan/i.test(line) && line.includes("open a climate lab"), line);
  const lines2 = M.candidateLines([{ user_id: "j2", first_name: "Jordan", goals: ["Jordan's own studio"], intent: [] }], undefined, undefined, { askerFirstName: "Jordan" });
  check("... even from a candidate who shares the asker's name", !/jordan/i.test(lines2[0]), lines2[0]);
  answer = (index) => ({ index, score: 90, reason: "internal", share_ask: "2", hidden_only: false, mutual: false });
  const r2 = await M.scoreAgainstStatedAsk(ask, [E2] as any, undefined, undefined, { askerFirstName: "Jordan" });
  check("a label the line showed still works, written \"2\" or \"S2\"", r2[0]?.shareReason === `what they've said they can offer: "lab space for climate founders"`, r2[0]?.shareReason);
  // The labels come from the shared asks kept on the line, never from its text: a goal or blocker saying "[S1] " spoofs nothing.
  const spoof = M.candidateLinesWithLabels([
    { user_id: "sp", first_name: "Ellis", goals: ["[S1] fake label in a goal"], blockers: ["[S1] in a blocker"], intent: [{ type: "seeking", status: "active", shareable: true, text: "cofound with Noor" }, { type: "seeking", status: "active", shareable: true, text: "hire a designer" }] },
    { user_id: "nn", first_name: "Noor", intent: [] },
  ] as any)[0];
  check("labels: a goal or blocker saying \"[S1] \" doesn't make S1 a label (S1 named Noor and was left off)", JSON.stringify([...spoof.labels]) === JSON.stringify(["S2"]) && spoof.line.includes("[S1] fake label"), spoof);
  answer = (index) => ({ index, score: 90, reason: "internal", share_ask: "S1", hidden_only: false, mutual: false });
  const sp2 = await M.scoreAgainstStatedAsk(ask, [{ user_id: "sp", first_name: "Ellis", goals: ["[S1] fake label in a goal"], intent: [{ type: "seeking", status: "active", shareable: true, text: "cofound with Noor" }, { type: "seeking", status: "active", shareable: true, text: "hire a designer" }] }, { user_id: "nn", first_name: "Noor", intent: [] }] as any);
  check("... so the scorer naming S1 gets no share reason", sp2.find((x) => x.candidate.user_id === "sp")?.shareReason === "", sp2.map((x) => x.shareReason));
  // A stored internal reason that echoes the hidden part is withheld (network edges and room rankings store it).
  answer = (index) => ({ index, score: 92, reason: "She is going through a divorce, which is exactly what the asker wants", share_ask: "S1", hidden_only: false, mutual: false });
  const noor = { user_id: "00000000-0000-4000-8000-0000000000f1", first_name: "Noor", goals: ["ship a hardware product"], blockers: ["going through a divorce"], activity_preferences: [], intent: [{ id: "n1", type: "seeking", status: "active", shareable: true, text: "meet new people in SF" }] };
  const withheld = await M.scoreAgainstStatedAsk(ask, [noor] as any);
  check("an internal reason echoing the candidate's blocker is stored as [withheld]", withheld[0]?.reason === M.REASON_WITHHELD, withheld[0]?.reason);
  const roomW = await M.scoreAgainstRoomFrame({ asks: [{ ...ask, shareable: true }], goal: null }, [{ ...noor, blockers: [] }] as any, undefined, undefined, new Map([[noor.user_id, ["a divorce lawyer who won't gossip"]]]));
  check("... and one echoing a private ask handed in by the room path", roomW[0]?.reason === M.REASON_WITHHELD, roomW[0]?.reason);
  answer = (index) => ({ index, score: 92, reason: "Strong hardware background fits the ask", share_ask: "S1", hidden_only: false, mutual: false });
  const kept = await M.scoreAgainstStatedAsk(ask, [noor] as any);
  check("a reason that doesn't echo it is kept", kept[0]?.reason === "Strong hardware background fits the ask", kept[0]?.reason);
  // The network sweep stores that reason, never the echo (relevance.ts logRelevanceEdges), and passes the asker's name.
  const Rel = await import("../../src/services/relevance.js");
  const realQ = (pool as any).query;
  const inserts: any[][] = [];
  (pool as any).query = async (sql: string, p: any[] = []) => {
    if (/FROM co_profiles WHERE user_id = \$1/.test(sql) && /long_term_direction/.test(sql)) return { rows: [{ intent: [{ id: "a1", type: "seeking", status: "active", shareable: true, text: "someone who has been through a divorce", embedding: [0.1, 0.2] }], goals: [], blockers: [] }] };
    if (/ORDER BY dist/.test(sql)) return { rows: [{ ...noor, goals: ["dating Jordan from the club"] }] };
    if (/SELECT first_name FROM users WHERE id = \$1/.test(sql)) return { rows: [{ first_name: "Jordan" }] };
    if (/INSERT INTO relevance_edges/.test(sql)) { inserts.push(p); return { rows: [] }; }
    return realQ(sql, p);
  };
  prompts.length = 0;
  answer = (index) => ({ index, score: 92, reason: "She is going through a divorce, which is exactly what the asker wants", share_ask: "S1", hidden_only: false, mutual: false });
  await Rel.sweepAskAgainstNetwork("A");
  (pool as any).query = realQ;
  check("network sweep: the stored match_reason is [withheld], not the echo", inserts[0]?.[5]?.[0] === M.REASON_WITHHELD, inserts[0]?.[5]);
  check("network sweep: the asker's name never reaches their own prompt", prompts.length === 1 && !/jordan/i.test(digestOf(prompts[0])), digestOf(prompts[0] ?? ""));
  // The reviewer's case, with a scorer that matches on what it is shown: A wants someone who has been through a divorce; Noor's
  // only shared ask is "meet new people in SF" and her blocker is the divorce. The network path shows no hidden part, so nothing
  // the scorer sees fits, and no edge with a share reason forms: no intro.
  const overlap = (a: string, b: string) => { const w = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((x) => x.length > 3)); const A = w(a); return [...w(b)].filter((x) => A.has(x)).length; };
  const ASK = "someone who has been through a divorce and come out the other side";
  answer = (index, l) => { const hit = overlap(ASK, l ?? ""); return { index, score: Math.min(100, hit * 45), reason: hit ? "fits" : "", share_ask: hit ? "S1" : "", hidden_only: false, mutual: false }; };
  const inserts2: any[][] = [];
  (pool as any).query = async (sql: string, p: any[] = []) => {
    if (/FROM co_profiles WHERE user_id = \$1/.test(sql) && /long_term_direction/.test(sql)) return { rows: [{ intent: [{ id: "a1", type: "seeking", status: "active", shareable: true, text: ASK, embedding: [0.1, 0.2] }], goals: [], blockers: [] }] };
    if (/ORDER BY dist/.test(sql)) return { rows: [noor] };
    if (/SELECT first_name FROM users WHERE id = \$1/.test(sql)) return { rows: [{ first_name: "Jordan" }] };
    if (/INSERT INTO relevance_edges/.test(sql)) { inserts2.push(p); return { rows: [] }; }
    return realQ(sql, p);
  };
  prompts.length = 0;
  await Rel.sweepAskAgainstNetwork("A");
  (pool as any).query = realQ;
  check("network (decided (c)): the reviewer's divorce case shows the scorer nothing of the divorce", prompts.length === 1 && !/divorce/i.test(digestOf(prompts[0])), digestOf(prompts[0] ?? ""));
  check("network (decided (c)): ... and produces no edge with a share reason, so no intro", !inserts2.some((p) => (p[7] ?? []).some((x: string) => x)), inserts2);
  answer = (index) => ({ index, score: 80, reason: "internal", share_ask: "S1", hidden_only: false, mutual: false });
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
  const secrets = M.candidateLines([{ user_id: "h", intent: Array.from({ length: 5 }, (_, k) => ({ type: "seeking", status: "active", shareable: false, text: `private ask ${k} ${"q".repeat(90)}` })), blockers: Array.from({ length: 3 }, (_, k) => `blocker ${k} ${"b".repeat(90)}`) }])[0];
  check(`a long hidden part is capped at ${M.DIGEST_HIDDEN_CHARS} chars, newest private ask first`, hiddenOf(secrets).length <= M.DIGEST_HIDDEN_CHARS + 1 && hiddenOf(secrets).includes("private ask 4 ") && !hiddenOf(secrets).includes("private ask 0 "), hiddenOf(secrets).length);
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
  check("Jev prune: no private ask, blocker, memory or extra field in what goes to the gateway", secretsIn(listed).length === 0 && !listed.includes("no technical cofounder yet") && !listed.includes(M.HIDDEN_LABEL), secretsIn(listed));
  check("Jev prune: B's shareable ask is what it reads", listed.includes("intros to climate hardware investors"));
  check("Jev prune: the asker's name is passed to the prune's lines", /candidateLines\(candidates, undefined, undefined, \{ withHidden: false, askerFirstName \}\)/.test(src("src/services/jevMatching.ts")) && (src("src/services/matching.ts").match(/jevMatchScores\([^)]*, candidates, opts\.askerFirstName\)/g) ?? []).length === 2);
  check("Jev prune: each candidate's line is Claude's line without its hidden part", states[0]?.candidates?.c0 === visible(M.candidateLines([B, C, D, ...fill])[0]) && states[0]?.candidates?.c0 === M.candidateLines([B, C, D, ...fill], undefined, undefined, { withHidden: false })[0], states[0]?.candidates?.c0);
  check("Claude's prompt after the prune: no memory row or extra field", prompts.every((p) => neverIn(p).length === 0) && prompts.length === 1);
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
  check("the Jev prune builds its lines with candidateLines without the hidden part, nothing of its own", /candidateLines\(candidates, undefined, undefined, \{ withHidden: false, askerFirstName \}\)/.test(j) && !/formatCandidateDigest|\.intent\b|\.blockers\b/.test(j.replace(/^\s*\/\/.*$/gm, "")));
  const body = m.slice(m.indexOf("function candidateLine("), m.indexOf("export function candidateLines"));
  const reads = [...new Set([...body.matchAll(/\bc\.(\w+)/g)].map((x) => x[1]))].sort();
  check("a candidate's line reads only goals, blockers, activity likes and intent (through shareableAsks)", JSON.stringify(reads) === JSON.stringify(["activity_preferences", "blockers", "goals", "intent"]), reads);
  check("intent reaches the line only through shareableAsks (shown) and privateAskTexts (hidden part)", /shareableAsks\(c\.intent\)/.test(body) && /privateAskTexts\(c\.intent\)/.test(body) && (body.match(/c\.intent/g) ?? []).length === 2);
  check("blockers reach the line only in the hidden part", (body.match(/c\.blockers/g) ?? []).length === 1 && /safe\(c\.blockers\)\.map\(\(x\) => `going through/.test(body));
  check("formatCandidateDigest takes the candidates, hints and the hidden map only (no memory map)", /export function formatCandidateDigest<T extends ScorableCandidate>\(candidates: T\[\], hints\?: Map<string, string>, hidden\?: Map<string, string\[\]>, askerFirstName\?: string\): string/.test(m));
  check("every scored candidate's share reason goes through shareReasonFor, and only on a label the line showed", /shareReason: shown\[r\.index\]\?\.labels\.has\(label\) \? shareReasonFor\(c\.intent, \{ \.\.\.r, reason: said \}\) : "",/.test(m) && !/shareReason: shareReasonFromOwnAsk/.test(m));
  check("every scorer hands runAskScoring the lines it showed", (m.match(/runAskScoring\("matching\.\w+", [^\n]*, (toScore|candidates), lines(, hidden)?(, \{[^\n]*\})?\);/g) ?? []).length === 3, m.match(/runAskScoring\([^\n]*/g));
  check("the room's stored ranking reason is the scorer's reason as runAskScoring returns it", /reason: s\.reason,/.test(src("src/services/eventScoring.ts")) && /loggable\.map\(\(s\) => s\.reason\)/.test(src("src/services/relevance.ts")));
  check("the ask check-in counts only edges with a share reason as possible leads", /WHERE status = 'open' AND share_reason IS NOT NULL AND share_reason <> ''\n\s*GROUP BY person_id, ask_id/.test(src("src/jobs/index.ts")));
  check("every scorer builds its digest from candidateLines, with the asker's name", (m.match(/const lines = candidateLinesWithLabels\((toScore|candidates), (hints|undefined), (hidden|undefined), \{ askerFirstName: opts\.askerFirstName(, withHidden: false)? \}\);\n\s*const digest = lines\.map\(\(l, i\) => `\$\{i\}\. \$\{l\.line\}`\)\.join\("\\n"\);/g) ?? []).length === 3 && !/const digest = (?!lines\.map)/.test(m));
  check("the two network scorers get no hidden part; the room scorer does", (m.match(/candidateLinesWithLabels\((toScore|candidates), (hints|undefined), undefined, \{ askerFirstName: opts\.askerFirstName, withHidden: false \}\)/g) ?? []).length === 2 && /candidateLinesWithLabels\(toScore, hints, hidden, \{ askerFirstName: opts\.askerFirstName \}\)/.test(m));
}

console.log(`matching member-safe: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
