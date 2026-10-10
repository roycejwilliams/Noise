// Mo as a teammate (Royce, 2026-09-24: "Could we tag Mo in conversations?
// How would the relationship between Co & Mo work?" then "build all three").
//
// 1. Talking to Mo: Royce and Jacqueline (users.mo_approver) text Co's
//    number and Mo answers, in plain words, whatever they ask of it: where
//    things stand, how a named person is going, a steer for the next search,
//    pause / back on (mo/teamAgent.ts). From anyone else "Mo" is just a word
//    and Co answers as usual.
// 2. Joins: the moment someone Mo found uses their invite, Mo tells the team.
//    From then on they're Co's.
// 3. Gaps: Co tells Mo what the network is short on, in general terms only
//    ("technical cofounders", 4 members), never who. Mo scouts for those
//    instead of reading members' asks.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { DateTime } from "luxon";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { parseModelJson } from "../services/modelJson.js";
import { recordDecision } from "../harness/core.js";

// Mo understands the team in plain words (mo/teamAgent.ts, 2026-09-26):
// what it can do is mo/abilities.ts, and these are the pieces its tools use.

async function getSetting<T>(key: string): Promise<{ value: T; updatedAt: Date } | null> {
  const { rows } = await pool.query(`SELECT value, updated_at FROM mo_settings WHERE key = $1`, [key]).catch(() => ({ rows: [] as any[] }));
  return rows[0] ? { value: rows[0].value as T, updatedAt: new Date(rows[0].updated_at) } : null;
}
async function setSetting(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO mo_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

// Paused: no new searches, no reviews, no outreach. A prospect who's waiting
// (a question, a yes) is still answered; nobody gets left hanging.
export async function isMoPaused(): Promise<boolean> {
  return (await getSetting<{ paused: boolean }>("paused"))?.value.paused === true;
}

export async function activeFocus(): Promise<string[]> {
  const { rows } = await pool
    .query(`SELECT text FROM mo_focus WHERE created_at > NOW() - INTERVAL '21 days' ORDER BY created_at DESC LIMIT 5`)
    .catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => String(r.text));
}

// ------------------------------------------------------------ people (pure)

const fmtDay = (d: Date | string | null) => (d ? DateTime.fromJSDate(new Date(d)).setZone("America/Los_Angeles").toFormat("ccc LLL d") : "");

export function whoShort(p: { name: string | null; x_handle: string | null }): string {
  return p.name?.trim() || (p.x_handle ? `@${p.x_handle}` : "them");
}

// Where one person stands, in plain words, from what's recorded.
export function prospectStatusLine(p: any): string {
  const n = whoShort(p);
  switch (p.status) {
    case "shortlisted": return `${n} is waiting on a yes from you or Jacqueline.`;
    case "approved": return `${n} is approved; Co's reply to their post hasn't gone out yet.`;
    case "warmed": return `Co replied to ${n}'s post${p.warmed_at ? ` on ${fmtDay(p.warmed_at)}` : ""}; my DM goes out a few days after that.`;
    case "contacted": return `I reached out to ${n}${p.contacted_at ? ` on ${fmtDay(p.contacted_at)}` : ""}. No answer yet.`;
    case "question": return `${n} wrote back with a question, and it's waiting on your answer.`;
    case "invited": return `${n} said yes and has their invite, but hasn't joined yet.`;
    case "joined": return `${n} joined${p.joined_at ? ` on ${fmtDay(p.joined_at)}` : ""}. They're Co's now.`;
    case "manual_pending": return `${n} is only on LinkedIn; I'm reaching out by email from Co if I can find a public address.`;
    case "declined": return `${n} said no thanks, so I won't reach out again.`;
    case "skipped": return `You passed on ${n}, so they won't come up again.`;
    case "unreachable": return `I couldn't reach ${n}: DMs are closed and there's no public email.`;
    case "closed": return `${n} never answered after the follow-up, so I've closed it out.`;
    default: return `${n}: ${String(p.status)}.`;
  }
}

export async function findProspects(query: string): Promise<any[]> {
  const q = query.replace(/^@/, "").replace(/[?.!,]+$/, "").trim();
  if (q.length < 2) return [];
  const { rows } = await pool.query(
    `SELECT * FROM mo_prospects
     WHERE x_handle ILIKE $1 OR name ILIKE $2 OR name ILIKE $3
     ORDER BY updated_at DESC LIMIT 3`,
    [q, `${q}%`, `% ${q}%`],
  );
  return rows;
}

// ------------------------------------------------------------ joins

export function joinText(p: any): string {
  return `It's Mo. ${whoShort(p)} just joined with the invite I sent. They're Co's now.`;
}

