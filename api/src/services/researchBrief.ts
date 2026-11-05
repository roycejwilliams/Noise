// Research on rooms, events and communities they would attend (Royce, 2026-10-07; the document wrapper and the venue and vendor path
// removed 2026-11-04): a member asks for something research-shaped ("find founder dinners and communities for climate people"); a background task runs the find and the result goes back as finds by text, the way every other find does: each
// find's link, then one line under it (services/taskMessages.ts assembleMessages), inside the usual caps. It never becomes a document.
//
// Grounding, the part that matters:
//   - Every caption is written by code from the find's fixed fields (no model writes, infers or interpolates them). A find with no
//     source link or no check time isn't sent.
//   - "unknown" is an allowed answer; a caption says what wasn't confirmed.
// Search quality (services/researchQuality.ts) runs through it: the query is built from member state (a missing load-bearing
// fact is a question back, asked by the tool before this starts), every read is the find type's fixed fields, a re-sent run
// re-reads anything past its freshness window, and the options are ordered by what this member (or everyone) said yes and no to.
// Sources: the general reader (services/sdkGeneralReader.ts, evals/browserPilot/round2.ts: 39 right, 11 unknown, 0 wrong on 12 sites)
// for an event's or community's own page. The scripted Peerspace venue reader is no longer used here.
import { regionFor } from "./areaCodes.js";
import { proactivePaused } from "./proactivePause.js";
import { schemaFields, type FieldValue, type FindField, type FindType, type StoredFind } from "./researchQuality.js";
import { assembleMessages, captionOk, draftTaskMessages, type SendItem } from "./taskMessages.js";

export const SDK_FINDS_ALLOWED = true;
// How many finds one run sends: the usual find cap (services/researchFinds.ts RESEARCH_FIND_SHOWN), so it reads like any other find text.
export const BRIEF_LIMITS = { maxOptions: 3, maxReads: 8 };

export type { FindField };
export type ResearchFind = { name: string; url: string; checkedAt: string; reader: "scripted" | "sdk"; fields: FindField[] };

export const UNKNOWN = "unknown";
// The oldest field's check time: the caption says no more than its stalest line can back.
export const findCheckedAt = (fields: FindField[], fallback: string) => fields.map((x) => x.checkedAt).filter(Boolean).sort()[0] ?? fallback;

