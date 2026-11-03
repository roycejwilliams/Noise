// The working set (Royce, 2026-10-09): every ask, goal, find and backlog item is live, fulfilled, expired, rejected, superseded or
// cancelled, and only live items are ever swept, picked, re-judged or counted against a budget. Items leave on facts only (fulfilled,
// past their date, rejected by the picker, superseded, their event cancelled, the member gone), never because a model felt they were
// stale. What leaves stays for audit but is inert. On the way out, the distilled fact goes into the member's one record (co_facts,
// Co's action record, through coFacts.ts like every other fact Co writes), with its reason and its scope, never stronger than what
// happened: "set aside Hardly Strictly Bluegrass (an event on Oct 3): its date passed; scope: this event", not "doesn't like music".
// There is no second store: the states live on the rows that already hold the items, and the facts in the record that already
// holds the member. A member re-opens anything by saying it again, which makes a fresh item (an exited one never revives).
import pool from "../db/db.js";

export const LIFE_STATES = ["live", "fulfilled", "expired", "rejected", "superseded", "cancelled"] as const;
export type LifeState = (typeof LIFE_STATES)[number];
export type ExitState = Exclude<LifeState, "live">;
export type ItemKind = "ask" | "goal" | "find" | "backlog";

// ------------------------------------------------------------------ states, read from the rows that already hold the items

// An ask's closed_reason (services/askLifecycle.ts) is its exit reason; the state follows from it.
const ASK_STATE: Record<string, ExitState> = {
  member: "fulfilled", answered: "fulfilled", delivered: "fulfilled", co: "fulfilled", fulfilled: "fulfilled",
  expired: "expired", nothing_found: "expired",
  moved_on: "cancelled", archived: "cancelled", member_gone: "cancelled", cancelled: "cancelled",
  superseded: "superseded", rejected: "rejected",
};
export function askLifeState(r: { resolved_at: unknown; closed_reason?: string | null }): LifeState {
  if (!r.resolved_at) return "live";
  return ASK_STATE[String(r.closed_reason ?? "")] ?? "fulfilled";
}

