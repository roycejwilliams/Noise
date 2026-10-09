// The picker goes live (Royce, 2026-10-08): the picker decides WHAT is sent, the queue decides HOW. Zero tokens.
//   npx tsx evals/proactive/pickerLive.ts
import fs from "node:fs";
const S = await import("../../src/services/sweepShadow.js");
const src = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

const m = (name: string, date: string | null, tier: number) => ({ name, tier, event_date: date, url: `https://x.test/${name.length}` });
const backlog = [
  { askId: "a1", askText: "a founder community", fromProfile: false, match: m("Extraordinary Founders Dinner", "2026-10-14", 2) },
  { askId: "profile", askText: "goals", fromProfile: true, match: m("Extraordinary Founders Dinner", "2026-10-14", 2) },
  { askId: "profile", askText: "goals", fromProfile: true, match: m("Solo Founders Program", null, 3) },
  { askId: "a2", askText: "this weekend", fromProfile: false, match: m("Chiffon Cake Popup", "2026-10-10", 2) },
  { askId: "a3", askText: "chess", fromProfile: false, match: m("Pawn Shop Chess Club", "2026-10-11", 2) },
];
const key = (n: string, d: string | null) => S.shadowKey(n, d);
const judgments: any[] = [
  { key: key("Extraordinary Founders Dinner", "2026-10-14"), name: "Extraordinary Founders Dinner", verdict: "send", why: "They asked for a 0-to-1 founder community.", whyNow: "Next Wednesday, spots open." },
  { key: key("Solo Founders Program", null), name: "Solo Founders Program", verdict: "send", why: "They're weighing pre-seed timing." },
  { key: key("Chiffon Cake Popup", "2026-10-10"), name: "Chiffon Cake Popup", verdict: "reject", reason: "weak_fit", why: "Not their scene." },
  { key: key("Pawn Shop Chess Club", "2026-10-11"), name: "Pawn Shop Chess Club", verdict: "hold", why: "Sunday option, not today's strongest." },
];
const waiting = [{ id: "w1", key: key("Chiffon Cake Popup", "2026-10-10") }, { id: "w2", key: key("Extraordinary Founders Dinner", "2026-10-14") }, { id: "w3", key: key("Old Thing", null) }];
const plan = S.planPicks(judgments, backlog as any, waiting);
check(`each "send" is queued once, from the ask's backlog before a goal find (${plan.queue.map((q) => `${q.match.name}@${q.askId}`).join(", ")})`, plan.queue.length === 2 && plan.queue[0].askId === "a1" && plan.queue[1].match.name === "Solo Founders Program");
check("the queued pick carries the picker's reason (why them and why now)", /0-to-1 founder community\. Next Wednesday/.test(plan.queue[0].why));
check(`a waiting find the picker rejected comes out; a chosen one stays (${plan.reject.map((d) => d.id).join(",")})`, plan.reject.map((d) => d.id).join(",") === "w1" && /reject, Not their scene/.test(plan.reject[0].why));
check("a find the picker never saw is left alone", !plan.reject.concat(plan.unqueue).some((d) => d.id === "w3"));
const heldPlan = S.planPicks([{ ...judgments[3] }], backlog as any, [{ id: "h1", key: key("Pawn Shop Chess Club", "2026-10-11") }]);
check("a held find goes back to the backlog only (its row comes out of the queue, never marked decided)", heldPlan.unqueue.map((d) => d.id).join(",") === "h1" && !heldPlan.reject.length);
check("holds and rejects are never queued", !plan.queue.some((q) => /Chess|Chiffon/.test(q.match.name)));

// Internal record ids never reach a member (review of #116).
for (const [inp, ok] of [["They asked for a founder community (A8, A12) and it's next week.", "They asked for a founder community and it's next week."], ["Royce explicitly asked again for the Pitch Protocol link (A17).", "Royce explicitly asked again for the Pitch Protocol link."], ["Fits A18's evening window.", "Fits evening window."], ["asked T1", "asked"], ["exploring pre-seed options (A4-A6); this program", "exploring pre-seed options; this program"]] as const) {
  const got = S.memberSafeWhy(inp);
  check(`ids stripped: "${inp}" -> "${got}"`, !/\b[ATSOC]\d+\b/.test(got) && got.replace(/\W/g, "").length > 0 && got === ok);
}
check("the queued reason is the stripped one", !/\b[ATSOC]\d+\b/.test(S.planPicks([{ ...judgments[0], why: "asked again (A17)" }], backlog as any, []).queue[0].why));
// A reminder beats its own already-sent pitch for the same thing.
const remBacklog = [{ askId: "a1", askText: "x", fromProfile: false, match: m("Founders Dinner", "2026-10-14", 2) }, { askId: "a1", askText: "x", fromProfile: false, match: m("Founders Dinner", "2026-10-14", 2), reminder: true }];
check("a reminder is queued before its original pitch", S.planPicks([{ key: key("Founders Dinner", "2026-10-14"), name: "Founders Dinner", verdict: "send", why: "coming up" } as any], remBacklog as any, []).queue[0].reminder === true);

// HOW stays the queue's: a pick goes through enqueueCandidate as an event_offer, the same row the send step bundles by tier.
const ess = src("services/eventSurfacingSweep.ts");
check("a pick is queued as an ordinary event_offer through enqueueCandidate (bundled by tier, one per tier, caps, hours)", /export async function queuePickedOffer[\s\S]{0,1600}enqueueCandidate\(\{[\s\S]{0,200}type: "event_offer"/.test(ess));
check("a pick checks it isn't already sent/decided or past before queueing", /queuePickedOffer[\s\S]{0,900}alreadyDecided\(userId, item\)[\s\S]{0,120}isPastEvent\(o\.match, zone\)/.test(ess));
check("for a picker account the per-ask sweep only feeds the backlog (no queueing of its own)", /if \(await pickerDecides\(candidate\.userId\)\) \{\s*await log\("act", "fed_to_picker"\);\s*return \{ queued: false, fed: true \};/.test(ess) && ess.indexOf("fed_to_picker") < ess.indexOf("const { rows: waiting }"));
check("the send step still bundles every waiting tier with the picked one (pickSiblingOffers)", /for \(const sib of pickSiblingOffers\(c, ev\.eligible\)\)/.test(src("harness/proactive.ts")));
check("live only where the review runs (co-test), for the picker accounts", /export const pickerLive = \(\) => reviewEnabled\(\);/.test(src("services/sweepShadow.ts")) && /S\.pickerLive\(\) && \(await S\.pickerUserIds\(\)\)\.includes\(userId\)/.test(ess));
{
  const sh = src("services/sweepShadow.ts");
  check("the picks go in before the run is recorded as done (not on a dry run, an error or an unchanged day)", /if \(!opts\.dryRun\) await applyPicks\(/.test(sh) && sh.indexOf("await applyPicks(") < sh.indexOf('decision: "sweep.select.shadow",\n    userId,\n    outcome: "act"'));
}

console.log(`picker live: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
