// Co working on one of its tasks by itself (services/coTasks.ts). When a task's
// check-in comes due, Co wakes up with the task, its steps and notes, and the
// recent conversation, and decides what to do: search, read a page, write down
// what it learned, text the member if there's something real, and when to look
// again, or close it. It's Co's plan; code guards the edges (coTasks.ts).
//
// What a task may tell them (2026-09-30): web results prove themselves first
// (services/taskWeb.ts), and a text is drafted only from verified fields, with
// every number in it backed by them.
import { deliveryShapeProblems } from "./speakable.js";
import { CO_VOICE } from "./coVoice.js";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { recordDecision } from "../harness/core.js";
import { checkDraft, draftAgain, draftProactive, localHourOk, sendExempt } from "../harness/proactive.js";
import { eventCandidates } from "./tieredRecommendation.js";
import { alreadyFoundOpenings } from "./eventSurfacingSweep.js";
import { closeTask, isExhausted, isFinalCheck, markFinalTold, markTexted, mayText, noteOnTask, scheduleTask, scheduleTaskAt, setTaskWindow, taskTextsToday, TASK_LIMITS, clampNextHours, type CoTask } from "./coTasks.js";
import { describeRead, excerptFact, readLink } from "./linkReader.js";
import { getTimezoneForCity } from "./geocoding.js";
import { notToTeammate, withoutTeammateLines } from "./teamLines.js";
import { recordSentItems } from "./coFacts.js";
import { numbersBacked, OFFERS_WHAT_CO_CANT, placesBacked, taskWebSearch, verifiedFactLines, type TaskWebResult, type VerifiedResult } from "./taskWeb.js";
import { assembleMessages, captionOk, draftTaskMessages, orderByTier, type SendItem } from "./taskMessages.js";
import { promiseKeptBy, sendsSince, wantsDocument, type Sent } from "./followThrough.js";
import { localStamp, missesWindow, nextSendable, rescheduledWindow, sendableAt, windowLine, type CommitWindow } from "./memberTime.js";
import { toolUse } from "./capabilities.js";
import { WRITE_DOCUMENT_INPUT, type WriteDocumentInput } from "./documentSheet.js";
import type { GateCheck } from "../harness/core.js";

export const TASK_MODEL = MODELS.sonnet;

// What a task turn reads and writes. Real turns use the database and send
// texts; a dry turn (evals) keeps everything in memory and sends nothing.
export type TaskTurnDeps = {
  person: { first_name: string | null; phone_number: string; city: string | null };
  recent: string;
  // The one model of them (services/personModel.ts).
  personModel?: string;
  zone: string | null;
  note: (text: string, stepDone: string | null) => Promise<void>;
  schedule: (inHours: number, plan: string) => Promise<string | null>;
  close: (status: "done" | "dropped" | "expired", outcome: string) => Promise<void>;
  textsToday: () => Promise<number>;
  send: (messages: string[]) => Promise<{ sent: boolean; reason?: string }>;
  markTexted: () => Promise<void>;
  markFinalTold: () => Promise<void>;
  search: (what: string, when?: string | null) => Promise<{ name: string; url: string | null; date: string | null; tier?: number; details?: string[] }[]>;
  web: (what: string) => Promise<TaskWebResult>;
  readPage: (url: string) => Promise<{ ok: boolean; facts: string[]; text: string }>;
  now: () => Date;
  // What Co sent them since a time (texts, links, documents): a promise closes as done only on a matching send after it.
  sentSince?: (since: Date) => Promise<Sent[]>;
  // The document tool, texting's own (services/documentDelivery.ts sendDocumentForTask): grounded, inside their hours, recorded.
  writeDocument?: (input: WriteDocumentInput, o: { read: string }) => Promise<{ ok: true; title: string; via: string } | { ok: false; why: string; nextAt?: Date }>;
  // A commitment's window (services/memberTime.ts): the miss warning, sent once per window through the send path with quiet hours,
  // the window moved to the new time, and the next check set to when the deliverable can go out.
  warn?: (text: string, key: string) => Promise<{ sent: boolean; reason?: string }>;
  setWindow?: (w: CommitWindow) => Promise<void>;
  scheduleAt?: (at: Date, plan: string) => Promise<string | null>;
  draftWarning?: (facts: Record<string, string>, redo?: { draft: string; failed: string }) => Promise<string | null>;
};

// A promise is kept only by something sent AFTER it was made (2026-10-08: task 111 closed itself as done on a document sent the
// day before, on a different focus, and nothing went out after the call). Texts sent in this wake-up count; earlier sends never do.
export async function promiseCloseCheck(task: Pick<CoTask, "goal" | "theirWords" | "createdAt" | "source">, sentThisTurn: string[], deps: Pick<TaskTurnDeps, "sentSince" | "now">, docsThisTurn: string[] = []): Promise<{ ok: boolean; why: string }> {
  if (task.source !== "promise") return { ok: true, why: "not a promise" };
  const at = new Date(task.createdAt);
  // A few days back too, so the refusal can say plainly that an earlier send doesn't count.
  const sends: Sent[] = [
    ...((await deps.sentSince?.(new Date(at.getTime() - 3 * 24 * 3_600_000)).catch(() => [] as Sent[])) ?? []),
    ...sentThisTurn.map((t) => ({ at: deps.now(), text: t, kind: (/^\s*https?:\/\/\S+\s*$/.test(t) ? "link" : "text") as Sent["kind"], forThis: true })),
    // A document this wake-up sent (writeDocument) is a document send, the kind a promised doc or plan needs.
    ...docsThisTurn.map((title) => ({ at: deps.now(), text: `a document (PDF): ${title}`, kind: "document" as const, forThis: true })),
  ];
  const v = promiseKeptBy({ goal: task.goal, theirWords: task.theirWords, at }, sends);
  return { ok: v.kept, why: v.why };
}

