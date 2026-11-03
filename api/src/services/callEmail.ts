// Email on a call (Royce, 2026-11-02, onboarding rulings 1 and 3). A first call whose member has no email on file asks for it once, near
// the end, and drops it if they'd rather not (prompts/co-system-prompt.md, the first-call section). After the call, what they said is
// read by the existing intake extraction (harness/intake.ts: buildIntakeExtractionPrompt, then decideIntake, whose emailAppearsInReply
// reads a spoken "at" and "dot"), and one text confirms the address so a mishearing can be fixed.
//   - Only their email is taken from a call, never a name: their call lines can name other people.
//   - Asked once (ruling A): a call where Cue asked for it counts as the ask (users.intake_retries), by text or call.
//   - A name already on file plus the email completes their identity, the same write as the text door; with no name yet the email is
//     held as the partial email, as on texts.
//   - An email that can't be used (not in their words, malformed, on another account) is dropped: nothing written, no text.
import pool from "../db/db.js";
import { recordDecision } from "../harness/core.js";
import { MODELS } from "../models.js";
import { callKey } from "./callKey.js";
import { hasPendingEmail } from "./identity.js";

type Db = { query: (sql: string, args?: unknown[]) => Promise<{ rows: any[] }> };

// Pure: their side of a transcript ("user:" lines), and Cue's.
const linesOf = (transcript: string, who: "user" | "assistant") =>
  transcript
    .split("\n")
    .filter((l) => new RegExp(`^${who}:`, "i").test(l))
    .map((l) => l.replace(/^\w+:\s*/, ""))
    .join("\n");
export const theirCallLines = (transcript: string): string => linesOf(transcript, "user");
// Pure: Cue asked for their email on this call.
export const cueAskedForEmail = (transcript: string): boolean => /\be-?mail\b/i.test(linesOf(transcript, "assistant"));
// Pure: their words could hold an address (written, or spoken "name at gmail dot com"): no model call otherwise.
export const mayHoldEmail = (text: string): boolean => /@/.test(text) || /\bat\b[\s\S]{0,40}\bdot\b/i.test(text);

// The confirmation text when Cue's own draft can't be used. Member-facing copy, approved by Royce (2026-11-03).
export const EMAIL_CONFIRM_FALLBACK = (email: string): string => `Got your email as ${email}. If that's not right, just text me the right one.`;
export const EMAIL_CONFIRM_TASK = "On the call they just gave you their email (email_they_gave). Text them one short sentence that confirms the exact address, so they can fix it if you misheard. Nothing else: no thanks for sharing, no question beyond that, no sign-off.";

export type CallEmailDeps = {
  db: Db;
  extract: (prompt: string) => Promise<string>;
  emailTaken: (email: string, userId: string) => Promise<boolean>;
  draft: (o: { firstName: string; email: string }) => Promise<string | null>;
  send: (o: { userId: string; phone: string; text: string; key: string; zone: string | null }) => Promise<{ sent: boolean; queued?: boolean }>;
  zone: (userId: string) => Promise<string | null>;
  record: typeof recordDecision;
};

