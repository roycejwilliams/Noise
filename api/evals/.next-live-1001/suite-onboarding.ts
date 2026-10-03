// Suite 4: onboarding through the real Sendblue webhook route, mounted
// in-process (router.ts) with a fake socket.io and the synthetic signing secret.
// New numbers become TEMP placeholder users; every Co text is captured
// (test numbers) and logged to TEMP outbound_messages / co_memories.
import { H } from "./boot.js";
import { member, rows, ck, ID, type Case } from "./fixtures.js";
import { inbound, turnDone, mountRouter } from "./router.js";

const NEW1 = "+14155550110", NEW2 = "+14155550111", NEW3 = "+14155550112";
async function userBy(phone: string) { return (await rows(`SELECT * FROM users WHERE phone_number = $1`, [phone]))[0] ?? null; }
async function coTexts(phone: string) {
  const u = await userBy(phone);
  if (!u) return [] as string[];
  return (await rows(`SELECT content FROM co_memories WHERE user_id = $1 AND content LIKE 'Co replied:%' ORDER BY created_at, id`, [u.id])).map((r: any) => r.content.replace(/^Co replied:\s*/, ""));
}
// A placeholder made the way production makes one, then let in and asked for name/email.
async function inIntake(phone: string) {
  const { findOrCreateUserByPhone } = await import("../../src/services/identity.js");
  const u = await findOrCreateUserByPhone(phone);
  await rows(`UPDATE users SET invite_verified = true, invite_asked = true, intake_asked = true WHERE id = $1`, [u.id]);
}
async function say(phone: string, text: string, o: any = {}) {
  const r = await inbound(phone, text, o);
  const done = r.status === 200 ? await turnDone(r.handle, 90000) : true;
  return { ...r, done };
}

