// Mo as a teammate (Royce, 2026-09-24: "Could we tag Mo in conversations?
// How would the relationship between Co & Mo work?" then "build all three").
//
// 1. Tagging: Royce and Jacqueline (users.mo_approver) text Co's number
//    "Mo, ..." and Mo answers: where things stand, how a named person is
//    going, "find me more X" (steers the next search), pause / back on.
//    From anyone else "Mo" is just a word and Co answers as usual.
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
import { MO_RULES } from "./moVoice.js";

// ------------------------------------------------------------ tagging (pure)

// "Mo, ...", "hey Mo ...", "@mo ...". Only ever checked for the team.
export function addressedToMo(text: string): boolean {
  return /^\s*(?:(?:hey|hi|yo|ok|okay|and)[\s,]+)?@?mo\b/i.test(text) || /(^|\s)@mo\b/i.test(text);
}
export function stripMo(text: string): string {
  return text
    .replace(/^\s*(?:(?:hey|hi|yo|ok|okay|and)[\s,]+)?@?mo\b[\s,:!.-]*/i, "")
    .replace(/(^|\s)@mo\b[\s,:]*/i, " ")
    .trim();
}

export type MoCommand =
  | { kind: "help" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "status" }
  | { kind: "focus"; text: string }
  | { kind: "person"; query: string };

