// What Co can see once a member connects Google (services/googleAuth.ts):
// when they're busy over the next few days (free/busy only, no event
// titles), and which email threads they started are still waiting on a reply
// (Gmail metadata: who, subject, when; never a body). Read in the background
// and cached, never while they wait on a reply, and only ever for that
// member's own context.
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { accessTokenFor, isConnected } from "./googleAuth.js";

export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
const DAYS_AHEAD = 4;

export type Busy = { start: string; end: string };
export type WaitingThread = { subject: string; to: string; sentAt: string };
export type GoogleSnapshot = { busy: Busy[] | null; waiting: WaitingThread[] | null; fetchedAt: Date };

// ------------------------------------------------------------ fetching (background)

export async function fetchBusy(token: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<Busy[] | null> {
  const res = await fetchImpl("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + DAYS_AHEAD * 86_400_000).toISOString(), items: [{ id: "primary" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  const busy = j?.calendars?.primary?.busy;
  return Array.isArray(busy) ? busy.filter((b: any) => b?.start && b?.end).map((b: any) => ({ start: String(b.start), end: String(b.end) })) : null;
}

const header = (msg: any, name: string) => String(msg?.payload?.headers?.find((h: any) => String(h?.name).toLowerCase() === name.toLowerCase())?.value ?? "");

// Threads they started or last wrote in, with no reply since. Metadata scope
// can't search, so it walks their SENT label.
export async function fetchWaiting(token: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<WaitingThread[] | null> {
  const auth = { Authorization: `Bearer ${token}` };
  const list = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=SENT&maxResults=25", { headers: auth, signal: AbortSignal.timeout(10_000) });
  if (!list.ok) return null;
  const ids: string[] = Array.from(new Set(((await list.json()) as any)?.messages?.map((m: any) => String(m.threadId)) ?? [])).slice(0, 12) as string[];
  const out: WaitingThread[] = [];
  for (const id of ids) {
    const res = await fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Date`,
      { headers: auth, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) continue;
    const t: any = await res.json();
    const msgs: any[] = Array.isArray(t?.messages) ? t.messages : [];
    const last = msgs[msgs.length - 1];
    if (!last || !(last.labelIds ?? []).includes("SENT")) continue; // someone replied last
    const sentAt = new Date(Number(last.internalDate ?? 0));
    if (!sentAt.getTime() || now.getTime() - sentAt.getTime() < 86_400_000) continue; // under a day isn't "waiting"
    out.push({ subject: header(msgs[0], "Subject").slice(0, 120) || "(no subject)", to: recipientLabel(header(last, "To")), sentAt: sentAt.toISOString() });
  }
  return out.slice(0, 6);
}

// "Jordan Lee <jordan@acme.com>" → "Jordan Lee (acme.com)"; first recipient only.
export function recipientLabel(to: string): string {
  const first = to.split(",")[0]?.trim() ?? "";
  const m = first.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m?.[2] ?? first).trim();
  const domain = email.split("@")[1] ?? "";
  const name = m?.[1]?.trim();
  return name ? `${name}${domain ? ` (${domain})` : ""}` : domain || email || "someone";
}

// Refreshes one member's snapshot. Background only.
export async function refreshGoogleSnapshot(userId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const conn = await isConnected(userId);
  if (!conn.connected) return;
  const token = await accessTokenFor(userId, fetchImpl).catch(() => null);
  if (!token) return;
  const canCal = conn.scopes.some((s) => s.endsWith("/calendar.freebusy"));
  const canMail = conn.scopes.some((s) => s.endsWith("/gmail.metadata"));
  const [busy, waiting] = await Promise.all([canCal ? fetchBusy(token, new Date(), fetchImpl).catch(() => null) : null, canMail ? fetchWaiting(token, new Date(), fetchImpl).catch(() => null) : null]);
  await pool.query(
    `INSERT INTO google_snapshots (user_id, busy, waiting, fetched_at) VALUES ($1, $2::jsonb, $3::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET busy = EXCLUDED.busy, waiting = EXCLUDED.waiting, fetched_at = NOW()`,
    [userId, busy ? JSON.stringify(busy) : null, waiting ? JSON.stringify(waiting) : null],
  );
  await recordDecision({ layer: 3, decision: "google.read", userId, outcome: "act", action: "refreshed", proposal: { busyBlocks: busy?.length ?? null, waitingThreads: waiting?.length ?? null } }).catch(() => {});
}

// ------------------------------------------------------------ for Co

const refreshing = new Set<string>();

// The member's own snapshot as facts, read from the cache; a stale or
// missing one is refreshed in the background for next time.
export async function googleFactsFor(userId: string, zone: string | null, now = new Date()): Promise<string[]> {
  const { rows } = await pool
    .query(`SELECT s.busy, s.waiting, s.fetched_at, (c.user_id IS NOT NULL) AS connected FROM google_connections c LEFT JOIN google_snapshots s ON s.user_id = c.user_id WHERE c.user_id = $1`, [userId])
    .catch(() => ({ rows: [] as any[] }));
  const r = rows[0];
  if (!r?.connected) return [];
  const fetchedAt = r.fetched_at ? new Date(r.fetched_at) : null;
  if ((!fetchedAt || now.getTime() - fetchedAt.getTime() > SNAPSHOT_MAX_AGE_MS) && !refreshing.has(userId)) {
    refreshing.add(userId);
    refreshGoogleSnapshot(userId)
      .catch(() => {})
      .finally(() => refreshing.delete(userId));
  }
  if (!fetchedAt) return ["They connected Google, but Co hasn't read their calendar or email yet."];
  return describeSnapshot({ busy: r.busy, waiting: r.waiting, fetchedAt }, zone, now);
}

export function describeSnapshot(s: GoogleSnapshot, zone: string | null, now = new Date()): string[] {
  const z = zone && DateTime.now().setZone(zone).isValid ? zone : "America/Los_Angeles";
  const asOf = DateTime.fromJSDate(s.fetchedAt).setZone(z).toFormat("ccc h:mm a");
  const out: string[] = [];
  if (s.busy) {
    const blocks = s.busy
      .filter((b) => new Date(b.end).getTime() > now.getTime())
      .map((b) => {
        const st = DateTime.fromISO(b.start).setZone(z);
        const en = DateTime.fromISO(b.end).setZone(z);
        return `${st.toFormat("ccc MMM d h:mm a")}–${en.hasSame(st, "day") ? en.toFormat("h:mm a") : en.toFormat("ccc h:mm a")}`;
      });
    out.push(
      blocks.length
        ? `Their Google Calendar (busy times only, next ${DAYS_AHEAD} days, as of ${asOf}): busy ${blocks.slice(0, 12).join("; ")}. Any other time in that window shows free. Co sees only busy or free, never what the events are.`
        : `Their Google Calendar shows them free for the next ${DAYS_AHEAD} days (as of ${asOf}). Co sees only busy or free, never what the events are.`,
    );
  }
  if (s.waiting) {
    out.push(
      s.waiting.length
        ? `Emails they sent that haven't had a reply yet (Gmail, as of ${asOf}; Co sees who, subject and date, never the message): ${s.waiting
            .map((w) => `"${w.subject}" to ${w.to}, sent ${DateTime.fromISO(w.sentAt).setZone(z).toFormat("ccc MMM d")}`)
            .join("; ")}.`
        : `None of their recent sent emails is waiting on a reply (Gmail, as of ${asOf}).`,
    );
  }
  return out;
}
