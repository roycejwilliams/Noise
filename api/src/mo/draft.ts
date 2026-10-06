// What goes to someone Mo found: a public reply to their post (the warm-up,
// from Co's account), then Mo's own DM, and an email for when DMs are closed.
// Checked in code (rules.ts) and never sent without approval.
//
// Mo reaches out as itself (Jacqueline, 2026-09-24: "Hey, I'm Mo..."; since
// 2026-09-25 Mo "extends invitations to Co"; structure: who you are, why you're
// reaching out, what you want to do, how they fit, the ask). Two styles,
// alternated so the team can see which lands (she: "We can test different
// messaging"):
//   intro:   her full version, ending "Want me to send you an invite?"
//   curious: her short one, now "I'm Mo. I extend invitations to Co, a
//            private social club in San Francisco. [where] led me to you. I
//            think you belong. Want to know why?" A yes gets "why" (drafted
//            now, approved with the rest) plus the invite.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { MO_VOICE } from "./moVoice.js";
import { parseModelJson } from "../services/modelJson.js";
import { checkMoDraft, namesAMember, MO } from "./rules.js";
import { sealedTelemetry } from "../services/privateTurn.js";

export type DmStyle = "intro" | "curious";
export const DM_STYLES: DmStyle[] = ["intro", "curious"];

// How Mo opens (Royce, 2026-09-25: "Mo should have a variation of its
// intros"). Rotated evenly and stored per prospect (mo_prospects.opener),
// so the team can see which lands. Every one says "I'm Mo" (rules.ts
// dm_says_its_mo). Jacqueline's short "Want to know why?" DM keeps its
// approved shape; the opener shapes the intro DM and the email.
export type OpenerId = "warm" | "noticed" | "rooms" | "plain";
// Mo extends invitations to Co (Royce, 2026-09-25); every opening says so.
export const OPENERS: Record<OpenerId, string> = {
  warm: 'Open warmly: "Hey, I\'m Mo. I extend invitations to Co."',
  noticed: 'Open with the specific thing of theirs that caught your eye, then who you are, e.g. "Your post about [it] caught my eye. I\'m Mo. I extend invitations to Co, a private social club in San Francisco."',
  rooms: 'Open with what you do, e.g. "I\'m Mo. I extend invitations to Co, for people who should be in the same room."',
  plain: 'Open plainly, e.g. "Hi, I\'m Mo. I extend invitations to Co, a private social club in San Francisco."',
};
export const OPENER_IDS = Object.keys(OPENERS) as OpenerId[];

export type DraftInput = { name: string | null; handle: string | null; postText: string; reason: string; event: string | null; source: "x" | "linkedin"; style?: DmStyle; opener?: OpenerId };
export type Drafts =
  | { ok: true; reply: string | null; dm: string; why: string | null; emailSubject: string; emailBody: string }
  | { ok: false; failed: string[] };

async function memberNames(): Promise<{ first: string; last: string | null }[]> {
  const { rows } = await pool.query(`SELECT first_name, last_name FROM users WHERE archived_at IS NULL AND first_name IS NOT NULL AND first_name <> ''`).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ first: r.first_name, last: r.last_name ?? null }));
}

export const dmMaxFor = (style: DmStyle | undefined) => ((style ?? "intro") === "intro" ? MO.maxIntroDmChars : MO.maxDmChars);

export function draftPrompt(i: DraftInput): string {
  const style = i.style ?? "intro";
  const opener = i.opener ?? "warm";
  const where = i.source === "x" ? "their post" : "their LinkedIn profile";
  const dmSpec =
    style === "curious"
      ? `2. "dm": Mo's private message (under ${MO.maxDmChars} characters), short and curious, in this shape: "I'm Mo. I extend invitations to Co, a private social club in San Francisco. [where you came across them, a few words, e.g. their post about design dinners] led me to you. I think you belong. Want to know why?" Keep the reason itself out of the DM; that's what they get if they say yes. No link, no code.
3. "why": what Mo tells them if they say yes (1-2 sentences, under 260 characters, speaking to them as "you"): the specific reason they fit, from their own words above. No link, no code; the invite is added after it.`
      : `2. "dm": Mo's private message (under ${MO.maxIntroDmChars} characters), in this shape: who Mo is (${OPENERS[opener]}), where Mo came across them (a few words, e.g. "your post about design dinners put you on my radar"), what Co is (a private, invite-only social club in ${MO.city}, where members meet the few people in the room worth knowing), one specific line on how they fit, from their own words, and end with "Want me to send you an invite?" No link, no code.
3. "why": null.`;
  return `${MO_VOICE}

You're reaching out, for the first time, to someone Co has never spoken to: ${i.name ?? "them"}${i.handle ? ` (@${i.handle} on X)` : ""}. They don't know Co or Mo. You found them through ${where}, in their own words:
"${i.postText.slice(0, 500)}"

Why they'd fit (your notes for the team): ${i.reason}
${i.event ? `The next Co gathering: ${i.event}` : ""}

Write four things. Use only what's above: never mention any member or anyone else by name, never invent details about them or the club, no em dashes, no hype. The tone is a private social club: grown, professional, assured, a little magnetic. Write like an invitation, not a pitch.

1. "reply"${i.source === "x" ? `: a short public reply to their post from Co's account (under ${MO.maxReplyChars} characters). A genuine, specific reaction to what they posted, the way a thoughtful person in the same world would reply. No pitch, no mention of a club, invite, Mo, or DMs, no link.` : ": null (there's no post to reply to)."}
${dmSpec}
4. "emailSubject" and "emailBody": the same approach as a short email from Mo (3 short paragraphs at most): who Mo is (${OPENERS[opener]}), where Mo came across them, why they fit, and the invite. Include the placeholder {{CODE}} where their invite code goes. Don't include Co's number or tell them to text it anywhere: the email's button does that (Royce, 2026-09-25). Sign it "Mo".