// Null when it isn't a command (a plain yes/no to what Mo asked goes on to
// the approval flow as before).
export function parseMoCommand(body: string): MoCommand | null {
  const t = body.trim().replace(/[.!?]+$/, "").trim();
  if (/^(yes|yeah|yep|no|nope|nah|sure|ok|okay|sent|done|go|go ahead|do it|send it)\b/i.test(t) && t.split(/\s+/).length <= 4) return null;
  if (/^(what can you do|what do you do|how do you work|help|what are you|who are you)\b/i.test(t)) return { kind: "help" };
  if (/^(pause|hold off|stop( reaching out| for now)?|take a break|stand down)\b/i.test(t)) return { kind: "pause" };
  if (/^(resume|unpause|back on|start (again|back up)|keep going|you can (start|go) again|go again)\b/i.test(t)) return { kind: "resume" };
  const person = t.match(/^(?:how'?s|how is|how are|what happened (?:with|to)|any (?:news|word) (?:on|from)|update on|status (?:on|of)|where are we (?:with|on)|what about)\s+(.+)$/i);
  if (person) return { kind: "person", query: person[1].trim() };
  const focus = t.match(/^(?:(?:can you |could you |please )?(?:find|look for|search for|scout(?: for)?|go find|get me|bring me|i want)\s+(?:me\s+)?(?:some\s+|more\s+)?)(.{3,})$/i);
  if (focus) return { kind: "focus", text: focus[1].trim() };
  if (!t || /^(what did you find|what'?s new|anything( new)?|status|update|what'?s up|how'?s it going|what do you have|who do you have|report)\b/i.test(t)) return { kind: "status" };
  return null;
}

// ------------------------------------------------------------ state

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
    case "manual_pending": return `${n} is only on LinkedIn; the note is waiting for you to send it.`;
    case "declined": return `${n} said no thanks, so I won't reach out again.`;
    case "skipped": return `You passed on ${n}, so they won't come up again.`;
    case "unreachable": return `I couldn't reach ${n}: DMs are closed and there's no public email.`;
    case "closed": return `${n} never answered after the follow-up, so I've closed it out.`;
    default: return `${n}: ${String(p.status)}.`;
  }
}

async function findProspects(query: string): Promise<any[]> {
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
export async function noteProspectJoined(code: string): Promise<number> {
  const { rows } = await pool.query(
    `UPDATE mo_prospects SET status = 'joined', joined_at = NOW(), updated_at = NOW()
     WHERE invite_code = $1 AND status <> 'joined' RETURNING *`,
    [code],
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
// open asks, and cut if a gap carries a member's name or 5+ of their words
// in a row (the same leak rule as Mo's searches). Cached for a day.
export async function networkGaps(opts: { refresh?: boolean } = {}): Promise<Gap[]> {
  const cached = await getSetting<Gap[]>("gaps");
  if (!opts.refresh && cached && Date.now() - cached.updatedAt.getTime() < 24 * 3_600_000) return cached.value;
  const { rows } = await pool
    .query(
      `SELECT a.ask_text FROM ask_checkins a JOIN users u ON u.id = a.user_id
       WHERE a.resolved_at IS NULL AND u.archived_at IS NULL AND a.created_at > NOW() - INTERVAL '45 days'
       ORDER BY a.created_at DESC LIMIT 40`,
    )
    .catch(() => ({ rows: [] as any[] }));
  const asks = rows.map((r: any) => String(r.ask_text).slice(0, 200));
  if (!asks.length) return [];
  let gaps: Gap[] = [];
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.haiku),
      experimental_telemetry: { isEnabled: true, functionId: "mo.networkGaps" },
      prompt: `These are what members of a private network are looking for right now, one per line:
${asks.map((a) => `- ${a}`).join("\n")}

Group them into at most 3 gaps: the kinds of people the network is short on, each a few general words ("technical cofounders", "designers who host events"), with how many of the lines above point to it. No names, no companies, never more than three words in a row from any line.

Return ONLY JSON: {"gaps": [{"gap": "...", "members": 2}]}`,
    });
    gaps = (parseModelJson<{ gaps?: Gap[] }>(text).gaps ?? [])
      .filter((g) => typeof g?.gap === "string" && g.gap.trim().length > 2 && Number.isFinite(Number(g.members)))
      .map((g) => ({ gap: g.gap.trim().slice(0, 80), members: Math.max(1, Math.round(Number(g.members))) }))
      .slice(0, 3);
  } catch {
    return cached?.value ?? [];
  }
  const { queryLeaks } = await import("./find.js");
  const { rows: names } = await pool.query(`SELECT first_name, last_name FROM users WHERE archived_at IS NULL`).catch(() => ({ rows: [] as any[] }));
  const nameList = names.flatMap((r: any) => [r.first_name, r.last_name]).filter((n: any) => typeof n === "string" && n.trim().length >= 3).map((n: string) => n.trim().toLowerCase());
  const safe = gaps.filter((g) => !queryLeaks(g.gap, asks, nameList));
  await setSetting("gaps", safe).catch(() => {});
  return safe;
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
  const parts = [
    `${MO_RULES.opener(approverFirst)} ${waiting ? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting on your yes` : "Nobody new waiting on you"}, ${moving} in progress, ${joined} joined so far.`,
    styleLine(styles as StyleResult[]),
    gapsLine(gaps),
    focus.length ? `You asked me to look for: ${focus.join("; ")}.` : null,
    paused ? `I'm paused, so no new searches or outreach until you say "Mo, back on."` : sendingStatus(),
  ];
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------ commands

// Mo's own description of what it does, for "Mo, what can you do?" and the
// team update. Every line is something built.
export function moCapabilitiesText(approverFirst: string | null): string {
  return [
    `${MO_RULES.opener(approverFirst)} Here's what I do and how to use me.`,
    "",
    `Every Monday I search X, plus LinkedIn through public web results, for people in SF who should be in Co, steered by what Co tells me the network's short on (never who's asking).`,
    `Each morning I bring you one person at a time: what they wrote, why I think they fit, and what I'd send. Just answer yes, no, or what to change.`,
    `Once you say yes, Co replies to their post and I DM them a few days later as Mo, in one of two styles Jacqueline wrote, so we can see which lands. If they say yes, they get the invite; if they ask something, I bring it to you and send your answer word for word.`,
    `People who are only on LinkedIn get a note from you instead: I send it to you to post, with their invite.`,
    `When someone I found joins, I tell you. From then on they're Co's.`,
    "",
    `Text me any time starting with "Mo":`,
    `"Mo, what did you find?" for where things stand`,
    `"Mo, how's Noor?" for one person`,
    `"Mo, find me designers who host events" to steer my next search`,
    `"Mo, pause" or "Mo, back on"`,
  ].join("\n");
}

export async function runMoCommand(cmd: MoCommand, userId: string, approverFirst: string | null): Promise<string> {
  let reply: string;
  if (cmd.kind === "help") {
    reply = moCapabilitiesText(approverFirst);
  } else if (cmd.kind === "pause") {
    await setSetting("paused", { paused: true, by: userId });
    reply = `Paused. No new searches or outreach until you say "Mo, back on." If someone I already reached out to writes back, I'll still bring it to you.`;
  } else if (cmd.kind === "resume") {
    await setSetting("paused", { paused: false, by: userId });
    reply = `Back on. I'll pick up where I left off.`;
  } else if (cmd.kind === "focus") {
    await pool.query(`INSERT INTO mo_focus (text, asked_by) VALUES ($1, $2)`, [cmd.text.slice(0, 200), userId]);
    reply = `Got it, I'll look for ${cmd.text.replace(/^(for|some|more)\s+/i, "")} in my next search (Monday mornings).`;
  } else if (cmd.kind === "person") {
    const found = await findProspects(cmd.query);
    reply = found.length ? found.map(prospectStatusLine).join(" ") : `I don't have anyone called ${cmd.query} on my list.`;
  } else {
    reply = await moStatusText(approverFirst);
  }
  await recordDecision({ layer: 5, decision: "mo.command", userId, outcome: "act", action: cmd.kind, proposal: cmd.kind === "focus" ? { focus: cmd.text } : cmd.kind === "person" ? { query: cmd.query } : {} }).catch(() => {});
  return reply;
}
