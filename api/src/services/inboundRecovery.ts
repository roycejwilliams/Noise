// Answering the texts an outage held back (services/inboundHold.ts) or that never reached this process at all (Sendblue's message
// list), through the same replay path a crashed turn uses (routes/sendblue.ts replayOwedTurn: the one-shot retry claim, the phone's
// lock, the already-answered and newer-text checks). Pure apart from what's injected, so the rules can be tested without a database.
//
// One answer per member, not one per text: when someone sent several texts while Cue couldn't answer, the earlier ones are put on
// file (their "User said" lines, claimed so nothing replays them again) and the newest is replayed, so its turn sees them all.
import { isOptInKeyword, isOptOutKeyword } from "./optOut.js";

// COPY: awaiting Royce's OK (PR "Copy" section). One fixed line, not a model's choice, so it can be checked: said first, once, when
// a held or recovered text is answered more than LATE_AFTER_MS after it arrived. It owns the delay without explaining the outage.
export const LATE_REPLY_LINE = "Sorry for the slow reply.";
export const LATE_AFTER_MS = 10 * 60_000;
// At most once per member in this window, however many of their texts were held or recovered.
export const LATE_LINE_EVERY_MS = 30 * 60_000;
// A recovered text may be up to a day old (the hold's cap and the Sendblue look-back); a crashed turn's replay stays at an hour.
export const RECOVERED_MAX_AGE_MS = 24 * 60 * 60_000;

export type RecoveredText = { handle: string; payload: Record<string, unknown>; receivedAt: Date | number };
const ms = (d: Date | number) => (d instanceof Date ? d.getTime() : d);
const phoneKey = (n: unknown) => String(n ?? "").replace(/\D/g, "").slice(-10);

export const answeredLate = (receivedAt: Date | number, now: Date | number): boolean => ms(now) - ms(receivedAt) > LATE_AFTER_MS;

// Pure: whether the late line belongs in front of this text's answer: late, and not an opt-out or opt-in keyword (STOP gets its
// confirmation, never an apology first).
export function lateLineFits(payload: Record<string, unknown>, receivedAt: Date | number, now: Date | number): boolean {
  const content = typeof payload.content === "string" ? payload.content : "";
  if (content && (isOptOutKeyword(content) || isOptInKeyword(content))) return false;
  return answeredLate(receivedAt, now);
}

// The late line goes to a member once in LATE_LINE_EVERY_MS, whichever path answers them (the drain, a live turn that took held
// texts in, the Sendblue recovery).
export function createLateGuard(now: () => number = Date.now) {
  const said = new Map<string, number>();
  return {
    claim(phone: string): boolean {
      const k = phoneKey(phone);
      if (!k) return false;
      const at = said.get(k);
      if (at !== undefined && now() - at < LATE_LINE_EVERY_MS) return false;
      said.set(k, now());
      return true;
    },
    // The line didn't go: the next answer may say it.
    release(phone: string): void {
      said.delete(phoneKey(phone));
    },
  };
}

// Pure: texts by member, oldest first, each handle once; groups are never 1:1 turns and outbound or typing events are never texts.
export function byPhone(items: RecoveredText[]): { phone: string; texts: RecoveredText[] }[] {
  const groups = new Map<string, RecoveredText[]>();
  const seen = new Set<string>();
  for (const t of [...items].sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt))) {
    // One text is one text, however many paths found it.
    if (seen.has(t.handle)) continue;
    seen.add(t.handle);
    const p = t.payload ?? {};
    if (p.is_outbound || p.type === "typing" || p.message_type === "group" || p.group_id) continue;
    const k = phoneKey(p.number);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.values()].map((texts) => ({ phone: String(texts[0].payload.number), texts }));
}

// The existing STOP/START detection (services/optOut.ts), on a held text's words.
export const keywordOf = (t: RecoveredText): "out" | "in" | null => {
  const c = typeof t.payload?.content === "string" ? t.payload.content : "";
  return c && isOptOutKeyword(c) ? "out" : c && isOptInKeyword(c) ? "in" : null;
};

