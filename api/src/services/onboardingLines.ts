// Onboarding copy (Royce, 2026-09-19): hand-written, approved lines, one
// picked at random per person, so no two onboardings read the same and every
// line is on brand. The feel is a private social club, the Raya kind:
// understated, grown, never selling, and never announcing that it's
// exclusive. These replaced model-written lines after one went out as
// "I need more context to write this message. Who am I reaching out to, and
// why?" with the contact card.
//
// {name} is filled with their first name.

// A new number's first text, before any code.
export const GATE_ASK = [
  "Hey, I'm Co. I get to know every member, and when we're in the same room, I make sure you meet the right people. What's your invite code?",
  "Hi, I'm Co. Think of me as the one who knows who you should meet. What's your invite code?",
  "Hey, it's Co. I make the right introductions when we're in the same room. Send me your invite code to start.",
  "Hey, I'm Co. Every member gets to know me, and I get to know them. What's your invite code?",
];

export const WRONG_CODE = [
  "That one didn't work. Check it and send it again.",
  "That code isn't going through. Mind sending it again?",
  "That code didn't take. Double-check it with whoever sent it.",
];

// Right after a good code.
export const WELCOME = [
  "You're in. Glad someone brought you.",
  "You're in. Someone thought you belonged here.",
  "You're in. Good to have you.",
];

export const HOW_IT_WORKS = [
  "Here's how this works. I get to know you: what you're into, what you're working on, the kind of people you click with. At our events, I'll point you to the few people in the room you should meet. In between, I'm a text or a call away.",
  "Quick version: I learn who you are and who you'd click with. When you're at one of our events, I'll tell you who in the room is worth meeting. Otherwise, text or call me whenever.",
  "The more I know you, the better the room gets. Tell me what you're into and who you like being around, and at our events I'll point you to the right people. Text or call me here anytime.",
];

// Goes out with Co's contact card attached.
export const CARD = ["Save my number.", "Save me in your phone.", "Here's my card. Keep it close."];

export const NAME_EMAIL = ["First, your full name and email.", "Let's start simple. Full name and email?", "What's your full name and best email?"];

// After name and email: the first call offer.
export const CALL_OFFER = [
  "Good to meet you, {name}. Next, a quick five-minute call, just so I can get to know you properly. It's how I'll know who to introduce you to when you're in the room. Now, or should we pick a time? Texting's fine too.",
  "{name}, good to have you. I'd love five minutes on the phone. I learn more in a quick call than a week of texts, and it's how I'll know who to put you next to. Call now, or pick a time? We can keep texting if you'd rather.",
  "Nice to meet you, {name}. Easiest next step is a five-minute call so I actually know who you are. Now works, or tell me a time. Texting's fine too.",
];

// Invites (Royce, 2026-09-19): each member gets 5, one only counts once
// the friend joins, and unused ones never expire (services/invites.ts).

// Right after a good code that came from a member's invite. {inviter} is
// that member's first name.
export const WELCOME_INVITED = [
  "You're in. {inviter} brought you, so you're in good company.",
  "You're in. Any friend of {inviter}'s is welcome here.",
  "You're in. {inviter} has good taste.",
];

// A member asked for an invite. The link goes in its own text right after,
// so it shows as a tappable card.
export const INVITE_READY = [
  "Here's an invite. Send it to them, and one tap opens a text to me with the code filled in.",
  "Pass this along. One tap and they're texting me.",
  "Here you go. Forward this to whoever you have in mind.",
];

export const NO_INVITES_LEFT = [
  "All 5 of your invites are taken. Everyone you brought is in.",
  "You've used all 5 of your invites. Good company, all of them.",
  "No invites left. All 5 found someone.",
];

// To the member, once their friend finishes onboarding. {friend} is the
// friend's first name; {left} is how many invites the member has left.
export const INVITE_JOINED = [
  "{friend}'s in. Good taste, {name}.",
  "Your invite worked. {friend} just joined.",
  "{friend} got in on your invite. You've got {left} left.",
  "Just met {friend}. Thanks for bringing them in.",
];

type LineVars = { name?: string | null } & Record<string, string | number | null | undefined>;

// {name} falls back to "there"; any other {key} is filled from vars. A line
// needing a var that wasn't given (or {left} when it's 0) is skipped, so a
// blank or "0 left" never goes out.
export function pickLine(pool: readonly string[], vars: LineVars = {}, rand: () => number = Math.random): string {
  const usable = pool.filter((line) =>
    [...line.matchAll(/\{(\w+)\}/g)].every(([, key]) => {
      if (key === "name") return true;
      const v = vars[key];
      if (v === null || v === undefined || String(v).trim() === "") return false;
      return !(key === "left" && Number(v) <= 0);
    }),
  );
  const from = usable.length ? usable : pool;
  const line = from[Math.floor(rand() * from.length) % from.length];
  return line.replace(/\{(\w+)\}/g, (_, key) => (key === "name" ? String(vars.name ?? "").trim() || "there" : String(vars[key] ?? "").trim()));
}
