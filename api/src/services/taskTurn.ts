// Co working on one of its tasks by itself (services/coTasks.ts). When a task's
// check-in comes due, Co wakes up with the task, its steps and notes, and the
// recent conversation, and decides what to do: search, read a page, write down
// what it learned, text the member if there's something real, and when to look
// again, or close it. It's Co's plan; code guards the edges (coTasks.ts), and a
// text is drafted in Co's voice only from what the task actually found.
import { CO_VOICE } from "./coVoice.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { checkDraft, draftProactive, localHourOk, sendExempt } from "../harness/proactive.js";
import { reserveWebSearch } from "./webOpportunitySearch.js";
import { parseModelJson } from "./modelJson.js";
import { searchWithTimeCap } from "../agent/conversationTools.js";
import { closeTask, isExhausted, markTexted, mayText, noteOnTask, scheduleTask, taskTextsToday, TASK_LIMITS, type CoTask } from "./coTasks.js";
import { describeRead, excerptFact, readLink } from "./linkReader.js";
import { getTimezoneForCity } from "./geocoding.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";
import { recordSentItems } from "./coFacts.js";

export const TASK_MODEL = MODELS.sonnet;

type Found = { name: string; url: string | null; about: string };

export function taskTurnPrompt(o: { task: CoTask; firstName: string; now: string; zone: string | null; recent: string }): string {
  const t = o.task;
  return `${CO_VOICE}

Right now you're working in the background on something ${o.firstName} asked you to do. Nobody is waiting on this message; you're doing the work, then deciding what's next.

Their goal: "${t.goal}"
Their own words when they asked: "${t.theirWords}"
Steps: ${t.steps.length ? t.steps.map((s) => `${s.done ? "[done]" : "[ ]"} ${s.text}`).join("; ") : "(none written)"}
What you planned to do now: ${t.planNext ?? "(nothing written)"}
Your notes so far (oldest first):
${t.notes.map((n) => `- [${n.at.slice(0, 16)}] ${n.text}`).join("\n") || "- (none)"}
This is wake-up ${t.wakes} of at most ${TASK_LIMITS.maxWakes}. Now: ${o.now}${o.zone ? ` (their time zone: ${o.zone})` : ""}.

Your recent texts with them (oldest first):
${o.recent || "(none)"}

Do the next real step with your tools (search for events and opportunities, webSearch for anything else such as venues, vendors or prices, readPage), and write down what you learned with note. Then decide:
- Text them (tellThem) only when there's something real to tell or a question only they can answer. Not to say you're still working on it.
- If they've said since that they don't need it anymore, or it's done, finish it.
- Otherwise schedule your next look (scheduleNext): pick the time that makes sense for this (before a deadline, after a date they gave, a few days for things that change slowly), and write what you'll do then.
You must end with scheduleNext or finish. Never make up results: only what your tools returned.`;
}

