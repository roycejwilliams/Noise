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
  pairs: [] as any[],
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
  if (/^SELECT \* FROM co_pairs WHERE a_id = \$1 AND b_id = \$2/.test(sql)) return { rows: world.pairs.filter((r) => r.a_id === p[0] && r.b_id === p[1]) };
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
  // Cue named exactly one Ellis (Ellis Park) to Jordan; "Ellis and I work together" still ties to nobody: a first name alone never does.
  world.told = [{ id: 1, event_id: "ev-3", other_id: ELLIS, first_name: "Ellis" }];
  await K.noteAlreadyKnow(JORDAN, { name: "Ellis", theirWords: "Ellis and I work together", source: "text" });
  check("a first name alone ties to nobody, even when Cue named exactly one Ellis", world.facts.at(-1)?.meta.otherId === null && world.facts.at(-1)?.meta.name === "Ellis", world.facts.at(-1));
  await K.noteAlreadyKnow(JORDAN, { name: "Ellis", lastName: "Park", theirWords: "Ellis Park and I work together", source: "text" });
  check("the full name of someone Cue named: tied to that member", world.facts.at(-1)?.meta.otherId === ELLIS);
  await K.noteAlreadyKnow(NOOR, { name: "Jordan", theirWords: "yes! Jordan and I already work together", source: "text", otherId: JORDAN });
  check("explicit context (their reply to Cue's question about that person): tied to that member", world.facts.at(-1)?.meta.otherId === JORDAN);
  world.told = [];
  await K.noteAlreadyKnow(JORDAN, { name: "Sam", theirWords: "Sam and I go way back", source: "text" });
  check("a first name Cue never named: kept by name, no member", world.facts.at(-1)?.meta.otherId === null && world.facts.at(-1)?.meta.name === "Sam");
  const sql = K.CONNECTION_SQL;
  check("at check time a name-only statement blocks only with a last name, and only the one active member with that full name", /COALESCE\(f\.meta->>'lastName', ''\) <> ''/.test(sql) && /d\.archived_at IS NULL\) = 1\) AS said_by_name/.test(sql));
  const before = world.facts.length;
  await K.noteAlreadyKnow(JORDAN, { name: "Sam", theirWords: "Sam and I go way back", source: "call" });
  check("said twice (the post-turn read and the call's read): kept once", world.facts.length === before);
  check("the answer is the same whether or not the person is a member (no 'not a member' path)", !/not a member|isn't a member|no such member/i.test(src("src/services/knownConnections.ts")));
}

