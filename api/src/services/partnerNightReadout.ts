// The host read for a partner night (Royce, 2026-10-14, partner-room spec step 9: "The host read is room-level only:
// connections made, what the room was thin on, follow-through. Never member-level or guest-level data."). The member is the
// customer; the host is the channel.
//
// It reuses the partner readout (services/partnerReadout.ts and partnerReadoutSend.ts) and keeps every one of its floors:
// counts only, never a name, a quote, an ask in anyone's words or who talked to whom; a count under 3 is "a few"; headcounts are
// rounded; a category under 3 people folds into "something else"; a room under READOUT.minRoom gets no readout; the page is
// checked for any member's name, an email, a phone number or a link before it's stored; and nothing reaches a host until a
// person on the team approves it and sends it (partnerReadoutSend's approve, send and withdraw, unchanged).
//
// What's different at a partner night:
//   - The room is guests and members together. Guests are forgotten when the room closes (services/partnerGuests.ts), so the
//     numbers are taken at the close, just before that, as a snapshot of counts (partner_night_stats). It holds no words: what
//     the room was looking for is already folded into fixed categories (partnerReadout.THEMES) by then.
//   - Every sentence the host reads is Royce's copy (services/partnerCopy.ts, host_*). Until each line is approved, no
//     readout is drafted at all ("copy pending"): a member-worded line ("members were registered") would be false here.
//   - Where it goes: the partner's own host settings (partners.host_email) are the default address when the team approves it.
//   - "What the room was thin on" comes from the sparse-rooms work (#208), once that lands, with its own coverage floor.
import pool from "../db/db.js";
import { approx, cell, classifyAsks, foldThemes, READOUT, themeOfAsk, type Theme } from "./partnerReadout.js";
import { copyFor } from "./partnerCopy.js";

export type NightStats = {
  kind: "partner";
  eventName: string;
  partnerName: string;
  // Everyone who texted in (guests) or checked in (members), and who arrived by the door code.
  room: number;
  arrived: number;
  intakeDone: number;
  // Pairs Co judged worth an intro (the value gate's strong verdict), and intros both people said yes to.
  pairs: number;
  intros: number;
  themes: Partial<Record<Theme, number>>;
  askCount: number;
};

// ---------------------------------------------------------------- rules (pure)

// The host's page from the snapshot: Royce's lines around counts that can't point at anyone. Null while any line it needs is
// still pending: no readout rather than a wrong one.
export function describeNight(s: NightStats): { headline: string; lines: string[]; note: string } | null {
  const v = { event: s.eventName, partner: s.partnerName };
  const headline = copyFor("host_headline", v);
  const note = copyFor("host_note", v);
  if (!headline || !note) return null;
  if (s.room < READOUT.minRoom) {
    const small = copyFor("host_too_small", v);
    return small ? { headline, lines: [small], note } : null;
  }
  const lines: (string | null)[] = [];
  lines.push(copyFor("host_room", { ...v, room: approx(s.room), arrived: approx(s.arrived) }));
  if (s.pairs) lines.push(copyFor("host_pairs", { ...v, pairs: cell(s.pairs) }));
  if (s.intros) lines.push(copyFor("host_intros", { ...v, intros: cell(s.intros) }));
  const themes = s.askCount >= READOUT.minForThemes ? foldThemes(s.themes) : [];
  lines.push(themes.length ? copyFor("host_themes", { ...v, themes: themes.map((t) => `${t.theme.toLowerCase()} (${t.n})`).join(", ") }) : copyFor("host_no_themes", v));
  if (lines.some((l) => l === null)) return null;
  return { headline, lines: lines as string[], note };
}

export function renderNightText(d: { headline: string; lines: string[]; note: string }): string {
  return [d.headline, "", ...d.lines, "", d.note].join("\n");
}

// ---------------------------------------------------------------- the snapshot, at close

export type SnapshotDeps = { classify?: (ask: string) => Promise<Theme> };

