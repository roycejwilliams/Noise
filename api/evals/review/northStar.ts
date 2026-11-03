// The two numbers (harness/northStar.ts, Royce 2026-10-14): the definitions pinned, the lines checked. Zero tokens, no database.
import { northStarLines, ROOM_SQL, NETWORK_SQL, ENGAGEMENT_SQL, TEST_NUMBER, type NorthStar } from "../../src/harness/northStar.js";
import { readFileSync } from "fs";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
};
const flat = (s: string) => s.replace(/\s+/g, " ");

// ---------------------------------------------------------------- what counts as a connection Cue made
check("room: only Cue's own idea counts (origin 'co'); a pair a member asked for by name is counted apart", /count\(\*\) FILTER \(WHERE f\.origin = 'co'\) AS room/.test(flat(ROOM_SQL)) && /FILTER \(WHERE f\.origin = 'member'\) AS member_asked/.test(flat(ROOM_SQL)));
check("room: only the pair's first introduction (a second intro of the same two people is not a new connection)", /DISTINCT ON \(p\.a_id, p\.b_id\)[\s\S]*ORDER BY p\.a_id, p\.b_id, p\.intro_sent_at/.test(ROOM_SQL));
check("room: both said yes and the intro went out (intro_sent_at)", /p\.intro_sent_at IS NOT NULL/.test(ROOM_SQL));
check("room: never two people already connected before the intro", /NOT EXISTS \(SELECT 1 FROM member_connections mc WHERE mc\.person_a = f\.a_id AND mc\.person_b = f\.b_id AND mc\.created_at < COALESCE\(f\.both_yes_at, f\.intro_sent_at\)/.test(flat(ROOM_SQL)));
check("room: met is met_at; went well is either side saying met_good", /f\.met_at IS NOT NULL/.test(ROOM_SQL) && /f\.a_outcome = 'met_good' OR f\.b_outcome = 'met_good'/.test(ROOM_SQL));
check("network: introduced between real members, not already connected, not already introduced in a room", /n\.introduced_at IS NOT NULL/.test(NETWORK_SQL) && /NOT EXISTS \(SELECT 1 FROM member_connections/.test(NETWORK_SQL) && /NOT EXISTS \(SELECT 1 FROM co_pairs p/.test(NETWORK_SQL));
check("network: only intros whose email went (a claim no send confirmed never counts; one from before claims existed does)", /\(n\.email_sent_at IS NOT NULL OR n\.email_claimed_at IS NULL\)/.test(NETWORK_SQL));
check("real members only: invite-verified (email or not), not archived, not simulated, never a test number", [ROOM_SQL, NETWORK_SQL, ENGAGEMENT_SQL].every((q) => /invite_verified = true/.test(q) && !/identity_captured/.test(q) && /archived_at IS NULL/.test(q) && /is_simulated/.test(q) && q.includes("!~")));
check("the test-number pattern is the fictional 555-01xx range", new RegExp(TEST_NUMBER).test("+14155550192") && new RegExp(TEST_NUMBER).test("+16175550149") && !new RegExp(TEST_NUMBER).test("+14155551234") && !new RegExp(TEST_NUMBER).test("+13105550100x"));

// ---------------------------------------------------------------- 30-day engagement
check("engagement: their own words only (a text or voice memo), never Cue's lines, never a line to a teammate", /'User said:%'/.test(ENGAGEMENT_SQL) && /'User sent a voice memo:%'/.test(ENGAGEMENT_SQL) && !/Co replied/.test(ENGAGEMENT_SQL) && /person_|teammate|\[to /i.test(ENGAGEMENT_SQL) === true);
check("engagement: the cohort is members who joined 30+ days ago; all members reported too", /created_at <= NOW\(\) - INTERVAL '30 days' AS eligible/.test(ENGAGEMENT_SQL) && /AS all_members/.test(ENGAGEMENT_SQL));

// ---------------------------------------------------------------- the lines
const n: NorthStar = { days: 30, connections: { room: 3, network: 1, roomMet: 2, roomGood: 1, memberAsked: 2 }, engagement: { eligible: 25, active30: 18, medianActiveDays: 6, allMembers: 40, allActive30: 31 } };
const lines = northStarLines(n);
check("lines: Cue's connections add room and network, with the funnel and its counts", /: 4 \(3 in a room, 1 between events\)/.test(lines[0]) && /met: 2 of 3/.test(lines[0]) && /went well: 1 of 3/.test(lines[0]), lines[0]);
check("lines: a member's by-name request is shown apart, never counted as Cue's", /Plus 2 a member asked for by name \(not counted as Cue's\)/.test(lines[0]));
check("lines: network meetings say they aren't recorded yet (never shown as zero)", /Between-events meetings aren't recorded yet/.test(lines[0]));
check("lines: engagement as a rate with its counts, both definitions", /72% \(18 of 25\)/.test(lines[1]) && /31 of 40|78% \(31 of 40\)/.test(lines[1]) && /median active days: 6/.test(lines[1]), lines[1]);

// ---------------------------------------------------------------- logging: once a day, team-only, no message and no email of its own
const src = readFileSync(new URL("../../src/harness/northStar.ts", import.meta.url), "utf8");
check("snapshot: logged once a day as metrics.north_star (30 days and all time)", /decision: "metrics\.north_star"/.test(src) && /proposal->>'day' = \$1/.test(src) && /computeNorthStar\(30\), computeNorthStar\(3650\)/.test(src));
check("snapshot: no send of any kind", !/sendblue|sendTeamEmail|resend/i.test(src.replace(/\/\/.*$/gm, "")));
const jobs = readFileSync(new URL("../../src/jobs/index.ts", import.meta.url), "utf8");
check("snapshot: scheduled daily", /m\.recordNorthStar\(\)/.test(jobs));

console.log(`north star: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