// ---------------------------------------------------------------- 5b. "yes! Maya and I already work together" (the race)
{
  check("the reply read: a yes that says they already know them", (await K.saysAlreadyKnow("Maya", "yes! Maya and I already work together", async () => "yes")) === true);
  check("the reply read: a plain yes is no", (await K.saysAlreadyKnow("Maya", "yes please, I'd love to meet her", async () => "no")) === false);
  check("the reply read fails: no (the yes goes on as before; the post-turn read still keeps what they said)", (await K.saysAlreadyKnow("Maya", "yes", async () => { throw new Error("down"); })) === false);
  check("the read's prompt: wanting to meet or saying yes is not knowing", /Wanting to meet Maya, being curious about them, or saying yes to the intro is not knowing them/.test(K.alreadyKnowReplyPrompt("Maya", "yes")));
  const sb = src("src/routes/sendblue.ts");
  const read = sb.indexOf("saysAlreadyKnow(pendingMatchNudge.candidate_first_name, resolvedContent)");
  const act = sb.indexOf("await handleMatchNudgeReply(");
  check("room: read BEFORE the yes is acted on (handleMatchNudgeReply, the direct ask, the email)", read > 0 && act > read);
  check("room: a yes that already knows them becomes a decline, kept against that person", /if \(alreadyKnew\) \{\s*classification = "not_interested";/.test(sb) && /source: "text", otherId: pendingMatchNudge\.candidate_id/.test(sb));
  check("room: only for a named intro (never an anonymous heads-up or an additive offer)", /pendingMatchNudge\.kind !== "additive" && !pendingMatchNudge\.anonymous/.test(sb));
  const nRead = sb.indexOf("saysAlreadyKnow(introCandidate.first_name, resolvedContent)");
  check("network: read before resolveNetworkIntroReply, declined, kept", nRead > 0 && sb.indexOf("const resolved = await resolveNetworkIntroReplyState(", nRead) > nRead && /if \(alreadyKnewIntro\) \{\s*classification = "not_interested";/.test(sb));
  check("network: an 'already know' decline is recorded as known (no_signal), never as a 'declined' preference", /alreadyKnewIntro \? "no_signal" : classification === "interested" \? "interested" : "declined"/.test(sb) && /\(they already know each other\)/.test(sb));
  check("the reply says nothing about the other side", /Don't say anything about \$\{other\}'s side\./.test(sb));
}

// ---------------------------------------------------------------- 5c. an intro the member asked for by name (a reconnection)
{
  const [a, b] = JORDAN < NOOR ? [JORDAN, NOOR] : [NOOR, JORDAN];
  world.rows.set(key(JORDAN, NOOR), { said: true });
  world.pairs = [{ event_id: "ev-5", a_id: a, b_id: b, origin: "member", state: "asked", declined_at: null, intro_sent_at: null, a_answer: null, b_answer: null, value_verdict: null, blocked_reason: null, created_at: new Date() }];
  check("member-requested: known, still asked of the other side (double opt-in applies)", (await RM.mayAsk("ev-5", NOOR, JORDAN, "test")) === null && (await RM.directAskStale("ev-5", NOOR, JORDAN)) === null);
  world.pairs[0].origin = "co";
  check("Cue's own suggestion for the same known pair: refused", /already connected/.test(String(await RM.mayAsk("ev-5", NOOR, JORDAN, "test"))));
  check("memberAsked is per event", RM.memberAsked([{ event_id: "ev-5", origin: "member" }], "ev-6") === false);
  const h = src("src/services/eventGuestMatchHandoff.ts");
  check("a refused ask is never reported as requested", /if \(await RM\.mayAsk\(eventId, candidate\.user_id, asker\.user_id, "eventGuestMatchHandoff\.directAsk"\)\) return false;/.test(h) && /return \(await maybeAskCandidateDirectly\(eventId, eventName, requester\.first_name, target, requester\)\) !== false;/.test(h));
  check("the intro email exempts a member's own request too", /const connected = sentBefore \|\| memberAsked \? null/.test(h));
  world.pairs = [];
  world.rows.clear();
}

// ---------------------------------------------------------------- 5d. visible knowledge: shown (no name), removable, really removed
{
  const W = await import("../../src/services/whatCoKnows.js");
  const raw: any = { profile: null, claims: [], snapshot: null, threads: [], kit: [], tastes: [], asks: [], files: [], alreadyKnows: [{ id: "7", on: "2026-11-02", quote: "Noor and I work together" }] };
  const items = W.knownItems(raw).filter((i: any) => i.source === "knows");
  check("what Cue knows shows it, their words with it, no name in Cue's line", items.length === 1 && /someone you told me you already know \(2026-11-02\)/.test(items[0].text) && !/Noor/.test(items[0].text) && items[0].theirWords === "Noor and I work together");
  check("removable only", items[0].canCorrect === false && W.fieldFor("knows:7") === "someone they already know");
  const sqls: string[] = [];
  const db = { query: async (sql: string) => (sqls.push(sql), { rows: [], rowCount: 1 }) };
  const r: any = await W.applyOne(db as any, JORDAN, raw, items[0], "remove", null, "forget that I know her");
  check("removing retires it at its source, theirs only", r.source === "knows" && /UPDATE co_facts SET retired_at = NOW\(\) WHERE id = \$2 AND owner_user_id = \$1 AND relation = 'already_knows' AND retired_at IS NULL/.test(sqls[0]));
  check("...and the check reads only facts not retired (so matching can introduce them again)", (K.CONNECTION_SQL.match(/f\.relation = 'already_knows' AND f\.retired_at IS NULL/g) ?? []).length === 2);
  // The real SQL is not run in layer 1 (no local Postgres): it was run read-only against dev's schema by hand (see the PR).
  console.log("SKIP CONNECTION_SQL against a real Postgres: no local database in layer 1; run read-only on dev's schema by hand (PR #359)");
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