// Counts for the night, taken at its close and before guests are forgotten. Room-level only; no words are kept.
export async function snapshotNight(eventId: string, deps: SnapshotDeps = {}): Promise<NightStats | null> {
  const { partnerEvent } = await import("./partners.js");
  const found = await partnerEvent(eventId);
  if (!found) return null;
  const count = async (sql: string) => Number((await pool.query(sql, [eventId])).rows[0]?.n ?? 0);
  const [guests, guestsArrived, intakeDone, members, membersArrived, pairs, intros] = await Promise.all([
    count(`SELECT COUNT(*)::int AS n FROM partner_guests WHERE event_api_id = $1`),
    count(`SELECT COUNT(*)::int AS n FROM partner_guests WHERE event_api_id = $1 AND arrived_at IS NOT NULL`),
    count(`SELECT COUNT(*)::int AS n FROM partner_guests WHERE event_api_id = $1 AND intake_done_at IS NOT NULL`),
    count(`SELECT COUNT(DISTINCT w.person_id)::int AS n FROM event_walkin_checkins w JOIN users u ON u.id = w.person_id WHERE w.event_api_id = $1 AND coalesce(u.invite_verified, false) = true`),
    count(`SELECT COUNT(DISTINCT w.person_id)::int AS n FROM event_walkin_checkins w JOIN users u ON u.id = w.person_id JOIN event_presence p ON p.event_api_id = w.event_api_id AND p.user_id = w.person_id WHERE w.event_api_id = $1 AND coalesce(u.invite_verified, false) = true AND p.arrived_at IS NOT NULL`),
    count(`SELECT COUNT(*)::int AS n FROM co_pairs WHERE event_id = $1 AND value_verdict = 'strong'`),
    count(`SELECT COUNT(*)::int AS n FROM co_pairs WHERE event_id = $1 AND (both_yes_at IS NOT NULL OR intro_sent_at IS NOT NULL)`),
  ]);
  // What the room was looking for: each arrived guest's own "who are you hoping to meet", and each arrived member's open
  // seeking ask, read only to put it in a fixed category. The words are not kept.
  const asks: string[] = [];
  const { rows: g } = await pool.query(`SELECT hoping FROM partner_guests WHERE event_api_id = $1 AND arrived_at IS NOT NULL AND hoping IS NOT NULL`, [eventId]);
  for (const r of g) asks.push(String(r.hoping));
  const { rows: m } = await pool.query(
    `SELECT cp.intent FROM event_walkin_checkins w JOIN co_profiles cp ON cp.user_id = w.person_id JOIN event_presence p ON p.event_api_id = w.event_api_id AND p.user_id = w.person_id
     WHERE w.event_api_id = $1 AND p.arrived_at IS NOT NULL`,
    [eventId],
  );
  const { isOpenAsk } = await import("../harness/profileWrite.js");
  for (const r of m) {
    const open = (Array.isArray(r.intent) ? r.intent : []).filter((i: any) => isOpenAsk(i) && i?.type === "seeking");
    if (open.length) asks.push(String(open[open.length - 1].text));
  }
  const themes = asks.length >= READOUT.minForThemes ? await classifyAsks(asks, deps.classify ?? themeOfAsk) : {};
  const stats: NightStats = { kind: "partner", eventName: found.event.name, partnerName: found.partner.name, room: guests + members, arrived: guestsArrived + membersArrived, intakeDone, pairs, intros, themes, askCount: asks.length };
  await pool.query(
    `INSERT INTO partner_night_stats (event_api_id, stats) VALUES ($1, $2::jsonb) ON CONFLICT (event_api_id) DO NOTHING`,
    [eventId, JSON.stringify(stats)],
  );
  return stats;
}

// ---------------------------------------------------------------- the draft

export type NightDraftDeps = { names?: () => Promise<string[]>; now?: Date };

