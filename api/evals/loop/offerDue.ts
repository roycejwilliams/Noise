// Offer loops end with their event (closure audit, 2026-11-02: offers got no due date, services/openLoops.ts deriveLoops). An offer
// tied to a dated thing carries its day; once that day is over the daily pass closes the loop quietly as date_passed, and no reply
// reads it as still waiting. No member text either way. Zero tokens: the store is stubbed.
//   npx tsx evals/loop/offerDue.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
const { default: pool } = await import("../../src/db/db.js");
const O = await import("../../src/services/openLoops.js");
const LL = await import("../../src/services/loopLifecycle.js");

let total = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { total++; if (!ok) { failed++; console.log(`FAIL ${label}${detail !== undefined ? `\n  ${JSON.stringify(detail).slice(0, 600)}` : ""}`); } };

const NOW = new Date("2026-11-02T20:00:00Z"); // Monday noon in Pacific
const TODAY = "2026-11-02";
const PT = "America/Los_Angeles";

// ---- the day an offer is over by, from every date it can carry, in their zone
check("a public event: its event day", O.offerDay({ kind: "public_event", event_date: "2026-11-01", startAt: "2026-11-02T02:30:00.000Z" }, PT) === "2026-11-01");
check("... its page's end when it runs over days", O.offerDay({ details: { startAt: "2026-11-07T17:00:00Z", endAt: "2026-11-08T23:00:00Z" } }, PT) === "2026-11-08");
check("a web opportunity: the date its post states", O.offerDay({ kind: "opportunity", statedDates: { start: "2026-10-21" } }, PT) === "2026-10-21");
check("an evening start in UTC is still that evening's day where they are", O.offerDay({ details: { startAt: "2026-11-04T02:30:00.000Z" } }, PT) === "2026-11-03");
check("an offer with no date has none (it ends the way it always did)", O.offerDay({ kind: "opportunity", name: "A standing community" }, PT) === null && O.offerDay(null, PT) === null);

// ---- derive: the offer's loop carries the day
const loops = O.deriveLoops({ tasks: [], notes: null, asks: [], offers: [{ key: "offer:a", name: "Founder dinner", date: "2026-11-01" }, { key: "offer:b", name: "A standing community", date: null }] });
const dated = loops.find((l) => l.sourceRef === "offer:a")!;
const undated = loops.find((l) => l.sourceRef === "offer:b")!;
check("an offer tied to an event gets that event's date as its due date", dated.dueDate === "2026-11-01" && dated.status === "waiting_on_reply", dated);
check("... one with no date keeps none", undated.dueDate === null);

// ---- the daily pass: dated yesterday closes as date_passed, quietly; tomorrow's and an undated one wait
const row = (id: number, dueDate: string | null) => ({ id, source: "offer", sourceRef: `offer:${id}`, title: `Sent them event ${id}`, status: "waiting_on_reply", statusBy: "code", detail: "waiting on how it landed", dueDate, taskId: null, changedAt: NOW, seenAt: NOW, wokeAt: null, closedAt: null, closedReason: null, lastConfirmedAt: NOW, decayAskedAt: null, userId: "u1", zone: PT }) as any;
check("deriveLoops on an offer dated yesterday gives close_date_passed", LL.decayAction({ ...row(1, "2026-11-01") }, NOW, TODAY).kind === "close_date_passed");
check("... on the day itself, not yet", LL.decayAction({ ...row(2, TODAY) }, NOW, TODAY).kind === "none");
{
  const closed: [number, string][] = [];
  const asked: number[] = [];
  const out = await O.runLoopDecay(NOW, {
    live: async () => [row(1, "2026-11-01"), row(2, "2026-11-03"), row(3, null)],
    close: async (id, reason) => { closed.push([id, reason]); },
    expire: async () => {},
    ask: async (l) => { asked.push(l.id); return true; },
  });
  check("the daily pass closes the past one as date_passed and leaves the rest", closed.length === 1 && closed[0][0] === 1 && closed[0][1] === "date_passed" && out.closed === 1, closed);
  check("... and sends nothing: no ask is queued for any of them (waiting loops are never asked about)", asked.length === 0 && out.asked === 0);
  check("a reply never reads a past-dated offer as current", !LL.isDraftable({ status: "waiting_on_reply", closedAt: null, closedReason: null, dueDate: "2026-11-01", lastConfirmedAt: NOW, decayAskedAt: null }, NOW, TODAY));
}

// ---- the sync reads the offer's date and writes it on the loop
{
  const writes: any[][] = [];
  const handle = async (raw: string, a: any[] = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (/FROM proactive_candidates WHERE user_id = \$1 AND type = 'event_offer' AND status = 'sent'/.test(sql)) {
      if (!/payload->'match' AS match/.test(sql)) return { rows: [] };
      return { rows: [{ target_key: "offer:luma-1", name: "Founder dinner", match: { kind: "public_event", event_date: "2026-11-01", startAt: "2026-11-02T03:00:00.000Z" } }] };
    }
    if (/^INSERT INTO open_loops/.test(sql)) { writes.push(a); return { rows: [{ id: 1, source: a[1], source_ref: a[2], title: a[3], status: a[4], status_by: "code", detail: a[5], due_date: a[6], changed_at: NOW }] }; }
    return { rows: [] };
  };
  const orig = { query: (pool as any).query, connect: (pool as any).connect };
  (pool as any).query = handle;
  (pool as any).connect = async () => ({ query: handle, release: () => {} });
  try {
    await O.syncOpenLoops("u1", NOW);
  } finally { (pool as any).query = orig.query; (pool as any).connect = orig.connect; }
  const offer = writes.find((w) => w[1] === "offer");
  check("the sync writes the offer's event day as the loop's due date", !!offer && offer[6] === "2026-11-01", writes);
}

console.log(`offer loops end with their event: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
process.exit(failed ? 1 : 0);
