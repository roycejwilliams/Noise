// Second contact (Royce, 2026-10-11): "X% of Co introductions lead to a second meeting". Zero tokens, no database.
//   1. Co records what a member says about seeing someone it introduced them to again: their side only, in their record only.
//   2. Only Co's own introductions count; a name that fits two of them is asked about, never guessed.
//   3. The number: intros whose email went, met or talked again within 30 days by either side's word.
//   npx tsx evals/intros/secondContact.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.OPENAI_API_KEY ||= "unused-in-tests";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";
import fs from "node:fs";
const SC = await import("../../src/services/secondContact.js");
const Cap = await import("../../src/services/capabilities.js");
const CT = await import("../../src/services/callTools.js");
const N = await import("../../src/services/memberStateNudges.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}`, detail ?? ""); } };
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

const list = [
  { otherId: "u-noor", firstName: "Noor", introducedAt: new Date("2026-10-01") },
  { otherId: "u-ellis1", firstName: "Ellis", introducedAt: new Date("2026-09-20") },
  { otherId: "u-ellis2", firstName: "Ellis", introducedAt: new Date("2026-09-10") },
];
check("the person is found by first name among Co's own intros", (SC.pickIntro(list, "Noor Haddad") as any)?.otherId === "u-noor" && (SC.pickIntro(list, "noor") as any)?.otherId === "u-noor");
check("someone Co never introduced them to isn't recorded", SC.pickIntro(list, "Jordan") === null && SC.pickIntro(list, "") === null);
check("a name that fits two intros is asked about, never guessed", SC.pickIntro(list, "Ellis") === "ambiguous");
check("the fact is their side, in plain words, with the day they said it", SC.secondContactLabel("Noor", "met_again", new Date("2026-10-20T18:00:00Z")) === "Saw Noor again (said 2026-10-20; Co introduced them)" && /^Hasn't seen Noor again yet/.test(SC.secondContactLabel("Noor", "not_yet", new Date())));
check("met and talked count as a second contact; not yet and not going to don't", SC.MET.has("met_again") && SC.MET.has("talked_again") && !SC.MET.has("not_yet") && !SC.MET.has("not_going_to"));

const s = src("services/secondContact.ts");
check("recorded in their own record only (owner visibility), never sent to the other person", /visibility: "owner"/.test(s) && /relation: SECOND_CONTACT_RELATION/.test(s) && !/sendExempt|sendblue|messages\.send/.test(s));
check("only intros whose email went count (member_connections), archived members never named back", /FROM member_connections c/.test(s) && /u\.archived_at IS NULL/.test(s));
check("the number: either side's word, met or talked within 30 days of the intro, intros old enough to have had the 30 days", SC.SECOND_CONTACT_DAYS === 30 && /l\.outcome IN \('met_again', 'talked_again'\) AND l\.at >= i\.created_at AND l\.at <= i\.created_at \+ make_interval\(days => \$3\)/.test(s) && /\(l\.owner_user_id = i\.person_a AND l\.other = i\.person_b::text\) OR \(l\.owner_user_id = i\.person_b AND l\.other = i\.person_a::text\)/.test(s) && /c\.created_at < NOW\(\) - make_interval\(days => \$3\)/.test(s));
check("review of #147: archived members (reset test members) never count", /JOIN users ua ON ua\.id = c\.person_a AND ua\.archived_at IS NULL/.test(s) && /JOIN users ub ON ub\.id = c\.person_b AND ub\.archived_at IS NULL/.test(s));
check("review of #147: each side's latest word stands, and the window counts from when they met when they said", /DISTINCT ON \(f\.owner_user_id, f\.meta->>'otherId'\)/.test(s) && /ORDER BY f\.owner_user_id, f\.meta->>'otherId', f\.happened_at DESC/.test(s) && /COALESCE\(\(f\.meta->>'metOn'\)::date::timestamptz, f\.happened_at\)/.test(s));

const entry: any = Cap.ABILITIES.find((c: any) => c.tool === "noteMetAgain");
check("Co decides when to record it: a tool in the capability registry, bounded per turn, their side only", !!entry && entry.limits?.perTurn === 2 && /never ask what the other person said, and never tell the other person/.test(entry.use ?? ""), entry);
check("the same tool on calls", (CT.CALL_TOOL_NAMES as readonly string[]).includes("noteMetAgain"));
const ct = src("agent/conversationTools.ts");
check("the tool records only Co's own intros, asks when a name fits two", /noteMetAgain: tool\(/.test(ct) && /isn't someone Co introduced them to/.test(ct) && /More than one person Co introduced them to is called/.test(ct));
const facts = N.introNudgeFacts({ otherFirstName: "Noor", how: "network", eventName: null, reasonAsEmailed: "both building in climate", introducedAt: new Date("2026-10-01") }, new Date("2026-10-06"));
check("the intro check-in is curious whether they've met or talked since (their side only)", facts.worth_asking === "whether the two of you have met or talked since");
check("there's a read-only report for the number", /secondContactRate/.test(src("scripts/secondContact.ts")) && /"metric:second-contact": "tsx src\/scripts\/secondContact\.ts"/.test(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")));

console.log(`second contact: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
