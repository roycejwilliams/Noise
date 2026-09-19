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

export function pickLine(pool: readonly string[], vars: { name?: string | null } = {}, rand: () => number = Math.random): string {
  const line = pool[Math.floor(rand() * pool.length) % pool.length];
  return line.replace(/\{name\}/g, (vars.name ?? "").trim() || "there");
}
