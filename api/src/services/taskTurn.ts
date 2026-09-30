// Co working on one of its tasks by itself (services/coTasks.ts). When a task's
// check-in comes due, Co wakes up with the task, its steps and notes, and the
// recent conversation, and decides what to do: search, read a page, write down
// what it learned, text the member if there's something real, and when to look
// again, or close it. It's Co's plan; code guards the edges (coTasks.ts).
//
// What a task may tell them (2026-09-30): web results prove themselves first
// (services/taskWeb.ts), and a text is drafted only from verified fields, with
// every number in it backed by them.
import { CO_VOICE } from "./coVoice.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { checkDraft, draftAgain, draftProactive, localHourOk, sendExempt } from "../harness/proactive.js";
import { searchWithTimeCap } from "../agent/conversationTools.js";
import { closeTask, isExhausted, isFinalCheck, markFinalTold, markTexted, mayText, noteOnTask, scheduleTask, taskTextsToday, TASK_LIMITS, clampNextHours, type CoTask } from "./coTasks.js";
import { describeRead, excerptFact, readLink } from "./linkReader.js";
import { getTimezoneForCity } from "./geocoding.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";
import { recordSentItems } from "./coFacts.js";
import { numbersBacked, OFFERS_WHAT_CO_CANT, placesBacked, taskWebSearch, verifiedFactLines, type TaskWebResult, type VerifiedResult } from "./taskWeb.js";

export const TASK_MODEL = MODELS.sonnet;

// What a task turn reads and writes. Real turns use the database and send
// texts; a dry turn (evals) keeps everything in memory and sends nothing.
export type TaskTurnDeps = {
  person: { first_name: string | null; phone_number: string; city: string | null };
  recent: string;
  zone: string | null;
  note: (text: string, stepDone: string | null) => Promise<void>;
  schedule: (inHours: number, plan: string) => Promise<string | null>;
  close: (status: "done" | "dropped" | "expired", outcome: string) => Promise<void>;
  textsToday: () => Promise<number>;
  send: (messages: string[]) => Promise<{ sent: boolean; reason?: string }>;
  markTexted: () => Promise<void>;
  markFinalTold: () => Promise<void>;
  search: (what: string) => Promise<{ name: string; url: string | null; date: string | null }[]>;
  web: (what: string) => Promise<TaskWebResult>;
  readPage: (url: string) => Promise<{ ok: boolean; facts: string[]; text: string }>;
  now: () => Date;
};

export function taskTurnPrompt(o: { task: CoTask; firstName: string; now: string; zone: string | null; recent: string; final?: boolean }): string {
  const t = o.task;
  const deadlineLine = t.deadline ? `\nTheir deadline: ${t.deadline}.` : "";
  const finalLine = o.final
    ? `\nTHIS IS YOUR LAST CHECK BEFORE THEIR DEADLINE. Do what you can now, then tellThem plainly where it stands, even if the answer is that nothing real turned up. Don't go quiet on a deadline. Keep the task open and schedule your next look unless they've said they don't need it; if you ask them something, their answer wakes it. Don't mark a step done that you didn't do (sending options you don't have isn't done).`
    : "";
  return `${CO_VOICE}

Right now you're working in the background on something ${o.firstName} asked you to do. Nobody is waiting on this message; you're doing the work, then deciding what's next.

Their goal: "${t.goal}"
Their own words when they asked: "${t.theirWords}"
Steps: ${t.steps.length ? t.steps.map((s) => `${s.done ? "[done]" : "[ ]"} ${s.text}`).join("; ") : "(none written)"}
What you planned to do now: ${t.planNext ?? "(nothing written)"}${deadlineLine}${finalLine}
Your notes so far (oldest first):
${t.notes.map((n) => `- [${n.at.slice(0, 16)}] ${n.text}`).join("\n") || "- (none)"}
This is wake-up ${t.wakes} of at most ${TASK_LIMITS.maxWakes}. Now: ${o.now}${o.zone ? ` (their time zone: ${o.zone})` : ""}.

Your recent texts with them (oldest first; read their newest messages first, they may have answered you or changed their mind):
${o.recent || "(none)"}

Do the next real step with your tools (search for events and opportunities, webSearch for anything else such as venues, vendors, people or prices, readPage), and write down what you learned with note. When you finish a step, call note with stepDone set to that step's exact text. Only mark a step done when you actually did it; closing a task doesn't finish its steps.
Then decide:
- If they've said they don't need it anymore, found it themselves, or it's done: finish it (and tellThem only if a short close-out helps).
- Text them (tellThem) only when there's something real to tell or a question only they can answer, never just to say you're still working on it. Only verified results can be told.
- Otherwise schedule your next look (scheduleNext): pick the time that makes sense for this (before a deadline, after a date they gave, a few days for things that change slowly), and write what you'll do then.
You must end with scheduleNext or finish. Never make up results: only what your tools returned.`;
}