// Pure: what happens to each of one member's held texts, in the order they sent them (review of #301: a held STOP followed by
// another text was only put on file, so it was never honored, and they got the late line and an answer).
//   replay: through the normal turn (an opt-out or opt-in keyword always is, so STOP/START is honored by the usual code, never
//           with the late line); the newest of the rest too, with the late line when it's late.
//   fold:   claimed and put on file, so the replayed turn after it sees it.
//   drop:   claimed, nothing sent and nothing logged: they opted out after it, so it gets no answer.
export type Step = { t: RecoveredText; do: "replay" | "fold" | "drop"; late: boolean };
export function planGroup(texts: RecoveredText[], now: Date | number): Step[] {
  const steps: Step[] = [];
  let pending: RecoveredText[] = [];
  let optedOut = false;
  for (const t of texts) {
    const k = keywordOf(t);
    if (!k) {
      pending.push(t);
      continue;
    }
    for (const p of pending) steps.push({ t: p, do: "fold", late: false });
    pending = [];
    steps.push({ t, do: "replay", late: false });
    optedOut = k === "out";
  }
  if (pending.length) {
    if (optedOut) for (const p of pending) steps.push({ t: p, do: "drop", late: false });
    else {
      const last = pending[pending.length - 1];
      for (const p of pending.slice(0, -1)) steps.push({ t: p, do: "fold", late: false });
      steps.push({ t: last, do: "replay", late: lateLineFits(last.payload, pending[0].receivedAt, now) });
    }
  }
  return steps;
}

export type AnswerDeps = {
  // Runs one member's steps under their phone's lock, so a live text of theirs can't run in between (review of #301).
  withLock: <T>(phone: string, fn: () => Promise<T>) => Promise<T>;
  // Claims the text (once, by handle) and puts its line on file. false: something else already had it.
  foldIn: (t: RecoveredText) => Promise<boolean>;
  // Claims the text and does nothing else (they opted out after it). false: something else already had it.
  drop: (t: RecoveredText) => Promise<boolean>;
  // Replays the text's turn through the normal replay path, the lock already held. false: the claim or the replay checks stopped it.
  replay: (t: RecoveredText, o: { late: boolean }) => Promise<boolean>;
  // This text is done with (answered, folded in, dropped, or stopped for good).
  done: (t: RecoveredText) => void;
  // Whether this error means the database is down (its own word for it, or a probe that gets no answer).
  isDbDown: (err: unknown) => Promise<boolean>;
  now: () => Date;
};
export type AnswerResult = { replayed: number; folded: number; dropped: number; skipped: number; failed: number; stoppedOnDb: boolean; lockBusy: number };

export async function answerTexts(items: RecoveredText[], deps: AnswerDeps): Promise<AnswerResult> {
  const r: AnswerResult = { replayed: 0, folded: 0, dropped: 0, skipped: 0, failed: 0, stoppedOnDb: false, lockBusy: 0 };
  const count = { replay: "replayed", fold: "folded", drop: "dropped" } as const;
  // One step on one text. The database going away again stops the batch (everything not yet done stays held for the next pass);
  // anything else can't be fixed by trying again (the claim may already be taken), so that text is let go, counted.
  const step = async (s: Step): Promise<boolean> => {
    try {
      const ok = s.do === "replay" ? await deps.replay(s.t, { late: s.late }) : s.do === "fold" ? await deps.foldIn(s.t) : await deps.drop(s.t);
      if (ok) r[count[s.do]]++;
      else r.skipped++;
    } catch (err) {
      if (await deps.isDbDown(err)) {
        r.stoppedOnDb = true;
        return false;
      }
      r.failed++;
      console.error(`inbound recovery: answering a held text failed (${(err as any)?.constructor?.name ?? "Error"})`);
    }
    deps.done(s.t);
    return true;
  };
  for (const g of byPhone(items)) {
    let go: boolean;
    try {
      go = await deps.withLock(g.phone, async () => {
        for (const s of planGroup(g.texts, deps.now())) if (!(await step(s))) return false;
        return true;
      });
    } catch (err) {
      // The lock itself failed: the database, or the phone busy past the lock's wait. Their texts stay held either way.
      if (await deps.isDbDown(err)) {
        r.stoppedOnDb = true;
        return r;
      }
      r.lockBusy++;
      continue;
    }
    if (!go) return r;
  }
  return r;
}

// A live text's turn, under its phone's lock: what to do with that phone's held texts first.
//   defer: one of them is STOP or START, which must go through the normal path in order, so the live text joins the hold and the
//          drain answers them all, in order, right after this handler lets go of the lock;
//   fold:  otherwise each is claimed and put on file (so this turn answers it); one that can't be claimed is left held, never let go
//          (whoever has it, or the drain, settles it).
// Returns the oldest folded text's arrival (for the late line), or "defer".
export async function takeHeldIntoLiveTurn(
  held: RecoveredText[],
  deps: { foldIn: (t: RecoveredText) => Promise<boolean>; release: (handle: string) => void },
): Promise<Date | null | "defer"> {
  if (!held.length) return null;
  if (held.some((t) => keywordOf(t))) return "defer";
  let oldest: number | null = null;
  for (const t of held) {
    if (!(await deps.foldIn(t))) continue;
    deps.release(t.handle);
    oldest = Math.min(oldest ?? ms(t.receivedAt), ms(t.receivedAt));
  }
  return oldest === null ? null : new Date(oldest);
}