// Called when an invite code is redeemed (services/inviteCodes.ts) and, as
// a backup, from the outreach job. The status flip is the once-only guard.
export async function noteProspectJoined(code: string, userId: string | null = null): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE mo_prospects SET status = 'joined', joined_at = NOW(), joined_user_id = COALESCE($2, joined_user_id), updated_at = NOW()
     WHERE invite_code = $1 AND status <> 'joined' RETURNING *`,
    [code, userId],
  );
  await tellTeamAboutJoins(rows);
  return rows.length;
}
export async function tellTeamAboutJoins(rows: any[]): Promise<void> {
  if (!rows.length) return;
  const { textApprovers } = await import("./review.js");
  for (const p of rows) {
    await textApprovers(joinText(p)).catch(() => 0);
    await recordDecision({ layer: 5, decision: "mo.joined", userId: null, outcome: "act", action: "told_team", proposal: { no: p.no } }).catch(() => {});
  }
}

// ------------------------------------------------------------ gaps from Co

export type Gap = { gap: string; members: number };

// What the network is short on, in general terms. Built by Co from members'
// open "find" asks (a "help" ask, like sponsors, isn't a kind of person to
// invite), and cut if a gap carries a member's name or 5+ of their words in
// a row (the same leak rule as Mo's searches). Cached for a day.
export async function networkGaps(opts: { refresh?: boolean } = {}): Promise<Gap[]> {
  const cached = await getSetting<Gap[]>("gaps");
  if (!opts.refresh && cached && Date.now() - cached.updatedAt.getTime() < 24 * 3_600_000) return cached.value;
  const { rows } = await pool
    .query(
      `SELECT a.ask_text FROM ask_checkins a JOIN users u ON u.id = a.user_id
       WHERE a.resolved_at IS NULL AND a.kind IN ('find', 'person') AND u.archived_at IS NULL AND a.created_at > NOW() - INTERVAL '45 days'
       ORDER BY a.created_at DESC LIMIT 40`,
    )
    .catch(() => ({ rows: [] as any[] }));
  const asks = rows.map((r: any) => String(r.ask_text).slice(0, 200));
  if (!asks.length) return [];
  const gaps = await groupIntoGaps(
    asks,
    `These are what members of a private social club are looking for right now, one per line:`,
    `Group them into at most 3 gaps: the kinds of people the network is short on`,
    "mo.networkGaps",
  );
  if (!gaps) return cached?.value ?? [];
  await setSetting("gaps", gaps).catch(() => {});
  return gaps;
}

// Who the next Co event needs (Royce, 2026-09-26: aim Mo at the room). From
// the guests already on its list: what they're looking for, grouped into the
// kinds of people they'd most want to meet there. General terms only, with
// the same leak rule. Null when there's no Co event in the next 3 weeks or
// no guest Co knows. Cached for 12 hours.
export type RoomNeeds = { event: string; gaps: Gap[] };

export async function roomNeeds(opts: { refresh?: boolean } = {}): Promise<RoomNeeds | null> {
  const cached = await getSetting<RoomNeeds | null>("room");
  if (!opts.refresh && cached && Date.now() - cached.updatedAt.getTime() < 12 * 3_600_000) return cached.value;
  const { listCalendarEvents, getEventGuestList } = await import("../services/luma.js");
  const { matchGuestsToUsers } = await import("../services/eventScoring.js");
  const soon = Date.now() + 21 * 24 * 3_600_000;
  const next = (await listCalendarEvents().catch(() => []))
    .filter((e) => e.start_at && new Date(e.start_at).getTime() > Date.now() && new Date(e.start_at).getTime() < soon)
    .sort((a, b) => (a.start_at < b.start_at ? -1 : 1))[0];
  let value: RoomNeeds | null = null;
  if (next) {
    const guests = await getEventGuestList(next.api_id).catch(() => []);
    const members = await matchGuestsToUsers(guests.filter((g) => g.approval_status !== "declined")).catch(() => []);
    const ids = [...new Set(members.map((m) => m.user_id))];
    const { rows } = ids.length
      ? await pool
          .query(
            `SELECT a.ask_text FROM ask_checkins a WHERE a.user_id = ANY($1::uuid[]) AND a.resolved_at IS NULL AND a.kind IN ('find', 'person') ORDER BY a.created_at DESC LIMIT 40`,
            [ids],
          )
          .catch(() => ({ rows: [] as any[] }))
      : { rows: [] as any[] };
    const lines = [
      ...rows.map((r: any) => String(r.ask_text).slice(0, 200)),
      ...members.flatMap((m) => (m.goals ?? []).slice(0, 2)).map((g) => `goal: ${String(g).slice(0, 160)}`),
    ];
    const when = DateTime.fromISO(String(next.start_at)).setZone("America/Los_Angeles").toFormat("cccc, LLLL d");
    const gaps = lines.length
      ? await groupIntoGaps(
          lines,
          `These are what the guests already coming to a private social club's evening are looking for, one per line:`,
          `Group them into at most 3 kinds of people these guests would most want to meet in that room`,
          "mo.roomNeeds",
        )
      : [];
    if (gaps?.length) value = { event: `${next.name} on ${when}`, gaps };
  }
  await setSetting("room", value).catch(() => {});
  return value;
}

