// The reply's tools in cache order (agent/conversationTools.ts orderForCache, Phase B 2026-10-27). Tools render first in the
// request, so the part every member gets on every turn must come first, be byte-identical across members and turns, and carry the
// cache point; the tools that come and go follow it. Built from real tool sets for different members and turns.
// Layer 1: no model, no DB, nothing sent.
//   npx tsx evals/cache/toolOrder.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
import fs from "node:fs";
const { createConversationTools, comeAndGoTools } = await import("../../src/agent/conversationTools.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

const base = { phoneNumber: "+10000000000", resolvedContent: "", isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: true, sendCoReply: async () => true };
const sets = {
  member: createConversationTools({ ...base, userId: "u1" } as any).tools,
  team: createConversationTools({ ...base, userId: "u2", isTeam: true } as any).tools,
  acked: createConversationTools({ ...base, userId: "u3", ackSent: "👍", lastReaction: "👍" } as any).tools,
  walkin: createConversationTools({ ...base, userId: "u4", walkinAsk: { eventApiId: "evt", eventName: "Dinner" }, lastReaction: "🔥" } as any).tools,
};
// What the API would see up to the cache point: each tool's name, description and input schema, in order.
const wire = (t: Record<string, any>) => {
  const names = Object.keys(t);
  const cut = names.findIndex((n) => t[n]?.providerOptions?.anthropic?.cacheControl);
  const head = names.slice(0, cut + 1).map((n) => JSON.stringify({ n, d: t[n].description, s: t[n].inputSchema?._def ?? t[n].inputSchema?.jsonSchema ?? null }));
  return { names, cut, head: head.join("\n") };
};
const w = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, wire(v as any)]));
for (const [k, v] of Object.entries(w)) check(`${k}: exactly one tool carries the cache point`, Object.values(sets[k as keyof typeof sets]).filter((x: any) => x?.providerOptions?.anthropic?.cacheControl).length === 1 && v.cut > 0, v.cut);
check("the cached part is identical for a member, the team, a turn after a reaction and a walk-in turn", w.member.head === w.team.head && w.member.head === w.acked.head && w.member.head === w.walkin.head);
const moving = comeAndGoTools();
for (const [k, v] of Object.entries(w)) check(`${k}: nothing that comes and goes sits before the cache point`, v.names.slice(0, v.cut + 1).every((n) => !moving.has(n)), v.names.slice(0, v.cut + 1).filter((n) => moving.has(n)));
check("the team's own tools, a leave-it and the walk-in receipt are still offered when they apply (after the cache point)", w.team.names.length > w.member.names.length && w.acked.names.includes("leaveItAtReaction") && w.walkin.names.includes("askedWalkin"));
check("nothing added or removed by the ordering: same tool names as before, only the order", Object.keys(sets.member).length === new Set(Object.keys(sets.member)).size);
check("the reaction tool's description no longer names their last reaction", !String((sets.acked as any).reactInsteadOfReplying.description).includes("👍"));
const reply = fs.readFileSync(new URL("../../src/agent/conversationReply.ts", import.meta.url), "utf8");
check("their last reaction is in the reply prompt's member part instead (both prompts)", (reply.match(/Your last reaction to them was \$\{input\.lastReaction\}/g) ?? []).length === 2);
console.log(`tools in cache order: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