type Found = { name: string; url: string | null; facts: string[] };

export async function runTaskTurnWith(task: CoTask, deps: TaskTurnDeps): Promise<{ action: string; did: string[]; texts: string[]; final: boolean }> {
  const final = isFinalCheck(task, deps.now());
  const verified: VerifiedResult[] = [];
  const events: Found[] = [];
  const pageFacts: string[] = [];
  const texts: string[] = [];
  const did: string[] = [];
  let decided: "scheduled" | "finished" | null = null;
  const linkOk = (l: string) => verified.some((v) => v.url === l) || events.some((e) => e.url === l);

  const tell = async (what: string, links?: string[]) => {
        // Outside their hours nothing is held in memory to send later: Co waits for their morning.
        if (!localHourOk(deps.now(), deps.zone)) return { ok: false, error: "It's outside their hours (9am to 8pm their time). Note what you'd tell them and schedule your next look for their morning." };
        const allowed = mayText(task, await deps.textsToday(), deps.now());
        if (!allowed.ok) return { ok: false, error: `Not sent: ${allowed.why}. Note it and schedule the next look instead.` };
        const known = (links ?? []).filter(linkOk);
        // Only verified fields: web results that proved themselves, events from Co's
        // own gated search, and fields the page reader verified. Never raw page text.
        const facts = {
          what_they_asked_for: task.goal,
          their_words: task.theirWords,
          verified_results: verifiedFactLines(verified).join(" | ") || "(none)",
          events_found: events.map((e) => `${e.name}${e.url ? ` (${e.url})` : ""}${e.facts.length ? `: ${e.facts.join("; ")}` : ""}`).join(" | ") || "(none)",
          verified_page_facts: pageFacts.join(" | ") || "(none)",
        };
        let text = await draftProactive({
          functionId: "taskTurn.tell",
          firstName: deps.person.first_name || "them",
          facts,
          task: `Tell them where this stands, in your own voice. What to get across (a guide to your intent, not a source: state only what's in CONFIRMED_FACTS): ${what}. Don't put links in the text; they go right after it. Never offer to call, book, reserve or contact anyone for them: you can't. No sign-off.`,
          maxSentences: 4,
        }).catch(() => null);
        if (!text) return { ok: false, error: "Nothing worth sending came out of the verified facts. Note it and schedule the next look." };
        let failed = checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass);
        // One redraft with what broke, in code, so a long first draft doesn't use up
        // Co's steps (2026-09-30: three verified caterers found, nothing sent).
        if (failed.length) {
          const again = await draftAgain({ draft: text, failed: failed.map((f) => f.reason ?? f.name).join("; ") }, () =>
            draftProactive({ functionId: "taskTurn.tell", firstName: deps.person.first_name || "them", facts, task: `Tell them where this stands in at most 3 short sentences. What to get across (a guide, not a source: state only what's in CONFIRMED_FACTS): ${what}. No links in the text. Never offer to call, book, reserve or contact anyone for them. No sign-off.`, maxSentences: 3 }),
          ).catch(() => null);
          if (again) {
            text = again;
            failed = checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass);
          }
        }
        if (failed.length) return { ok: false, error: `The draft broke a rule (${failed.map((f) => f.name).join(", ")}). Note it and schedule the next look.` };
        const nums = numbersBacked(text, Object.values(facts).join(" "));
        if (!nums.ok) return { ok: false, error: `The draft had numbers no verified fact backs (${nums.missing.join(", ")}). Tell them only verified facts.` };
        const places = placesBacked(text, Object.values(facts).join(" "));
        if (!places.ok) return { ok: false, error: `The draft named places no verified fact backs (${places.missing.join(", ")}). Tell them only verified facts.` };
        const offer = text.match(OFFERS_WHAT_CO_CANT);
        if (offer) return { ok: false, error: `The draft offered something Co can't do ("${offer[0]}"): Co can't call, book or contact anyone for them. Suggest they do it, or ask what they'd like next.` };
        const sent = await deps.send([text, ...known]);
        if (!sent.sent) return { ok: false, error: `Couldn't send: ${sent.reason ?? "unknown"}.` };
        await deps.markTexted();
        await deps.note(`Texted them: ${text.slice(0, 200)}`, null);
        texts.push(text, ...known);
        did.push("texted them");
        return { ok: true, sent: text };
  };

  const tools = {
    search: tool({
      description: "Search for events, communities, programs or opportunities for this task. One plain sentence of what to look for.",
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }) => {
        did.push(`search: ${what}`);
        const items = await deps.search(what).catch(() => []);
        for (const i of items) if (!events.some((e) => e.name === i.name)) events.push({ name: i.name, url: i.url, facts: i.date ? [`date: ${i.date}`] : [] });
        return items.length ? { found: items } : { found: [], note: "Nothing real came up." };
      },
    }),
    webSearch: tool({
      description: "Search the whole web for anything the task needs that isn't an event: venues, vendors, prices, people, how-tos, programs. One plain sentence of what to find. Every result is checked against its own page; only its listed facts are verified.",
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }) => {
        if (did.filter((d) => d.startsWith("web:")).length >= 3) return { found: [], note: "That's the web searches for this wake-up. Work with what you have, note it, and schedule the next look." };
        did.push(`web: ${what}`);
        const r = await deps.web(what);
        for (const k of r.kept) if (!verified.some((v) => v.url === k.url)) verified.push(k);
        return { found: r.kept.map((k) => ({ name: k.name, url: k.url, official: k.official, verifiedFacts: k.facts, date: k.date, deadline: k.deadline })), droppedBecause: r.dropped.map((d) => `${d.name}: ${d.why}`), note: r.note };
      },
    }),
    readPage: tool({
      description: "Read a web page (a link from the search, their words, or your notes) and get what it says.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        did.push(`read: ${url}`);
        const r = await deps.readPage(url).catch(() => ({ ok: false, facts: [] as string[], text: "" }));
        pageFacts.push(...r.facts);
        return { ok: r.ok, verifiedFacts: r.facts, pageText: r.text.slice(0, 2500) };
      },
    }),
    note: tool({
      description: "Write down what you learned or did, in one or two plain sentences. When you finished a step, set stepDone to that step's exact text.",
      inputSchema: z.object({ text: z.string(), stepDone: z.string().optional() }),
      execute: async ({ text, stepDone }) => {
        await deps.note(text, stepDone ?? null);
        did.push(`note: ${text.slice(0, 120)}${stepDone ? ` [done: ${stepDone.slice(0, 60)}]` : ""}`);
        return { ok: true };
      },
    }),
    tellThem: tool({
      description: "Text them what you found or ask what only they can answer. Say what it should get across; it's written in your voice from verified results only.",
      inputSchema: z.object({ what: z.string().describe("What the text should get across, plainly."), links: z.array(z.string()).max(2).optional().describe("Links from verified results to send with it.") }),
      execute: async ({ what, links }) => tell(what, links),
    }),
    scheduleNext: tool({
      description: `When to work on this next, in hours from now (${TASK_LIMITS.minHours} to ${TASK_LIMITS.maxHours}), and what you'll do then.`,
      inputSchema: z.object({ inHours: z.number(), plan: z.string() }),
      execute: async ({ inHours, plan }) => {
        const at = await deps.schedule(inHours, plan);
        decided = "scheduled";
        did.push(`next in ${clampNextHours(inHours)}h: ${plan.slice(0, 100)}`);
        return { ok: !!at, nextCheckAt: at };
      },
    }),
    finish: tool({
      description: "Close the task: done, or they no longer need it.",
      inputSchema: z.object({ outcome: z.string(), status: z.enum(["done", "dropped"]) }),
      execute: async ({ outcome, status }) => {
        await deps.close(status, outcome);
        decided = "finished";
        did.push(`finished (${status}): ${outcome.slice(0, 100)}`);
        return { ok: true };
      },
    }),
  };

  try {
    await generateText({
      model: anthropic(TASK_MODEL),
      maxOutputTokens: 6000,
      providerOptions: { anthropic: { effort: "medium" } },
      experimental_telemetry: { isEnabled: true, functionId: "taskTurn.run" },
      tools,
      stopWhen: [stepCountIs(12), () => decided !== null],
      prompt: taskTurnPrompt({ task, firstName: deps.person.first_name || "them", now: deps.now().toISOString().slice(0, 16), zone: deps.zone, recent: deps.recent, final }),
    });
  } catch (err: any) {
    console.error("taskTurn failed (non-fatal):", err?.message ?? err);
  }
  // The last check before their deadline never goes quiet: if Co didn't tell them,
  // code does, from what's verified, even when that's "nothing real yet".
  if (final && !texts.length) {
    const r = await tell("Be straight about where this stands before their deadline: what you found that's real, or plainly that nothing real turned up yet, and what, if anything, you'll still do.");
    did.push(r.ok ? "final check: told them where it stands" : `final check: couldn't tell them (${"error" in r ? r.error : "unknown"})`);
  }
  if (final && texts.length) await deps.markFinalTold();
  // Co didn't decide: look again tomorrow rather than leave it hanging.
  if (!decided) await deps.schedule(24, task.planNext ?? "Pick up where I left off.");
  return { action: decided ?? "defaulted_24h", did, texts, final };
}