Return ONLY JSON: {"reply": "..." or null, "dm": "...", "why": "..." or null, "emailSubject": "...", "emailBody": "..."}`;
}

export async function draftOutreach(i: DraftInput): Promise<Drafts> {
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.draft" },
    prompt: draftPrompt(i),
  });
  const p = parseModelJson<{ reply?: string | null; dm?: string; why?: string | null; emailSubject?: string; emailBody?: string }>(text);
  const reply = i.source === "x" && typeof p.reply === "string" ? p.reply.trim() : null;
  const dm = (p.dm ?? "").trim();
  const why = (i.style ?? "intro") === "curious" && typeof p.why === "string" ? p.why.trim() : null;
  const emailSubject = (p.emailSubject ?? "").trim().slice(0, 120);
  const emailBody = (p.emailBody ?? "").trim();
  const failed = [
    ...(i.source === "x" ? checkMoDraft("reply", reply ?? "") : []),
    ...checkMoDraft("dm", dm, { dmMax: dmMaxFor(i.style) }),
    ...((i.style ?? "intro") === "curious" ? checkMoDraft("why", why ?? "") : []),
    ...checkMoDraft("email", emailBody),
  ]
    .filter((c) => !c.pass)
    .map((c) => c.name);
  if (!emailSubject) failed.push("email_subject_empty");
  const members = await memberNames();
  for (const [label, t] of [["reply", reply ?? ""], ["dm", dm], ["why", why ?? ""], ["email", `${emailSubject} ${emailBody}`]] as const) {
    const leaked = namesAMember(t, members, { name: i.name, postText: i.postText });
    if (leaked) failed.push(`${label}_names_member(${leaked})`);
  }
  if (failed.length) return { ok: false, failed };
  // Nothing beyond the post, and the drafts agree with each other (2026-09-23:
  // a reply put an event at "nTopology HQ" while the DM said it was moving to
  // NYC).
  const consistency = await checkDraftsAgainstPost(i.postText, [reply, dm, why, emailBody].filter((t): t is string => Boolean(t)), { name: i.name, handle: i.handle, event: i.event });
  if (!consistency.ok) return { ok: false, failed: [`drafts_inconsistent(${consistency.problem})`] };
  return { ok: true, reply, dm, why, emailSubject, emailBody };
}

export async function checkDraftsAgainstPost(postText: string, drafts: string[], known: { name?: string | null; handle?: string | null; event?: string | null } = {}): Promise<{ ok: boolean; problem: string }> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.draftCheck" },
      prompt: `A post, and messages written to its author based on it.

Post: "${postText.slice(0, 700)}"

Messages:
${drafts.map((d, n) => `${n + 1}. ${d}`).join("\n")}

Also known, and fine to use (2026-09-25: the checker used to call their own name "invented"):${known.name ? ` their name is ${known.name};` : ""}${known.handle ? ` their handle is @${known.handle};` : ""}${known.event ? ` Co's next gathering is ${known.event};` : ""} Mo may also open by saying what of theirs caught its eye.

The messages are SUPPOSED to say that Mo extends invitations to Co, a private invite-only social club in ${MO.city}, offer an invite or ask if they want to know why, and (in the email) contain the placeholder {{CODE}}; that's never a problem. Only check what the messages say about the AUTHOR and their post: does any message state a place, date, number, or detail about them that the post doesn't say, or contradict the post or another message?

Return ONLY JSON: {"ok": true} or {"ok": false, "problem": "what's wrong, briefly"}`,
    });
    const r = parseModelJson<{ ok?: boolean; problem?: string }>(text);
    return r.ok === true ? { ok: true, problem: "" } : { ok: false, problem: String(r.problem ?? "unclear").slice(0, 120) };
  } catch {
    return { ok: false, problem: "check failed" };
  }
}

// An approver's change, in their own words ("make the DM shorter"). Same
// checks as the first draft; only the public reply and the DM are redone.
export async function redraftOutreach(p: any, instruction: string): Promise<{ ok: true; reply: string | null; dm: string } | { ok: false; failed: string[] }> {
  const input: DraftInput = { name: p.name, handle: p.x_handle, postText: p.post_text ?? p.headline ?? "", reason: p.reason, event: null, source: p.source, style: p.dm_style ?? "intro", opener: p.opener && p.opener in OPENERS ? p.opener : "warm" };
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    experimental_telemetry: { ...sealedTelemetry(), isEnabled: true, functionId: "mo.redraft" },
    prompt: `${draftPrompt(input)}

The current drafts:
reply: ${JSON.stringify(p.draft_reply ?? null)}
dm: ${JSON.stringify(p.draft_dm ?? "")}

A teammate asked for this change: "${instruction.slice(0, 400)}"
Apply it, keeping every rule above. Return the same JSON shape.`,
  });
  const r = parseModelJson<{ reply?: string | null; dm?: string }>(text);
  const reply = input.source === "x" && typeof r.reply === "string" ? r.reply.trim() : null;
  const dm = (r.dm ?? "").trim();
  const failed = [...(input.source === "x" ? checkMoDraft("reply", reply ?? "") : []), ...checkMoDraft("dm", dm, { dmMax: dmMaxFor(input.style) })].filter((c) => !c.pass).map((c) => c.name);
  const members = await memberNames();
  for (const [label, t] of [["reply", reply ?? ""], ["dm", dm]] as const) {
    const leaked = namesAMember(t, members, { name: input.name, postText: input.postText });
    if (leaked) failed.push(`${label} names a member`);
  }
  return failed.length ? { ok: false, failed } : { ok: true, reply, dm };
}