// Pure: finds that can be sent at all: an https source and a check time. Filtered before the cap, so a valid fourth find fills the
// slot a dropped one leaves.
export const sendable = (finds: ResearchFind[]): ResearchFind[] => finds.filter((f) => /^https:\/\//.test(f.url) && !Number.isNaN(new Date(f.checkedAt).getTime()));

// Pure: what a find's page said, as the facts its caption may state: each fixed field with a value, and the fields it did not confirm.
export function findFacts(f: ResearchFind): string[] {
  const known = f.fields.filter((x) => x.value && x.value.trim()).map((x) => `${x.label}: ${x.value!.trim()}`);
  const open = f.fields.filter((x) => !x.value || !x.value.trim()).map((x) => x.label.toLowerCase());
  const d = new Date(findCheckedAt(f.fields, f.checkedAt));
  return [...known, ...(open.length ? [`not confirmed on its page: ${open.join(", ")}`] : []), ...(Number.isNaN(d.getTime()) ? [] : [`checked ${d.toISOString().slice(0, 10)}`])];
}

// The captions come from the same path every task's finds use (services/taskMessages.ts draftTaskMessages, held by captionOk: the
// draft rules, its own facts' numbers and places, no scarcity it can't back): one line each saying why it fits, in Cue's voice, stating
// only the find's fixed fields. A caption that doesn't hold gets one redraft; what still doesn't hold is left out and its slot goes to
// the next valid find. Returns the texts (link, then caption) for up to the usual cap, or [] when nothing held up.
export type CaptionDraft = (o: { items: SendItem[]; fix?: string }) => Promise<{ captions: Map<string, string> } | null>;
export async function researchMessages(finds: ResearchFind[], o: { firstName: string; ask: string; context: string[]; draft?: CaptionDraft }): Promise<{ messages: string[]; sent: ResearchFind[] }> {
  const valid = sendable(finds);
  if (!valid.length) return { messages: [], sent: [] };
  const items: SendItem[] = valid.map((f) => ({ url: f.url, name: f.name, tier: 3, facts: findFacts(f) }));
  const draft: CaptionDraft = o.draft ?? ((d) => draftTaskMessages({ firstName: o.firstName || "them", goal: o.ask, items: d.items, what: `why each fits what they asked for: ${o.ask}`, context: o.context.join(" | "), fix: d.fix }).catch(() => null));
  const vet = (d: { captions: Map<string, string> }, pool: SendItem[]) => {
    const good: { f: ResearchFind; caption: string }[] = [];
    const dropped: string[] = [];
    for (const it of pool) {
      const cap = d.captions.get(it.url);
      const v = cap ? captionOk(cap, `${it.name} ${it.facts.join(" ")}`) : { ok: false, why: "no caption" };
      const f = valid.find((x) => x.url === it.url)!;
      if (cap && v.ok) good.push({ f, caption: cap });
      else dropped.push(`${it.name}: ${v.why}`);
    }
    return { good, dropped };
  };
  const first = await draft({ items });
  if (!first) return { messages: [], sent: [] };
  let v = vet(first, items);
  if (v.dropped.length) {
    const again = await draft({ items, fix: v.dropped.join("; ") });
    const w = again ? vet(again, items) : null;
    if (w && w.good.length >= v.good.length) v = w;
  }
  const top = v.good.slice(0, BRIEF_LIMITS.maxOptions);
  return { messages: assembleMessages(top.map((g) => ({ url: g.f.url, caption: g.caption })), null), sent: top.map((g) => g.f) };
}

// ---------------------------------------------------------------- reading a source as the event schema

// A room, event or community they would attend (the purpose boundary, Royce 2026-11-04): never a venue or a vendor for their own event.
export type RoomAsk = { what: string; city: string | null };

// One source, read as the event schema (date, start, price, where, sold out) by the general reader. Null when the page couldn't be
// read or said nothing the schema asks.
export async function readRoomSource(url: string): Promise<{ reader: "scripted" | "sdk"; fields: FindField[]; title: string; gone?: boolean } | null> {
  const now = () => new Date().toISOString();
  if (!SDK_FINDS_ALLOWED) return null;
  const { FIND_SCHEMAS } = await import("./researchQuality.js");
  const { readWithSdk } = await import("./sdkGeneralReader.js");
  const asks = FIND_SCHEMAS.event.map((f) => ({ key: f.key, ask: f.ask }));
  const r = await readWithSdk(url, asks).catch(() => null);
  if (!r || r.stopped === "blocked site") return null;
  const fields = schemaFields("event", r.answers, now());
  if (!fields.some((f) => f.value)) return null;
  const title = (r.pageText.match(/^([^\n|]{3,80})/)?.[1] ?? "").trim();
  return { reader: "sdk", fields, title };
}

// The find's search never ran (every pass failed, or the web search budget blocked it): thrown so the brief retries, then says it
// couldn't search, never that nothing fits.
export class SearchFailed extends Error {}

// The find, in a background task only. The assembled query (researchQuality.assembleQuery("event", ...)) goes to the verified web
// search; each result below Co's bar is skipped; each other result is read as the event schema from the room's or community's own page.
export async function findRoomOptions(userId: string, query: string, ask: RoomAsk, zone: string | null): Promise<ResearchFind[]> {
  const { taskWebSearch, coreName } = await import("./taskWeb.js");
  const { belowTheBar } = await import("./researchQuality.js");
  // Each option is read from its own page (taskWeb marks official pages): a roundup or directory about many events is never read for
  // one of them. Too few of those from the first pass: another pass asking only for own pages.
  const own = (k: { url: string; official: boolean }) => k.official;
  const placeKey = (k: { url: string }) => { try { return new URL(k.url).hostname.replace(/^www\./, "") + new URL(k.url).pathname.replace(/\/$/, ""); } catch { return k.url; } };
  const sameName = (a: string, b: string) => coreName(a).toLowerCase() === coreName(b).toLowerCase();
  const ownPage = "For each, give the event's or community's OWN page (when it is, where, how to join), never a roundup, list, review or directory.";
  const angles = ["", "Look further: different events and communities from these, already found:", "This time look at a different kind of room at the same standard: a talk series, a salon, a members' community, a recurring dinner, which these are not:"];
  const kept: import("./taskWeb.js").VerifiedResult[] = [];
  const ownPlaces = () => kept.filter(own).filter((k, i, a) => a.findIndex((x) => placeKey(x) === placeKey(k)) === i);
  const log: { pass: number; kept: number; own: number; listicles: string[] }[] = [];
  // A search that failed (Exa down or timed out) or that the budget blocked never ran: when no pass ran, that's a failure, never
  // "nothing fits" (review of #225).
  const failures: string[] = [];
  for (const [i, angle] of angles.entries()) {
    if (i > 0 && ownPlaces().length >= BRIEF_LIMITS.maxOptions) break;
    const seen = [...new Set(kept.map((k) => coreName(k.name)))].slice(0, 12).join("; ");
    const q = i === 0 ? `${query} ${ownPage}` : `${query} ${ownPage} ${angle}${seen ? ` ${seen}.` : ""}`;
    // A brief is always one the member asked for (or said yes to), so its searches draw from the direct-ask share of the day's web
    // search budget, never the sweep's (re-review of #235).
    const r = await taskWebSearch(userId, q, { city: ask.city, zone, background: true, max: BRIEF_LIMITS.maxOptions, searches: 4, ownPage: "event or community page", readsPageItself: true, source: "request" });
    if (/^(?:Web search failed|No web search right now)/.test(r.note)) failures.push(r.note);
    for (const k of r.kept) if (!kept.some((x) => x.url === k.url || (own(x) && own(k) && (placeKey(x) === placeKey(k) || sameName(x.name, k.name))))) kept.push(k);
    log.push({ pass: i + 1, kept: r.kept.length, own: r.kept.filter(own).length, listicles: r.kept.filter((k) => !own(k)).map((k) => k.url).slice(0, 4) });
  }
  if (failures.length === log.length && !kept.length) throw new SearchFailed(failures[0]);
  const urls = [...new Set(ownPlaces().map((k) => k.url).filter((u) => u.startsWith("https://") && !belowTheBar(u)))].slice(0, BRIEF_LIMITS.maxReads);
  const names = new Map(kept.map((k) => [k.url.split("?")[0], coreName(k.name)]));
  const finds: ResearchFind[] = [];
  const reads: { url: string; got: string }[] = [];
  for (const url of urls) {
    if (finds.length >= BRIEF_LIMITS.maxOptions) break;
    const read = await readRoomSource(url).catch((err: any) => {
      console.error(`research brief read failed for ${url} (non-fatal):`, err?.message ?? err);
      return null;
    });
    reads.push({ url, got: !read ? "nothing readable" : read.gone ? "gone" : `${read.fields.filter((f) => f.value).length} fields` });
    if (!read || read.gone) continue;
    const checkedAt = findCheckedAt(read.fields, new Date().toISOString());
    finds.push({ name: names.get(url.split("?")[0]) || read.title || new URL(url).hostname.replace(/^www\./, ""), url, checkedAt, reader: read.reader, fields: read.fields });
  }
  const { recordDecision } = await import("../harness/core.js");
  await recordDecision({ layer: 7, decision: "research.find", userId, outcome: finds.length ? "act" : "skip", action: `${finds.length} options`, proposal: { passes: log, reads } }).catch(() => {});
  return finds;
}

// Pure: after trying to send a run's closing texts, what happens to the task. "told": it went (or already had, same target key),
// close as planned. "hold": it's outside their hours, so keep the task open and say it when their hours start (bounded by the
// task's wake-ups, so a line that never fits can't loop). "untold": paused, opted out or failed: close as dropped and say so.
export const BRIEF_HOLD_MAX_WAKES = 6;

// What they're told when the find's search never ran, after its retries: it couldn't search, never that nothing fits. Wording
// pending Royce's approval (PR #235).
export const SEARCH_FAILED_LINE = "My search didn't go through just now, so I couldn't look for rooms yet. Want me to try again?";
// A find whose search never ran (Exa down or timed out, or the web search budget blocked it) is tried again at the task's next wake
// this many times before they're told (Royce, 2026-10-17: "retry once or twice ... Only tell the member if those fail"). No new
// machinery: the task is left open, and coTasks.claimDueTasks already leased it to its next wake 45 minutes on, when the whole run
// (and the find) goes again. task.wakes counts the runs (the first is 1), so runs 1 and 2 retry and run 3 tells them.
export const BRIEF_SEARCH_RETRIES = 2;
export const briefSearchNext = (wakes: number): "retry" | "tell" => (wakes <= BRIEF_SEARCH_RETRIES ? "retry" : "tell");

// How long a brief whose line waits at the door goes before it looks again (only to hand the same line over again; the door's send closes it).
export const BRIEF_DOOR_LOOK_HOURS = 12;
export function briefLineOutcome(r: { sent: boolean; reason?: string; door?: boolean; queued?: boolean }, wakes: number): "told" | "hold" | "untold" | "queued" {
  // Waiting at the door for Cue's next message (harness/door.ts): not told yet; the task stays open until the pick sends it.
  if (r.door && r.queued) return "queued";
  // Its line ended at the door without going (past its valid-until): never told, and no more looks.
  if (r.door && /^ended at the door/.test(r.reason ?? "")) return "untold";
  if (r.sent || r.reason === "already sent") return "told";
  // Held by their own rule or the spacing (harness/notifyGate.ts) waits the same way: it's work they asked for, never dropped for it.
  // Held by their own rule or the spacing (harness/notifyGate.ts): it's work they asked for, it waits however long, never dropped for it
  // (its wake is given back, below).
  if (r.reason?.startsWith("held:")) return "hold";
  if (r.reason === "outside local hours" && wakes < BRIEF_HOLD_MAX_WAKES) return "hold";
  return "untold";
}

type BriefParams = { what?: string; city?: string | null; neighborhood?: string | null; date?: string | null; start?: string | null; headcount?: number | null; budget?: string | null; memberContext?: string[]; again?: boolean };

// On file as research finds (so "send it" has the link) and as shown finds (the ranking signal for the next run). Called only once the
// texts went out: right after a direct send, or by the door's after-send step when the pick sent them (services/deferredSends.ts).
export async function recordSentResearchFinds(userId: string, taskId: number, fs: ResearchFind[]): Promise<void> {
  const [{ recordResearchFinds }, Q] = await Promise.all([import("./researchFinds.js"), import("./researchQuality.js")]);
  await recordResearchFinds(userId, fs.map((f) => ({ name: f.name, url: f.url, facts: f.fields.filter((x) => x.value).map((x) => `${x.label}: ${x.value}`).join("; ") }))).catch(() => 0);
  await Q.recordShownFinds(userId, taskId, fs.map((f) => ({ type: "event", name: f.name, url: f.url, reader: f.reader, fields: f.fields }) as StoredFind));
}

// The background run of one research task (services/taskTurn.ts runDueTasks): find (or, for "send it again", re-check the
// last run's finds), rank, text them as finds (link, then one line), record what was shown, close. Never a document.
// The member asked (or said yes) before this task existed: the reply-loop tool that starts it carries that check, and asks
// them first when a load-bearing fact is missing.
export async function runResearchBriefTask(task: import("./coTasks.js").CoTask): Promise<void> {
  const { closeTask } = await import("./coTasks.js");
  const { default: pool } = await import("../db/db.js");
  const Q = await import("./researchQuality.js");
  const p = (task.followup ?? {}) as BriefParams;
  const { rows } = await pool.query(`SELECT u.first_name, u.phone_number, cp.city FROM users u LEFT JOIN co_profiles cp ON cp.user_id = u.id WHERE u.id = $1`, [task.userId]);
  const person = rows[0];
  if (!person?.phone_number || !p.what) {
    await closeTask(task.userId, task.id, "dropped", "missing what to research or who to send it to");
    return;
  }
  const city = p.city ?? person.city ?? null;
  const zone = city ? await import("./geocoding.js").then((g) => g.getTimezoneForCity(city, { region: regionFor({ city, phone: person?.phone_number }) })).catch(() => null) : null;
  const { sendExempt } = await import("../harness/proactive.js");
  // A line to them that ends the brief (what it came to, or the question it needs first). Outside their hours it used to be
  // dropped while the task closed as done, so they never heard (2026-10-07). Now: told, then closed; outside their hours, held
  // to their morning with the task kept open; never told for any other reason, closed as dropped and saying so.
  const recordSentFinds = (fs: ResearchFind[]) => recordSentResearchFinds(task.userId, task.id, fs);
  const tellThenClose = async (what: string | string[], status: "done" | "dropped", outcome: string, record?: ResearchFind[]) => {
    const messages = Array.isArray(what) ? what : [what];
    const text = messages.join("\n");
    // Work they asked for (requested): the pause on unprompted outreach never holds it. Unless the pause is on, it goes through the door
    // (harness/door.ts) at its priority band, gathered with whatever else is ready and capped, unless it answers their latest message.
    // The task stays open until the pick sends it: the door closes it then, and records the finds (after-send step), or, if it never
    // goes, closes it as not told. Paused, the door isn't a way out (the dispatcher is stopped), so it goes directly. Opt-out, safety,
    // their hours and their own rule still apply either way.
    const door = proactivePaused()
      ? undefined
      : {
          summary: `The research on rooms and events they asked for: ${String(p.what ?? "").slice(0, 120)}`,
          validUntil: (await import("../harness/door.js")).doorValidUntil("requested", new Date(), zone),
          taskId: task.id,
          close: { status, outcome },
          awaitingReply: false,
          ...(record?.length ? { after: { kind: "research_finds" as const, payload: { userId: task.userId, taskId: task.id, finds: record } } } : {}),
        };
    const r = await sendExempt({ userId: task.userId, phoneNumber: person.phone_number, type: "task_update", targetKey: `research_brief:${task.id}`, messages, timezone: zone, respectHours: true, requested: true, answers: { askedAt: task.createdAt ? new Date(task.createdAt) : null }, ...(door ? { door } : {}) }).catch((err: any) => ({ sent: false, reason: String(err?.message ?? err) }) as { sent: boolean; reason?: string; retryAt?: Date; door?: boolean; queued?: boolean });
    const next = briefLineOutcome(r, task.wakes);
    // Recorded only for what actually went out.
    if (next === "told" && r.sent && record?.length) await recordSentFinds(record).catch(() => {});
    if (next === "queued") {
      // Waiting at the door: the task stays open, looking again later only to re-hand the same line (the same key, so never twice).
      const { holdBriefLine, unspendWake } = await import("./coTasks.js");
      if (await holdBriefLine(task.userId, task.id, { text, messages, status, outcome, ...(record?.length ? { record } : {}) }, new Date(Date.now() + BRIEF_DOOR_LOOK_HOURS * 3_600_000))) await unspendWake(task.userId, task.id).catch(() => {});
      return;
    }
    if (next === "hold") {
      const { holdBriefLine, unspendWake } = await import("./coTasks.js");
      const { nextSendable } = await import("./memberTime.js");
      // Held by their rule or the spacing: it waits until it may go, and the wake comes back (a hold never uses up an owed delivery).
      const held = r.reason?.startsWith("held:") ? (r as { retryAt?: Date }).retryAt ?? null : null;
      if (await holdBriefLine(task.userId, task.id, { text, messages, status, outcome, ...(record?.length ? { record } : {}) }, held ?? nextSendable(new Date(), zone))) {
        if (held) await unspendWake(task.userId, task.id).catch(() => {});
        return;
      }
    }
    await closeTask(task.userId, task.id, next === "told" ? status : "dropped", next === "told" ? outcome : `${outcome}; never told them (${r.reason ?? "not sent"})`);
  };
  // A line held from an earlier run: say it now (the find isn't run again).
  const held = (task.followup as any)?.held as { text: string; messages?: string[]; status: "done" | "dropped"; outcome: string; record?: ResearchFind[] } | undefined;
  if (held?.text) {
    await tellThenClose(held.messages?.length ? held.messages : held.text, held.status, held.outcome, held.record);
    return;
  }
  let finds: ResearchFind[] = [];
  let rechecked = 0;
  if (p.again) {
    // The same brief again: its own finds, each re-read where a field is past its window, before it goes.
    const last = await Q.lastBriefFinds(task.userId, "event");
    for (const f of last.finds) {
      const r = await Q.freshForShow(f, async (old) => {
        const read = await readRoomSource(old.url);
        return read ? { gone: !!read.gone, fields: read.fields } : null;
      });
      rechecked += r.rechecked.length ? 1 : 0;
      if (r.find) finds.push({ name: r.find.name, url: r.find.url, reader: r.find.reader, fields: r.find.fields, checkedAt: findCheckedAt(r.find.fields, new Date().toISOString()) });
    }
  } else {
    const state = await Q.loadMemberSearchState(task.userId, { city, neighborhood: p.neighborhood ?? null, budget: p.budget ?? null, date: p.date ?? null, start: p.start ?? null, headcount: p.headcount ?? null });
    const q = Q.assembleQuery("event", p.what, state);
    if (!q.ok) {
      // The tool asks first; this is the backstop. Never search on a guess.
      await tellThenClose(q.question, "dropped", `asked them first: missing ${q.missing.join(", ")}`);
      return;
    }
    const find = { failed: null as string | null };
    finds = await findRoomOptions(task.userId, q.query, { what: p.what, city }, zone).catch((err: any) => {
      console.error("research brief find failed (non-fatal):", err?.message ?? err);
      find.failed = err instanceof SearchFailed ? err.message : "the find threw an error";
      return [] as ResearchFind[];
    });
    // The find never ran (the search failed or was blocked): tried again at the next wake, then they're told it couldn't search,
    // never that nothing fits (review of #225).
    if (find.failed) {
      if (briefSearchNext(task.wakes) === "retry") {
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 7, decision: "research.find", userId: task.userId, outcome: "skip", action: `search didn't run; retry ${task.wakes} of ${BRIEF_SEARCH_RETRIES} at the next wake`, reason: find.failed, proposal: { taskId: task.id, wakes: task.wakes } }).catch(() => {});
        return;
      }
      await tellThenClose(SEARCH_FAILED_LINE, "dropped", `the search didn't run after ${BRIEF_SEARCH_RETRIES} retries: ${find.failed}`);
      return;
    }
  }
  // Ordered by what they (or everyone) said yes and no to before.
  const signal = await Q.rankingSignal(task.userId);
  finds = Q.rankFinds(finds.map((f) => ({ ...f, type: "event" as FindType })), signal.member, signal.global).map(({ score: _s, type: _t, ...f }) => f);

  // Only what has a source and a check time can go; the captions come from the shared find-caption path; the cap applies after the
  // filter, so a valid fourth find fills a dropped slot.
  const { messages, sent } = await researchMessages(finds, { firstName: String(person.first_name ?? ""), ask: p.what, context: [...(p.memberContext ?? []), `their budget: ${p.budget ?? "not given"}`].slice(0, 7) });
  if (!sent.length) {
    // Nothing held up. If the captions never came (the model call failed) the next wake tries again; otherwise there is nothing to send.
    if (sendable(finds).length && task.wakes <= BRIEF_SEARCH_RETRIES) return;
    if (sendable(finds).length) {
      await closeTask(task.userId, task.id, "dropped", "no finds sent: no caption held up");
      return;
    }
    await tellThenClose("I looked, but couldn't verify any rooms that fit. Want me to widen the search?", "done", "no finds sent: none found");
    return;
  }
  const { recordDecision } = await import("../harness/core.js");
  // The kind of thing, never its title (the title is their ask in words).
  await recordDecision({ layer: 7, decision: "task.researchBrief", userId: task.userId, outcome: "act", action: "room finds texted", proposal: { taskId: task.id, options: sent.length, again: !!p.again, rechecked, readers: [...new Set(sent.map((f) => f.reader))] } }).catch(() => {});
  // The close note is Co's record of what went out: the options by number, so a reaction ("the second one") can be matched. The
  // options are the places found, never their words.
  const list = sent.map((f, i) => `${i + 1}. ${f.name}`).join("; ");
  await tellThenClose(messages, "done", `texted the finds: ${list}`, sent);
}
