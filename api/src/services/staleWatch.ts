// A heads-up when something Co sent goes stale (Royce, 2026-09-29, from
// Instinct: "Constant's listing just went down, so I'm swapping in another").
// Pages of things Co sent in the last 3 days are re-read every few hours
// (services/linkReader.ts). If one someone said they were interested in sold
// out, moved, or disappeared, they hear it once, in Co's own words, through
// the same path as Co's other event-change texts (their hours, STOP, sent once).
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { sendExemptWhenAllowed } from "../harness/proactive.js";
import { getTimezoneForCity } from "./geocoding.js";
import { regionFor } from "./areaCodes.js";
import { humanTime, readLink, REREAD_AFTER_MS, VOLATILE_AFTER_MS, savedRead, type LinkRead } from "./linkReader.js";
import { lineInVoice } from "./voiceLine.js";

export type Change = { kind: "sold_out" | "moved" | "gone"; detail: string };

function minutesApart(a: string, b: string): number {
  const x = DateTime.fromISO(a, { setZone: true });
  const y = DateTime.fromISO(b, { setZone: true });
  return x.isValid && y.isValid ? Math.abs(x.toMillis() - y.toMillis()) / 60_000 : 0;
}

// What changed between two reads of the same page, only when both are known:
// a page Co couldn't read this time proves nothing.
export function staleChange(prev: LinkRead | null, next: LinkRead): Change | null {
  if (!prev || prev.status !== "ok") return null;
  if (next.status === "failed" && /\b(404|410)\b/.test(next.why ?? "")) return { kind: "gone", detail: "its page is gone, so it may have been canceled" };
  if (next.status !== "ok") return null;
  const soldNow = next.fields.sold_out;
  if (soldNow?.verified && soldNow.value === "yes" && prev.fields.sold_out?.value !== "yes") return { kind: "sold_out", detail: "it's sold out now" };
  const a = prev.fields.start;
  const b = next.fields.start;
  if (a?.verified && b?.verified && minutesApart(a.value, b.value) >= 15) {
    return { kind: "moved", detail: `it now starts ${humanTime(b.value, next.fields.timezone?.value ?? null)}` };
  }
  return null;
}

type Row = { user_id: string; item_key: string; item_name: string; url: string; phone_number: string; first_name: string | null; city: string | null };

async function interested(row: Row): Promise<boolean> {
  const { rows } = await pool
    .query(
      `SELECT
         EXISTS (SELECT 1 FROM suggestion_outcomes WHERE user_id = $1 AND (item_key = $2 OR lower(item_name) = lower($3)) AND result IN ('interested', 'acted')) AS yes,
         EXISTS (SELECT 1 FROM suggestion_outcomes WHERE user_id = $1 AND (item_key = $2 OR lower(item_name) = lower($3)) AND result = 'declined') AS no`,
      [row.user_id, row.item_key, row.item_name],
    )
    .catch(() => ({ rows: [] as any[] }));
  return rows[0]?.yes === true && rows[0]?.no !== true;
}

async function tell(row: Row, change: Change): Promise<boolean> {
  const stock = `Heads up on ${row.item_name}: ${change.detail}.`;
  const line = await lineInVoice({
    purpose: "Tell them plainly, in one or two short sentences, that something they said they were interested in has changed. No question and no pitch.",
    facts: [`"${row.item_name}": ${change.detail}.`, "They told Cue they were interested in it."],
    examples: [],
    mustInclude: [],
    fallback: stock,
  }).catch(() => ({ text: stock, written: false }));
  const timezone = row.city ? await getTimezoneForCity(row.city, { region: regionFor({ city: row.city, phone: row.phone_number }) }).catch(() => null) : null;
  const sent = await sendExemptWhenAllowed({
    userId: row.user_id,
    phoneNumber: row.phone_number,
    type: "event_change",
    targetKey: `stale:${row.item_key}:${change.kind}`,
    messages: [line.text],
    timezone,
  }).catch(() => ({ sent: false, queued: false }));
  return sent.sent || sent.queued;
}

// Hourly: re-read what's due, compare with the read before, tell the people
// who said they were interested. At most 25 pages a run.
export async function watchSentPages(now = new Date()): Promise<{ checked: number; changed: number; told: number }> {
  const { rows } = await pool.query(
    `SELECT ro.user_id, ro.item_key, ro.item_name, ro.url, u.phone_number, u.first_name, cp.city
     FROM revealed_offers ro
     JOIN users u ON u.id = ro.user_id AND COALESCE(u.sms_opted_out, false) = false AND u.archived_at IS NULL AND u.phone_number IS NOT NULL
     LEFT JOIN co_profiles cp ON cp.user_id = ro.user_id
     WHERE ro.sent_at > NOW() - INTERVAL '3 days' AND ro.url IS NOT NULL`,
  );
  const byUrl = new Map<string, Row[]>();
  for (const r of rows as Row[]) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  let checked = 0;
  let changed = 0;
  let told = 0;
  for (const [url, members] of [...byUrl.entries()].slice(0, 25)) {
    const prev = await savedRead(url).catch(() => null);
    // Only what changes gets re-read, and only when the last read is a few hours old.
    if (prev && prev.status === "ok" && now.getTime() - prev.fetchedAt.getTime() < VOLATILE_AFTER_MS) continue;
    if (prev && prev.status !== "ok" && now.getTime() - prev.fetchedAt.getTime() < REREAD_AFTER_MS) continue;
    const next = await readLink(url, { force: true }).catch(() => null);
    if (!next) continue;
    checked++;
    const change = staleChange(prev, next);
    if (!change) continue;
    changed++;
    for (const m of members) {
      if (!(await interested(m))) continue;
      if (await tell(m, change)) told++;
    }
  }
  if (checked) await recordDecision({ layer: 5, decision: "stale.watch", userId: null, outcome: "act", action: `${checked} checked, ${changed} changed, ${told} told` }).catch(() => {});
  return { checked, changed, told };
}
