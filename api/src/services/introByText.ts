// An intro to a member with no email goes by text (Royce, 2026-11-03, review of the onboarding branch, finding 4). Ruling A lets a
// member decline their email, and the placeholder (pending-...@copatible.pending) is no email: it is never a send address. Wherever an
// intro would email both members (services/eventGuestMatchHandoff.ts sendIntroEmail, services/networkIntroNudge.ts
// sendNetworkIntroEmail), the members with a real email get the email and the others get the same content by text, through the gated
// send (harness/proactive.ts sendExemptWhenAllowed: their opt-out, hours and rules hold it; a held one is queued, never dropped).
// The text carries the other's email when they have one, since the email puts both on one thread; the relay recorded after the intro
// (services/relay.ts) is how two members reach each other through Cue otherwise.
import { usableEmail } from "./identity.js";

export type IntroPerson = { user_id: string; first_name: string; phone_number: string | null; email: string | null };
type Send = (o: { userId: string; phoneNumber: string; targetKey: string; text: string }) => Promise<{ sent: boolean; queued: boolean; reason?: string }>;

// Pure: who gets the intro by email (a real address) and who by text (no email, or only the placeholder).
export function introChannels(a: IntroPerson, b: IntroPerson): { email: IntroPerson[]; text: IntroPerson[] } {
  return { email: [a, b].filter((p) => usableEmail(p.email)), text: [a, b].filter((p) => !usableEmail(p.email)) };
}

// Pure: the email's own content as one text to `me`: the headline, the body, the close, and the other's email when there is one.
export function introText(me: IntroPerson, other: IntroPerson, body: string[], close: string): string {
  const theirs = usableEmail(other.email);
  return [`${me.first_name}, meet ${other.first_name}.`, ...body, close, ...(theirs ? [`${other.first_name}'s email: ${theirs}`] : [])].join("\n\n");
}

// Sends the text to each member in `to`. ok only when every one went (now or before) or is queued for when it may go.
export async function textIntro(o: { to: IntroPerson[]; pair: [IntroPerson, IntroPerson]; body: string[]; close: string; key: string }, send: Send = sendForTests ?? gatedSend): Promise<{ ok: boolean; results: { userId: string; sent: boolean; queued: boolean; reason?: string }[] }> {
  const results: { userId: string; sent: boolean; queued: boolean; reason?: string }[] = [];
  for (const me of o.to) {
    const other = o.pair[0].user_id === me.user_id ? o.pair[1] : o.pair[0];
    if (!me.phone_number) {
      results.push({ userId: me.user_id, sent: false, queued: false, reason: "no email and no phone on file" });
      continue;
    }
    const r = await send({ userId: me.user_id, phoneNumber: me.phone_number, targetKey: `${o.key}:text:${me.user_id}`, text: introText(me, other, o.body, o.close) }).catch((err: any) => ({ sent: false, queued: false, reason: String(err?.message ?? err) }));
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