// The promised thing is a document (a doc, PDF, write-up, or a plan Co is writing): it goes through writeDocument, never a text.
export function documentPromiseLine(t: Pick<CoTask, "source" | "goal" | "theirWords">): string {
  if (t.source !== "promise" || !wantsDocument(t.goal, t.theirWords)) return "";
  return `\nWHAT YOU PROMISED IS A DOCUMENT. Send it with writeDocument (it arrives as a PDF), never as a text or a run of texts. Their points (the sections) only in their own words: what they want, their event, their constraints. Your plan, ideas and recommendations go in suggestions: that's most of a planning doc, and it's fine. Don't name a place, person, number or date they never said or you never read. Once it's sent, finish the task as done.`;
}

export function taskTurnPrompt(o: { task: CoTask; firstName: string; now: string; zone: string | null; recent: string; final?: boolean; person?: string }): string {
  const t = o.task;
  const deadlineLine = `${t.deadline ? `\nTheir deadline: ${t.deadline}.` : ""}${t.window && !t.window.closedAt ? `\nYour window: ${windowLine(t.window)} An empty search is a result, and they hear it inside the window: if it won't be ready in time, don't text about that yourself, just schedule your next look; when it lands past the window they're told once, in one plain line, with the new time.` : ""}${documentPromiseLine(t)}`;
  const finalLine = o.final
    ? `\nTHIS IS YOUR LAST CHECK BEFORE THEIR DEADLINE. Do what you can now, then tellThem plainly where it stands, even if the answer is that nothing real turned up. Don't go quiet on a deadline. Keep the task open and schedule your next look unless they've said they don't need it; if you ask them something, their answer wakes it. Don't mark a step done that you didn't do (sending options you don't have isn't done).`
    : "";
  return `${CO_VOICE}

${t.source === "lookout" ? `Right now you're keeping an eye out for ${o.firstName}, as you told them on a call you would. Nobody is waiting on a message: look, and text only when something real turns up, never a progress report and never "nothing yet". If it stops making sense (it happened, or they moved on), finish it quietly.\n\nWhat you said you'd look out for: "${t.goal.replace(/^Keep an eye out, as promised on a call:\s*/i, "")}"\nWhat they had said just before: "${t.theirWords}"` : t.source === "promise" ? `Right now you're following through on something you told ${o.firstName} you would do. They're expecting it: do what you said and send it when it's done. If it isn't done yet, keep working and say nothing: no progress reports, no "no details yet", no "a few leads". Text before it's done only when you need something from them (ask for exactly that), or when it truly can't be done (say plainly what you couldn't find and what you'd do instead). Never hold their own thing back because you judge it not good enough yet.\n\nWhat you promised: "${t.goal}"\nWhat they had said when you promised: "${t.theirWords}"` : `Right now you're working in the background on something ${o.firstName} asked you to do. Nobody is waiting on this message; you're doing the work, then deciding what's next.\n\nTheir goal: "${t.goal}"\nTheir own words when they asked: "${t.theirWords}"`}
Steps: ${t.steps.length ? t.steps.map((s) => `${s.done ? "[done]" : "[ ]"} ${s.text}`).join("; ") : "(none written)"}
What you planned to do now: ${t.planNext ?? "(nothing written)"}${deadlineLine}${finalLine}
Your notes so far (oldest first):
${t.notes.map((n) => `- [${localStamp(n.at, o.zone)}] ${n.text}`).join("\n") || "- (none)"}
This is wake-up ${t.wakes} of at most ${TASK_LIMITS.maxWakes}. Now, their time: ${o.now}${o.zone ? ` (their time zone: ${o.zone})` : ""}.

${o.person ? `What you know about them (who they are, what's going on, what you've done, everything you're carrying for them):\n${o.person}\n\n` : ""}Your recent texts with them (oldest first; read their newest messages first, they may have answered you or changed their mind):
${o.recent || "(none)"}

Do the next real step with your tools (search for events and opportunities, webSearch for anything else such as venues, vendors, people or prices, readPage, writeDocument for a document you promised), and write down what you learned with note. When you finish a step, call note with stepDone set to that step's exact text. Only mark a step done when you actually did it; closing a task doesn't finish its steps.
Then decide:
- If they've said they don't need it anymore, found it themselves, or it's done: finish it (and tellThem only if a short close-out helps).
- Text only about this goal. Their other goals have their own tasks, so never start, promise or report work on another goal here.
- Text them (tellThem) only when there's something real to tell or a question only they can answer, never just to say you're still working on it. Only verified results can be told.
- Otherwise schedule your next look (scheduleNext): pick the time that makes sense for this (before a deadline, after a date they gave, a few days for things that change slowly), and write what you'll do then.
You must end with scheduleNext or finish. Never make up results: only what your tools returned.`;
}

type Found = { name: string; url: string | null; facts: string[]; tier: number };

// Their newest lines in the thread ("User said: …"), oldest first.
export function newestMemberLines(recent: string, n = 3): string[] {
  return recent.split("\n").map((l) => l.match(/^\s*User said:\s*(.+)$/i)?.[1]?.trim() ?? "").filter(Boolean).slice(-n);
}

// Did they say this goal is done (booked it, found it themselves, no longer
// need it)? A model read, held to their actual words: the quote must be in
// what they said (2026-10-01 next-live run: "we booked Wave" left the venue
// task open 3 of 4 times, and it texted about a different goal).
export function quoteIsTheirs(quote: string | null | undefined, lines: string[]): boolean {
  const q = (quote ?? "").trim().toLowerCase();
  return q.length >= 3 && lines.some((l) => l.toLowerCase().includes(q));
}
export async function memberSaysGoalDone(goal: string, recent: string): Promise<{ done: boolean; quote: string | null }> {
  const lines = newestMemberLines(recent);
  if (!lines.length) return { done: false, quote: null };
  const { text } = await generateText({
    model: anthropic(MODELS.haiku),
    maxOutputTokens: 200,
    experimental_telemetry: { isEnabled: true, functionId: "taskTurn.goalDone" },
    prompt: `Co is working on this for a member: "${goal}".\nTheir newest messages, oldest first:\n${lines.map((l) => `- ${l}`).join("\n")}\n\nDid they say THIS goal is done, handled themselves (booked it, found it, sorted it), or no longer wanted? Only this goal: a different goal they mention doesn't count. Return ONLY JSON: {"done": true|false, "quote": "their exact words that say so, or null"}.`,
  });
  const m = text.match(/\{[\s\S]*\}/);
  let j: any = null;
  try { j = m ? JSON.parse(m[0]) : null; } catch {}
  const done = j?.done === true && quoteIsTheirs(j?.quote, lines);
  return { done, quote: done ? String(j.quote) : null };
}