// A real wake-up: the database, the web budget, and texts to their phone.
export async function runTaskTurn(task: CoTask): Promise<{ action: string }> {
  const userId = task.userId;
  if (isExhausted(task, new Date())) {
    await closeTask(userId, task.id, "expired", "Ran out of wake-ups or days.");
    await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "skip", action: "expired", proposal: { taskId: task.id } }).catch(() => {});
    return { action: "expired" };
  }
  const [{ rows: u }, { rows: convo }] = await Promise.all([
    pool.query(`SELECT u.first_name, u.phone_number, u.sms_opted_out, u.archived_at, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]),
    pool.query(`SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 14`, [userId]),
  ]);
  const person = u[0];
  if (!person || person.sms_opted_out || person.archived_at) {
    await closeTask(userId, task.id, "dropped", "Member opted out or archived.");
    return { action: "dropped" };
  }
  const zone = person.city ? await getTimezoneForCity(person.city).catch(() => null) : null;
  const deps: TaskTurnDeps = {
    person,
    zone,
    recent: withoutTeammateLines(convo.map((r: any) => String(r.content)).reverse().join("\n")).slice(-3000),
    note: async (text, stepDone) => void (await noteOnTask(userId, task.id, text, stepDone)),
    schedule: async (h, plan) => (await scheduleTask(userId, task.id, h, plan))?.nextCheckAt ?? null,
    close: async (status, outcome) => void (await closeTask(userId, task.id, status, outcome)),
    textsToday: () => taskTextsToday(userId),
    send: async (messages) => {
      const r = await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_update", targetKey: `task:${task.id}:${Date.now()}`, messages, timezone: zone, respectHours: true });
      const urls = messages.filter((m) => /^https?:\/\//.test(m));
      if (r.sent && urls.length) await recordSentItems(userId, urls.map((url) => ({ name: url, url })), "taskTurn").catch(() => {});
      return { sent: r.sent, reason: r.reason };
    },
    markTexted: () => markTexted(userId, task.id),
    markFinalTold: () => markFinalTold(userId, task.id),
    search: async (what) => {
      const r = await searchWithTimeCap(userId, what, 60_000, "taskTurn.search").catch(() => ({ available: false as const, reason: "search failed" }));
      if (!r.available || !("matches" in r) || !r.matches?.length) return [];
      return r.matches.slice(0, 4).map((m: any) => ({ name: String(m.name), url: m.url ? String(m.url) : null, date: typeof m.event_date === "string" ? m.event_date.slice(0, 10) : null }));
    },
    web: (what) => taskWebSearch(userId, what, { city: person.city, zone, taskId: task.id }),
    readPage: async (url) => {
      const r = await readLink(url, { ownerUserId: userId }).catch(() => null);
      if (!r) return { ok: false, facts: [], text: "" };
      const ex = excerptFact(url, r);
      return { ok: r.status === "ok", facts: describeRead(url, r).facts, text: ex ?? "" };
    },
    now: () => new Date(),
  };
  const r = await runTaskTurnWith(task, deps);
  await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "act", action: r.action, proposal: { taskId: task.id, did: r.did, final: r.final, deadline: task.deadline } }).catch(() => {});
  return { action: r.action };
}

export async function runDueTasks(): Promise<void> {
  const { claimDueTasks } = await import("./coTasks.js");
  for (const t of await claimDueTasks()) await runTaskTurn(t);
}
