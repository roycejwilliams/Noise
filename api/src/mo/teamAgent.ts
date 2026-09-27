// Mo reads the team's texts itself and chooses what to do (Royce,
// 2026-09-26: "how can we make Mo more compatible with Co"), the way Co
// does: its abilities are one registry (mo/abilities.ts), each is a tool it
// picks, and agent/toolGuard.ts holds the hard lines (a switch per ability,
// limits, the approver's own yes before anyone outside Co is contacted, a
// receipt and a tool.* log for each call). This replaced a keyword parser
// ("Mo, pause", "how's X", "find me Y") and a yes/no/change classifier.
//
// What Mo says back is built from what its tools returned: a tool's `say`
// is what actually happened, and Mo's reply must carry it word for word.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { guardTools } from "../agent/toolGuard.js";
import { MO_VOICE, MO_RULES } from "./moVoice.js";
import { moAbilityForTool, moCapabilitySheet, moToolUse } from "./abilities.js";

export type TeamPending = { kind: "review" | "question"; p: any } | null;

export type TeamTurnInput = {
  userId: string;
  approverFirst: string | null;
  text: string;
  pending: TeamPending;
  // Co has texted them since Mo asked about the pending item.
  coSpoke: boolean;
  // Tests: nothing is written or sent; each tool reports what it would do.
  dryRun?: boolean;
};

export type TeamTurn = { reply: string | null; passed: boolean; tools: string[]; notDone: string[] };

// What Mo is waiting on, in plain words, for its own prompt.
export function pendingLine(pending: TeamPending): string {
  if (!pending) return "You're not waiting on an answer from them about anyone right now.";
  const p = pending.p;
  const name = p.name ?? (p.x_handle ? `@${p.x_handle}` : "someone");
  if (pending.kind === "question") {
    return `You're waiting on their answer to a question from ${name}, who wrote back: "${String(p.pending_question ?? "").slice(0, 400)}". Whatever they write for ${name} goes to them word for word (moSendAnswer).`;
  }
  const send = [p.draft_reply ? `public reply: "${p.draft_reply}"` : null, p.draft_dm ? `message: "${p.draft_dm}"` : null].filter(Boolean).join("; ");
  return `You showed them ${name} (${p.source === "x" ? "on X" : "on LinkedIn"}) and asked "Want me to go for it? Yes, no, or tell me what to change." What you'd send: ${send}. A yes is moApprove, a no is moSkip, a change is moChangeDraft.`;
}

export function teamSystem(input: Pick<TeamTurnInput, "approverFirst" | "pending" | "coSpoke">): string {
  return `${MO_VOICE}

You and Co share one phone number and one thread. ${input.approverFirst ?? "This person"} is on the team (they approve who you reach out to).

What you can do, and the lines you don't cross:
${moCapabilitySheet().map((c) => `- ${c}`).join("\n")}

Right now: ${pendingLine(input.pending)}${input.coSpoke ? "\nCo has texted them since you asked, so a short yes or no is probably an answer to Co unless it names you or the person." : ""}

First decide who the message is for. It's for Co, not you, unless it's about your work (the people you find and reach out to, your search, pausing you) or answers what you're waiting on. Anything about their own life, plans, feelings, events for themselves, calls, their invites or membership, or what Co can do is Co's ("call me", "how many invites do I have?", "what's on tonight?"). Then call notForMo and nothing else, and never answer for Co or say what Co can or can't do.

Otherwise do what they asked with your tools, then write your reply. Your reply is only what your tools returned: when a tool gives \`say\`, include it word for word, and never claim something happened that a tool didn't report. If they ask what you can do, answer in two or three short sentences from the list above, never a list. Never offer something your tools can't do right now: you can't reach anyone the team hasn't approved, and you can't make outreach go out on demand or faster. Describe yourself the way your definition says: you extend invitations to Co. If you need something from them, ask one plain question. When your reply doesn't start with a tool's \`say\`, open with "${MO_RULES.opener(input.approverFirst)}". Short, plain, no em dashes.`;
}

type Deps = {
  status: (first: string | null, pendingOpen: boolean) => Promise<string>;
  person: (query: string) => Promise<string>;
  focus: (text: string) => Promise<void>;
  pause: (paused: boolean) => Promise<void>;
  approve: (p: any) => Promise<{ ok: true; say: string } | { ok: false; error: string }>;
  skip: (p: any) => Promise<{ ok: true; say: string } | { ok: false; error: string }>;
  change: (p: any, instruction: string) => Promise<{ ok: true; say: string } | { ok: false; error: string }>;
  answer: (p: any, text: string) => Promise<{ ok: true; say: string } | { ok: false; error: string }>;
};

