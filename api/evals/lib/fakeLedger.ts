// An in-memory stand-in for the proactive send ledger, for tests of the name notice (evals/proactive/nameChange.ts and golden
// case 52): what sendWithLedger reads and writes inside its lock, plus a captured outbox. Nothing reaches a database or Sendblue.
// Each query yields once, like a real round trip, so two sends started together really interleave.
export type LedgerRow = { user_id: string; type: string; target_key: string; topic_key: string | null; sent_at: Date; exempt: boolean; message: string; kind?: string | null };
// findsToday: what the day's discovery-find count reads (proactive.ts findsSentToday), 0 unless a test sets it.
export type FakeLedger = { sends: LedgerRow[]; sentCandidates: string[]; outbox: { to: string; content: string }[]; findsToday?: number };

type Queryable = { query: (sql: string, args?: any[]) => Promise<{ rows: any[] }> };

export function installFakeLedger(pool: any, sendblue: any): { ledger: FakeLedger; restore: () => void } {
  const ledger: FakeLedger = { sends: [], sentCandidates: [], outbox: [] };
  const handle = async (rawSql: string, args: any[] = []): Promise<{ rows: any[] }> => {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    await new Promise((r) => setImmediate(r));
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/^SELECT COALESCE\(sms_opted_out, false\) AS opted_out FROM users/.test(sql)) return { rows: [{ opted_out: false }] };
    if (/FROM proactive_sends/.test(sql) && /DISTINCT ON/.test(sql)) return { rows: [] };
    if (/^SELECT type, target_key, topic_key, sent_at, exempt FROM proactive_sends/.test(sql)) return { rows: ledger.sends.filter((r) => r.user_id === args[0]) };
    if (/^SELECT 1 FROM proactive_sends WHERE user_id = \$1 AND target_key = \$2/.test(sql)) return { rows: ledger.sends.filter((r) => r.user_id === args[0] && r.target_key === args[1]).map(() => ({ "?column?": 1 })) };
    if (/^INSERT INTO proactive_sends/.test(sql)) {
      if (ledger.sends.some((r) => r.user_id === args[0] && r.target_key === args[2])) return { rows: [] };
      ledger.sends.push({ user_id: args[0], type: args[1], target_key: args[2], topic_key: args[3] ?? null, sent_at: new Date(), exempt: /, true(, \$\d+)?\)/.test(sql) || args[6] === true, message: String(args[5] ?? ""), kind: args[7] ?? null });
      return { rows: [{ id: ledger.sends.length }] };
    }
    if (/^UPDATE proactive_candidates SET status = 'sent'/.test(sql)) {
      ledger.sentCandidates.push(String(args[0]));
      return { rows: [] };
    }
    if (/^SELECT COUNT\(\*\)::int AS n FROM proactive_candidates WHERE user_id = \$1 AND status = 'sent'/.test(sql)) return { rows: [{ n: ledger.findsToday ?? 0 }] };
    if (/^SELECT MAX\(created_at\) AS at FROM co_memories/.test(sql)) return { rows: [{ at: null }] };
    if (/FROM users u WHERE u\.id = \$1/.test(sql) && /stamped_at/.test(sql)) return { rows: [{ stamped_at: null, co_reply_at: null, running: false }] };
    if (/^SELECT created_at FROM users WHERE id = \$1/.test(sql)) return { rows: [{ created_at: new Date("2026-01-01T00:00:00Z") }] };
    return { rows: [] };
  };
  const was = { query: pool.query, connect: pool.connect, send: sendblue.messages.send };
  pool.query = handle;
  pool.connect = async (): Promise<Queryable & { release: () => void }> => ({ query: handle, release: () => {} });
  sendblue.messages.send = async (b: any) => {
    ledger.outbox.push({ to: b.number, content: b.content });
    return { message_handle: `fake-${ledger.outbox.length}` };
  };
  return {
    ledger,
    restore: () => {
      pool.query = was.query;
      pool.connect = was.connect;
      sendblue.messages.send = was.send;
    },
  };
}