export async function runTaskTurnWith(task: CoTask, deps: TaskTurnDeps): Promise<{ action: string; did: string[]; texts: string[]; final: boolean; warning?: string | null }> {
  const final = isFinalCheck(task, deps.now());
  // They already said it's done: close it before any work or text.
  const doneByThem = await memberSaysGoalDone(task.goal, deps.recent).catch(() => ({ done: false, quote: null as string | null }));
  if (doneByThem.done) {
    await deps.close("done", `They said so: "${(doneByThem.quote ?? "").slice(0, 200)}"`);
    return { action: "finished", did: [`closed: they said "${(doneByThem.quote ?? "").slice(0, 120)}"`], texts: [], final };
  }
  const verified: VerifiedResult[] = [];
  const events: Found[] = [];
  const pageFacts: string[] = [];
  const texts: string[] = [];
  const docsSent: string[] = [];
  const did: string[] = [];
  let decided: "scheduled" | "finished" | null = null;
  // When the next check lands (Co's scheduleNext, or the default): the window check reads it after the turn.
  let nextAt: Date | null = null;
  const linkOk = (l: string) => verified.some((v) => v.url === l) || events.some((e) => e.url === l);

  const tell = async (what: string, links?: string[]) => {
        // One delivery, one line (services/speakable.ts): the document went with its own sentence. Nothing texts about it again.
        if (docsSent.length) return { ok: false, error: "The document already went out with its one line. Don't text about it: finish the task, or note anything else for later." };
        // Outside their hours nothing is held in memory to send later: Co waits for their morning.
        if (!localHourOk(deps.now(), deps.zone)) return { ok: false, error: "It's outside their hours (8am to 9pm their time). Note what you'd tell them and schedule your next look for their morning." };
        // A "nothing yet" text is a progress report, and progress reports never go (Royce, 2026-10-08): silence until there's
        // something real. Only the last check before their own deadline may say plainly that nothing turned up.
        if (!final && NOTHING_YET.test(what)) return { ok: false, error: "Not sent: that's a progress report (nothing yet). Say nothing until you have the thing itself; note it and schedule your next look." };
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
        // Things to send: each link, then its own caption, in tier order, the way
        // search results arrive (services/taskMessages.ts). A closing line last.
        if (known.length) {
          const items: SendItem[] = orderByTier(
            known.map((url) => {
              const ev = events.find((e) => e.url === url);
              const v = verified.find((x) => x.url === url);
              return ev
                ? { url, name: ev.name, tier: ev.tier, facts: ev.facts }
                : { url, name: v!.name, tier: 3, facts: [...v!.facts, ...(v!.date ? [`a date its page mentions: ${v!.date}`] : []), ...(v!.deadline ? [`deadline: ${v!.deadline}`] : [])] };
            }),
          );
          const drafted = await draftTaskMessages({ firstName: deps.person.first_name || "them", goal: task.goal, items, what, context: [facts.verified_page_facts, `their deadline: ${task.deadline ?? "none"}`].join(" | ") }).catch(() => null);
          if (!drafted) return { ok: false, error: "Couldn't write the captions. Note it and schedule the next look." };
          const good: { url: string; caption: string }[] = [];
          const droppedCaptions: string[] = [];
          for (const it of items) {
            const cap = drafted.captions.get(it.url);
            const verdict = cap ? captionOk(cap, `${it.name} ${it.facts.join(" ")}`) : { ok: false, why: "no caption" };
            if (cap && verdict.ok) good.push({ url: it.url, caption: cap });
            else droppedCaptions.push(`${it.name}: ${verdict.why}`);
          }
          if (!good.length) return { ok: false, error: `No caption held up (${droppedCaptions.join("; ")}). Note it and schedule the next look.` };
          let closing = drafted.closing;
          if (closing) {
            const allFacts = Object.values(facts).join(" ");
            const bad = checkDraft(closing, { maxSentences: 2, maxChars: 280 }).some((c) => !c.pass) || !numbersBacked(closing, allFacts).ok || !placesBacked(closing, allFacts).ok || OFFERS_WHAT_CO_CANT.test(closing);
            if (bad) closing = null;
          }
          const messages = assembleMessages(good, closing);
          const sent = await deps.send(messages);
          if (!sent.sent) return { ok: false, error: `Couldn't send: ${sent.reason ?? "unknown"}.` };
          await deps.markTexted();
          await deps.note(`Texted them ${good.length} thing(s): ${good.map((g) => items.find((i) => i.url === g.url)?.name).join(", ")}${closing ? `, then: ${closing.slice(0, 120)}` : ""}${droppedCaptions.length ? ` (left out: ${droppedCaptions.join("; ")})` : ""}`, null);
          texts.push(...messages);
          did.push(`texted them ${good.length} link(s), each with its caption`);
          return { ok: true, sent: messages.join(" / ") };
        }
        let text = await draftProactive({
          functionId: "taskTurn.tell",
          firstName: deps.person.first_name || "them",
          facts,
          task: `Tell them where this stands, in your own voice. What to get across (a guide to your intent, not a source: state only what's in CONFIRMED_FACTS): ${what}. Don't put links in the text; they go right after it. Never offer to call, book, reserve or contact anyone for them: you can't. No sign-off.`,
          maxSentences: 4,
        }).catch(() => null);
        if (!text) return { ok: false, error: "Nothing worth sending came out of the verified facts. Note it and schedule the next look." };
        // Rule 1 of the delivery shape (services/speakable.ts): no "Got it" for an ask that isn't seconds old.
        const shapeChecks = (t: string) => deliveryShapeProblems(t, { askedAt: new Date(task.createdAt), sendAt: deps.now() }).map((reason) => ({ name: "delivery_shape", pass: false, reason }));
        let failed = [...checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass), ...shapeChecks(text)];
        // One redraft with what broke, in code, so a long first draft doesn't use up
        // Co's steps (2026-09-30: three verified caterers found, nothing sent).
        if (failed.length) {
          const again = await draftAgain({ draft: text, failed: failed.map((f) => f.reason ?? f.name).join("; ") }, () =>
            draftProactive({ functionId: "taskTurn.tell", firstName: deps.person.first_name || "them", facts, task: `Tell them where this stands in at most 3 short sentences. What to get across (a guide, not a source: state only what's in CONFIRMED_FACTS): ${what}. No links in the text. Never offer to call, book, reserve or contact anyone for them. No sign-off.`, maxSentences: 3 }),
          ).catch(() => null);
          if (again) {
            text = again;
            failed = [...checkDraft(text, { maxSentences: 4, maxChars: 480 }).filter((c) => !c.pass), ...shapeChecks(text)];
          }
        }
        if (failed.length) return { ok: false, error: `The draft broke a rule (${failed.map((f) => f.name).join(", ")}). Note it and schedule the next look.` };
        const nums = numbersBacked(text, Object.values(facts).join(" "));
        if (!nums.ok) return { ok: false, error: `The draft had numbers no verified fact backs (${nums.missing.join(", ")}). Tell them only verified facts.` };
        const places = placesBacked(text, Object.values(facts).join(" "));
        if (!places.ok) return { ok: false, error: `The draft named places no verified fact backs (${places.missing.join(", ")}). Tell them only verified facts.` };
        const offer = text.match(OFFERS_WHAT_CO_CANT);
        if (offer) return { ok: false, error: `The draft offered something Co can't do ("${offer[0]}"): Co can't call, book or contact anyone for them. Suggest they do it, or ask what they'd like next.` };
        if (!final && NOTHING_YET.test(text)) return { ok: false, error: "Not sent: the draft is a progress report (nothing yet). Say nothing until you have the thing itself; note it and schedule your next look." };
        const sent = await deps.send([text]);
        if (!sent.sent) return { ok: false, error: `Couldn't send: ${sent.reason ?? "unknown"}.` };
        await deps.markTexted();
        await deps.note(`Texted them: ${text.slice(0, 200)}`, null);
        texts.push(text);
        did.push("texted them");
        return { ok: true, sent: text };
  };

  const tools = {
    search: tool({
      description:
        "Look up events for this task: Co's own events and the public feed, in the days you name, plus openings Co's daily search already found. You get real events with their details, closest to what you asked first, and you judge which fit, because they're candidates, not answers. Put `when` in their words (\"this weekend\", \"Oct 10\") so the dates come out right. The feed is short (a few events a day), so when it's thin, use webSearch for the same thing.",
      inputSchema: z.object({ what: z.string(), when: z.string().optional() }),
      execute: async ({ what, when }) => {
        did.push(`search: ${what}${when ? `, ${when}` : ""}`);
        const items = await deps.search(what, when ?? null).catch(() => []);
        for (const i of items) if (!events.some((e) => e.name === i.name)) events.push({ name: i.name, url: i.url, facts: [...(i.date ? [`date: ${i.date}`] : []), ...(i.details ?? []).slice(0, 4)], tier: i.tier ?? 2 });
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
        // The send step of a promise is done only when the send really happened after it (same check as closing it).
        if (stepDone && task.source === "promise" && /^\s*(?:send|write)\b/i.test(stepDone)) {
          const kept = await promiseCloseCheck(task, texts, deps, docsSent);
          if (!kept.ok) {
            await deps.note(text, null);
            did.push(`note: ${text.slice(0, 120)} [step not marked: nothing sent after the promise]`);
            return { ok: true, stepNotMarked: kept.why };
          }
        }
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
        nextAt = at ? new Date(at) : new Date(deps.now().getTime() + clampNextHours(inHours) * 3_600_000);
        decided = "scheduled";
        did.push(`next in ${clampNextHours(inHours)}h: ${plan.slice(0, 100)}`);
        return { ok: !!at, nextCheckAt: at };
      },
    }),
    finish: tool({
      description: "Close the task: done, or they no longer need it.",
      inputSchema: z.object({ outcome: z.string(), status: z.enum(["done", "dropped"]) }),
      execute: async ({ outcome, status }) => {
        if (status === "done") {
          const kept = await promiseCloseCheck(task, texts, deps, docsSent);
          if (!kept.ok) {
            did.push(`finish refused: ${kept.why.slice(0, 100)}`);
            return { ok: false, error: `Not closed: ${kept.why}. Do what you said now and send it, or tellThem plainly where it stands, then scheduleNext. Close it as dropped only if they no longer want it.` };
          }
        }
        await deps.close(status, outcome);
        decided = "finished";
        did.push(`finished (${status}): ${outcome.slice(0, 100)}`);
        return { ok: true };
      },
    }),
    // Texting's own document tool (the same input and registry entry, agent/loopTools.ts writeDocument; the same pipeline,
    // services/documentDelivery.ts), so a promised plan or doc arrives as a document, never a wall of text.
    writeDocument: tool({
      description: toolUse("writeDocument"),
      inputSchema: WRITE_DOCUMENT_INPUT,
      execute: async (input) => {
        if (!deps.writeDocument) return { ok: false, error: "Documents can't be sent from here. Note it and schedule the next look." };
        if (docsSent.length) return { ok: false, error: "You already sent the document this wake-up." };
        // What Co read this wake-up can back a place or event in its own suggestions; never a claim about them.
        const read = [verifiedFactLines(verified).join("\n"), events.map((e) => `${e.name} ${e.facts.join(" ")}`).join("\n"), pageFacts.join("\n")].join("\n");
        const r = await deps.writeDocument(input, { read }).catch((err: any) => ({ ok: false as const, why: `it didn't go out (${String(err?.message ?? err).slice(0, 80)})` }));
        if (!r.ok) {
          did.push(`document not sent: ${r.why.slice(0, 140)}`);
          // Their quiet hours (9pm to 8am): the next look is their 8am, set here, not left to the model's arithmetic.
          const quietUntil = "nextAt" in r ? r.nextAt : undefined;
          if (quietUntil && deps.scheduleAt) {
            await deps.scheduleAt(quietUntil, "Send the document you promised: it was ready during their quiet hours.");
            nextAt = quietUntil;
            decided = "scheduled";
          }
          return { ok: false, error: r.why };
        }
        docsSent.push(r.title);
        did.push(`sent a document: ${r.title} (${r.via})`);
        await deps.note(`Sent them the document "${r.title}" (${r.via === "pdf_text" ? "a PDF in their thread" : r.via}).`, null);
        return { ok: true, note: "It's sent, with its one line. If it's what you promised, finish the task as done. Don't text about it or its contents: the delivery is complete." };
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
      prompt: taskTurnPrompt({ task, firstName: deps.person.first_name || "them", now: localStamp(deps.now(), deps.zone), zone: deps.zone, recent: deps.recent, final, person: deps.personModel }),
    });
  } catch (err: any) {
    console.error("taskTurn failed (non-fatal):", err?.message ?? err);
  }
  // A promised document that went out keeps the promise: the commitment closes itself (task, window, open loop), even if Co
  // didn't say finish.
  if (decided !== "finished" && task.source === "promise" && docsSent.length) {
    const kept = await promiseCloseCheck(task, texts, deps, docsSent);
    if (kept.ok) {
      await deps.close("done", `Kept: sent the document "${docsSent[0].slice(0, 120)}".`);
      decided = "finished";
      did.push("finished (done): the promised document went out");
    }
  }
  // The last check before their deadline never goes quiet: if Co didn't tell them,
  // code does, from what's verified, even when that's "nothing real yet".
  if (final && !texts.length) {
    const r = await tell("Be straight about where this stands before their deadline: what you found that's real, or plainly that nothing real turned up yet, and what, if anything, you'll still do.");
    did.push(r.ok ? "final check: told them where it stands" : `final check: couldn't tell them (${"error" in r ? r.error : "unknown"})`);
  }
  if (final && texts.length) await deps.markFinalTold();
  // Co didn't decide: look again tomorrow rather than leave it hanging.
  if (!decided) {
    const at = await deps.schedule(24, task.planNext ?? "Pick up where I left off.");
    nextAt = at ? new Date(at) : new Date(deps.now().getTime() + 24 * 3_600_000);
  }
  // The window (services/memberTime.ts): a turn that ends without the deliverable, whose next check would land past the last
  // moment Co can still tell them, tells them now, in one plain line with the new time. Event-driven: the end of this turn is the
  // trigger, never a poll.
  let warning: string | null = null;
  // Co texted them itself this turn and the next check still lands past the window: they've heard where it stands, so the window
  // moves (marked told) without a second line, and a later wake doesn't warn about the old one again.
  if (decided !== "finished" && texts.length && !docsSent.length && task.window && !task.window.closedAt && missesWindow(task.window, nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now()) && !(task.window.warnedFor ?? []).includes(task.window.deadline)) {
    const re = rescheduledWindow(nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now(), deps.zone, task.window);
    await deps.setWindow?.(re.window);
    did.push(`window: told in the turn's own text; moved to ${re.when}`);
  }
  // No "not yet" text when the window will be missed (Royce, 2026-10-08: progress reports are forbidden; silence until there's
  // something real, then one message). The window moves quietly to the next check, and the delivery, when it lands, says what
  // they asked for and when (services/speakable.ts deliveryLine).
  if (decided !== "finished" && !texts.length && !docsSent.length && task.window && !task.window.closedAt && missesWindow(task.window, nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now())) {
    const re = rescheduledWindow(nextAt ?? new Date(deps.now().getTime() + 24 * 3_600_000), deps.now(), deps.zone, task.window);
    await deps.setWindow?.(re.window);
    if (deps.scheduleAt) await deps.scheduleAt(re.checkAt, `You told them ${task.window.words}; it moves to ${re.when}. Do the work and send it then: one message with the thing itself.`);
    did.push(`window: moved quietly to ${re.when}, no "not yet" text`);
  }
  return { action: decided ?? "defaulted_24h", did, texts, final, warning };
}

