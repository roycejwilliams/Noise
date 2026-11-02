// A direct ask is a yes (2026-11-02 helper audit, PR 1). On dev, 11-01, a member asked twice for a checklist document and
// writeDocument was refused six times: the yes read said "If no offer of this action appears in the exchange, no", while the
// registry's their_yes has always been "they asked for it, or said yes to Co's offer" (services/capabilities.ts).
// Zero tokens. The judge is NOT stubbed to always-yes: each case hands back a fixture of what the read returns (raw text, parsed by the
// real parseYes), through the real guard (agent/toolGuard.ts) and the real confirmYes (services/theirYes.ts). What these prove is the
// prompt and the plumbing; whether Haiku answers each fixture the same way is the optional live check (under $0.05, not run here).
//   1. the prompt: a direct ask counts; a vague mention, a yes to something else and Cue's own words don't; for an intro it judges the
//      asker's side only
//   2. through the guard: a direct ask runs the tool (writeDocument, researchBrief, writeFromFile); a vague mention doesn't; Cue's own
//      suggestion with no reply doesn't, whether it's quoted as theirs (code, no read) or their unrelated words are (the read)
//   3. an intro asked for directly: the asker's side goes, the other member is only asked (double opt-in), never introduced
//   npx tsx evals/capabilities/directAsk.ts
import { z } from "zod";
import { W, reset, addMember, addEvent, ask } from "../inroom/world.js";

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };
const log = console.log, err = console.error;
// Quiet, but every line kept: the intro email's send in tests is a log line ("[sendIntroEmail stub ...]", eventGuestMatchHandoff.ts).
const logged: string[] = [];
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };
const introEmailed = () => logged.some((l) => /\[sendIntroEmail stub/.test(l));

const Y = await import("../../src/services/theirYes.js");
(await import("../../src/services/abilitySwitches.js")).setSwitchesForTest({});
const { guardTools } = await import("../../src/agent/toolGuard.js");
const { ABILITIES } = await import("../../src/services/capabilities.js");

// The fixture judge: for each member message, the text the read hands back. It builds the real prompt for every read, so a case can
// see exactly what the model would have been shown.
const FIXTURES = new Map<string, string>();
const prompts: string[] = [];
Y.setYesJudgeForTests(async (r) => {
  prompts.push(Y.yesPrompt(r));
  const out = FIXTURES.get(r.message);
  if (out === undefined) throw new Error(`no fixture for ${JSON.stringify(r.message)}`);
  return Y.parseYes(out);
});

// ------------------------------------------------------------ 1. the prompt
{
  const p = Y.yesPrompt({ recent: "Member: can you make me a checklist for the move\nCue: Here's the list: boxes, utilities, keys.", message: "Place that in a document for me", ability: "Cue can write them a document" });
  check("the read asks whether they asked for THIS action or said yes to Cue's offer of it", /either ask Cue for THIS action, or say yes to Cue's offer of it/.test(p), p);
  check("…a direct ask is enough with no offer before it", /A direct ask is enough on its own, with no offer before it/.test(p));
  check("…the old rule that refused every direct ask is gone", !/If no offer of this action appears/.test(p));
  check("…a passing mention or a wish is still no", /a passing mention or a wish that doesn't ask Cue to do it/.test(p));
  check("…a yes to a different offer, a maybe, a not-now, a question back, an acknowledgment are still no", /a yes to a different offer, a maybe, a not-now, a question back, or a plain acknowledgment/.test(p));
  check("…Cue's own words are never theirs", /Cue's own words are never theirs: an offer of Cue's that their latest message doesn't ask for or accept is no/.test(p));
  check("…for an action with another person, only the member's side", /judge only the member's side: the other person is asked separately/.test(p));
  check("…and it shows the exchange, their message and the action", p.includes("Cue: Here's the list") && p.includes('"Place that in a document for me"') && p.includes("Cue can write them a document"));
}
check("the field Cue fills is still their own words in this message", (() => {
  const t: any = { execute: async () => ({ ok: true }), inputSchema: z.object({ title: z.string() }) };
  guardTools({ writeDocument: t }, { userId: "u", resolvedContent: "", dryRun: true, notDone: () => {} });
  return /Their own words in THIS message/.test(t.inputSchema.shape.theirYes?.description ?? "");
})());
check("every tool this read gates needs their yes in the registry", ["writeDocument", "writeFromFile", "researchBrief", "requestEventIntro", "moveLane"].every((n) => !!ABILITIES.find((a) => a.tool === n)?.confirm));

// ------------------------------------------------------------ 2. through the guard
// Stand-ins for the gated tools, so the case is the guard and the read only: each records that it ran.
const ran: string[] = [];
const guarded = (message: string, recent: string) => {
  const notDone: string[] = [];
  const stub = (name: string) => ({ execute: async () => (ran.push(name), { ok: true, note: `${name} ran` }), inputSchema: z.object({ what: z.string().optional() }) });
  const tools: any = guardTools({ writeDocument: stub("writeDocument"), researchBrief: stub("researchBrief"), writeFromFile: stub("writeFromFile") }, { userId: "u", resolvedContent: message, dryRun: true, notDone: (w) => notDone.push(w), recentExchange: recent });
  return { tools, notDone };
};

// The 11-01 shape, invented words: asked twice for a checklist they can tick off, Cue never offered a document.
{
  const recent = ["Member: can you give me a checklist for the move I can tick off", "Cue: Here's what's left: boxes by Friday, utilities on the 3rd, keys to the landlord."].join("\n");
  const msg = "Place that in a document for me, one I can tick off";
  FIXTURES.set(msg, '{"yes": true, "why": "they asked for the checklist as a document"}');
  ran.length = 0; prompts.length = 0;
  const { tools, notDone } = guarded(msg, recent);
  const r = await quiet(() => tools.writeDocument.execute({ what: "move checklist", theirYes: "Place that in a document for me", why: "they asked" }, {}));
  check("a direct ask for a document, never offered: the document is written", r.ok === true && ran.join() === "writeDocument" && notDone.length === 0, { r, ran, notDone });
  check("…after one read that saw the exchange and their ask", prompts.length === 1 && prompts[0].includes("can you give me a checklist") && prompts[0].includes(msg));
}
{
  const msg = "Can you find venues for my launch dinner for 40 in the Mission?";
  FIXTURES.set(msg, '{"yes": true, "why": "they asked Cue to find venues"}');
  ran.length = 0;
  const { tools } = guarded(msg, "Member: the launch is the 14th");
  const r = await quiet(() => tools.researchBrief.execute({ what: "launch dinner for 40", theirYes: "Can you find venues for my launch dinner", why: "they asked" }, {}));
  check("a direct ask for venues, never offered: the brief starts", r.ok === true && ran.join() === "researchBrief", { r, ran });
}
{
  const msg = "write me a one-pager from that PDF";
  FIXTURES.set(msg, '{"yes": true, "why": "they asked for a document from their file"}');
  ran.length = 0;
  const { tools } = guarded(msg, "Member: [sent a PDF]\nCue: Got it, I have the deck.");
  const r = await quiet(() => tools.writeFromFile.execute({ what: "one-pager", theirYes: "write me a one-pager from that PDF", why: "they asked" }, {}));
  check("a direct ask for a document from their file: written", r.ok === true && ran.join() === "writeFromFile", { r, ran });
}

// A vague mention: their words, but no ask.
{
  const msg = "I really should write all of this down at some point";
  FIXTURES.set(msg, '{"yes": false, "why": "a passing thought, not asking Cue for a document"}');
  ran.length = 0;
  const { tools, notDone } = guarded(msg, "Cue: That's a lot to hold in your head before the move.");
  const r = await quiet(() => tools.writeDocument.execute({ what: "notes", theirYes: "write all of this down", why: "seems useful" }, {}));
  check("a vague mention: nothing is written", r.ok === false && ran.length === 0, { r, ran });
  check("…Cue reads that it isn't a yes, and is told not to ask again in this reply", /doesn't read as a yes/.test(r.error ?? "") && /don't ask again/.test(r.error ?? ""), r);
  check("…and the turn has a NOT DONE receipt", notDone.some((n) => /isn't a yes/.test(n)), notDone);
}

// Cue's own suggestion, no reply to it.
{
  const recent = "Cue: Want me to put this in a doc so it's all in one place?";
  const msg = "anyway what's on tonight";
  FIXTURES.set(msg, '{"yes": false, "why": "their message doesn\'t answer Cue\'s offer"}');
  ran.length = 0; prompts.length = 0;
  const own = guarded(msg, recent);
  const a = await quiet(() => own.tools.writeDocument.execute({ what: "doc", theirYes: "put this in a doc", why: "I offered" }, {}));
  check("Cue's own offer quoted as their yes: refused in code, no read", a.ok === false && /Quote only the words in their message/.test(a.error ?? "") && prompts.length === 0 && ran.length === 0, { a, prompts: prompts.length });
  const b = await quiet(() => own.tools.writeDocument.execute({ what: "doc", theirYes: "anyway", why: "I offered" }, {}));
  check("their unrelated words quoted instead: the read says no, nothing is written", b.ok === false && /doesn't read as a yes/.test(b.error ?? "") && prompts.length === 1 && ran.length === 0, { b, ran });
}

// A read that couldn't be read is still not a yes.
{
  const msg = "make that a doc please";
  FIXTURES.set(msg, "Sure, sounds like a yes to me");
  ran.length = 0;
  const { tools } = guarded(msg, "");
  const r = await quiet(() => tools.writeDocument.execute({ what: "doc", theirYes: "make that a doc please", why: "they asked" }, {}));
  check("an unreadable read is not a yes, even on a direct ask", r.ok === false && /couldn't be checked/.test(r.error ?? "") && ran.length === 0, r);
}

// ------------------------------------------------------------ 3. an intro asked for directly: only the asker's side
{
  // The in-room world (evals/inroom/world.ts): the real guest-list lookup, opt-ins, direct ask and send over a fake database.
  const { default: pool } = await import("../../src/db/db.js");
  const world = (pool as any).query;
  (pool as any).query = async (sql: string, p: any[] = []) => {
    const flat = sql.replace(/\s+/g, " ");
    // The guard's own reads of its log (once per person, per day) and the lasting record: nothing on file yet.
    if (/SELECT 1 FROM harness_decisions/.test(flat)) return { rows: [] };
    if (/COUNT\(\*\)::int AS n FROM harness_decisions/.test(flat)) return { rows: [{ n: 0 }] };
    if (/INSERT INTO co_facts/i.test(flat)) return { rows: [] };
    return world(sql, p);
  };
  // Pinned to 18:00 UTC as evals/review/introTrace.ts: a member with no time zone is texted 16:00-24:00 UTC, so the direct ask goes now.
  const RealDate = Date;
  const pinned = new RealDate();
  pinned.setUTCHours(18, 0, 0, 0);
  const offset = pinned.getTime() - RealDate.now();
  (globalThis as any).Date = class extends RealDate {
    constructor(...a: any[]) { super(...((a.length ? a : [RealDate.now() + offset]) as [any])); }
    static now() { return RealDate.now() + offset; }
  };
  const { createConversationTools } = await import("../../src/agent/conversationTools.js");
  const msg = "connect me with Sarah Kim from Cue Night";
  FIXTURES.set(msg, '{"yes": true, "why": "they asked for an intro to Sarah"}');
  const run = async (sarahSaidYes: boolean) => {
    reset();
    logged.length = 0;
    prompts.length = 0;
    const jo = addMember({ first_name: "Jo", last_name: "Lee", intent: [ask("a cofounder for a climate startup")] });
    const sarah = addMember({ first_name: "Sarah", last_name: "Kim", intent: [ask("an engineer who has shipped hardware")] });
    addEvent({ api_id: "evt-direct", name: "Cue Night" }, [{ m: jo }, { m: sarah }]);
    W.checkinFollowups.push({ user_id: jo.id, event_api_id: "evt-direct", event_name: "Cue Night" });
    if (sarahSaidYes) W.optIns.push({ event_id: "evt-direct", person_id: sarah.id, candidate_id: jo.id, status: "interested" });
    const facts: { kind: string; text: string }[] = [];
    const tools: any = createConversationTools({
      userId: jo.id, phoneNumber: jo.phone_number, resolvedContent: msg, isVoice: false, hasPendingOffer: false, recentOfferBurstActive: false, dryRun: false,
      recentExchange: "Member: met some great people last night\nCue: Sounds like a good night.",
      sendCoReply: async () => true, facts: { add: (kind: string, text: string) => facts.push({ kind, text }), text: () => "" },
    } as any).tools;
    const r = await quiet(async () => {
      const out = await tools.requestEventIntro.execute({ personName: "Sarah", lastName: "Kim", theirYes: "connect me with Sarah Kim", why: "they asked" }, { toolCallId: "t0", messages: [] });
      for (let i = 0; i < 200 && !W.decisions.some((d) => d.decision === "reply.requestEventIntro"); i++) await new Promise((res) => setTimeout(res, 5));
      return out;
    });
    return { r, jo, sarah, facts };
  };
  {
    const { r, jo, sarah, facts } = await run(false);
    check("an intro asked for directly, never offered: the request goes", r?.ok === true && prompts.length === 1 && /judge only the member's side/.test(prompts[0]), { r, prompts: prompts.length });
    check("…Sarah is asked whether she's open to it, once", W.sent.filter((s) => s.to === sarah.phone_number).length === 1, W.sent);
    check("…only Jo's side is on file as interested; Sarah's yes isn't assumed", W.optIns.length === 1 && W.optIns[0].person_id === jo.id && W.optIns[0].candidate_id === sarah.id && !W.optIns.some((o) => o.person_id === sarah.id), W.optIns);
    check("…no introduction email goes until Sarah says yes", !introEmailed(), logged.filter((l) => /intro/i.test(l)));
    check("…and what Cue reads says nothing happens unless both say yes", facts.some((f) => /Nothing happens unless both say yes/.test(f.text)), facts);
  }
  {
    // The control: the same ask after Sarah already said yes to Jo is the one case that introduces them.
    const { r } = await run(true);
    check("control: with Sarah's own yes already on file, the same ask does introduce them", r?.ok === true && introEmailed(), logged.filter((l) => /intro/i.test(l)));
  }
  (globalThis as any).Date = RealDate;
}

console.log(`direct ask: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
