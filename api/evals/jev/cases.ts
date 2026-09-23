// The 32 labelled texts shared by evals/jev/coCompare.ts and gatewayLive.ts
// (labels written before running, invented, no member data).
export type Feel = "none" | "life" | "co";
export type Case = { convo: string; msg: string; solving: boolean; issue: boolean; feel: Feel };
const C = (convo: string, msg: string, solving: boolean, issue: boolean, feel: Feel): Case => ({ convo, msg, solving, issue, feel });
const CO = "Co replied: Here's what I found for this weekend: a founders dinner in SoMa on Saturday.";

export const CASES: Case[] = [
  C(CO, "thanks, looks good", false, false, "none"),
  C(CO, "ok cool", false, false, "none"),
  C(CO, "what time does it start?", false, false, "none"),
  C(CO, "you sent me that same event twice", false, true, "none"),
  C(CO, "that link doesn't work", false, true, "none"),
  C(CO, "this isn't what I asked for at all, I said climate founders", false, true, "co"),
  C(CO, "you keep finding nothing useful, it's getting frustrating", false, true, "co"),
  C(CO, "you're way too slow to reply", false, true, "co"),
  C(CO, "you should ask me what I'm looking for before sending events", false, true, "none"),
  C(CO, "honestly this is perfect, exactly what I needed!", false, false, "co"),
  C("Co replied: How's the week going?", "rough week, my cofounder quit on monday", false, false, "life"),
  C("Co replied: How's the week going?", "pretty good, just busy", false, false, "none"),
  C("Co replied: How's the week going?", "I'm so excited, we closed our first customer today", false, false, "life"),
  C("Co replied: How's the week going?", "feeling really lonely since moving here, don't know anyone yet", false, false, "life"),
  C("Co replied: How's the week going?", "stressed about the launch, nothing is ready", false, false, "life"),
  C("Co replied: How's the week going?", "I can't decide whether to raise now or wait six months, what would you do?", true, false, "none"),
  C("User said: we have two venue options\nCo replied: Tell me about them.", "one's cheap but far, the other is perfect but $4k. I keep going back and forth", true, false, "none"),
  C("Co replied: How's the week going?", "should I take the job offer or keep building?", true, false, "none"),
  C("Co replied: What are you working on?", "trying to figure out how to get my first 10 users, any ideas", true, false, "none"),
  C("Co replied: What are you working on?", "just shipped a new feature, pretty proud of it", false, false, "life"),
  C("Co replied: What are you working on?", "a scheduling tool for small clinics", false, false, "none"),
  C("User said: my launch is next week\nCo replied: How are you feeling about it?", "fine I guess", false, false, "none"),
  C("User said: we lost our biggest client today\nCo replied: I'm sorry. How are you holding up?", "fine", false, false, "life"),
  C("Co replied: How's the week going?", "my cofounder and I keep fighting about direction, I don't know if we should split", true, false, "life"),
  C("Co replied: How's the week going?", "work is killing me lol", false, false, "life"),
  C(CO, "can you find something for next weekend instead?", false, false, "none"),
  C(CO, "no more hackathons please", false, false, "none"),
  C(CO, "you already told me about this one yesterday", false, true, "none"),
  C(CO, "you said it was free but the page says $40", false, true, "co"),
  C("Co replied: How's the week going?", "the venue fell through and the event is in 10 days, what do I do", true, false, "life"),
  C("Co replied: How's the week going?", "good! heading to a friend's birthday tonight", false, false, "life"),
  C("Co replied: Want me to call you?", "yeah call me", false, false, "none"),
];

