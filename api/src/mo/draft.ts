// What Co would say to someone Mo found: a public reply to their post
// (the warm-up), the DM, and the email for when DMs are closed. Written in
// Co's voice, checked in code (rules.ts), and never sent without approval.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import pool from "../db/db.js";
import { MODELS } from "../models.js";
import { CO_VOICE } from "../services/coVoice.js";
import { parseModelJson } from "../services/modelJson.js";
import { checkMoDraft, namesAMember, MO } from "./rules.js";

export type DraftInput = { name: string | null; handle: string | null; postText: string; reason: string; event: string | null; source: "x" | "linkedin" };
export type Drafts =
  | { ok: true; reply: string | null; dm: string; emailSubject: string; emailBody: string }
  | { ok: false; failed: string[] };

async function memberNames(): Promise<{ first: string; last: string | null }[]> {
  const { rows } = await pool.query(`SELECT first_name, last_name FROM users WHERE archived_at IS NULL AND first_name IS NOT NULL AND first_name <> ''`).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => ({ first: r.first_name, last: r.last_name ?? null }));
}

export function draftPrompt(i: DraftInput): string {
  return `${CO_VOICE}

You're reaching out, for the first time, to someone Co has never spoken to: ${i.name ?? "them"}${i.handle ? ` (@${i.handle} on X)` : ""}. They don't know Co. Co found them through this, in their own words:
"${i.postText.slice(0, 500)}"

Why they'd fit the club: ${i.reason}
${i.event ? `The next Co gathering: ${i.event}` : ""}

Write three things. Use only what's above: never mention any member or anyone else by name, never invent details about them or the club, no em dashes, no hype.

1. "reply"${i.source === "x" ? `: a short public reply to their post (under ${MO.maxReplyChars} characters). A genuine, specific reaction to what they posted, the way a thoughtful person in the same world would reply. No pitch, no mention of a club, invite, or DMs, no link.` : ": null (there's no post to reply to)."}
2. "dm": the private message (under ${MO.maxDmChars} characters). Say what you noticed in their words, that Co runs a small invite-only club in ${MO.city} for people like that, and end by asking whether they'd like an invite. No link and no code.
3. "emailSubject" and "emailBody": the same invitation as a short email (3 short paragraphs at most). Include the placeholder {{CODE}} where their invite code goes and {{PHONE}} where Co's number goes, with "text it to Co at {{PHONE}}" as the next step. No sign-off beyond "Co".

Return ONLY JSON: {"reply": "..." or null, "dm": "...", "emailSubject": "...", "emailBody": "..."}`;
}

export async function draftOutreach(i: DraftInput): Promise<Drafts> {
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    experimental_telemetry: { isEnabled: true, functionId: "mo.draft" },
    prompt: draftPrompt(i),
  });
  const p = parseModelJson<{ reply?: string | null; dm?: string; emailSubject?: string; emailBody?: string }>(text);
  const reply = i.source === "x" && typeof p.reply === "string" ? p.reply.trim() : null;
  const dm = (p.dm ?? "").trim();
  const emailSubject = (p.emailSubject ?? "").trim().slice(0, 120);
  const emailBody = (p.emailBody ?? "").trim();
  const failed = [
    ...(i.source === "x" ? checkMoDraft("reply", reply ?? "") : []),
    ...checkMoDraft("dm", dm),
    ...checkMoDraft("email", emailBody),
  ]
    .filter((c) => !c.pass)
    .map((c) => c.name);
  if (!emailSubject) failed.push("email_subject_empty");
  const members = await memberNames();
  for (const [label, t] of [["reply", reply ?? ""], ["dm", dm], ["email", `${emailSubject} ${emailBody}`]] as const) {
    const leaked = namesAMember(t, members, { name: i.name, postText: i.postText });
    if (leaked) failed.push(`${label}_names_member(${leaked})`);
  }
  if (failed.length) return { ok: false, failed };
  // Nothing beyond the post, and the drafts agree with each other (2026-09-23:
  // a reply put an event at "nTopology HQ" while the DM said it was moving to
  // NYC).
  const consistency = await checkDraftsAgainstPost(i.postText, [reply, dm, emailBody].filter((t): t is string => Boolean(t)));
  if (!consistency.ok) return { ok: false, failed: [`drafts_inconsistent(${consistency.problem})`] };
  return { ok: true, reply, dm, emailSubject, emailBody };
}

export async function checkDraftsAgainstPost(postText: string, drafts: string[]): Promise<{ ok: boolean; problem: string }> {
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "mo.draftCheck" },
      prompt: `A post, and messages written to its author based on it.

Post: "${postText.slice(0, 700)}"

Messages:
${drafts.map((d, n) => `${n + 1}. ${d}`).join("\n")}

Does any message state a place, date, number, or detail that the post doesn't say, or contradict the post or another message? Opinions and general statements about Co are fine.

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
  const input: DraftInput = { name: p.name, handle: p.x_handle, postText: p.post_text ?? p.headline ?? "", reason: p.reason, event: null, source: p.source };
  const { text } = await generateText({
    model: anthropic(MODELS.sonnet),
    experimental_telemetry: { isEnabled: true, functionId: "mo.redraft" },
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
  const failed = [...(input.source === "x" ? checkMoDraft("reply", reply ?? "") : []), ...checkMoDraft("dm", dm)].filter((c) => !c.pass).map((c) => c.name);
  const members = await memberNames();
  for (const [label, t] of [["reply", reply ?? ""], ["dm", dm]] as const) {
    const leaked = namesAMember(t, members, { name: input.name, postText: input.postText });
    if (leaked) failed.push(`${label} names a member`);
  }
  return failed.length ? { ok: false, failed } : { ok: true, reply, dm };
}
