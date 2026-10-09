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
check(`a waiting find the picker didn't choose comes out; a chosen one stays (${plan.drop.map((d) => d.id).join(",")})`, plan.drop.map((d) => d.id).sort().join(",") === "w1,w3" && /reject, Not their scene/.test(plan.drop.find((d) => d.id === "w1")!.why));
check("holds and rejects are never queued", !plan.queue.some((q) => /Chess|Chiffon/.test(q.match.name)));

// HOW stays the queue's: a pick goes through enqueueCandidate as an event_offer, the same row the send step bundles by tier.
const ess = src("services/eventSurfacingSweep.ts");
check("a pick is queued as an ordinary event_offer through enqueueCandidate (bundled by tier, one per tier, caps, hours)", /export async function queuePickedOffer[\s\S]{0,1600}enqueueCandidate\(\{[\s\S]{0,200}type: "event_offer"/.test(ess));
check("a pick checks it isn't already sent/decided or past before queueing", /queuePickedOffer[\s\S]{0,900}alreadyDecided\(userId, item\)[\s\S]{0,120}isPastEvent\(o\.match, zone\)/.test(ess));
check("for a picker account the per-ask sweep only feeds the backlog (no queueing of its own)", /if \(await pickerDecides\(candidate\.userId\)\) \{\s*await log\("act", "fed_to_picker"\);\s*return \{ queued: false, fed: true \};/.test(ess) && ess.indexOf("fed_to_picker") < ess.indexOf("const { rows: waiting }"));
check("the send step still bundles every waiting tier with the picked one (pickSiblingOffers)", /for \(const sib of pickSiblingOffers\(c, ev\.eligible\)\)/.test(src("harness/proactive.ts")));
check("live only where the review runs (co-test), for the picker accounts", /export const pickerLive = \(\) => reviewEnabled\(\);/.test(src("services/sweepShadow.ts")) && /S\.pickerLive\(\) && \(await S\.pickerUserIds\(\)\)\.includes\(userId\)/.test(ess));
check("the picker queues only after a real run (not a dry run, not an error, not an unchanged day)", /if \(!opts\.dryRun\) await applyPicks\(/.test(src("services/sweepShadow.ts")));

console.log(`picker live: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
