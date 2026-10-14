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

// The Oct 9 queue: three picks, all tier 3 (openings), Fleet Week the only time-bound one. Since 2026-10-14 (Royce: "one find per
// tier") picks never stack in one tier: the most time-bound goes, the others wait for their own send.
const cand = (id: string, name: string, priority: number, expires: string, picked = true) => ({ id, userId: "u", type: "event_offer", targetKey: id, topicKey: id, summary: name, payload: { picked, match: { name, tier: 3 } }, priority, dueAt: new Date("2026-10-09T17:01:00Z"), expiresAt: new Date(expires), status: "pending", createdAt: new Date("2026-10-09T17:01:00Z") }) as any;
const pitch = cand("277", "Pitch Protocol", 60, "2026-10-23T17:01:15Z");
const fleet = cand("278", "San Francisco Fleet Week Air Show (Blue Angels)", 95, "2026-10-10T06:59:59Z");
const chess = cand("279", "Pawn Shop Chess Club SF - Sunday Chess Meetup", 60, "2026-10-23T17:01:15Z");
for (const chosen of [pitch, fleet, chess]) {
  const lead = P.leadPick(chosen, [pitch, fleet, chess]);
  const sibs = P.pickSiblingOffers(lead, [pitch, fleet, chess]);
  const order = [lead, ...sibs].map((c: any) => c.payload.match.name);
  check(`whichever pick Co chose (${chosen.payload.match.name}), Fleet Week leads and no second tier-3 pick rides with it: ${order.join(" > ")}`, order.length === 1 && order[0].startsWith("San Francisco Fleet Week"));
}
// One pick from each tier: all three go together, most time-bound first.
const tiered = (c: any, tier: number) => ({ ...c, payload: { ...c.payload, match: { ...c.payload.match, tier } } });
const [p1, p2, p3] = [tiered(pitch, 1), tiered(chess, 2), fleet];
const three = [P.leadPick(p1, [p1, p2, p3]), ...P.pickSiblingOffers(P.leadPick(p1, [p1, p2, p3]), [p1, p2, p3])].map((c: any) => c.payload.match.tier);
check(`a pick from each tier goes together, one per tier (${three.join(",")})`, three.length === 3 && new Set(three).size === 3 && three[0] === 3);
// A morning's picks go with that morning's, ahead of an earlier pick still waiting in the same tier.
const morning = (c: any, day: string | null) => ({ ...c, payload: { ...c.payload, ...(day ? { morningDay: day } : {}) } });
const old2 = morning({ ...tiered(cand("o2", "Older tier-2 pick", 95, "2026-10-10T00:00:00Z"), 2) }, null);
const m1 = morning(p1, "2026-10-09"), m2 = morning(p2, "2026-10-09"), m3 = morning(p3, "2026-10-09");
const mLead = P.leadPick(m1, [m1, m2, m3, old2]);
const mOut = [mLead, ...P.pickSiblingOffers(mLead, [m1, m2, m3, old2])].map((c: any) => c.id);
check(`a morning bundle is that morning's finds, one per tier, never an older pick in their place (${mOut.join(",")})`, mOut.length === 3 && !mOut.includes("o2"));
// Picks bundle across one tier; anything not picked keeps the old one-per-tier rule.
const t2a = { ...cand("a", "Event A", 60, "2026-10-20T00:00:00Z", false), payload: { match: { name: "Event A", tier: 2 } } };
const t2b = { ...cand("b", "Event B", 60, "2026-10-20T00:00:00Z", false), payload: { match: { name: "Event B", tier: 2 } } };
check("finds the pick didn't choose: still one per tier", P.pickSiblingOffers(t2a, [t2a, t2b]).length === 0);
check(`at most ${P.MAX_PICKED_TOGETHER} picks in one message, one per tier`, P.pickSiblingOffers(p3, [p1, p2, p3, tiered(cand("x", "X", 60, "2026-10-23T00:00:00Z"), 1), tiered(cand("y", "Y", 60, "2026-10-23T00:00:00Z"), 2)]).length === P.MAX_PICKED_TOGETHER - 1);

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