async function liveDeps(userId: string): Promise<Deps> {
  const team = await import("./team.js");
  const review = await import("./review.js");
  return {
    status: async (first, pendingOpen) => {
      const text = await team.moStatusText(first);
      // Asking where things stand also brings the next person when nothing
      // is waiting on them.
      if (!pendingOpen) await review.presentNext();
      return text;
    },
    person: async (query) => {
      const found = await team.findProspects(query);
      return found.length ? found.map(team.prospectStatusLine).join(" ") : `I don't have anyone called ${query} on my list.`;
    },
    focus: (text) => team.addFocus(text, userId),
    pause: (paused) => team.setPaused(paused, userId),
    approve: (p) => review.approveProspect(p, userId),
    skip: (p) => review.skipProspect(p),
    change: (p, instruction) => review.changeDraft(p, instruction),
    answer: (p, text) => review.sendAnswer(p, text),
  };
}

function dryDeps(): Deps {
  const ok = (say: string) => Promise.resolve({ ok: true as const, say });
  return {
    status: async () => "[status]",
    person: async (q) => `[status of ${q}]`,
    focus: async () => {},
    pause: async () => {},
    approve: () => ok("[approved]"),
    skip: () => ok("[skipped]"),
    change: () => ok("[new version]"),
    answer: () => ok("[answer sent]"),
  };
}

export async function runMoTeamTurn(input: TeamTurnInput): Promise<TeamTurn> {
  const deps = input.dryRun ? dryDeps() : await liveDeps(input.userId);
  const says: string[] = [];
  const notDone: string[] = [];
  const used: string[] = [];
  let passed = false;
  const pending = input.pending;
  const say = (s: string) => {
    says.push(s);
    return { ok: true, say: s };
  };
  const needs = (kind: "review" | "question") => (pending?.kind === kind ? null : { ok: false, error: `You aren't waiting on ${kind === "review" ? "a yes or no about anyone" : "an answer to anyone's question"} right now, so nothing was done.` });
  const done = (r: { ok: true; say: string } | { ok: false; error: string }) => (r.ok ? say(r.say) : { ok: false, error: r.error });

  const raw = {
    notForMo: tool({
      description: "Their message is for Co, not you. Call this alone and write nothing.",
      inputSchema: z.object({}),
      execute: async () => {
        passed = true;
        return { ok: true };
      },
    }),
    moStatus: tool({
      description: moToolUse("moStatus"),
      inputSchema: z.object({}),
      execute: async () => say(await deps.status(input.approverFirst, Boolean(pending))),
    }),
    moPersonStatus: tool({
      description: moToolUse("moPersonStatus"),
      inputSchema: z.object({ who: z.string().describe("Their name or handle, as the team said it.") }),
      execute: async ({ who }) => say(await deps.person(who)),
    }),
    moSetFocus: tool({
      description: moToolUse("moSetFocus"),
      inputSchema: z.object({ kindOfPerson: z.string().describe("The kind of person to look for, a few general words.") }),
      execute: async ({ kindOfPerson }) => {
        const k = kindOfPerson.trim().replace(/^(for|some|more)\s+/i, "");
        if (k.length < 3) return { ok: false, error: "Say what kind of person, in a few words." };
        await deps.focus(k);
        return say(`Got it, I'll look for ${k} in my next search (Monday mornings).`);
      },
    }),
    moPause: tool({
      description: moToolUse("moPause"),
      inputSchema: z.object({}),
      execute: async () => {
        await deps.pause(true);
        return say(`Paused. No new searches or outreach until you tell me to start again. If someone I already reached out to writes back, I'll still bring it to you.`);
      },
    }),
    moResume: tool({
      description: moToolUse("moResume"),
      inputSchema: z.object({}),
      execute: async () => {
        await deps.pause(false);
        return say(`Back on. I'll pick up where I left off.`);
      },
    }),
    moApprove: tool({
      description: moToolUse("moApprove"),
      inputSchema: z.object({}),
      execute: async () => needs("review") ?? done(await deps.approve(pending!.p)),
    }),
    moSkip: tool({
      description: moToolUse("moSkip"),
      inputSchema: z.object({}),
      execute: async () => needs("review") ?? done(await deps.skip(pending!.p)),
    }),
    moChangeDraft: tool({
      description: moToolUse("moChangeDraft"),
      inputSchema: z.object({ change: z.string().describe("The change they asked for, in their words.") }),
      execute: async ({ change }) => needs("review") ?? done(await deps.change(pending!.p, change)),
    }),
    moSendAnswer: tool({
      description: moToolUse("moSendAnswer"),
      inputSchema: z.object({}),
      // Their own words, never Mo's version of them.
      execute: async () => needs("question") ?? done(await deps.answer(pending!.p, input.text)),
    }),
  };
  const tools = guardTools(raw as Record<string, any>, {
    userId: input.userId,
    resolvedContent: input.text,
    dryRun: Boolean(input.dryRun),
    notDone: (w) => notDone.push(w),
    abilityFor: moAbilityForTool,
  });
  for (const [name, t] of Object.entries(tools)) {
    const run = t.execute;
    t.execute = async (a: any, o: any) => {
      used.push(name);
      return run(a, o);
    };
  }

  let text = "";
  try {
    const r = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" as const } },
      system: teamSystem(input),
      prompt: input.text.slice(0, 1500),
      tools,
      stopWhen: [stepCountIs(5), () => passed],
      experimental_telemetry: { isEnabled: true, functionId: "mo.teamTurn" },
    });
    text = r.text.trim();
  } catch (err: any) {
    console.error("mo team turn failed:", err?.message ?? err);
    // Nothing was understood, so nothing is claimed; Co answers instead
    // unless a tool already acted.
    if (!says.length) return { reply: null, passed: true, tools: used, notDone };
  }

  let reply = passed && !says.length ? null : finalReply(text, says, input.approverFirst);
  // Mo's own words are held to what Mo can do and what its tools just did,
  // the same claim check as Co's (2026-09-26: "I can still get today's 5
  // moving"). Unsupported sentences are cut; what the tools said stays.
  if (reply) reply = await holdToFacts(reply, says, input);
  if (!input.dryRun) {
    await recordDecision({
      layer: 5,
      decision: "mo.teamTurn",
      userId: input.userId,
      outcome: reply === null ? "skip" : "act",
      action: reply === null ? "not_for_mo" : used.join(",") || "reply_only",
      proposal: { message: input.text.slice(0, 300), pending: pending ? { kind: pending.kind, no: pending.p.no } : null, notDone },
      reason: (reply ?? "").slice(0, 300),
    }).catch(() => {});
    if (pending && reply !== null && used.some((u) => ["moApprove", "moSkip", "moChangeDraft", "moSendAnswer"].includes(u))) {
      const { recordApproval } = await import("./review.js");
      await recordApproval(input.userId, pending.kind, pending.p.no, reply);
    }
  }
  return { reply, passed: reply === null, tools: used, notDone };
}

