// PR #49 items 1 and 2, end to end: the real buildContextSummary on TEMP
// fixtures. Maya (D) is linked to A by a match nudge; A's call summary and
// person model describe her. Her details must not reach the summary.
import "../lib/requireMeter.js";
import { member, memory, rows, ck, ID, type Case } from "./fixtures.js";

const MAYA = /grid storage|Tesla|leaving|raise soon|raising/i;
export const context: Case[] = [
  {
    suite: "context", id: "ctx-summary-strip", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      await member("D", { first: "Maya" });
      await rows(`INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score) VALUES ('evt-m', $1, $2, 80)`, [ID.A, ID.D]);
      await memory("A", "text_exchange", "User said: I'm hunting for a technical cofounder this month.", undefined, 30);
      await memory("A", "text_exchange", "[Call] Avery said they met Maya at the mixer. Maya is leaving Tesla and raising for her grid storage startup. Avery wants a technical cofounder.", undefined, 20);
      await rows(`INSERT INTO person_snapshots (user_id, snapshot) VALUES ($1, $2::jsonb)`, [ID.A, JSON.stringify({ work: "climate founder", place: "San Francisco", wantsNow: ["a technical cofounder", "Maya is leaving Tesla to build grid storage"], weighingOn: [], valuesInPeople: [], worked: [], didntWork: [], asOf: "2026-10-01" })]);
      const { buildContextSummary } = await import("../../src/services/callContext.js");
      const summary = await buildContextSummary(ID.A);
      return {
        checks: [
          ck("Maya's details never reach the summary", !MAYA.test(summary), summary),
          ck("the call summary keeps A's own part", /technical cofounder/.test(summary), summary),
          ck("the person model still says who A is", /climate founder/.test(summary), summary),
          ck("Maya is still known as someone Co linked them with", /Maya, another member/.test(summary), summary),
          ck("A's own words pass unchanged", /hunting for a technical cofounder/.test(summary), summary),
        ],
        texts: { summary },
      };
    },
  },
  {
    suite: "context", id: "ctx-person-model-strip", mode: "model-free", runs1: true,
    run: async () => {
      await member("A");
      await member("D", { first: "Maya" });
      await rows(`INSERT INTO event_guest_match_nudges (event_id, person_id, candidate_id, score) VALUES ('evt-m', $1, $2, 80)`, [ID.A, ID.D]);
      await rows(`INSERT INTO person_snapshots (user_id, snapshot) VALUES ($1, $2::jsonb)`, [ID.A, JSON.stringify({ work: "climate founder", place: "San Francisco", wantsNow: ["a technical cofounder", "Maya is leaving Tesla to build grid storage"], weighingOn: [], valuesInPeople: [], worked: [], didntWork: [], asOf: "2026-10-01" })]);
      await memory("A", "text_exchange", "Co replied: Maya's leaving Tesla and raising for grid storage, worth meeting.", undefined, 10);
      const { personModel } = await import("../../src/services/personModel.js");
      const pm = await personModel(ID.A, { maxDid: 5 });
      const { memberSafe } = await import("../../src/services/memberSafeMemories.js");
      const recent = (await memberSafe(ID.A, await rows(`SELECT content, memory_type FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange'`, [ID.A]))).join("\n");
      return {
        checks: [
          ck("the person model the sweep and tasks read has no Maya details", !MAYA.test(pm), pm),
          ck("their own wants survive", /a technical cofounder/.test(pm) && /climate founder/.test(pm), pm),
          ck("the task/follow-up recent texts have no Maya details", !MAYA.test(recent) && /Maya, another member/.test(recent), recent),
        ],
        texts: { personModel: pm, recent },
      };
    },
  },
  {
    suite: "context", id: "ctx-call-blocked-reply",
    run: async () => {
      await member("A");
      const G = await import("../../src/harness/replyGrounding.js");
      const { runConversationReplyAgent } = await import("../../src/agent/conversationReply.js");
      const { callNotPlacedReason, callNotPlacedFacts } = await import("../../src/services/callReasons.js");
      const err = "Call blocked: Co called 1 min ago (needs 2)";
      const why = callNotPlacedReason(err);
      const facts = G.baseReplyFacts();
      for (const f of callNotPlacedFacts(err)) G.addFact(facts, f.kind, f.text);
      // The instruction exactly as routes/sendblue.ts adds it.
      G.addInstruction(facts, `They just asked you to call them. Co genuinely can call (this is real and live), but no call went out this time: ${why} Say plainly that you didn't call and why, in a line, and what they can do (text "call me" again once it's allowed). Never say you tried or that it didn't go through, don't promise to call back on your own, and don't say "calling you now."`);
      const recent = "User said: Call me\nCo replied: Calling you now.\nCo replied: Reached your voicemail just now. Reply here when you can, or I'll try again in a bit.";
      const r: any = await runConversationReplyAgent({ ackSent: null, userId: ID.A, phoneNumber: "+14155550100", firstName: "Avery", resolvedContent: "Try again", isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: recent, recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => true } as any, { dryRun: true, record: false, stubSearch: true });
      const text = String(r.replyText ?? "");
      return {
        checks: [
          ck("no false 'tried' / 'didn't go through'", !/\b(tried|trying|didn'?t go through|not going through|couldn'?t get through)\b/i.test(text), text),
          ck("says no call went out and why", /minute|just called|a minute ago|called you/i.test(text), text),
          ck("doesn't say calling now", !/calling you now/i.test(text), text),
        ],
        texts: { reply: text },
        observed: { grounding: (r.grounding ?? []).map((g: any) => ({ outcome: g.outcome, failed: (g.checks ?? []).filter((c: any) => !c.pass).map((c: any) => c.reason ?? c.name) })) },
      };
    },
  },
];