export async function captureEmailFromCall(userId: string, transcript: string, deps: CallEmailDeps = realDeps): Promise<{ action: string; email?: string }> {
  const I = await import("../harness/intake.js");
  const { rows } = await deps.db.query(`SELECT first_name, last_name, email, phone_number, intake_partial_email, intake_retries, sms_opted_out, archived_at FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) return { action: "no_member" };
  if (u.email && !hasPendingEmail(String(u.email))) return { action: "on_file" };
  if (cueAskedForEmail(transcript)) await deps.db.query(`UPDATE users SET intake_retries = GREATEST(COALESCE(intake_retries, 0), 1) WHERE id = $1`, [userId]).catch(() => {});
  const theirs = theirCallLines(transcript);
  if (!mayHoldEmail(theirs)) return { action: "none_said" };
  const state = { userId, knownName: I.knownNameOf(u), knownEmail: null, partialEmail: u.intake_partial_email ?? null, retries: Number(u.intake_retries ?? 0), lastCoLine: null };
  const proposal = I.parseIntakeProposal(await deps.extract(I.buildIntakeExtractionPrompt(state, theirs)).catch(() => ""));
  const email = proposal.email?.trim() || null;
  if (!email) return { action: "none_found" };
  const taken = I.isValidEmail(email) ? await deps.emailTaken(email, userId).catch(() => true) : false;
  // Their email only: a name in their call lines may be someone else's.
  const d = I.decideIntake(state, { full_name: null, email }, { emailTakenByOtherAccount: taken, replyText: theirs });
  const usable = d.action === "capture" ? d.email : d.savePartialEmail;
  deps.record({ layer: 1, decision: "intake.identity", userId, outcome: usable ? "act" : "skip", action: d.action === "capture" ? "capture" : usable ? "hold_email" : "drop_email", proposal: { source: "call" }, checks: d.checks, reason: d.reason }).catch(() => {});
  if (!usable) return { action: "dropped" };
  if (d.action === "capture") {
    const write = (username: string) =>
      deps.db.query(`UPDATE users SET email = $2, username = $3, identity_captured = true, intake_partial_email = NULL WHERE id = $1 AND (email IS NULL OR email LIKE '%.pending')`, [userId, usable, username]);
    const local = usable.split("@")[0];
    try {
      await write(local);
    } catch (err: any) {
      if (err?.code !== "23505") throw err;
      if (!String(err?.constraint ?? "").includes("username")) return { action: "dropped" };
      await write(`${local}_${userId.slice(0, 6)}`);
    }
  } else {
    await deps.db.query(`UPDATE users SET intake_partial_email = $2 WHERE id = $1`, [userId, usable]);
  }
  if (!u.phone_number || u.sms_opted_out || u.archived_at) return { action: "saved_no_text", email: usable };
  const drafted = await deps.draft({ firstName: u.first_name || "them", email: usable }).catch(() => null);
  const text = drafted && drafted.includes(usable) && drafted.length <= 320 && !/[—–]/.test(drafted) ? drafted : EMAIL_CONFIRM_FALLBACK(usable);
  const zone = await deps.zone(userId).catch(() => null);
  const r = await deps.send({ userId, phone: u.phone_number, text, key: `call_email:${callKey(transcript)}`, zone });
  return { action: r.sent || r.queued ? "confirmed" : "saved_text_held", email: usable };
}

const realDeps: CallEmailDeps = {
  db: pool,
  extract: async (prompt) => {
    const [{ generateText }, { anthropic }, { INTAKE_EXTRACT_MODEL }] = await Promise.all([import("ai"), import("@ai-sdk/anthropic"), import("../harness/intake.js")]);
    return (await generateText({ model: anthropic(INTAKE_EXTRACT_MODEL), experimental_telemetry: { isEnabled: true, functionId: "call.intake.extractEmail" }, prompt })).text;
  },
  emailTaken: async (email, userId) => (await import("../harness/intake.js")).isEmailOnOtherAccount(email, userId),
  draft: async ({ firstName, email }) => {
    const P = await import("../harness/proactive.js");
    return P.draftProactive({ functionId: "call.email.confirm", firstName, facts: { email_they_gave: email }, task: EMAIL_CONFIRM_TASK, maxSentences: 2, model: MODELS.haiku });
  },
  send: async ({ userId, phone, text, key, zone }) => {
    const P = await import("../harness/proactive.js");
    const { CONFIRM_TYPE } = await import("./callFollowThrough.js");
    return P.sendExemptWhenAllowed({ userId, phoneNumber: phone, type: CONFIRM_TYPE, targetKey: key, messages: [text], timezone: zone });
  },
  zone: async (userId) => (await import("./memberTime.js")).memberZone(userId),
  record: recordDecision,
};
