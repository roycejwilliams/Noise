// Re-types a member's stored entries as ask or goal (services/entryKind.ts). Two steps, and the second only after the list is approved:
//   npx tsx src/scripts/reclassifyEntries.ts propose <userId>            read-only: prints EVERY entry with its proposed type and why;
//                                                                         writes the proposal to ~/copatible-backups/reclassify-<id>.json
//   npx tsx src/scripts/reclassifyEntries.ts apply <userId> <file.json>  applies the (edited) proposal: backs up first, in one transaction
// What applying does, per entry:
//   ask   gets kind "ask" (it already has its ask_checkins row; nothing else changes)
//   goal  gets kind "goal"; its ask_checkins row is DELETED (a goal has none, so nothing can search or check in on it); if the lifecycle had
//         closed it on evidence (answered / delivered / expired) it is made active again, because a goal is not finished by one answer;
//         a goal they closed themselves stays closed.
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pool from "../db/db.js";
import { reclassify } from "../services/entryKind.js";

const [cmd, userId, file] = process.argv.slice(2);
if (!cmd || !userId) { console.error("usage: reclassifyEntries.ts propose <userId> | apply <userId> <file.json>"); process.exit(2); }
const host = (await pool.query(`SELECT current_database() d`)).rows[0].d;
if (host !== "railway" || !/localhost:55432/.test(process.env.DATABASE_URL ?? "")) { console.error("not the dev database tunnel: stopping"); process.exit(1); }
const out = path.join(os.homedir(), "copatible-backups", `reclassify-${userId.slice(0, 8)}.json`);

const profile = (await pool.query(`SELECT intent FROM co_profiles WHERE user_id = $1`, [userId])).rows[0];
const intent: any[] = Array.isArray(profile?.intent) ? profile.intent : [];
const asks = (await pool.query(`SELECT ask_id, resolved_at, closed_reason, expired_at FROM ask_checkins WHERE user_id = $1`, [userId])).rows;
const askRow = new Map(asks.map((a: any) => [a.ask_id, a]));
const typed = intent.filter((e) => typeof e?.text === "string" && e.text.trim());

if (cmd === "propose") {
  const items = typed.map((e, i) => ({ n: `E${i + 1}`, text: e.text, status: e.status ?? "?", said: String(e.created_at ?? "").slice(0, 10) }));
  const got = await reclassify(items);
  const rows = typed.map((e, i) => {
    const g = got.find((x) => x.n === `E${i + 1}`)!;
    const r = askRow.get(e.id);
    const wasClosedByEvidence = !!r?.resolved_at && ["answered", "delivered", "expired"].includes(r?.expired_at ? "expired" : r?.closed_reason);
    return { id: e.id, text: e.text, said: items[i].said, status: e.status, kind: g.kind, why: g.why, hasAskRow: !!r, reviveAsActive: g.kind === "goal" && e.status !== "active" && wasClosedByEvidence };
  });
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(`${rows.length} entries (${rows.filter((r) => r.kind === "goal").length} goal, ${rows.filter((r) => r.kind === "ask").length} ask). Proposal written to ${out}\n`);
  for (const r of rows) console.log(`${r.kind.toUpperCase().padEnd(4)} ${String(r.status).padEnd(9)} ${r.said} ${r.text.slice(0, 84)}${r.reviveAsActive ? "  [would reopen: closed on evidence]" : ""}  — ${r.why}`);
} else if (cmd === "apply") {
  if (!file) { console.error("apply needs the proposal file"); process.exit(2); }
  const rows: any[] = JSON.parse(fs.readFileSync(file, "utf8"));
  const backup = path.join(os.homedir(), "copatible-backups", `reclassify-${userId.slice(0, 8)}-before.json`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = (await client.query(`SELECT intent FROM co_profiles WHERE user_id = $1 FOR UPDATE`, [userId])).rows[0];
    const ids = rows.filter((r) => r.kind === "goal").map((r) => r.id);
    fs.writeFileSync(backup, JSON.stringify({ intent: cur.intent, ask_checkins: (await client.query(`SELECT * FROM ask_checkins WHERE user_id = $1 AND ask_id = ANY($2::text[])`, [userId, ids])).rows }, null, 1));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const next = (cur.intent as any[]).map((e) => {
      const r = byId.get(e?.id);
      if (!r) return e;
      const base = { ...e, kind: r.kind };
      if (r.kind === "goal" && r.reviveAsActive) { delete (base as any).resolved_at; base.status = "active"; }
      return base;
    });
    await client.query(`UPDATE co_profiles SET intent = $2::jsonb, updated_at = NOW() WHERE user_id = $1`, [userId, JSON.stringify(next)]);
    const del = await client.query(`DELETE FROM ask_checkins WHERE user_id = $1 AND ask_id = ANY($2::text[])`, [userId, ids]);
    await client.query("COMMIT");
    console.log(`typed ${rows.length} entries; ${rows.filter((r) => r.kind === "goal").length} goals (${del.rowCount} ask rows removed, ${rows.filter((r) => r.reviveAsActive).length} reopened); backup ${backup}`);
  } catch (e: any) { await client.query("ROLLBACK"); console.error("failed, nothing applied:", e.message); process.exit(1); } finally { client.release(); }
}
await pool.end();