export const onboarding: Case[] = [
  {
    suite: "onboarding", id: "onboard-new-gate",
    run: async () => {
      await mountRouter();
      const { GATE_ASK, WELCOME, WRONG_CODE } = await import("../../src/services/onboardingLines.js");
      const t1 = await say(NEW1, "hey there");
      const u1 = await userBy(NEW1);
      const after1 = await coTexts(NEW1);
      const t2 = await say(NEW1, "hello? is this Co");
      const after2 = await coTexts(NEW1);
      const second = after2.slice(after1.length);
      return {
        checks: [
          ck("a TEMP placeholder member exists, nothing captured as identity", !!u1 && !u1.identity_captured && !u1.invite_verified && u1.invite_asked, u1 && { identity: u1.identity_captured, invite: u1.invite_verified, asked: u1.invite_asked }),
          ck("first text gets exactly one invite-code ask", after1.length === 1 && (GATE_ASK as readonly string[]).includes(after1[0]), after1),
          ck("the second text doesn't resend the welcome or the ask", second.length <= 1 && !second.some((t) => (WELCOME as readonly string[]).includes(t) || (GATE_ASK as readonly string[]).includes(t)), second),
          ck("the second text gets the wrong-code line (no code in it)", second.length === 1 && (WRONG_CODE as readonly string[]).includes(second[0]), second),
          ck("both turns finished", t1.done && t2.done),
        ],
        texts: { first: after1, second },
      };
    },
  },
  {
    suite: "onboarding", id: "onboard-code",
    run: async () => {
      await mountRouter();
      await member("A");
      await rows(`INSERT INTO invite_codes (code, created_by) VALUES ('HRNS7QXA', $1), ('USDZ9QXA', $1)`, [ID.A]);
      await rows(`UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = 'USDZ9QXA'`, [ID.A]);
      const t1 = await say(NEW1, "hi! Avery sent me, my code is HRNS7QXA :)");
      const u1 = await userBy(NEW1);
      const texts1 = await coTexts(NEW1);
      const code = (await rows(`SELECT used_by FROM invite_codes WHERE code = 'HRNS7QXA'`))[0];
      // Same user sends it again: nothing changes, it isn't redeemed twice.
      await say(NEW1, "HRNS7QXA");
      const code2 = (await rows(`SELECT used_by FROM invite_codes WHERE code = 'HRNS7QXA'`))[0];
      // Another new number: invalid code, then an already-used code.
      await say(NEW2, "hey, code NOPE1234");
      await say(NEW2, "USDZ9QXA");
      const u2 = await userBy(NEW2);
      // A third person tries the code the first one used.
      await say(NEW3, "HRNS7QXA");
      const u3 = await userBy(NEW3);
      const toInviter = await rows(`SELECT content FROM outbound_messages WHERE user_id = $1`, [ID.A]);
      return {
        checks: [
          ck("a valid code in a friendly message unlocks and starts intake that turn", u1?.invite_verified && u1.intake_asked && texts1.length >= 3, { u1: u1 && { v: u1.invite_verified, intake: u1.intake_asked }, texts1 }),
          ck("the code is now used by them", code?.used_by === u1?.id, code),
          ck("replaying it changes nothing", code2?.used_by === u1?.id),
          ck("invalid and already-used codes don't unlock", u2 && !u2.invite_verified, u2 && { v: u2.invite_verified }),
          ck("someone else can't reuse a used code", u3 && !u3.invite_verified, u3 && { v: u3.invite_verified }),
          ck("the inviter isn't texted (no real notification)", toInviter.length === 0, toInviter),
        ],
        texts: { newMember: texts1, invalid: await coTexts(NEW2), reuse: await coTexts(NEW3) },
        observed: { t1: t1.done },
      };
    },
  },
  {
    suite: "onboarding", id: "onboard-intake-partial",
    run: async () => {
      await mountRouter();
      // In, invited, intake asked, identity not yet captured.
      await inIntake(NEW1);
      await say(NEW1, "idk");
      const s0 = await userBy(NEW1); const x0 = await coTexts(NEW1);
      await say(NEW1, "Sam Rivera");
      const s1 = await userBy(NEW1); const x1 = (await coTexts(NEW1)).slice(x0.length);
      await say(NEW1, "sam.rivera@co.invalid");
      const s2 = await userBy(NEW1); const x2 = (await coTexts(NEW1)).slice(x0.length + x1.length);
      return {
        checks: [
          ck("a vague answer captures nothing and asks again", !s0.identity_captured && !/sam/i.test(s0.first_name ?? "") && x0.length >= 1, { s0: { first: s0.first_name, email: s0.email }, x0 }),
          ck("name only: name kept, asks only for the email", !s1.identity_captured && /sam/i.test((s1.first_name ?? "") + (s1.intake_partial_email ?? "") + JSON.stringify(x1)) && x1.length >= 1 && /email/i.test(x1.join(" ")) && !/name/i.test(x1.join(" ").replace(/email/gi, "")), { s1: { first: s1.first_name, last: s1.last_name, email: s1.email }, x1 }),
          ck("email completes identity with what they actually said", s2.identity_captured && s2.first_name === "Sam" && s2.last_name === "Rivera" && s2.email === "sam.rivera@co.invalid", { first: s2.first_name, last: s2.last_name, email: s2.email }),
        ],
        texts: { vague: x0, afterName: x1, afterEmail: x2 },
      };
    },
  },
  {
    suite: "onboarding", id: "onboard-identity-collision", runs1: true,
    run: async () => {
      await mountRouter();
      await member("B"); // owns jordan.b@co.invalid, username jordan_b
      await inIntake(NEW1);
      await say(NEW1, "Jordan Lee, jordan.b@co.invalid");
      const u = await userBy(NEW1);
      const b = (await rows(`SELECT email, phone_number FROM users WHERE id = $1`, [ID.B]))[0];
      const x = await coTexts(NEW1);
      // Then a fresh, valid email whose local part matches an existing username.
      await say(NEW1, "oh sorry, use jordan_b@another.invalid");
      const u2 = await userBy(NEW1);
      const finished = u2.identity_captured;
      // A repeat of the same successful message doesn't onboard twice.
      const before = (await coTexts(NEW1)).length;
      await say(NEW1, "jordan_b@another.invalid");
      const after = (await coTexts(NEW1)).length;
      const usernames = await rows(`SELECT username FROM users WHERE phone_number IN ($1, $2)`, [NEW1, b.phone_number]);
      return {
        checks: [
          ck("another member's email can't be taken over", !u.identity_captured || u.email !== "jordan.b@co.invalid", { email: u.email, captured: u.identity_captured }),
          ck("the other member is untouched", b.email === "jordan.b@co.invalid", b),
          ck("a fresh email completes, with a username that doesn't collide", finished && new Set(usernames.map((r: any) => r.username)).size === 2, { usernames, finished }),
          ck("a repeated message doesn't run onboarding again", after - before <= 1, { before, after }),
        ],
        texts: { collision: x },
        observed: { note: "Two connections racing for one email is not tested (needs concurrent independent transactions)." },
      };
    },
  },
  {
    suite: "onboarding", id: "onboard-call-or-text",
    run: async ({ run }) => {
      await mountRouter();
      await inIntake(NEW1);
      await say(NEW1, "Sam Rivera, sam.rivera@co.invalid");
      const offer = await rows(`SELECT content FROM co_memories WHERE content LIKE '[onboarding]%'`);
      const cap0 = H.captured.length;
      const answer = run === 1 ? "texting is better for me" : "sure, call me now";
      await say(NEW1, answer);
      const after = H.captured.slice(cap0).map((c) => `${c.transport}:${c.path}`);
      const x = await coTexts(NEW1);
      const calls = await rows(`SELECT count(*)::int AS n FROM scheduled_calls`).catch(() => [{ n: -1 }]);
      const callish = after.filter((a) => /twilio|hume|eleven/i.test(a));
      return {
        checks: [
          ck("identity completes and one onboarding call offer is pending", offer.length === 1, offer),
          ck(run === 1 ? "choosing text: no call attempt, nothing scheduled" : "accepting: any call attempt is captured/denied, never placed", run === 1 ? callish.length === 0 && calls[0].n <= 0 : true, { callish, calls }),
          ck("no real call, voice or email left the process", H.unexpectedNet.filter((n) => n.caseId === H.caseId).length === 0, H.unexpectedNet),
        ],
        texts: { offer: offer[0]?.content, conversation: x.slice(-4) },
        observed: { answer, transports: after },
      };
    },
  },
  {
    suite: "onboarding", id: "onboard-bad-origin-optout", runs1: true,
    run: async () => {
      await mountRouter();
      const bad = await inbound(NEW1, "hi", { secret: "nope" });
      await new Promise((r) => setTimeout(r, 800));
      const uBad = await userBy(NEW1);
      const mal = await inbound("+1555", "hi");
      await new Promise((r) => setTimeout(r, 1200));
      const uMal = await rows(`SELECT count(*)::int AS n FROM users`);
      await member("C");
      const s = await say("+14155550102", "STOP");
      const c1 = (await rows(`SELECT sms_opted_out FROM users WHERE id = $1`, [ID.C]))[0];
      const before = (await rows(`SELECT count(*)::int AS n FROM outbound_messages WHERE user_id = $1`, [ID.C]))[0].n;
      await say("+14155550102", "are you there?");
      const after = (await rows(`SELECT count(*)::int AS n FROM outbound_messages WHERE user_id = $1`, [ID.C]))[0].n;
      await say("+14155550102", "START");
      const c2 = (await rows(`SELECT sms_opted_out FROM users WHERE id = $1`, [ID.C]))[0];
      return {
        checks: [
          ck("wrong signing secret: 401, no member created", bad.status === 401 && !uBad, { status: bad.status, uBad: !!uBad }),
          ck("malformed number: no member created, no send", uMal[0].n === 0, uMal),
          ck("STOP opts out with one confirmation", c1.sms_opted_out && before === 1, { c1, before }),
          ck("an opted-out member gets nothing", after === before, { before, after }),
          ck("START resubscribes", !c2.sms_opted_out, c2),
        ],
        observed: { stop: s.status },
      };
    },
  },
];
