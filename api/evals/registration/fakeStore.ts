// An in-memory event_registrations for the registration tests: answers the store's own statements (registrationStore.ts) the way
// Postgres would, one row per member and event, the claim's WHERE clause included. Nothing reaches a database.
import type { Q } from "../../src/services/eventRegistration/registrationStore.js";

export function fakeRegistrations(now: () => Date = () => new Date()) {
  const rows: any[] = [];
  let n = 0;
  const parse = (v: unknown) => (typeof v === "string" && /^[[{]/.test(v) ? JSON.parse(v) : v);
  const q: Q = {
    query: async (sql: string, a: any[] = []) => {
      if (/INSERT INTO event_registrations/.test(sql)) {
        let r = rows.find((x) => x.user_id === a[0] && x.event_key === a[1]);
        if (!r) {
          r = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, user_id: a[0], event_key: a[1], event_url: a[2], item_key: a[3], event_name: a[4], status: "inspected", answers: {}, drafts: [], attempts: 0, created_at: now(), updated_at: now() };
          rows.push(r);
        } else r.item_key ??= a[3];
        return { rows: [r] };
      }
      if (/SELECT \* FROM event_registrations WHERE user_id = \$1 AND id = \$2/.test(sql)) return { rows: rows.filter((r) => r.user_id === a[0] && r.id === a[1]) };
      if (/SELECT \* FROM event_registrations WHERE user_id = \$1 AND event_key = \$2/.test(sql)) return { rows: rows.filter((r) => r.user_id === a[0] && r.event_key === a[1]) };
      if (/SELECT form, answers FROM event_registrations/.test(sql)) return { rows: rows.filter((r) => r.user_id === a[0] && r.id !== a[1] && r.form) };
      if (/SELECT event_key, event_url, item_key, status, updated_at FROM event_registrations/.test(sql)) return { rows: rows.filter((r) => r.user_id === a[0] && (a[1] as string[]).includes(r.status)) };
      const r = rows.find((x) => x.id === a[0] && x.user_id === a[1]);
      if (/SET status = 'submitting'/.test(sql)) {
        if (!r || r.ask_kind !== "submit") return { rows: [] };
        if (/status = 'uncertain'/.test(sql)) {
          if (r.status !== "uncertain" || r.scope_hash !== a[2] || !(new Date(r.asked_at) > new Date(r.submit_started_at))) return { rows: [] };
        } else if (!(a[2] as string[]).includes(r.status) || r.scope_hash !== a[3]) return { rows: [] };
        Object.assign(r, { status: "submitting", attempts: r.attempts + 1, submit_started_at: now(), updated_at: now() });
        return { rows: [r] };
      }
      if (/UPDATE event_registrations SET status = \$3/.test(sql)) {
        if (!r || !(a[3] as string[]).includes(r.status)) return { rows: [] };
        r.status = a[2];
        r.updated_at = now();
        for (const [, col, i] of sql.matchAll(/, ([a-z_]+) = \$(\d+)/g)) r[col] = parse(a[Number(i) - 1]);
        return { rows: [r] };
      }
      throw new Error(`fake store: unexpected SQL ${sql.slice(0, 80)}`);
    },
  };
  return { q, rows };
}