// Lines in, at most three general gaps out, with the leak rule applied.
// Null when the read failed.
async function groupIntoGaps(lines: string[], intro: string, ask: string, functionId: string): Promise<Gap[] | null> {
  let gaps: Gap[] = [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId },
      prompt: `${intro}
${lines.map((a) => `- ${a}`).join("\n")}

${ask}, each a few general words ("technical cofounders", "designers who host events"), with how many of the lines above point to it. No names, no companies, never more than three words in a row from any line.

Return ONLY JSON: {"gaps": [{"gap": "...", "members": 2}]}`,
    });
    gaps = (parseModelJson<{ gaps?: Gap[] }>(text).gaps ?? [])
      .filter((g) => typeof g?.gap === "string" && g.gap.trim().length > 2 && Number.isFinite(Number(g.members)))
      .map((g) => ({ gap: g.gap.trim().slice(0, 80), members: Math.max(1, Math.round(Number(g.members))) }))
      .slice(0, 3);
  } catch {
    return null;
  }
  const { queryLeaks } = await import("./find.js");
  const { rows: names } = await pool.query(`SELECT first_name, last_name FROM users WHERE archived_at IS NULL`).catch(() => ({ rows: [] as any[] }));
  const nameList = names.flatMap((r: any) => [r.first_name, r.last_name]).filter((n: any) => typeof n === "string" && n.trim().length >= 3).map((n: string) => n.trim().toLowerCase());
  return gaps.filter((g) => !queryLeaks(g.gap, lines, nameList));
}

export function gapsLine(gaps: Gap[]): string | null {
  if (!gaps.length) return null;
  return `The network's shortest on ${gaps.map((g) => `${g.gap} (${g.members} ${g.members === 1 ? "member" : "members"})`).join(", ")}, so that's what I'm scouting for.`;
}

// ------------------------------------------------------------ status

export type StyleResult = { style: string; reached: number; yes: number };
export function styleLine(results: StyleResult[]): string | null {
  const shown = results.filter((r) => r.reached > 0);
  if (!shown.length) return null;
  const label = (s: string) => (s === "curious" ? `the short "want to know why?" DM` : `the full intro DM`);
  return `So far ${shown.map((r) => `${r.yes} of ${r.reached} said yes to ${label(r.style)}`).join(", and ")}.`;
}

export async function moStatusText(approverFirst: string | null): Promise<string> {
  const { sendingStatus } = await import("./outreach.js");
  const [{ rows: counts }, { rows: styles }, gaps, focus, paused] = await Promise.all([
    pool.query(`SELECT status, count(*)::int AS n FROM mo_prospects GROUP BY status`),
    pool.query(
      `SELECT dm_style AS style, count(*)::int AS reached, count(*) FILTER (WHERE status IN ('invited', 'joined'))::int AS yes
       FROM mo_prospects WHERE dm_style IS NOT NULL AND contacted_at IS NOT NULL GROUP BY dm_style`,
    ),
    networkGaps().catch(() => [] as Gap[]),
    activeFocus(),
    isMoPaused(),
  ]);
  const n = (s: string[]) => counts.filter((r: any) => s.includes(r.status)).reduce((a: number, r: any) => a + r.n, 0);
  const waiting = n(["shortlisted"]);
  const moving = n(["approved", "warmed", "contacted", "question", "invited", "manual_pending"]);
  const joined = n(["joined"]);
  const room = await roomNeeds().catch(() => null);
  const { joinedOutcomes, outcomesLine } = await import("./learn.js");
  const outcomes = await joinedOutcomes().catch(() => []);
  const parts = [
    `${waiting ? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting on your yes` : "Nobody new waiting on you"}, ${moving} in progress, ${joined} joined so far.`,
    styleLine(styles as StyleResult[]),
    outcomesLine(outcomes),
    room ? `For ${room.event}, the guests would most want to meet ${room.gaps.map((g) => g.gap).join(", ")}, so they come first.` : null,
    gapsLine(gaps),
    focus.length ? `You asked me to look for: ${focus.join("; ")}.` : null,
    paused ? `I'm paused, so no new searches or outreach until you say "Mo, back on."` : sendingStatus(),
  ];
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------ team asks

export async function setPaused(paused: boolean, userId: string): Promise<void> {
  await setSetting("paused", { paused, by: userId });
}

export async function addFocus(text: string, userId: string): Promise<void> {
  await pool.query(`INSERT INTO mo_focus (text, asked_by) VALUES ($1, $2)`, [text.slice(0, 200), userId]);
}