// A failed attempt is not a decision (Royce, 2026-10-09: a failed Oct 6 draft kept the Extraordinary Founders Dinner from ever being
// queued again). Only a sent text or a member-visible outcome closes a find; a draft that failed its checks or a send that failed
// re-enters the working set.
export function isFailedAttempt(skipReason: string | null | undefined): boolean {
  // A queue window that ended unsent on an undated find is not a decision either (Phase B, B2: services/sendCheck.ts WINDOW_ENDED).
  // "recheck:": what it rested on was corrected (services/whatCoKnows.ts cancelQueued): judged again with what's true now.
  // "place corrected": queued for a want whose place they then corrected (cancelQueued): found for the wrong place, never judged.
  // "their ask has since closed": the row was dropped for the ask that queued it, not judged; the same find may still serve another,
  // open ask (the row's key has no ask in it), so it never decides the thing (review of the sweep fixes, 2026-10-12).
  // "what it serves has closed" (harness/closedSubject.ts SUBJECT_CLOSED): the same, for any subject it served (the ask, a thread).
  return /^(?:draft failed|send failed|send_failed|draft_failed|send error|window ended unsent|recheck:|place corrected|(?:draft skipped: )?their ask has since closed|what it serves has closed)/i.test(String(skipReason ?? "").trim());
}
// Pure: do these finished rows for one thing decide it? Any row that isn't a failed attempt does; failed attempts alone don't.
export function decidedByRows(rows: { skip_reason?: string | null }[]): boolean {
  return rows.some((r) => !isFailedAttempt(r.skip_reason));
}
export function candidateLifeState(r: { status: string; skip_reason?: string | null }): LifeState {
  if (r.status === "pending") return "live";
  if (r.status === "sent") return "fulfilled";
  if (r.status === "expired") return "expired";
  const why = String(r.skip_reason ?? "");
  if (isFailedAttempt(why)) return "live";
  if (/^(?:Co|Cue)'s daily pick: reject/i.test(why)) return "rejected";
  if (/^stale/i.test(why)) return "expired";
  if (/^sent in a reply/i.test(why)) return "fulfilled";
  return "rejected";
}

// ------------------------------------------------------------------ exits

export type Exit = {
  userId: string;
  kind: ItemKind;
  // A stable key for the item (a find's match key, an ask's id), so an exited find is never re-queued when a sweep finds it again.
  itemKey: string;
  label: string; // the item, named as the member would know it
  state: ExitState;
  reason: string; // the fact it left on, in a few words ("its date (Oct 3) passed", "Co's daily pick: an air show doesn't fit…")
  scope: string; // what the fact is about, and no wider ("this event, for their ask: events this weekend")
  // Set aside, not gone (Royce, 2026-10-11): a find that stalled at send (a rolling opening nobody picked) may come back once
  // RECOVER_AFTER_DAYS have passed, if a sweep finds it again for an ask it fits. It's read fresh before any offer (sendCheck.ts).
  recoverable?: boolean;
};
// How long a set-aside find stays out before a sweep may bring it back, and how many times it may be set aside before it's gone for
// good (review of #146: a recovered rolling opening that stalls again would otherwise cycle forever).
export const RECOVER_AFTER_DAYS = 7;
export const RECOVER_MAX_TIMES = 2;

// How many times this find has been set aside for this member already.
export async function setAsideCount(userId: string, itemKey: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM co_facts WHERE owner_user_id = $1 AND relation = $2 AND meta->>'itemKey' = $3 AND COALESCE(meta->>'recoverable', '') = 'true'`,
    [userId, EXIT_RELATION, itemKey],
  );
  return Number(rows[0]?.n ?? 0);
}

// Pure: the distilled fact, with its reason and scope. Never a verdict about the member.
export function exitFactLabel(e: Pick<Exit, "kind" | "label" | "state" | "reason" | "scope" | "recoverable">): string {
  const what = { ask: "ask", goal: "goal", find: "find", backlog: "find" }[e.kind];
  const verb = e.recoverable ? "Set aside for now" : { fulfilled: "Closed as done", expired: "Closed", rejected: "Set aside", superseded: "Replaced", cancelled: "Closed" }[e.state];
  return `${verb} the ${what} "${e.label.slice(0, 160)}": ${e.reason.slice(0, 220)}. Scope: ${e.scope.slice(0, 160)}.`;
}
// Pure: a fact is scoped only when it carries a reason and a scope, both its own (not just the verdict).
export function isScoped(e: Pick<Exit, "reason" | "scope">): boolean {
  return e.reason.trim().length >= 6 && e.scope.trim().length >= 6;
}

export const EXIT_RELATION = "exited";
export type ExitDeps = { writeFact: (e: Exit) => Promise<void> };
export const realExitDeps: ExitDeps = {
  writeFact: async (e) => {
    const { recordFactChecked } = await import("./coFacts.js");
    await recordFactChecked({
      ownerUserId: e.userId, subject: "co", relation: EXIT_RELATION, label: exitFactLabel(e), visibility: "owner", source: `working_set:${e.kind}`,
      meta: { kind: e.kind, itemKey: e.itemKey, state: e.state, reason: e.reason, scope: e.scope, ...(e.recoverable ? { recoverable: true } : {}) },
    });
  },
};

// The fact first; only once it's in their record does the caller archive the item. A fact that can't be written keeps the item live.
export async function writeExitFact(e: Exit, deps: ExitDeps = realExitDeps): Promise<boolean> {
  if (!isScoped(e)) throw new Error(`an exit needs its own reason and scope (${e.kind} "${e.label}")`);
  try {
    await deps.writeFact(e);
    return true;
  } catch (err: any) {
    console.error(`workingSet: exit fact for ${e.kind} "${e.label.slice(0, 60)}" failed, the item stays live:`, err?.message ?? err);
    return false;
  }
}

// Exited finds, by key: a sweep that finds one again never puts it back (inert, never re-queued). A set-aside one (recoverable)
// blocks only for RECOVER_AFTER_DAYS; after that a sweep that finds it again may queue it, and it's read fresh before any offer.
export async function exitedFindKeys(userId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const { rows } = await pool.query(
    `SELECT DISTINCT meta->>'itemKey' AS k FROM co_facts WHERE owner_user_id = $1 AND relation = $2 AND meta->>'kind' IN ('find', 'backlog') AND meta->>'itemKey' = ANY($3::text[])
       AND NOT (COALESCE(meta->>'recoverable', '') = 'true' AND created_at < NOW() - make_interval(days => $4))`,
    [userId, EXIT_RELATION, keys, RECOVER_AFTER_DAYS],
  );
  return new Set(rows.map((r: any) => String(r.k)));
}

// ------------------------------------------------------------------ asks

// Empty runs (Royce, 2026-10-09): an ask that keeps coming back empty backs off, then exits as "searched, nothing found".
export const ASK_BACKOFF = { slowAfter: 3, everyDays: 3, exitAfter: 6 } as const;
// Pure: is a find ask due a search today?
export function askSearchDue(r: { empty_runs?: number | null; last_attempted_at?: Date | string | null }, now = new Date()): boolean {
  const empties = Number(r.empty_runs ?? 0);
  if (empties < ASK_BACKOFF.slowAfter || !r.last_attempted_at) return true;
  return now.getTime() - new Date(r.last_attempted_at).getTime() >= ASK_BACKOFF.everyDays * 86_400_000;
}
export function askExhausted(r: { empty_runs?: number | null }): boolean {
  return Number(r.empty_runs ?? 0) >= ASK_BACKOFF.exitAfter;
}
// Pure: an ask's empty-run count after one hourly search (Royce, 2026-10-14: the taper "never deletes"). While the member is quiet (or
// their silence couldn't be read) an empty run isn't counted: the count is frozen (its backoff keeps it searching less often, as before)
// and marked held. The first empty run after they're engaged again starts counting fresh. A find resets it as always. An engaged member
// who never went quiet counts exactly as before.
export function nextEmptyRuns(o: { prev: number; found: boolean; quiet: boolean; heldBefore: boolean }): { emptyRuns: number; held: boolean } {
  if (o.found) return { emptyRuns: 0, held: false };
  if (o.quiet) return { emptyRuns: o.prev, held: true };
  if (o.heldBefore) return { emptyRuns: 1, held: false };
  return { emptyRuns: o.prev + 1, held: false };
}
// Pure: does this ask exit as "searched, nothing found" now? Never while its member is quiet or their silence can't be read.
export function askExitDue(r: { empty_runs?: number | null }, silence: "quiet" | "engaged" | "unknown"): boolean {
  return silence === "engaged" && askExhausted(r);
}

// One ask out of the working set: the fact, then the close (askKind.ts closeAsk, the one way an ask closes, in both places it lives).
export async function exitAsk(o: { userId: string; askRowId: string; askId: string; text: string; state: ExitState; reason: string; scope?: string; closedReason: string }, deps: ExitDeps = realExitDeps): Promise<boolean> {
  const ok = await writeExitFact({ userId: o.userId, kind: "ask", itemKey: `ask:${o.askRowId}`, label: o.text, state: o.state, reason: o.reason, scope: o.scope ?? "this ask only; saying it again opens a new one" }, deps);
  if (!ok) return false;
  const { closeAsk } = await import("./askKind.js");
  await closeAsk(o.userId, o.askId, o.closedReason, o.reason.slice(0, 300));
  return true;
}

// A member who's gone (archived or opted out) has nothing live (Royce, 2026-10-09: the archived test accounts were swept every
// morning and spent most of the shared web search budget).
export async function exitGoneMembersAsks(deps: ExitDeps = realExitDeps): Promise<number> {
  const { rows } = await pool.query(
    `SELECT ac.id, ac.ask_id, ac.user_id, ac.ask_text, u.archived_at IS NOT NULL AS archived
     FROM ask_checkins ac JOIN users u ON u.id = ac.user_id
     WHERE ac.resolved_at IS NULL AND (u.archived_at IS NOT NULL OR COALESCE(u.sms_opted_out, false))
     LIMIT 500`,
  );
  let n = 0;
  for (const r of rows) {
    const ok = await exitAsk({ userId: r.user_id, askRowId: String(r.id), askId: String(r.ask_id), text: String(r.ask_text ?? ""), state: "cancelled", closedReason: "member_gone", reason: r.archived ? "the member's account was archived" : "the member opted out of texts", scope: "this ask; nothing about what they wanted" }, deps);
    if (ok) n++;
  }
  return n;
}

// ------------------------------------------------------------------ the backlog

// An undated or unreadable find is held (never offered) and read again once a day; it exits only after this many separate days
// (review of #133: one failed read, or three passes in one day, used to exit it with a false "no date" fact).
export const UNREAD_DAYS = 3;
// "stalled" (Phase B, re-review of #138): a find the send path couldn't send after several tries (its queue window ended unsent again
// and again, or its page kept holding it back). It leaves the dispatch pool (offerable is false), is never re-classified back in (that
// was an endless loop: requeue, expire, reopen), and exits after UNREAD_DAYS separate days held. note: why it stalled.
export type Unread = { days: string[]; why: "undated" | "unknown" | "stalled"; note?: string };
// Pure: is a backlog item offerable? A held one isn't, anywhere (picker pool, the queue, a task's on-file finds).
export function offerable(item: { unread?: Unread | null } | null | undefined): boolean {
  return !item?.unread;
}

// The backlog, changed by merging into what's there now (review of #133: prune read the backlog, classified slowly, then overwrote it,
// so a find a sweep added in between was lost). remove: keys out; replace: the classified or held version of an item, by key.
export type BacklogChange = { remove: Set<string>; replace: Map<string, any> };
export type PruneDeps = ExitDeps & {
  backlogs: (userId: string) => Promise<{ ask_id: string; items: any[] }[]>;
  merge: (userId: string, askId: string, change: BacklogChange) => Promise<void>;
  classify: (match: any, today: string) => Promise<{ match: any; result: "dated_event" | "opening" | "undated" | "unknown"; note?: string }>;
  zone: (userId: string) => Promise<string | null>;
  key: (match: any) => string;
  exited?: (userId: string, keys: string[]) => Promise<Set<string>>;
  // How many times a find was set aside before (RECOVER_MAX_TIMES). Without it, a stalled find is set aside as if for the first time.
  setAsides?: (userId: string, itemKey: string) => Promise<number>;
};
// Pure: apply a change to a backlog's current items.
// Two items under one key are the same find: a replacement lands once, never as two copies (re-review of #133).
export function applyChange(items: any[], change: BacklogChange, key: (m: any) => string): any[] {
  const placed = new Set<string>();
  const out: any[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const k = key(it?.match ?? {});
    if (change.remove.has(k)) continue;
    const r = change.replace.get(k);
    if (!r) { out.push(it); continue; }
    if (placed.has(k)) continue;
    placed.add(k);
    out.push(r);
  }
  return out;
}

// Pure: a sweep's save, merged into the row as it is now (re-review of #133: the sweep overwrote the row with a list read before a
// minutes-long search, undoing a prune's or picker's work in between). What the sweep read (`read`), what it wants (`next`) and what's
// there now (`now`): an item someone else removed since the read stays out; one someone else added stays in; an item someone else
// changed since the read (a prune classified it, added a read day, or cleared its hold) keeps their version when the sweep left it as
// it was (Phase A, the re-review's low finding: a held copy came back after the prune had read it); when both changed it, the sweep's
// wins, with the read days recorded since.
export function mergeSweepSave(read: any[], next: any[], now: any[], key: (m: any) => string): any[] {
  const k = (it: any) => key(it?.match ?? {});
  const readKeys = new Set(read.map(k));
  const readBy = new Map(read.map((it) => [k(it), JSON.stringify(it)]));
  const nowBy = new Map(now.map((it) => [k(it), it]));
  const kept = next
    .filter((it) => !readKeys.has(k(it)) || nowBy.has(k(it)))
    .map((it) => {
      const cur = nowBy.get(k(it));
      if (!cur) return it;
      const was = readBy.get(k(it));
      const theyChanged = was !== undefined && JSON.stringify(cur) !== was;
      const sweepChanged = was === undefined || JSON.stringify(it) !== was;
      if (theyChanged && !sweepChanged) return cur;
      return cur.unread && (!it.unread || (cur.unread.days?.length ?? 0) > (it.unread.days?.length ?? 0)) ? { ...it, unread: cur.unread } : it;
    });
  const nextKeys = new Set(next.map(k));
  return [...kept, ...now.filter((it) => !readKeys.has(k(it)) && !nextKeys.has(k(it)))];
}

// Pure: the decision for one backlog item on a date, from its form and dates (services/findForm.ts).
export function backlogVerdict(match: any, today: string, f: { lifeEnd: (m: any) => string | null; form: (m: any) => "event" | "opening" | null }): "keep" | "past" | "classify" {
  const form = f.form(match);
  if (!form) return "classify";
  const end = f.lifeEnd(match);
  if (end && end < today) return "past";
  if (form === "event" && !end) return "classify";
  return "keep";
}

// Every backlog item for one member, through the same rules, in their zone: a past one exits on its date; an undated or unreadable
// one is held and read again once a day, and exits after UNREAD_DAYS separate days; the rest stay. Applied to the whole backlog.
// The prune runs before the daily pick: its reads are capped by count (classifyLimit) and by time (classifyMs), so the pick's start is
// bounded; what's left is read tomorrow.
export const PRUNE_CLASSIFY_MS = 120_000;
// quiet: the member is tapered (services/sweepShadow.ts holdWhileQuiet): only a find whose date or deadline has passed leaves, its fact
// saying "passed while quiet"; nothing is read to be dated, and nothing exits for being unread or stalled (it waits for them).
export async function pruneBacklogs(userId: string, today: string, deps: PruneDeps, opts: { classifyLimit?: number; classifyMs?: number; quiet?: boolean } = {}): Promise<{ exited: number; dated: number; kept: number }> {
  const started = Date.now();
  const F = await import("./findForm.js");
  const zone = await deps.zone(userId).catch(() => null);
  const lifeEnd = (m: any) => F.lifeEndOf(m, zone);
  const lists = await deps.backlogs(userId);
  const already = deps.exited ? await deps.exited(userId, lists.flatMap((b) => (b.items ?? []).map((it: any) => deps.key(it?.match ?? {})))).catch(() => new Set<string>()) : new Set<string>();
  let exited = 0, dated = 0, kept = 0, classified = 0;
  const gone = new Set<string>();
  for (const b of lists) {
    const change: BacklogChange = { remove: new Set(), replace: new Map() };
    for (const it of Array.isArray(b.items) ? b.items : []) {
      let match = it?.match;
      if (!match) continue;
      const k = deps.key(match);
      // Exited already (another ask's backlog this run, or an earlier exit a racing save put back): out, no second fact.
      if (gone.has(k) || already.has(k)) {
        change.remove.add(k);
        continue;
      }
      const held: Unread | null = it?.unread ?? null;
      let v = backlogVerdict(match, today, { lifeEnd, form: F.formOf });
      if (opts.quiet) {
        if (v !== "past") {
          kept++;
          continue;
        }
        const ok = await writeExitFact({ userId, kind: "backlog", itemKey: k, label: String(match.name ?? ""), state: "expired", reason: `${F.formOf(match) === "opening" ? "its deadline" : "its date"} (${lifeEnd(match)}) passed while quiet`, scope: `this ${F.formOf(match) ?? "find"}${it?.askText ? `, found for: ${String(it.askText).slice(0, 100)}` : ""}` }, deps);
        if (ok) {
          gone.add(k);
          change.remove.add(k);
          exited++;
        } else kept++;
        continue;
      }
      let nowHeld: Unread | null = null;
      if (held?.why === "stalled" && v !== "past") {
        if (held.days.includes(today)) {
          kept++;
          continue;
        }
        nowHeld = { ...held, days: [...new Set([...held.days, today])] };
      } else if (v === "classify" || held) {
        if (held?.days.includes(today) || classified >= (opts.classifyLimit ?? 12) || Date.now() - started >= (opts.classifyMs ?? PRUNE_CLASSIFY_MS)) {
          kept++;
          continue; // read today already, or over this run's reading budget: tomorrow
        }
        classified++;
        const c = await deps.classify(match, today).catch(() => ({ match, result: "unknown" as const }));
        match = c.match;
        // Why it couldn't be read, kept with it, and said when it exits (Royce, 2026-10-12: it shelved silently).
        if (c.result === "undated" || c.result === "unknown") nowHeld = { days: [...new Set([...(held?.days ?? []), today])], why: c.result, ...("note" in c && c.note ? { note: String(c.note).slice(0, 300) } : {}) };
        else {
          dated++;
          v = backlogVerdict(match, today, { lifeEnd, form: F.formOf });
        }
      }
      const tooLong = !!nowHeld && nowHeld.days.length >= UNREAD_DAYS;
      if (tooLong || v === "past") {
        const end = lifeEnd(match);
        const reason = tooLong
          ? nowHeld!.why === "stalled" ? `it couldn't be sent after repeated tries (${nowHeld!.note ?? "held at send"}), and was held ${UNREAD_DAYS} separate days` : nowHeld!.why === "unknown" ? `its page couldn't be read on ${UNREAD_DAYS} separate days${nowHeld!.note ? ` (${nowHeld!.note})` : ""}, so when it is can't be checked` : `its page didn't say when it is on ${UNREAD_DAYS} separate days`
          : `${F.formOf(match) === "opening" ? "its deadline" : "its date"} (${end}) passed`;
        const ok = await writeExitFact({ userId, kind: "backlog", itemKey: k, label: String(match.name ?? ""), state: "expired", recoverable: tooLong && nowHeld!.why === "stalled" && (deps.setAsides ? await deps.setAsides(userId, k).catch(() => RECOVER_MAX_TIMES) : 0) < RECOVER_MAX_TIMES, reason, scope: `this ${F.formOf(match) ?? "find"}${it?.askText ? `, found for: ${String(it.askText).slice(0, 100)}` : ""}` }, deps);
        if (ok) {
          gone.add(k);
          change.remove.add(k);
          exited++;
          continue;
        }
      }
      const next = { ...it, match };
      if (nowHeld) next.unread = nowHeld;
      else delete next.unread;
      change.replace.set(k, next);
      kept++;
    }
    if (change.remove.size || change.replace.size) await deps.merge(userId, b.ask_id, change);
  }
  return { exited, dated, kept };
}

// A find the picker rejected leaves every backlog for good, with the picker's reason, scoped to the thing and the ask it was for.
export async function exitRejectedFinds(userId: string, rejected: { key: string; name: string; why: string; askText?: string | null }[], deps: Pick<PruneDeps, "backlogs" | "merge" | "key"> & ExitDeps): Promise<number> {
  if (!rejected.length) return 0;
  const out = new Set<string>();
  for (const r of rejected) {
    const ok = await writeExitFact({ userId, kind: "find", itemKey: r.key, label: r.name, state: "rejected", reason: `Cue's daily pick: ${r.why || "not for them now"}`, scope: `this find${r.askText ? `, for: ${r.askText.slice(0, 100)}` : ""}; nothing broader about what they like` }, deps);
    if (ok) out.add(r.key);
  }
  if (!out.size) return 0;
  for (const b of await deps.backlogs(userId)) {
    if ((b.items ?? []).some((it: any) => out.has(deps.key(it?.match ?? {})))) await deps.merge(userId, b.ask_id, { remove: out, replace: new Map() });
  }
  return out.size;
}

