// The daily pick's choices go out together, most time-bound first (Royce, 2026-10-09). Zero tokens.
//   npx tsx evals/proactive/pickBundle.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const P = await import("../../src/harness/proactive.js");
const E = await import("../../src/services/eventSurfacingSweep.js");
const S = await import("../../src/services/sweepSelect.js");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

const NOW = new Date("2026-10-09T18:00:00Z"); // 11am Pacific, Friday
const SF = "America/Los_Angeles";
check("today and tomorrow outrank everything (95)", E.pickPriority("2026-10-09", SF, NOW) === 95 && E.pickPriority("2026-10-10", SF, NOW) === 95);
check("within three days, 85; further or no end, the default", E.pickPriority("2026-10-12", SF, NOW) === 85 && E.pickPriority("2026-10-20", SF, NOW) === undefined && E.pickPriority(null, SF, NOW) === undefined);

// Today's real queue (Oct 9): three picks, all tier 3 (openings), Fleet Week the only time-bound one.
const cand = (id: string, name: string, priority: number, expires: string, picked = true) => ({ id, userId: "u", type: "event_offer", targetKey: id, topicKey: id, summary: name, payload: { picked, match: { name, tier: 3 } }, priority, dueAt: new Date("2026-10-09T17:01:00Z"), expiresAt: new Date(expires), status: "pending", createdAt: new Date("2026-10-09T17:01:00Z") }) as any;
const pitch = cand("277", "Pitch Protocol", 60, "2026-10-23T17:01:15Z");
const fleet = cand("278", "San Francisco Fleet Week Air Show (Blue Angels)", 95, "2026-10-10T06:59:59Z");
const chess = cand("279", "Pawn Shop Chess Club SF - Sunday Chess Meetup", 60, "2026-10-23T17:01:15Z");
for (const chosen of [pitch, fleet, chess]) {
  const lead = P.leadPick(chosen, [pitch, fleet, chess]);
  const sibs = P.pickSiblingOffers(lead, [pitch, fleet, chess]);
  const order = [lead, ...sibs].map((c: any) => c.payload.match.name);
  check(`whichever pick Co chose (${chosen.payload.match.name}), one message with all three, Fleet Week first: ${order.join(" > ")}`, order.length === 3 && order[0].startsWith("San Francisco Fleet Week"));
}
// Picks bundle across one tier; anything not picked keeps the old one-per-tier rule.
const t2a = { ...cand("a", "Event A", 60, "2026-10-20T00:00:00Z", false), payload: { match: { name: "Event A", tier: 2 } } };
const t2b = { ...cand("b", "Event B", 60, "2026-10-20T00:00:00Z", false), payload: { match: { name: "Event B", tier: 2 } } };
check("finds the pick didn't choose: still one per tier", P.pickSiblingOffers(t2a, [t2a, t2b]).length === 0);
check(`at most ${P.MAX_PICKED_TOGETHER} picks in one message`, P.pickSiblingOffers(fleet, [pitch, fleet, chess, cand("x", "X", 60, "2026-10-23T00:00:00Z"), cand("y", "Y", 60, "2026-10-23T00:00:00Z")]).length === P.MAX_PICKED_TOGETHER - 1);

// The picker gives a time-bound send its last day; a day already past is too late.
const ctx: any = { today: "2026-10-09", asks: [{ id: "A1", text: "SF this weekend" }], texts: [], sent: [], outcomes: [], pool: [{ id: "C1", key: "k1", name: "Fleet Week", kind: "answer", asks: ["A1"] }, { id: "C2", key: "k2", name: "Old fair", kind: "answer", asks: ["A1"] }] };
const j = S.guardVerdicts(ctx, [
  { id: "C1", verdict: "send", whyMember: "asked for SF this weekend", cites: ["A1"], whyNow: "today", wow: true, lastDay: "2026-10-09" },
  { id: "C2", verdict: "send", whyMember: "asked", cites: ["A1"], whyNow: "now", wow: true, lastDay: "2026-10-04" },
] as any);
check("a send keeps its last day", j.find((x: any) => x.id === "C1")?.verdict === "send" && j.find((x: any) => x.id === "C1")?.lastDay === "2026-10-09");
check("a send whose last day has passed is too late, and takes no send slot", j.find((x: any) => x.id === "C2")?.verdict === "reject" && j.find((x: any) => x.id === "C2")?.reason === "too_late");
check("the picker is asked for the last day", /"lastDay"/.test(S.SELECT_SYSTEM));

console.log(`pick bundle: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