// A text that only says the thing isn't there yet (2026-10-08, Royce's call: "No luck yet...", "Nothing solid for this weekend yet").
export const NOTHING_YET = /\b(?:no luck|nothing (?:yet|solid|real|verified|good|worth)|not (?:yet|ready|there yet|done yet)|no (?:details|results|news|update) yet|still (?:looking|working|digging|searching|on it)|haven'?t (?:found|got|heard) (?:anything|it|them) yet|(?:i'?ll|you'?ll) have (?:it|them) (?:for you )?(?:by )?(?:tomorrow|in the morning|tonight|later))\b/i;

// ---------------------------------------------------------------- the miss warning

// Pure: the thing Co promised, out of its own sentence ("I'll text you the options tonight" -> "the options").
export function promisedThing(goal: string): string {
  const s = goal.replace(/^(?:Keep your word from the call|Keep your promise):\s*/i, "").replace(/^"|"$/g, "");
  const m = s.match(/\b(?:text|send|put together|pull together|write up|draft|share|drop|shoot|forward|get|find|line up|dig up|have)\s+(?:you\s+|over\s+|them\s+)?(.+?)(?=\s+(?:to you|for you|over|tonight|today|tomorrow|this \w+|later|in (?:an?|one|the|\d+|a few)\b|by\b|right after|after\b|before\b|once\b|when\b|so\b|and (?:text|send)\b|on (?:mon|tue|wed|thu|fri|sat|sun))|[,.;!?]|$)/i);
  const t = (m?.[1] ?? "").trim();
  if (!t || /^(?:what|whatever|it|that|this|something)\b/i.test(t) || t.split(/\s+/).length > 9) return "it";
  return t.replace(/^(?:a few|some|a couple of|a couple|three|two|four|five)\s+/i, "the ");
}

const TIME_WORDS = /\b(?:in the morning|tomorrow|tonight|this (?:morning|afternoon|evening)|by \d{1,2}(?::\d\d)?\s?(?:am|pm)|\d{1,2}(?::\d\d)?\s?(?:am|pm)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon)\b/i;

// Pure: what a miss warning must be: one or two plain sentences that say what isn't there yet and the new time, in the voice
// standard (services/speakable.ts narration, harness/proactive.ts checkDraft). The usual "no promise of a later action" rule is
// the one exception, as for the after-call confirmation: this line IS the new promise, and the task keeps it.
// alsoNames: their own words for it ("private dining rooms" for Co's "the options"): naming it either way counts.
const NOT_A_THING = new Set(["your", "them", "those", "these", "some", "with", "from", "that", "this", "about", "after", "their", "there", "would", "could", "want", "find", "need", "something", "anything", "please", "maybe", "really", "just"]);
export function warningChecks(text: string, o: { thing: string; when: string; alsoNames?: string }): GateCheck[] {
  const base = checkDraft(text, { maxSentences: 2, maxChars: 220 }).filter((c) => !(c.name === "draft_forbidden" && /promise of a later action/.test(c.reason ?? "")));
  const lower = text.toLowerCase();
  const wordsOf = (s: string, min: number) => (s.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []).filter((w) => w.length >= min && !NOT_A_THING.has(w));
  const thingWords = wordsOf(o.thing, 4);
  const namesIt = !thingWords.length || [...thingWords, ...wordsOf(o.alsoNames ?? "", 5)].some((w) => lower.includes(w.slice(0, 5)));
  return [
    ...base,
    { name: "warning_new_time", pass: lower.includes(o.when.toLowerCase()) || TIME_WORDS.test(text), reason: `doesn't say when they'll have it (${o.when})` },
    { name: "warning_names_it", pass: namesIt, reason: `doesn't say what isn't there yet (${o.thing})` },
    { name: "warning_no_question", pass: !/\?/.test(text), reason: "asks a question; the line tells them where it stands" },
    { name: "warning_no_preamble", pass: !/^\s*(?:(?:a )?quick |small |just an? )?(?:update|heads[- ]up|fyi|status)\b/i.test(text), reason: "opens on a status preamble (\"quick update\", \"heads up\"); say the thing" },
  ];
}

// Pure: the line in plain words when no draft holds up. Better than going quiet on a window.
export function fallbackWarning(thing: string, when: string, doc: boolean): string {
  const plural = /s$/i.test(thing) && !/\b(?:this|plan|brief|analysis)$/i.test(thing);
  const pron = thing === "it" ? "it" : plural ? "them" : "it";
  if (doc) return `${thing === "it" ? "The document" : thing[0].toUpperCase() + thing.slice(1)} isn't finished yet, I'll have it to you ${when}.`;
  return thing === "it" ? `No luck yet, I'll have it for you ${when}.` : `No luck on ${thing} yet, I'll have ${pron} for you ${when}.`;
}

export function warningTask(): string {
  return `You told them they'd have something by a time (window_words), and it won't be ready then. Text them one plain line, before that time passes: what they don't have yet and when they will (new_time, in those words). The shape, not the words: "No luck on the rooms yet, I'll have them for you in the morning." One or two short sentences. No preamble ("quick update", "heads up"). Never narrate your own process ("working on it", "still looking", "a few leads", "in progress", "nothing solid enough"), no apology, no question, no sign-off.`;
}

// Sends the warning when a turn ends without the deliverable and the next check would land past the warn-by (or the warn-by
// has passed). Once per window (the send key is the window's deadline, and the window remembers it was warned). Inside their
// hours only: past 8pm their time it moves the next check to their morning and warns then if it's still not done.
export async function warnIfWindowMissed(task: CoTask, w: CommitWindow, nextAt: Date, deps: TaskTurnDeps): Promise<{ sent: boolean; text?: string; what?: string }> {
  const now = deps.now();
  if (!missesWindow(w, nextAt, now)) return { sent: false };
  if ((w.warnedFor ?? []).includes(w.deadline)) return { sent: false, what: "window: already warned for this window" };
  // A window a warning just set ("in the morning"), reached before it opens (they replied at 9pm): the work is held to its
  // start, not warned about a second time.
  if (w.startsAt && now.getTime() < new Date(w.startsAt).getTime()) {
    if (deps.scheduleAt) await deps.scheduleAt(new Date(w.startsAt), `You told them ${w.words}: send it then, or say plainly what you found.`);
    return { sent: false, what: `window: held to its start, ${localStamp(w.startsAt, deps.zone)}` };
  }
  const kept = await promiseCloseCheck(task, [], deps);
  if (task.source === "promise" && kept.ok) return { sent: false, what: "window: already kept" };
  if (!sendableAt(now, deps.zone)) {
    const morning = nextSendable(now, deps.zone);
    if (deps.scheduleAt) await deps.scheduleAt(morning, "Their window passed outside their hours: do the work and send it, or tell them plainly where it stands and when they'll have it.");
    return { sent: false, what: `window: outside their hours, next check moved to ${localStamp(morning, deps.zone)}` };
  }
  const re = rescheduledWindow(nextAt, now, deps.zone, w);
  const thing = promisedThing(task.goal);
  const doc = wantsDocument(task.goal, task.theirWords);
  const facts = { what_you_promised: task.goal.replace(/^(?:Keep your word from the call|Keep your promise):\s*/i, ""), window_words: w.words, what_isnt_there_yet: thing, new_time: re.when, their_local_time: localStamp(now, deps.zone) };
  const bad = (t: string) => warningChecks(t, { thing, when: re.when, alsoNames: task.theirWords }).filter((c) => !c.pass);
  let text: string | null = null;
  const draft = deps.draftWarning ?? defaultDraftWarning(deps.person.first_name || "them");
  const first = await draft(facts).catch(() => null);
  if (first && !bad(first).length) text = first;
  else if (first) {
    const second = await draft(facts, { draft: first, failed: bad(first).map((c) => c.reason ?? c.name).join("; ") }).catch(() => null);
    if (second && !bad(second).length) text = second;
  }
  text ??= fallbackWarning(thing, re.when, doc);
  const r = deps.warn ? await deps.warn(text, `task:${task.id}:window:${w.deadline}`).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) })) : { sent: false, reason: "no send path" };
  if (!r.sent && r.reason !== "already sent") return { sent: false, what: `window: warning not sent (${r.reason ?? "unknown"})` };
  await deps.setWindow?.(re.window);
  if (deps.scheduleAt) await deps.scheduleAt(re.checkAt, `You told them ${re.when}: send it then, or say plainly what you found.`);
  await deps.note(`Told them it'll be ${re.when}: "${text.slice(0, 200)}"`, null);
  return { sent: r.sent, text: r.sent ? text : undefined, what: `window: told them it moves to ${re.when}` };
}

