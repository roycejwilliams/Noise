// An intro to a member with no email goes by text (Royce, 2026-11-03, review of the onboarding branch, finding 4). Ruling A lets a
// member decline their email, and the placeholder (pending-...@copatible.pending) is no email: it is never a send address. Wherever an
// intro would email both members (services/eventGuestMatchHandoff.ts sendIntroEmail, services/networkIntroNudge.ts
// sendNetworkIntroEmail), the members with a real email get the email and the others get the same content by text, through the gated
// send (harness/proactive.ts sendExemptWhenAllowed: their opt-out, hours and rules hold it; a held one is queued, never dropped).
// The text goes FIRST: if it can't go (opted out, held for good, failed), nothing is sent and the pair stays retryable; the email goes
// only after, so a retry never sends a second email. The text carries the other's email when they have one; without one, both reach
// each other through Cue's relay (services/relay.ts, a text to Cue), and the emailed member's close says so. Never a phone number.
import { usableEmail } from "./identity.js";

export type IntroPerson = { user_id: string; first_name: string; phone_number: string | null; email: string | null };
type Send = (o: { userId: string; phoneNumber: string; targetKey: string; text: string }) => Promise<{ sent: boolean; queued: boolean; reason?: string }>;

// Pure: who gets the intro by email (a real address) and who by text (no email, or only the placeholder).
export function introChannels(a: IntroPerson, b: IntroPerson): { email: IntroPerson[]; text: IntroPerson[] } {
  return { email: [a, b].filter((p) => usableEmail(p.email)), text: [a, b].filter((p) => !usableEmail(p.email)) };
}

// The intro text, in Cue's own first person (Royce approves the lines: they are listed in the PR's Copy section). Minimal: who, why,
// that both said yes, and how to reach the other. Never a phone number.
export const INTRO_TEXT = {
  headline: (me: string, other: string) => `${me}, meet ${other}.`,
  event: (eventName: string) => `You were both at ${eventName}, and I thought you two should meet.`,
  network: (reason: string) => `${/[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`} I thought you two should meet.`,
  bothYes: "You both said yes.",
  theirEmail: (other: string, email: string) => `You can reach ${other} at ${email}.`,
  passItOn: (other: string) => `Text me anything for ${other} and I'll pass it on.`,
};
// The emailed member's close when the other has no email (the email's own third person): they reach them through Cue's relay, by
// text (services/relay.ts; Resend takes no replies, so never "reply to this email").
export const EMAIL_PASS_IT_ON = (other: string) => `You both said yes. To reach ${other}, text Cue and it'll pass it on.`;
export const EMAIL_CLOSE = "You both said yes. Take it from here.";
export type IntroWhy = { event: string } | { reason: string };

// Pure: the intro as one text to `me`. Their contact: the other's email when there is one; otherwise Cue passes things on (the relay,
// only when it's on: relayOn false leaves the line out rather than promise what can't happen).
export function introText(me: IntroPerson, other: IntroPerson, why: IntroWhy, relayOn: boolean): string {
  const theirs = usableEmail(other.email);
  return [
    INTRO_TEXT.headline(me.first_name, other.first_name),
    "event" in why ? INTRO_TEXT.event(why.event) : INTRO_TEXT.network(why.reason),
    INTRO_TEXT.bothYes,
    ...(theirs ? [INTRO_TEXT.theirEmail(other.first_name, theirs)] : relayOn ? [INTRO_TEXT.passItOn(other.first_name)] : []),
  ].join(" ");
}

// Pure: the emailed member's close: "take it from here" when both have email, the relay when the other gets it by text.
export function emailCloseFor(channels: { text: IntroPerson[] }, relayOn: boolean): string {
  return channels.text.length === 1 && relayOn ? EMAIL_PASS_IT_ON(channels.text[0].first_name) : EMAIL_CLOSE;
}

// Pure: for the reply the same turn: how the intro reached them and the other, so Cue never tells a member with no email to check it.
export function introHowNote(me: IntroPerson, other: IntroPerson): string {
  const meE = !!usableEmail(me.email), oE = !!usableEmail(other.email);
  if (meE && oE) return "The intro goes to both of them by email.";
  if (!meE && !oE) return "Neither has an email on file, so the intro goes to each of them by text. Never mention email or an inbox.";
  return meE
    ? `The intro goes to them by email and to ${other.first_name} by text.`
    : `They have no email on file, so their intro comes by text (${other.first_name}'s by email). Never tell them to check their email or inbox.`;
}

// Sends the text to each member in `to`. ok only when every one went (now or before) or is queued for when it may go.
export async function textIntro(o: { to: IntroPerson[]; pair: [IntroPerson, IntroPerson]; why: IntroWhy; relayOn: boolean; key: string }, send: Send = sendForTests ?? gatedSend): Promise<{ ok: boolean; results: { userId: string; sent: boolean; queued: boolean; reason?: string }[] }> {
  const results: { userId: string; sent: boolean; queued: boolean; reason?: string }[] = [];
  for (const me of o.to) {
    const other = o.pair[0].user_id === me.user_id ? o.pair[1] : o.pair[0];
    if (!me.phone_number) {
      results.push({ userId: me.user_id, sent: false, queued: false, reason: "no email and no phone on file" });
      continue;
    }
    const r = await send({ userId: me.user_id, phoneNumber: me.phone_number, targetKey: `${o.key}:text:${me.user_id}`, text: introText(me, other, o.why, o.relayOn) }).catch((err: any) => ({ sent: false, queued: false, reason: String(err?.message ?? err) }));
    results.push({ userId: me.user_id, ...r });
  }
  // "already sent": a retry of an intro whose text went the first time (the target key is claimed once, harness/proactive.ts sendExempt).
  return { ok: results.every((r) => r.sent || r.queued || r.reason === "already sent"), results };
}

const gatedSend: Send = async ({ userId, phoneNumber, targetKey, text }) => {
  const [P, T] = await Promise.all([import("../harness/proactive.js"), import("./memberTime.js")]);
  // They both said yes to this intro: it's what they asked for (requested), never Cue's own outreach.
  return P.sendExemptWhenAllowed({ userId, phoneNumber, type: "direct_ask", targetKey, messages: [text], timezone: await T.memberZone(userId).catch(() => null), cls: "requested" });
};

// Layer 1 only: the send the intro paths use, stubbed (evals/onboarding/reviewFixes.ts). Never set in the app.
let sendForTests: Send | null = null;
export function setIntroTextSendForTests(fn: Send | null): void {
  sendForTests = fn;
}
