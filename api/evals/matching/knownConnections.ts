// Relationship-aware matching (Royce, 2026-11-02): Cue never introduces two people who already know each other as strangers. One
// check (services/knownConnections.ts alreadyConnected) in all three matching paths, before the tease and again right before any
// send, queued and deferred work included. Layer 1: isolated fixtures on an in-memory store, zero tokens, nothing sent. Invented
// people only.
//   npx tsx evals/matching/knownConnections.ts
import { readFileSync } from "fs";

process.env.SENDBLUE_API_API_KEY ||= "ci";
process.env.SENDBLUE_API_API_SECRET ||= "ci";
process.env.ANTHROPIC_API_KEY ||= "ci";
process.env.OPENAI_API_KEY ||= "ci";
process.env.DATABASE_URL = "postgres://ci:ci@127.0.0.1:1/ci";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `  :: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const JORDAN = "00000000-0000-4000-8000-0000000000a1";
const ELLIS = "00000000-0000-4000-8000-0000000000b2";
const ELLIS2 = "00000000-0000-4000-8000-0000000000b3";
const NOOR = "00000000-0000-4000-8000-0000000000c3";
const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

// ---------------------------------------------------------------- the fake store
const world = {
  // The connection read's answer per pair (the real SQL is checked on its own below).
  rows: new Map<string, Record<string, boolean>>(),
  facts: [] as any[],
  told: [] as { id: number; event_id: string; other_id: string; first_name: string }[],
  users: new Map<string, { first_name: string; last_name: string | null }>([
    [ELLIS, { first_name: "Ellis", last_name: "Park" }],
    [ELLIS2, { first_name: "Ellis", last_name: "Grant" }],
    [NOOR, { first_name: "Noor", last_name: "Haddad" }],
  ]),
  decisions: [] as any[],
};
const { default: pool } = await import("../../src/db/db.js");
(pool as any).query = async (sql: string, p: any[] = []) => {
  if (/^SELECT\s+EXISTS \(SELECT 1 FROM co_pairs WHERE a_id = \$1 AND b_id = \$2 AND intro_sent_at IS NOT NULL\) AS introduced_room/.test(sql.trim())) return { rows: [world.rows.get(`${p[0]}|${p[1]}`) ?? {}] };
  if (/INSERT INTO co_facts/.test(sql)) {
    world.facts.push({ owner: p[0], relation: p[2], label: p[3], meta: JSON.parse(p[9]) });
    return { rows: [] };
  }
  if (/FROM co_facts WHERE owner_user_id = \$1 AND relation = 'already_knows' AND retired_at IS NULL/.test(sql)) {
    const hit = world.facts.find((f) => f.owner === p[0] && (p[1] ? f.meta.otherId === p[1] : !f.meta.otherId && f.meta.name.toLowerCase() === String(p[2]).toLowerCase() && String(f.meta.lastName ?? "").toLowerCase() === String(p[3]).toLowerCase()));
    return { rows: hit ? [{ x: 1 }] : [] };
  }
  if (/FROM co_pairs p JOIN users u ON u\.id = CASE WHEN p\.a_id = \$1/.test(sql)) return { rows: world.told };
  if (/SELECT id, first_name, last_name FROM users WHERE id = ANY/.test(sql)) return { rows: (p[0] as string[]).filter((id) => world.users.has(id)).map((id) => ({ id, ...world.users.get(id) })) };
  if (/INSERT INTO decisions|recordDecision/i.test(sql)) return { rows: [] };
  return { rows: [] };
};
const K = await import("../../src/services/knownConnections.js");
const RM = await import("../../src/services/roomMatching.js");
const NI = await import("../../src/services/networkIntroNudge.js");
const MG = await import("../../src/harness/matchGate.js");
const CL = await import("../../src/services/callLearning.js");

// ---------------------------------------------------------------- 1. strangers
{
  check("strangers: nothing on record, not connected", (await K.alreadyConnected(JORDAN, NOOR)).known === false);
  check("strangers: the room may ask", (await RM.mayAsk("ev-1", JORDAN, NOOR, "test")) === null);
  check("strangers: a deferred network ask may go", (await NI.networkAskStale(JORDAN, NOOR)) === null);
  check("one person is never connected to themself (no read)", (await K.alreadyConnected(JORDAN, JORDAN)).known === false);
}

// ---------------------------------------------------------------- 2. a prior intro, in each of the three paths
{
  world.rows.set(key(JORDAN, ELLIS), { introduced_network: true });
  check("an intro Cue completed (network): connected", (await K.alreadyConnected(JORDAN, ELLIS)).known === true);
  check("room path: no nudge, offer or direct ask between them", /already connected/.test(String(await RM.mayAsk("ev-2", JORDAN, ELLIS, "test"))));
  check("room path, right before the send: stale", /already connected/.test(String(await RM.directAskStale("ev-2", ELLIS, JORDAN))));
  const facts = await MG.gatherNetworkFacts(JORDAN, ELLIS, "seed investors for climate hardware");
  check("network path (queue and reveal): the gate says no", facts.alreadyConnected !== null && MG.evaluateNetworkCandidate(facts).checks.some((c) => c.name === "not_already_connected" && !c.pass));
  check("network path, right before a deferred ask: stale", /already connected/.test(String(await NI.networkAskStale(ELLIS, JORDAN))));
  check("the same row from an event intro or a connection on record counts too", K.connectionFrom({ introduced_room: true }).known && K.connectionFrom({ connected: true }).known);
  check("the network intro being sent right now doesn't block its own email", !K.connectionFrom({ introduced_network: true }, { exceptNetwork: true }).known && K.connectionFrom({ introduced_network: true, connected: true }, { exceptNetwork: true }).known);
  check("outside-event matching goes through the same room check (scoreMatchedGroup -> mayAsk)", /await scoreMatchedGroup\(eventId, mention\.event_name_raw, matched, null\)/.test(src("src/services/eventMatching.ts")) && /RM\.mayAsk\(eventId, person\.user_id, candidate\.user_id, "eventScoring\.matchNudge"\)/.test(src("src/services/eventScoring.ts")));
  check("a block tells nobody why: the reason stays in the decision log", !/sendReply|addInstruction/.test(src("src/services/knownConnections.ts")));
  world.rows.clear();
}

// ---------------------------------------------------------------- 3. a personal invite vs a forwarded link
{
  check("a referral naming the other person: connected (personal invite)", K.connectionFrom({ referral: true }).known && (K.connectionFrom({ referral: true }) as any).kind === "personal_invite");
  check("a vouch: connected (personal invite)", K.connectionFrom({ vouched: true }).known);
  check("joining through someone's invite link (nothing else): not connected", !K.connectionFrom({}).known);
  const sql = K.CONNECTION_SQL;
  check("the read never counts an invite link's maker (created_by): a forwarded link proves nothing", !/created_by/.test(sql) && /c\.vouched_by = \$1 AND c\.used_by = \$2/.test(sql));
  check("a referral matches only the other person's own email or phone (last 10 digits, at least 10)", /lower\(trim\(r\.recipient\)\) = lower\(o\.email\)/.test(sql) && /length\(regexp_replace\(r\.recipient, '\\D', '', 'g'\)\) >= 10/.test(sql));
}

// ---------------------------------------------------------------- 4. "want to meet X" vs "X and I work together"
{
  const transcript = ["assistant: Anyone you're hoping to meet?", "user: I'd love to meet Ellis at some point.", "assistant: And Noor?", "user: Oh, Noor and I work together, I see her every day."].join("\n");
  const theirs = CL.theirLines(transcript);
  // The model reads what the words mean (never a regex). Both reads say plainly that wanting to meet is the opposite; code checks only
  // that what comes back is quoted from their own words.
  const read = K.alreadyKnowFrom({ already_know: [{ name: "Noor", last_name: null, quote: "Noor and I work together" }] }, theirs);
  check("a read with 'Noor and I work together' is kept, quoted from their line", read.length === 1 && read[0].name === "Noor");
  check("a quote from Cue's line is dropped", K.alreadyKnowFrom({ already_know: [{ name: "Noor", quote: "Anyone you're hoping to meet" }] }, theirs).length === 0);
  check("a quote that isn't in their words is dropped (no invented statement)", K.alreadyKnowFrom({ already_know: [{ name: "Ellis", quote: "Ellis and I work together" }] }, theirs).length === 0);
  check("the rule: wanting to meet is never knowing", /someone they want to meet \("I'd love to meet Ellis"\), ask about, or only mention is never one/.test(K.ALREADY_KNOW_RULE));
  const tl = src("src/services/turnLearning.ts");
  check("texts: the post-turn read carries the rule (after the preferences item: 10 or 11) and saves from THIS message only, source text", /\$\{o\.preferences \? 11 : 10\}\. already_know, from their LAST message only: \$\{ALREADY_KNOW_RULE\}/.test(tl) && /saveAlreadyKnow\(input\.userId, alreadyKnowFrom\(raw, input\.message\), "text"\)/.test(tl) && /\$\{ALREADY_KNOW_JSON\}/.test(tl));
  check("calls (GPT-Live post-call read): preferences 7, introductions 8 when any, already_know last (8 or 9), on every call, source call", /\n7\. [\s\S]*\n8\. already_know[\s\S]*"already_know": \[/.test(CL.callLearningPrompt({ transcript: "x", today: "2026-11-02", onFile: null, openAsks: [] })) && /8\. introductions[\s\S]*9\. already_know/.test(CL.callLearningPrompt({ transcript: "x", today: "2026-11-02", onFile: null, openAsks: [], introduced: ["Ellis"] })) && /saveAlreadyKnow\(input\.userId, alreadyKnowFrom\(raw, theirLines\(input\.transcript\)\), "call"\)/.test(src("src/services/callLearning.ts")));
  check("no new reply tool (the reply request is unchanged)", !/noteAlreadyKnow/.test(src("src/agent/conversationTools.ts")) && !/noteAlreadyKnow/.test(src("src/services/capabilities.ts")));
}

// ---------------------------------------------------------------- 5. same name is not the same member
{
  const named = [
    { otherId: ELLIS, firstName: "Ellis", lastName: "Park" },
    { otherId: ELLIS2, firstName: "Ellis", lastName: "Grant" },
    { otherId: NOOR, firstName: "Noor", lastName: "Haddad" },
  ];
  check("two Ellises Cue named: 'Ellis' alone is nobody", K.resolveNamed(named, "Ellis") === null);
  check("with a last name: the one Ellis", K.resolveNamed(named, "Ellis", "Grant")?.otherId === ELLIS2);
  check("one Noor: resolved", K.resolveNamed(named, "Noor")?.otherId === NOOR);
  // Cue told Jordan about Ellis Park only; Jordan says he works with "Ellis": resolved to the Ellis Cue named.
  world.told = [{ id: 1, event_id: "ev-3", other_id: ELLIS, first_name: "Ellis" }];
  await K.noteAlreadyKnow(JORDAN, { name: "Ellis", theirWords: "Ellis and I work together", source: "text" });
  check("said about someone Cue named to them: resolved to that member", world.facts.at(-1)?.meta.otherId === ELLIS && world.facts.at(-1)?.relation === "already_knows");
  // A first name Cue never named to them: kept as said, blocks nobody (the read matches a name only with a last name, and only one member).
  world.told = [];
  await K.noteAlreadyKnow(JORDAN, { name: "Sam", theirWords: "Sam and I go way back", source: "text" });
  check("a first name Cue never named: kept by name, no member", world.facts.at(-1)?.meta.otherId === null && world.facts.at(-1)?.meta.name === "Sam");
  const sql = K.CONNECTION_SQL;
  check("a name-only statement blocks only with a last name, and only the one member with that full name", /COALESCE\(f\.meta->>'lastName', ''\) <> ''/.test(sql) && /d\.archived_at IS NULL\) = 1\) AS said_by_name/.test(sql));
  const n = world.facts.length;
  await K.noteAlreadyKnow(JORDAN, { name: "Ellis", theirWords: "yeah I know Ellis", source: "call" });
  world.told = [{ id: 1, event_id: "ev-3", other_id: ELLIS, first_name: "Ellis" }];
  const before = world.facts.length;
  await K.noteAlreadyKnow(JORDAN, { name: "Ellis", theirWords: "yeah I know Ellis", source: "call" });
  check("said twice (the live call tool and the call's read): kept once", world.facts.length === before && n <= before);
  check("the answer is the same whether or not the person is a member (no 'not a member' path)", !/not a member|isn't a member|no such member/i.test(src("src/services/knownConnections.ts") + src("src/agent/conversationTools.ts").match(/noteAlreadyKnow: tool\([\s\S]*?\n    \}\),/)?.[0]));
  world.told = [];
}

// ---------------------------------------------------------------- 6. a connection added while a match is queued
{
  // Queued: Jordan's direct ask about Noor waits (deferred), a network ask waits, an in-room nudge sits in the proactive queue.
  check("queued: nothing on record yet, it would go", (await RM.directAskStale("ev-4", JORDAN, NOOR)) === null && (await NI.networkAskStale(JORDAN, NOOR)) === null);
  // Then Noor tells Cue "Jordan and I already know each other" (resolved), which the read now returns.
  world.rows.set(key(JORDAN, NOOR), { said: true });
  check("after 'we already know each other': the deferred room ask is stale", /already connected/.test(String(await RM.directAskStale("ev-4", JORDAN, NOOR))));
  check("...the deferred network ask is stale", /already connected/.test(String(await NI.networkAskStale(JORDAN, NOOR))));
  check("...the network reveal's gate says no", MG.evaluateNetworkCandidate(await MG.gatherNetworkFacts(JORDAN, NOOR, "x")).checks.some((c) => c.name === "not_already_connected" && !c.pass));
  const reg = src("src/harness/proactiveRegistry.ts");
  check("...a queued in-room nudge is rechecked when it's drafted", /knownReason\(c\.userId, p\.candidateId, "proactive\.eventMatchNudge"\)/.test(reg));
  const ds = src("src/services/deferredSends.ts");
  check("...the deferred runner rechecks with these same functions at send time", /mayAsk\(/.test(ds) && /directAskStale\(/.test(ds) && /networkAskStale\(/.test(ds));
  const h = src("src/services/eventGuestMatchHandoff.ts");
  check("...both intro emails recheck right before sending (room: final, never retried)", /alreadyConnected\(a\.user_id, b\.user_id\)/.test(h) && /noteIntroFailed\(eventId, a\.user_id, b\.user_id, "already connected", true\)/.test(h) && /alreadyConnected\(a\.user_id, b\.user_id, \{ exceptNetwork: true \}\)/.test(src("src/services/networkIntroNudge.ts")));
  check("double opt-in stays: a known pair adds a no, never a yes", !/both_yes|a_answer|b_answer|interested_at/.test(src("src/services/knownConnections.ts")));
  world.rows.clear();
}

console.log(`known connections: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