// A kind they ruled out takes what's already waiting with it (Phase A2: "I'll stop suggesting it" held only for new searches, so a
// hackathon already in the backlog or queued still went out). Each thing waiting is judged against the kind by its main activity
// (services/memberLimits.ts judgeAvoided, their own words when the read fails); one that is leaves every backlog, and a queued offer
// is skipped, each with its fact first.
export type AvoidDeps = Pick<PruneDeps, "backlogs" | "merge" | "key"> &
  ExitDeps & {
    judge: (items: { name: string; details: string }[], avoid: string[]) => Promise<(string | null)[]>;
    pending: (userId: string) => Promise<{ id: string; match: any; askText: string | null }[]>;
    skipPending: (id: string, reason: string) => Promise<void>;
  };
export const AVOID_JUDGE_MAX = 20;
export async function exitAvoidedFinds(userId: string, kind: string, deps: AvoidDeps): Promise<{ backlog: number; queued: number }> {
  const { judgedOf } = await import("./memberLimits.js");
  const waiting: { key: string; match: any; askText: string | null; pendingId: string | null }[] = [];
  const seen = new Set<string>();
  // Queued offers first: they're the next to go out (review of #134: a full backlog crowded them out of the judged set).
  for (const p of await deps.pending(userId)) waiting.push({ key: deps.key(p.match ?? {}), match: p.match, askText: p.askText, pendingId: p.id });
  for (const b of await deps.backlogs(userId)) {
    for (const it of b.items ?? []) {
      const key = deps.key(it?.match ?? {});
      if (seen.has(key)) continue;
      seen.add(key);
      waiting.push({ key, match: it.match, askText: it?.askText ?? null, pendingId: null });
    }
  }
  const judged = waiting;
  if (!judged.length) return { backlog: 0, queued: 0 };
  // Everything waiting is judged, AVOID_JUDGE_MAX to a read.
  const kinds: (string | null)[] = [];
  for (let i = 0; i < judged.length; i += AVOID_JUDGE_MAX) kinds.push(...(await deps.judge(judged.slice(i, i + AVOID_JUDGE_MAX).map((w) => judgedOf(w.match)), [kind])));
  const reason = `they asked Cue to stop suggesting ${kind}`;
  const out = new Set<string>();
  const written = new Set<string>();
  let queued = 0;
  for (let i = 0; i < judged.length; i++) {
    if (!kinds[i]) continue;
    const w = judged[i];
    // One fact per thing, though it can be both in a backlog and queued.
    const ok = written.has(w.key) || await writeExitFact({ userId, kind: "find", itemKey: w.key, label: String(w.match?.name ?? ""), state: "rejected", reason, scope: `this find${w.askText ? `, found for: ${w.askText.slice(0, 100)}` : ""}; the rule itself is on their record` }, deps);
    if (!ok) continue;
    written.add(w.key);
    if (w.pendingId) {
      await deps.skipPending(w.pendingId, reason);
      queued++;
    } else out.add(w.key);
  }
  if (out.size) {
    for (const b of await deps.backlogs(userId)) {
      if ((b.items ?? []).some((it: any) => out.has(deps.key(it?.match ?? {})))) await deps.merge(userId, b.ask_id, { remove: out, replace: new Map() });
    }
  }
  return { backlog: out.size, queued };
}

