// A switch per ability (Royce, 2026-09-25): turn any one of Co's abilities
// off without a deploy, in case Co starts misusing it. A row in
// ability_switches with off = true is enough; Co then refuses that tool,
// says it's unavailable, and the refusal is logged.
//
//   UPDATE ability_switches ... or:
//   INSERT INTO ability_switches (ability_id, off, reason) VALUES ('contact_card', true, 'sending twice')
//     ON CONFLICT (ability_id) DO UPDATE SET off = EXCLUDED.off, reason = EXCLUDED.reason, updated_at = NOW();
import pool from "../db/db.js";

const TTL_MS = 30_000;
let cache: { at: number; off: Map<string, string> } | null = null;

export async function switchedOff(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.off;
  const off = new Map<string, string>();
  const { rows } = await pool.query(`SELECT ability_id, COALESCE(reason, '') AS reason FROM ability_switches WHERE off`).catch(() => ({ rows: [] as any[] }));
  for (const r of rows) off.set(r.ability_id, r.reason);
  cache = { at: Date.now(), off };
  return off;
}

export async function isSwitchedOff(abilityId: string): Promise<boolean> {
  return (await switchedOff()).has(abilityId);
}

// Tests only.
export function setSwitchesForTest(off: Record<string, string>): void {
  cache = { at: Date.now() + 10 * 365 * 24 * 3600_000, off: new Map(Object.entries(off)) };
}