// The loop that waits for the database and then answers what was held. Retries with backoff (5s doubling to a minute) while the
// database doesn't answer; after an outage it also asks Sendblue for anything that never reached this process (recover).
export const DRAIN_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
// Texts whose first handler is still running get another look this often.
export const DRAIN_RECHECK_MS = 15_000;

export type DrainDeps = {
  hold: { ready: () => RecoveredText[]; size: () => number; release: (handle: string) => void };
  dbAnswers: () => Promise<boolean>;
  answer: (items: RecoveredText[], done: (t: RecoveredText) => void) => Promise<AnswerResult>;
  recover: (o: { before: Date }) => Promise<unknown>;
  alert: { noteDbUnreachable: () => void; noteHealthy: (source: "db" | "turn", o: { held: number }) => void; tick: () => void };
  schedule: (fn: () => void, ms: number) => void;
  stopping: () => boolean;
  now: () => number;
};

export function createHoldDrain(deps: DrainDeps) {
  let attempt = 0;
  let pending = false;
  let running = false;
  // When this process first saw the database fail and hasn't yet seen it answer: the start of the window to ask Sendblue about.
  let downSince: number | null = null;

  const schedule = (afterMs?: number) => {
    if (pending || deps.stopping()) return;
    pending = true;
    deps.schedule(() => {
      pending = false;
      void run();
    }, afterMs ?? DRAIN_BACKOFF_MS[Math.min(attempt, DRAIN_BACKOFF_MS.length - 1)]);
  };

  const run = async (): Promise<void> => {
    if (running || deps.stopping()) return;
    running = true;
    try {
      deps.alert.tick();
      if (!deps.hold.size() && downSince === null) return;
      if (!(await deps.dbAnswers())) {
        downSince ??= deps.now();
        deps.alert.noteDbUnreachable();
        attempt++;
        schedule();
        return;
      }
      attempt = 0;
      const ready = deps.hold.ready();
      let lockBusy = false;
      if (ready.length) {
        const r = await deps.answer(ready, (t) => deps.hold.release(t.handle));
        lockBusy = r.lockBusy > 0;
        console.error(`inbound recovery: held texts answered ${r.replayed}, taken into an answer ${r.folded}, after an opt-out ${r.dropped}, already handled ${r.skipped}, failed ${r.failed}${r.stoppedOnDb ? ", stopped: the database went away again" : ""}`);
        if (r.stoppedOnDb) {
          downSince ??= deps.now();
          deps.alert.noteDbUnreachable();
          attempt++;
          schedule();
          return;
        }
      }
      if (downSince !== null) {
        const before = new Date(downSince);
        downSince = null;
        await deps.recover({ before }).catch((err: any) => console.error(`inbound recovery: asking Sendblue for missed texts failed (${err?.status ?? err?.code ?? "error"})`));
      }
      // What the look-back just found goes now; texts whose first handler is still running get another look shortly.
      if (deps.hold.size()) schedule(deps.hold.ready().length && !lockBusy ? 0 : DRAIN_RECHECK_MS);
      else deps.alert.noteHealthy("db", { held: 0 });
    } finally {
      running = false;
    }
  };

  return {
    // Something was held, or the database just failed: start (or keep) waiting for it.
    kick(o: { dbDown?: boolean } = {}): void {
      if (o.dbDown) downSince ??= deps.now();
      schedule(o.dbDown ? undefined : 0);
    },
    run,
    state: () => ({ attempt, pending, running, downSince }),
  };
}

// What Sendblue's message list says arrived while this process couldn't save it (docs.sendblue.com/api-v2/messages:
// GET /api/v2/messages, is_outbound=false, sendblue_number, created_at_gte, ordered, 100 a page). Only this environment's own
// number, only 1:1 inbound texts with a handle, never a handle already handled here or still held, at most a day old.
//
// It only runs when the newest text this database handled for this number is itself in Sendblue's list (the anchor, checked with
// its own narrow query): the webhook for this number points here. Sendblue's webhooks are account-wide, so without that check an
// environment that doesn't receive a number's texts (co-test vs production) could answer the other's members.
//
// Read newest first (review of #301: oldest first, a long outage's newest texts sat past the page cap), back to the anchor or a day,
// whichever is nearer, up to RECOVERY_MAX_PAGES pages; past that, the oldest are the ones left out, and the log says so.
export const RECOVERY_MARGIN_MS = 2 * 60_000;
export const RECOVERY_MAX_PAGES = 20;
export const RECOVERY_PAGE = 100;

