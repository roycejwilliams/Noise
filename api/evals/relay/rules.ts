// Model-free checks for passing messages between members and reminders
// (services/relay.ts). Every guard behind the top rule: one member's info
// never reaches another's conversation without their yes.
//
//   npx tsx evals/relay/rules.ts
import { readFileSync } from "fs";
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const R = await import("../../src/services/relay.js");

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// Off by default
check("off unless CO_RELAY=on", !R.relayEnabled({} as any) && !R.relayEnabled({ CO_RELAY: "true" } as any) && R.relayEnabled({ CO_RELAY: "on" } as any));
{
  const saved = process.env.CO_RELAY;
  delete process.env.CO_RELAY;
  const { ABILITIES } = await import("../../src/services/capabilities.js");
  const a = ABILITIES.find((x) => x.id === "relay")!;
  check("while off, Co says it can't pass messages yet", /can't pass messages to other people or other members yet/.test(a.can));
  process.env.CO_RELAY = "on";
  check("once on, Co says exactly what it can and can't do", /already connected to through Co/.test(a.can) && /never says whether someone is a member/.test(a.can) && /never starts a group text/.test(a.can) && /never contacts anyone on its own/.test(a.can));
  if (saved === undefined) delete process.env.CO_RELAY;
  else process.env.CO_RELAY = saved;
}

// Only connected people, and nothing about membership
const conns = [
  { userId: "1", firstName: "Jordan", source: "introduced" as const },
  { userId: "2", firstName: "Ellis", source: "team" as const },
  { userId: "3", firstName: "Ellis Park", source: "introduced" as const },
];
check("a connected person is found by first name", (() => { const r = R.matchConnection("jordan", conns); return r.ok && r.person.userId === "1"; })());
check("someone they're not connected to can't be reached", !R.matchConnection("Noor", conns).ok && (R.matchConnection("Noor", conns) as any).reason === "not_reachable");
check("two connections with the same name: ask which, never guess", (R.matchConnection("Ellis", conns) as any).reason === "ambiguous");
check("an unreachable person gets one answer that never says whether they're a member", /can't reach this person, and must not say whether they're a member/.test(R.NOT_REACHABLE));
const rs = src("services/relay.ts");
check("people are resolved only among their own connections, never by searching members", /export async function connectionsFor\(userId: string\)/.test(rs) && /matchConnection\(opts\.to, await connectionsFor\(opts\.fromUserId\)\)/.test(rs) && !/FROM users WHERE (lower\()?first_name/i.test(rs));
check("connections are introductions after both said yes, or two team members", /status = 'introduced'/.test(rs) && /u2\.mo_approver AND u2\.id <> u1\.id/.test(rs) && /WHERE u1\.id = \$1 AND u1\.mo_approver/.test(rs));
check("introduction emails record the connection", /recordConnection\(a\.user_id, b\.user_id, "event_intro"\)/.test(src("services/eventGuestMatchHandoff.ts")) && /recordConnection\(a\.user_id, b\.user_id, "network_intro"\)/.test(src("services/networkIntroNudge.ts")));

// Consent in: only their own words, labeled as theirs
check("their own words pass", R.isOwnWords("the venue moved to Friday", ["Can you tell Jordan the venue moved to Friday?"]));
check("words they never texted don't", !R.isOwnWords("Royce is raising a seed round", ["tell Jordan hi from me and that the venue moved"]));
check("a word or two isn't a message", !R.isOwnWords("hi", ["tell Jordan hi"]));
check("the relay is labeled as theirs and adds nothing about them", R.relayText("Ellis", "the venue moved to Friday") === 'Ellis asked me to pass this along: "the venue moved to Friday"\n\nIf you want me to send anything back, just tell me what to say.');
check("the own-words check runs before anything is sent", rs.indexOf("isOwnWords(opts.message") < rs.indexOf("sendExemptWhenAllowed({ userId: to.userId"));

// Consent out: nothing comes back without their yes
check("the sender only learns what the recipient chose to send back", /hasn't sent anything back through Co, and Co knows nothing else about their reply/.test(rs) && /asked Co to send back:/.test(rs));
check("the recipient is told Co sends nothing back unless they ask", /Co sends nothing back to \$\{r\.from_name\} unless they explicitly ask it to, in their own words/.test(rs));
check("replies back are themselves relays from the recipient's own words", /From the other side, when someone who got a message from them asks you to send something back, relay that in their own words too/.test(src("services/capabilities.ts")));

// Limits
check("one relay per pair per day", R.RELAY_PER_PAIR_PER_DAY === 1 && /relaysToday\(opts\.fromUserId, to\.userId\)\) >= RELAY_PER_PAIR_PER_DAY/.test(rs));
check("one person per relay, never a group text", /phoneNumber: phone, type: "direct_ask"/.test(rs) && !/send-group-message|group_id|participants/.test(rs));
check("STOP and local hours apply (an exempt direct_ask send)", /sendExemptWhenAllowed\(\{ userId: to\.userId/.test(rs));
check("every step is logged", (rs.match(/await log\(/g) ?? []).length >= 6);
check("reminders only ever go to the member who asked", /sendExemptWhenAllowed\(\{ userId: r\.user_id, phoneNumber: r\.phone_number/.test(rs) && /cron\.schedule\("\*\/5 \* \* \* \*"/.test(src("jobs/index.ts")));
check("test runs apply the same guards", /Same guards as a real relay, minus the send/.test(src("agent/conversationTools.ts")));

console.log(`relay rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