// ------------------------------------------------------------------ the daily pass

// Once a day, before the morning sweep: the same factual exits for everyone. A gone member's live items close (asks, backlog,
// waiting finds); every live member's backlog is pruned (past dates out, undated items classified and dated or out). The first run
// migrates the pile that built up before the working set existed.
export async function pruneAllWorkingSets(deps: PruneDeps, now = new Date()): Promise<{ goneAsks: number; goneItems: number; pruned: number }> {
  const goneAsks = await exitGoneMembersAsks(deps);
  const { rows: gone } = await pool.query(
    `SELECT DISTINCT u.id, u.archived_at IS NOT NULL AS archived FROM users u
     WHERE (u.archived_at IS NOT NULL OR COALESCE(u.sms_opted_out, false))
       AND (EXISTS (SELECT 1 FROM event_backlogs b WHERE b.user_id = u.id AND jsonb_array_length(b.items) > 0)
            OR EXISTS (SELECT 1 FROM proactive_candidates c WHERE c.user_id = u.id AND c.status = 'pending'))`,
  );
  let goneItems = 0;
  for (const g of gone) {
    const why = g.archived ? "the member's account was archived" : "the member opted out of texts";
    for (const b of await deps.backlogs(g.id)) {
      const left: any[] = [];
      for (const it of b.items ?? []) {
        const ok = await writeExitFact({ userId: g.id, kind: "backlog", itemKey: deps.key(it?.match ?? {}), label: String(it?.match?.name ?? "a find"), state: "cancelled", reason: why, scope: "this find; nothing about what they wanted" }, deps);
        if (ok) goneItems++;
        else left.push(it);
      }
      const keep = new Set(left.map((it: any) => deps.key(it?.match ?? {})));
      await deps.merge(g.id, b.ask_id, { remove: new Set((b.items ?? []).map((it: any) => deps.key(it?.match ?? {})).filter((k: string) => !keep.has(k))), replace: new Map() });
    }
    const { rows: waiting } = await pool.query(`SELECT id, summary FROM proactive_candidates WHERE user_id = $1 AND status = 'pending'`, [g.id]);
    for (const c of waiting) {
      const ok = await writeExitFact({ userId: g.id, kind: "find", itemKey: `candidate:${c.id}`, label: String(c.summary ?? "a waiting text"), state: "cancelled", reason: why, scope: "this text; nothing about them" }, deps);
      if (ok) {
        await pool.query(`UPDATE proactive_candidates SET status = 'skipped', skip_reason = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [c.id, `member gone: ${why}`]);
        goneItems++;
      }
    }
  }
  const { rows: live } = await pool.query(
    `SELECT DISTINCT b.user_id FROM event_backlogs b JOIN users u ON u.id = b.user_id
     WHERE u.archived_at IS NULL AND COALESCE(u.sms_opted_out, false) = false AND jsonb_array_length(b.items) > 0`,
  );
  let pruned = 0;
  for (const r of live) {
    const zone = await deps.zone(r.user_id).catch(() => null);
    const z = zone ?? "America/Los_Angeles";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    // A quiet member (or one whose silence can't be read) keeps everything but what has passed (Royce, 2026-10-14).
    const quiet = await import("./dailySweep.js").then((D) => D.memberTapered(String(r.user_id), now)).catch(() => true);
    pruned += (await pruneBacklogs(r.user_id, today, deps, { quiet })).exited;
  }
  return { goneAsks, goneItems, pruned };
}

// ------------------------------------------------------------------ visibility

export type WorkingSetRow = { userId: string; name: string; asks: number; goals: number; finds: number; backlog: number; sweeps24h: number; web24h: number; x24h: number };
// Pure: the report's lines (Royce, 2026-10-09: "unbounded growth means a leak, and it should be visible on day one").
export function workingSetLines(rows: WorkingSetRow[]): string[] {
  if (!rows.length) return ["Working set: nothing live."];
  return [
    "Working set (live items) and search spend, last 24h, per member:",
    ...rows.map((r) => `- ${r.name}: ${r.asks} asks, ${r.goals} goals, ${r.finds} finds waiting, ${r.backlog} in backlog | ${r.sweeps24h} sweeps, ${r.web24h} web + ${r.x24h} X searches`),
  ];
}
export async function workingSetRows(): Promise<WorkingSetRow[]> {
  const { rows } = await pool.query(
    `SELECT u.id, COALESCE(u.first_name, '?') AS name,
       (SELECT COUNT(*) FROM ask_checkins a WHERE a.user_id = u.id AND a.resolved_at IS NULL)::int AS asks,
       (SELECT COALESCE(array_length(cp.goals, 1), 0) FROM co_profiles cp WHERE cp.user_id = u.id)
         - (SELECT COUNT(*) FROM goal_states g WHERE g.user_id = u.id AND g.state <> 'active')::int AS goals,
       (SELECT COUNT(*) FROM proactive_candidates c WHERE c.user_id = u.id AND c.status = 'pending')::int AS finds,
       (SELECT COALESCE(SUM(jsonb_array_length(b.items)), 0) FROM event_backlogs b WHERE b.user_id = u.id)::int AS backlog,
       (SELECT COUNT(*) FROM harness_decisions d WHERE d.user_id = u.id AND d.decision IN ('sweep.surface', 'goal_sweep.plan') AND d.created_at > NOW() - INTERVAL '1 day')::int AS sweeps,
       (SELECT COUNT(*) FROM web_search_log w WHERE w.user_id = u.id AND w.created_at > NOW() - INTERVAL '1 day')::int AS web,
       (SELECT COUNT(*) FROM x_search_log x WHERE x.user_id = u.id AND x.created_at > NOW() - INTERVAL '1 day')::int AS x
     FROM users u`,
  );
  return rows
    .map((r: any) => ({ userId: r.id, name: r.name, asks: r.asks, goals: Math.max(0, Number(r.goals ?? 0)), finds: r.finds, backlog: r.backlog, sweeps24h: r.sweeps, web24h: r.web, x24h: r.x }))
    .filter((r) => r.asks || r.goals || r.finds || r.backlog || r.sweeps24h || r.web24h || r.x24h)
    .sort((a, b) => b.web24h + b.x24h + b.sweeps24h - (a.web24h + a.x24h + a.sweeps24h));
}