// Build and freeze the host's draft for one closed partner night, from its snapshot, into partner_readouts (the same table
// and the same approve, send and withdraw flow as every readout). Never sends.
export async function draftNightReadout(eventId: string, deps: NightDraftDeps = {}): Promise<{ status: "drafted" | "exists" | "no_snapshot" | "too_small" | "copy_pending" | "leak"; why?: string }> {
  const { readoutFor, readoutLeak } = await import("./partnerReadoutSend.js");
  if (await readoutFor(eventId)) return { status: "exists" };
  const { rows } = await pool.query(`SELECT stats FROM partner_night_stats WHERE event_api_id = $1`, [eventId]);
  const stats = rows[0]?.stats as NightStats | undefined;
  if (!stats) return { status: "no_snapshot" };
  const d = describeNight(stats);
  if (!d) return { status: "copy_pending" };
  if (stats.room < READOUT.minRoom) return { status: "too_small" };
  const text = renderNightText(d);
  const names = await (deps.names ?? memberNames)();
  const leak = readoutLeak(text, stats.eventName, names);
  if (leak) return { status: "leak", why: leak };
  const { escapeHtml, quietEmail } = await import("./emailDesign.js");
  const html = quietEmail({ preview: d.headline, headline: escapeHtml(d.headline), lines: d.lines.map(escapeHtml), note: escapeHtml(d.note), signOff: true });
  const ins = await pool.query(
    `INSERT INTO partner_readouts (event_id, event_name, stats, text, html) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [eventId, stats.eventName.slice(0, 200), JSON.stringify({ ...stats, shown: d }), text, html],
  );
  return ins.rows.length ? { status: "drafted" } : { status: "exists" };
}

async function memberNames(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT first_name, last_name FROM users`);
  return rows.flatMap((r: any) => [r.first_name, r.last_name]).filter((n: any) => typeof n === "string" && n.trim().length >= 3);
}

// Hourly with the readout drafts (jobs/index.ts): each partner night that closed 12 hours to a week ago gets its draft. The team
// hears it's ready; nothing reaches the host.
export async function runNightReadoutDrafts(now = new Date(), deps: NightDraftDeps & { notify?: (subject: string, text: string) => Promise<unknown> } = {}): Promise<number> {
  const { readoutDue } = await import("./partnerReadoutSend.js");
  const { rows } = await pool.query(`SELECT e.api_id, e.name, e.start_at, e.end_at FROM partner_events e JOIN partner_night_stats s ON s.event_api_id = e.api_id LEFT JOIN partner_readouts r ON r.event_id = e.api_id WHERE r.id IS NULL`);
  let drafted = 0;
  for (const e of rows) {
    if (!readoutDue({ start_at: new Date(e.start_at).toISOString(), end_at: e.end_at ? new Date(e.end_at).toISOString() : null }, now)) continue;
    const r = await draftNightReadout(e.api_id, { ...deps, now }).catch((err: any) => ({ status: "error" as const, why: String(err?.message ?? err).slice(0, 160) }));
    if (r.status === "drafted") {
      drafted++;
      const notify = deps.notify ?? (async (subject: string, text: string) => (await import("./reportEmail.js")).sendReportEmail(subject, `<pre>${text.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]!)}</pre>`, text));
      await Promise.resolve(notify(`Host read drafted: ${e.name}`, `Nothing has gone to the host. To approve it: npx tsx src/scripts/partners.ts readout-approve ${e.api_id} --by <your name>`)).catch(() => {});
    } else if (r.status === "leak" || r.status === "error") {
      console.error(`partnerNightReadout: no draft for ${e.api_id} (${r.status}: ${"why" in r ? r.why : ""})`);
    }
  }
  return drafted;
}

// The team's yes for a partner night: the partner's own host address is the default (their host-read settings).
export async function approveNightReadout(eventId: string, by: string, hostEmail?: string | null): Promise<{ ok: true; link: string } | { ok: false; why: string }> {
  const { partnerEvent } = await import("./partners.js");
  const found = await partnerEvent(eventId);
  if (!found) return { ok: false, why: "not a partner night" };
  const { approveReadout } = await import("./partnerReadoutSend.js");
  return approveReadout(eventId, { by, hostEmail: hostEmail ?? found.partner.host_email });
}