function defaultDraftWarning(firstName: string): NonNullable<TaskTurnDeps["draftWarning"]> {
  return (facts, redo) => {
    const run = () => draftProactive({ functionId: "taskTurn.windowWarning", firstName, facts, task: warningTask(), maxSentences: 2 });
    return redo ? draftAgain(redo, run) : run();
  };
}

// A real wake-up: the database, the web budget, and texts to their phone.
// opts.now: a pinned clock for a live check (evals/tasks/windowsLive.ts); the real time otherwise. It drives the turn's own
// sense of now, the window math and the hours checks of its sends.
export async function runTaskTurn(task: CoTask, opts: { now?: () => Date; override?: Partial<TaskTurnDeps> } = {}): Promise<{ action: string; did?: string[]; warning?: string | null }> {
  const userId = task.userId;
  const clock = opts.now ?? (() => new Date());
  if (isExhausted(task, clock())) {
    await closeTask(userId, task.id, "expired", "Ran out of wake-ups or days.");
    await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "skip", action: "expired", proposal: { taskId: task.id } }).catch(() => {});
    return { action: "expired" };
  }
  const [{ rows: u }, { rows: convo }] = await Promise.all([
    pool.query(`SELECT u.first_name, u.phone_number, u.sms_opted_out, u.archived_at, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [userId]),
    pool.query(`SELECT content, memory_type FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND ${notToTeammate()} ORDER BY created_at DESC LIMIT 14`, [userId]),
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
    // Another member's details stripped, as in the reply (memberSafeMemories.ts).
    recent: withoutTeammateLines((await import("./memberSafeMemories.js").then((m) => m.memberSafe(userId, convo))).reverse().join("\n")).slice(-3000),
    personModel: await import("./personModel.js").then((m) => m.personModel(userId, { maxDid: 6 })).catch(() => undefined),
    note: async (text, stepDone) => void (await noteOnTask(userId, task.id, text, stepDone)),
    schedule: async (h, plan) => (await scheduleTask(userId, task.id, h, plan))?.nextCheckAt ?? null,
    scheduleAt: async (at, plan) => (await scheduleTaskAt(userId, task.id, at, plan))?.nextCheckAt ?? null,
    // Completion closes its own loop: the task (and its window, coTasks.ts closeTask), then the open loop that mirrors it, now
    // rather than on the next 15-minute sync (services/openLoops.ts closes a task loop only on a direct read of the task).
    close: async (status, outcome) => {
      await closeTask(userId, task.id, status, outcome);
      await import("./openLoops.js").then((m) => m.syncOpenLoops(userId)).catch((err: any) => console.error("taskTurn: loop sync after close failed (non-fatal):", err?.message ?? err));
    },
    setWindow: (w) => setTaskWindow(userId, task.id, w),
    // The miss warning: the existing send path, with quiet hours and the opt-out re-read (harness/proactive.ts sendExempt), its own
    // type so it never counts as the promised thing (services/followThrough.ts sendsSince) or uses up the task's text budget.
    warn: async (text, key) => {
      const r = await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_window", targetKey: key, messages: [text], timezone: zone, respectHours: true, now: clock() });
      return { sent: r.sent, reason: r.reason };
    },
    writeDocument: async (input, { read }) => {
      const { sendDocumentForTask, realTaskDocDeps } = await import("./documentDelivery.js");
      const r = await sendDocumentForTask(input, { userId, taskId: task.id, firstName: person.first_name ?? "", phone: person.phone_number, zone, taskTheirWords: task.theirWords, read, askedAt: task.createdAt ? new Date(task.createdAt) : null }, { ...realTaskDocDeps, now: clock });
      await recordDecision({ layer: 7, decision: "task.writeDocument", userId, outcome: r.ok ? "act" : "skip", action: r.ok ? r.title : "not_sent", reason: r.ok ? null : r.why.slice(0, 300), proposal: { taskId: task.id, via: r.ok ? r.via : null } }).catch(() => {});
      return r;
    },
    textsToday: () => taskTextsToday(userId),
    send: async (messages) => {
      const r = await sendExempt({ userId, phoneNumber: person.phone_number, type: "task_update", targetKey: `task:${task.id}:${Date.now()}`, messages, timezone: zone, respectHours: true, now: clock() });
      const urls = messages.filter((m) => /^https?:\/\//.test(m));
      if (r.sent && urls.length) await recordSentItems(userId, urls.map((url) => ({ name: url, url })), "taskTurn").catch(() => {});
      return { sent: r.sent, reason: r.reason };
    },
    markTexted: () => markTexted(userId, task.id),
    markFinalTold: () => markFinalTold(userId, task.id),
    // The same raw candidates Co's reply loop gets (agent/loopTools.ts), judged
    // by the task's own model, not the old pipeline's gates (2026-10-01).
    search: async (what, when) => {
      const [r, openings] = await Promise.all([
        eventCandidates(what, person.city ?? null, { when: when ?? null, userId, timezone: zone, limit: 6 }),
        alreadyFoundOpenings(userId).catch(() => []),
      ]);
      const events = r.candidates.map(({ match, lines }) => ({ name: match.name, url: "url" in match ? (match.url ?? null) : null, date: (match as any).event_date ? String((match as any).event_date).slice(0, 10) : null, tier: match.tier, details: lines }));
      const found = openings.filter((m) => "url" in m && m.url).slice(0, 3).map((m) => ({ name: m.name, url: (m as any).url as string, date: null, tier: 3, details: [m.reason] }));
      return [...events, ...found];
    },
    web: (what) => taskWebSearch(userId, what, { city: person.city, zone, taskId: task.id, background: true }),
    readPage: async (url) => {
      const r = await readLink(url, { ownerUserId: userId }).catch(() => null);
      if (!r) return { ok: false, facts: [], text: "" };
      const ex = excerptFact(url, r);
      return { ok: r.status === "ok", facts: describeRead(url, r).facts, text: ex ?? "" };
    },
    now: clock,
    sentSince: (since) => sendsSince(userId, since),
    ...opts.override,
  };
  const r = await runTaskTurnWith(task, deps);
  await recordDecision({ layer: 7, decision: "task.wake", userId, outcome: "act", action: r.action, proposal: { taskId: task.id, did: r.did, final: r.final, deadline: task.deadline, window: task.window ?? null, warning: r.warning ?? null } }).catch(() => {});
  return { action: r.action, did: r.did, warning: r.warning ?? null };
}

export async function runDueTasks(): Promise<void> {
  const { claimDueTasks } = await import("./coTasks.js");
  for (const t of await claimDueTasks()) {
    if (t.kind === "followup") await import("./followUps.js").then((f) => f.runFollowUpTurn(t));
    else if (t.kind === "research_brief") await import("./researchBrief.js").then((r) => r.runResearchBriefTask(t)).catch((err: any) => console.error("research brief task failed (non-fatal):", err?.message ?? err));
    else await runTaskTurn(t);
  }
}