export async function holdToFacts(reply: string, says: string[], input: Pick<TeamTurnInput, "text" | "pending" | "approverFirst">): Promise<string> {
  const { addFact, claimChecksOnly, createReplyFacts, stripUnsupported } = await import("../harness/replyGrounding.js");
  const rf = createReplyFacts();
  for (const c of moCapabilitySheet()) addFact(rf, "capability", c);
  for (const s of says) addFact(rf, "did_this_turn", `Mo's tools just reported: ${s}`);
  addFact(rf, "known", `What Mo is waiting on: ${pendingLine(input.pending)}`);
  const failed = (await claimChecksOnly(reply, rf, { message: input.text, recentConversation: "" }).catch(() => [])).filter((c) => !c.pass);
  if (!failed.length) return reply;
  const kept = stripUnsupported(reply, failed).trim();
  if (says.every((s) => kept.includes(s.trim())) && kept.split(/\s+/).length >= 3) return kept;
  return says.length ? says.join("\n\n") : kept || `${MO_RULES.opener(input.approverFirst)} I can't do that one.`;
}

// Mo's words around what its tools reported. Every `say` has to be in the
// reply as written; if the model paraphrased one away, the tools' own lines
// are sent instead.
export function finalReply(text: string, says: string[], approverFirst: string | null): string {
  const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/ - /g, ", ").trim();
  // The opener once: some tools' lines already start with it.
  const opener = MO_RULES.opener(approverFirst);
  const once = (s: string) => {
    let out = s;
    while (out.includes(`${opener} ${opener}`)) out = out.replace(`${opener} ${opener}`, opener);
    return out;
  };
  const t = once(clean(text));
  const carries = says.every((s) => t.includes(clean(s)));
  if (t && carries) return t;
  if (says.length) return once(says.map(clean).join("\n\n"));
  return t || `${MO_RULES.opener(approverFirst)} I didn't catch that. Want where things stand?`;
}