export async function runTaskTurn(task: CoTask): Promise<{ action: string }> {
  const userId = task.userId;
  if (isExhausted(task, new Date())) {
    await closeTask(userId, task.id, "expired", "Ran out of wake-ups or days.");
    await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "skip", action: "expired", proposal: { taskId: task.id } }).catch(() => {});
    return { action: "expired" };
  }
  const [{ rows: u }, { rows: convo }] = await Promise.all([
    pool.query(`SELECT u.first_name, u.phone_number, u.sms_opted_out, u.archived_at, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]),
    pool.query(
      `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 14`,
      [userId],
    ),
  ]);
  const person = u[0];
  if (!person || person.sms_opted_out || person.archived_at) {
    await closeTask(userId, task.id, "dropped", "Member opted out or archived.");
    return { action: "dropped" };
  }
  const zone = person.city ? await getTimezoneForCity(person.city).catch(() => null) : null;
  const recent = withoutTeammateLines(convo.map((r: any) => String(r.content)).reverse().join("\n")).slice(-3000);

  const found: Found[] = [];
  const pages: string[] = [];
  let decided: "scheduled" | "finished" | null = null;
  const did: string[] = [];

  const tools = {
    search: tool({
      description: "Search for events, communities, programs or opportunities for this task. One plain sentence of what to look for.",
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }) => {
        did.push(`search: ${what}`);
        const r = await searchWithTimeCap(userId, what, 60_000, "taskTurn.search").catch(() => ({ available: false as const, reason: "search failed" }));
        if (!r.available || !("matches" in r) || !r.matches?.length) return { found: [], note: "Nothing real came up." };
        const items = r.matches.slice(0, 4).map((m: any) => ({ name: String(m.name), url: m.url ? String(m.url) : null, about: String(m.reason ?? "").slice(0, 240) }));
        found.push(...items.filter((i) => !found.some((f) => f.name === i.name)));
        return { found: items };
      },
    }),
    // The whole web, not just events (2026-09-30: asked for a venue, the event
    // search only returned meetups). Shares the web search budget with the sweep;
    // only pages that really read are kept.
    webSearch: tool({
      description: "Search the whole web for anything the task needs that isn't an event: venues, vendors, prices, people, how-tos, programs. One plain sentence of what to find.",
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }) => {
        did.push(`web: ${what}`);
        const budget = await reserveWebSearch(userId, "sweep", what);
        if (!budget.ok) return { found: [], note: `No web search right now: ${budget.reason}.` };
        try {
          const { text: raw } = await generateText({
            model: anthropic(TASK_MODEL),
            providerOptions: { anthropic: { effort: "low" } },
            experimental_telemetry: { isEnabled: true, functionId: "taskTurn.webSearch", metadata: { userId } },
            tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 2 }) },
            stopWhen: stepCountIs(3),
            timeout: 60_000,
            prompt: `Find on the real web: ${what}${person.city ? ` (they're in ${person.city})` : ""}. Today: ${new Date().toISOString().slice(0, 10)}.
Up to 3 real, specific options, each from a page you actually read. Return ONLY JSON: {"items": [{"name": "...", "url": "the page you read", "about": "one line: what it is and the details that matter (capacity, price, dates) from that page"}]}. {"items": []} if nothing real.`,
          });
          const items = (parseModelJson<{ items?: { name?: string; url?: string; about?: string }[] }>(raw)?.items ?? []).filter((i) => i.name && i.url && /^https?:\/\//.test(i.url)).slice(0, 3);
          const kept: Found[] = [];
          for (const i of items) {
            // Only what really reads: the page opens and names the thing.
            const r = await readLink(i.url!, { ownerUserId: userId }).catch(() => null);
            const word = String(i.name).toLowerCase().split(/\s+/).find((w) => w.length >= 4) ?? "";
            if (!r || r.status !== "ok" || (word && !`${r.excerpt ?? ""} ${r.summary ?? ""}`.toLowerCase().includes(word))) continue;
            const f = { name: String(i.name).slice(0, 120), url: i.url!, about: String(i.about ?? "").slice(0, 240) };
            kept.push(f);
            if (!found.some((x) => x.url === f.url)) found.push(f);
            pages.push(`${f.name} (${f.url}): ${(r.excerpt ?? "").slice(0, 1200)}`);
          }
          return { found: kept, note: kept.length ? "Each of these pages was read." : "Nothing real came back that could be read." };
        } catch (err: any) {
          return { found: [], note: `Web search failed: ${err?.message ?? "error"}.` };
        }
      },
    }),
    readPage: tool({
      description: "Read a web page (a link from the search, their words, or your notes) and get what it says.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        did.push(`read: ${url}`);
        const r = await readLink(url, { ownerUserId: userId }).catch(() => null);
        if (!r) return { ok: false, note: "Couldn't read it." };
        const d = describeRead(url, r);
        const ex = excerptFact(url, r);
        const text = [...d.facts, ...(ex ? [ex.slice(0, 2500)] : [])].join("\n");
        pages.push(text);
        return { ok: r.status === "ok", page: text };
      },
    }),
    note: tool({
      description: "Write down what you learned or did, in one or two plain sentences. Name a step as done if you finished it.",
      inputSchema: z.object({ text: z.string(), stepDone: z.string().optional().describe("The step text you finished, if any.") }),
      execute: async ({ text, stepDone }) => {
        await noteOnTask(userId, task.id, text, stepDone ?? null);
        did.push(`note: ${text.slice(0, 120)}`);
        return { ok: true };
      },
    }),
    tellThem: tool({
      description: "Text them what you found or ask what only they can answer. Say what it should get across; it's written in your voice from what your tools found.",
      inputSchema: z.object({ what: z.string().describe("What the text should say, plainly."), links: z.array(z.string()).max(2).optional().describe("Links from what you found to send with it.") }),
      execute: async ({ what, links }) => {
        // Outside their hours nothing is held in memory to send later (2026-09-30: a
        // queued update died with the process that queued it): Co waits for their morning.
        if (!localHourOk(new Date(), zone)) return { ok: false, error: "It's outside their hours (9am to 8pm their time). Note what you'd tell them and schedule your next look for their morning." };
        const allowed = mayText(task, await taskTextsToday(userId), new Date());
        if (!allowed.ok) return { ok: false, error: `Not sent: ${allowed.why}. Note it and schedule the next look instead.` };
        const known = (links ?? []).filter((l) => found.some((f) => f.url === l) || pages.some((p) => p.includes(l)));
        const facts = {
          what_they_asked_for: task.goal,
          their_words: task.theirWords,
          what_co_did: did.slice(-6).join("; "),
          what_co_found: found.slice(0, 4).map((f) => `${f.name}${f.url ? ` (${f.url})` : ""}: ${f.about}`).join(" | ") || "(nothing new)",
          what_the_pages_say: pages.join("\n").slice(0, 2500) || "(no pages read)",
          what_co_wants_to_tell_them: what,
        };
        const text = await draftProactive({
          functionId: "taskTurn.tell",
          firstName: person.first_name || "them",
          facts,
          task: "Tell them where this stands, in your own voice: what you found or did for what they asked, and the one thing they need to know or decide. Only what's in the facts. Don't put links in the text; they go right after it. No sign-off.",
          maxSentences: 4,
        }).catch(() => null);
        if (!text) return { ok: false, error: "Nothing worth sending came out. Note it and schedule the next look." };
        const failed = checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass);
        if (failed.length) return { ok: false, error: `The draft broke a rule (${failed.map((f) => f.name).join(", ")}). Note it and schedule the next look.` };
        const sent = await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_update", targetKey: `task:${task.id}:${Date.now()}`, messages: [text, ...known], timezone: zone, respectHours: true });
        if (!sent.sent) return { ok: false, error: `Couldn't send: ${sent.reason ?? "unknown"}.` };
        await markTexted(userId, task.id);
        if (known.length) await recordSentItems(userId, found.filter((f) => f.url && known.includes(f.url)).map((f) => ({ name: f.name, url: f.url })), "taskTurn").catch(() => {});
        // Outside their hours it waits for the morning; the note says which.
        await noteOnTask(userId, task.id, `Texted them: ${text.slice(0, 200)}`);
        did.push("texted them");
        return { ok: true, sent: text };
      },
    }),
    scheduleNext: tool({
      description: `When to work on this next, in hours from now (${TASK_LIMITS.minHours} to ${TASK_LIMITS.maxHours}), and what you'll do then.`,
      inputSchema: z.object({ inHours: z.number(), plan: z.string() }),
      execute: async ({ inHours, plan }) => {
        const t = await scheduleTask(userId, task.id, inHours, plan);
        decided = "scheduled";
        return { ok: !!t, nextCheckAt: t?.nextCheckAt };
      },
    }),
    finish: tool({
      description: "Close the task: done, or they no longer need it.",
      inputSchema: z.object({ outcome: z.string(), status: z.enum(["done", "dropped"]) }),
      execute: async ({ outcome, status }) => {
        await closeTask(userId, task.id, status, outcome);
        decided = "finished";
        return { ok: true };
      },
    }),
  };

  try {
    await generateText({
      model: anthropic(TASK_MODEL),
      maxOutputTokens: 6000,
      providerOptions: { anthropic: { effort: "medium" } },
      experimental_telemetry: { isEnabled: true, functionId: "taskTurn.run", metadata: { userId } },
      tools,
      stopWhen: [stepCountIs(8), () => decided !== null],
      prompt: taskTurnPrompt({ task, firstName: person.first_name || "them", now: new Date().toISOString().slice(0, 16), zone, recent }),
    });
  } catch (err: any) {
    console.error("taskTurn failed (non-fatal):", err?.message ?? err);
  }
  // Co didn't decide: look again tomorrow rather than leave it hanging.
  if (!decided) await scheduleTask(userId, task.id, 24, task.planNext ?? "Pick up where I left off.");
  const action = decided ?? "defaulted_24h";
  await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "act", action, proposal: { taskId: task.id, did } }).catch(() => {});
  return { action };
}

export async function runDueTasks(): Promise<void> {
  const { claimDueTasks } = await import("./coTasks.js");
  for (const t of await claimDueTasks()) await runTaskTurn(t);
}