export type ListedMessage = Record<string, unknown> & { message_handle?: string };
// When it reached Sendblue: date_sent (an inbound text's arrival), else its last update.
const arrivedAt = (m: ListedMessage): number => Date.parse(String(m.date_sent ?? m.date_updated ?? ""));
export type FindDeps = {
  ourNumber: string | undefined;
  anchor: (before: Date) => Promise<{ handle: string; receivedAt: Date } | null>;
  list: (q: { created_at_gte: string; created_at_lte?: string; order_direction: "asc" | "desc"; offset: number; limit: number }) => Promise<{ data: ListedMessage[]; hasMore: boolean }>;
  known: (handles: string[]) => Promise<Set<string>>;
  held: (handle: string) => boolean;
  now: () => Date;
};
export type FindResult = { texts: RecoveredText[]; skipped: string | null; listed: number; capped: boolean };

export async function findMissedTexts(deps: FindDeps, o: { before: Date }): Promise<FindResult> {
  const ours = phoneKey(deps.ourNumber);
  if (!ours) return { texts: [], skipped: "no_sendblue_number", listed: 0, capped: false };
  const anchor = await deps.anchor(o.before);
  if (!anchor) return { texts: [], skipped: "no_anchor", listed: 0, capped: false };
  const now = deps.now().getTime();
  // The anchor, on its own: a few minutes either side of when it arrived.
  const near = await deps.list({
    created_at_gte: new Date(anchor.receivedAt.getTime() - RECOVERY_MARGIN_MS).toISOString(),
    created_at_lte: new Date(anchor.receivedAt.getTime() + RECOVERY_MARGIN_MS).toISOString(),
    order_direction: "desc",
    offset: 0,
    limit: RECOVERY_PAGE,
  });
  if (!near.data.some((m) => m.message_handle === anchor.handle)) return { texts: [], skipped: "anchor_not_listed", listed: near.data.length, capped: false };
  const from = new Date(Math.max(anchor.receivedAt.getTime() - RECOVERY_MARGIN_MS, now - RECOVERED_MAX_AGE_MS));
  const listed: ListedMessage[] = [];
  let capped = false;
  for (let page = 0; ; page++) {
    if (page >= RECOVERY_MAX_PAGES) {
      capped = true;
      break;
    }
    const { data, hasMore } = await deps.list({ created_at_gte: from.toISOString(), order_direction: "desc", offset: page * RECOVERY_PAGE, limit: RECOVERY_PAGE });
    listed.push(...data);
    if (!hasMore || data.length < RECOVERY_PAGE) break;
  }
  const candidates = listed.filter((m) => {
    if (typeof m.message_handle !== "string" || !m.message_handle) return false;
    if (m.is_outbound !== false && m.is_outbound !== "false") return false;
    if (phoneKey(m.sendblue_number ?? m.to_number) !== ours) return false;
    if (m.message_type === "group" || m.group_id) return false;
    const hasWords = typeof m.content === "string" && m.content.trim().length > 0;
    const hasMedia = typeof m.media_url === "string" && m.media_url.length > 0;
    if (!hasWords && !hasMedia) return false;
    const at = arrivedAt(m);
    return Number.isFinite(at) && at <= now && now - at <= RECOVERED_MAX_AGE_MS && !deps.held(m.message_handle);
  });
  if (!candidates.length) return { texts: [], skipped: null, listed: listed.length, capped };
  const known = await deps.known(candidates.map((m) => m.message_handle as string));
  const seen = new Set<string>();
  const texts: RecoveredText[] = [];
  for (const m of candidates) {
    const handle = m.message_handle as string;
    if (known.has(handle) || seen.has(handle)) continue;
    seen.add(handle);
    // The webhook's own field names (docs: receiving-messages); `number` is the member's for an inbound text.
    texts.push({ handle, payload: { ...m, number: m.number ?? m.from_number, is_outbound: false }, receivedAt: new Date(arrivedAt(m)) });
  }
  return { texts, skipped: null, listed: listed.length, capped };
}
