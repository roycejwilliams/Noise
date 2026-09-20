// Model-free checks for member invites (services/invites.ts,
// services/inviteCodes.ts, the invite lines in services/onboardingLines.ts;
// 2026-09-19). No API calls, no database:
//   npx tsx evals/invites/rules.ts
import "dotenv/config";
import { inviteCodeCandidates } from "../../src/services/inviteCodes.js";
import { decideInvite, inviteGreeting, inviteLink, invitesLeft, isInviteCountQuestion, isInviteRequest, smsInviteHref } from "../../src/services/invites.js";
import { INVITE_JOINED, INVITE_READY, NO_INVITES_LEFT, WELCOME_INVITED, pickLine } from "../../src/services/onboardingLines.js";
import { addFact, baseReplyFacts, codeChecks } from "../../src/harness/replyGrounding.js";
import { decideActions, NO_ROUTE } from "../../src/services/messageRouter.js";
import { decideInviteJoinedGate } from "../../src/services/inviteJoinGate.js";

let total = 0;
let failed = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};

// Asking for an invite
const asks = [
  "Can I get an invite for a friend?",
  "send me an invite link",
  "I want to invite my friend Sam",
  "how many invites do I have left",
  "can I invite someone to Co?",
  "Invite code for my coworker?",
  "how do I invite people",
];
const notAsks = [
  "I got an invite to a party this weekend",
  "can you send me the invite link for the dinner",
  "invite my friend to the event on Sunday",
  "I was invited by Royce",
  "what's on tonight?",
  "my friend Sam wants to meet you",
  "thanks for the invitation to Sunday's mixer",
];
for (const t of asks) check(`is an invite ask: "${t}"`, isInviteRequest(t));
for (const t of notAsks) check(`not an invite ask: "${t}"`, !isInviteRequest(t));

// 5 per member, counted on join, open links never more than what's left
check("new member mints", decideInvite({ joined: 0, open: [] }).action === "mint");
check("4 open, 0 joined still mints a 5th", decideInvite({ joined: 0, open: ["A", "B", "C", "D"] }).action === "mint");
const full = decideInvite({ joined: 0, open: ["A", "B", "C", "D", "E"] });
check("5 open, 0 joined re-sends the oldest open link", full.action === "reuse" && full.code === "A");
const three = decideInvite({ joined: 3, open: ["X", "Y"] });
check("3 joined, 2 open: every slot is out, re-send", three.action === "reuse" && three.code === "X");
check("3 joined, 1 open: mints", decideInvite({ joined: 3, open: ["X"] }).action === "mint");
check("5 joined: none left", decideInvite({ joined: 5, open: [] }).action === "none_left");
check("5 joined with a stray open code: still none left", decideInvite({ joined: 5, open: ["Z"] }).action === "none_left");
check("invites left counts joins only", invitesLeft(2) === 3 && invitesLeft(7) === 0);

// Finding the code in the friend's first text
check("bare code", inviteCodeCandidates("6VGF76VK").includes("6VGF76VK"));
check("lowercase with a dash", inviteCodeCandidates("6vgf-76vk").includes("6VGF76VK"));
check("inside the invite greeting", inviteCodeCandidates(inviteGreeting("Royce", "6VGF76VK")).includes("6VGF76VK"));
check("no candidates in a plain hello", inviteCodeCandidates("hey, who is this?").length === 0);
check("ambiguous letters never count (I, L, O, 0, 1)", inviteCodeCandidates("INVITED1").length === 0);

// The link and the pre-filled text
check("greeting names the inviter", inviteGreeting("Royce", "6VGF76VK") === "Hi Co, Royce invited me. Code: 6VGF76VK");
check("greeting without a name", inviteGreeting(null, "6VGF76VK") === "Hi Co, I was invited. Code: 6VGF76VK");
const href = smsInviteHref("+15551234567", inviteGreeting("Royce", "6VGF76VK"));
check("sms link opens Messages to Co with the text filled in", href.startsWith("sms:+15551234567?&body=Hi%20Co%2C%20Royce"));
check("invite link is a web page on the base URL", inviteLink("6VGF76VK", "https://test.copatible.com/") === "https://test.copatible.com/i/6VGF76VK");
check("no base URL, no link", inviteLink("6VGF76VK", "") === null);

// Lines: on brand
const pools = { WELCOME_INVITED, INVITE_READY, NO_INVITES_LEFT, INVITE_JOINED };
for (const [name, pool] of Object.entries(pools)) {
  check(`${name} has at least 3 options`, pool.length >= 3);
  for (const line of pool) {
    const short = line.slice(0, 40);
    check(`${name}: no em dash: "${short}"`, !/[—–]/.test(line));
    check(`${name}: Co is only ever Co: "${short}"`, !/copatible|matchmaker|assistant|concierge|\bAI\b/i.test(line));
    check(`${name}: never "network" or exclusivity talk: "${short}"`, !/network|exclusive|invite-only|vip|elite/i.test(line));
    check(`${name}: no gendered pronouns: "${short}"`, !/\b(she|her|hers|he|him|his)\b/i.test(line));
  }
}
check("every friend welcome names the inviter", WELCOME_INVITED.every((l) => l.includes("{inviter}")));
check("every joined note names the friend", INVITE_JOINED.every((l) => l.includes("{friend}")));
const joined0 = new Set([0, 0.26, 0.51, 0.76, 0.99].map((r) => pickLine(INVITE_JOINED, { name: "Royce", friend: "Jacqueline", left: 0 }, () => r)));
check("0 left: never says '0 left'", [...joined0].every((l) => !/\b0 left/.test(l)));
check("filled lines have no leftover {braces}", [...joined0].every((l) => !/[{}]/.test(l)));
check("left > 0 can say how many", pickLine(INVITE_JOINED, { name: "Royce", friend: "Jacqueline", left: 3 }, () => 0.6).includes("3 left"));
check("friend welcome fills the name", pickLine(WELCOME_INVITED, { inviter: "Royce" }, () => 0) === "You're in. Royce brought you, so you're in good company.");

// Grounding: Co never says an invite went out unless the invite step sent one
const turn = (message: string) => ({ message, recentConversation: "" });
const claimFails = (draft: string, message: string, sent = false) => {
  const rf = baseReplyFacts();
  if (sent) addFact(rf, "known", "Co just texted them an invite link for a friend, in its own messages this turn. Don't send or describe another one.");
  return codeChecks(draft, rf, turn(message)).some((c) => c.name === "no_invite_sent_claim" && !c.pass);
};
check("'Sending that now' to an invite ask, nothing sent: caught", claimFails("Sending that now, one sec.", "send my friend a code"));
check("'I can do that' to 'can you add her', nothing sent: caught", claimFails("Yep, I can do that.", "my sister wants in, can you add her?"));
check("'let's get her an invite': caught", claimFails("Yep! One sec, let's get her an invite for you to send over.", "my sister wants in, can you add her?"));
check("invite really sent this turn: not flagged", !claimFails("That link's for Sam, just forward it.", "can my friend Sam join?", true));
check("not an invite message: not flagged", !claimFails("Sent you the event link above.", "what's on this weekend?"));
check("honest how-to: not flagged", !claimFails("Invites go through me. Ask me for an invite for your friend, and you'll get a link to forward.", "how do invites work?"));

// Router: acts on an invite ask unless it's only guessing
const routed = (confidence: "high" | "medium" | "low", wantsInvite: boolean) =>
  decideActions({ ...NO_ROUTE, wantsInvite, confidence }, [], turn("can my friend Sam join?")).wantsInvite;
check("router invite ask, high confidence: runs", routed("high", true));
check("router invite ask, medium confidence: runs", routed("medium", true));
check("router invite ask, low confidence: doesn't", !routed("low", true));
check("router says no invite: doesn't", !routed("high", false));
check("router outage: never an invite", !decideActions(NO_ROUTE, [], turn("x")).wantsInvite);

// Grounding: the "your friend joined" note always produces a decision
// (2026-09-20: Co told Royce "Jacqueline's in" with nothing in the decision
// log behind it, true or not). tellInviterTheyJoined (routes/sendblue.ts) is
// a thin DB/send wrapper around this gate — pinning the gate's branches pins
// that every real outcome (sent, or one of the deliberate skips) is one
// recordDecision away from being logged, without touching a database.
const gate = (over: Partial<Parameters<typeof decideInviteJoinedGate>[0]>) =>
  decideInviteJoinedGate({
    newUserId: "new-user",
    claimedInviterId: "inviter-1",
    priorInviterId: null,
    inviterReachable: true,
    friend: "Jacqueline",
    ...over,
  });
check(
  "join note: sends and attributes the claim to the inviter",
  (() => {
    const g = gate({});
    return g.attempt && g.action === "sent" && g.userId === "inviter-1" && g.friend === "Jacqueline";
  })(),
);
check(
  "join note: nobody invited them — skip, attributed to the new member",
  (() => {
    const g = gate({ claimedInviterId: null, priorInviterId: null });
    return !g.attempt && g.action === "no_inviter" && g.userId === "new-user";
  })(),
);
check(
  "join note: already sent earlier — skip, attributed to the actual inviter",
  (() => {
    const g = gate({ claimedInviterId: null, priorInviterId: "inviter-1" });
    return !g.attempt && g.action === "already_sent" && g.userId === "inviter-1";
  })(),
);
check(
  "join note: inviter opted out/unreachable — skip, not sent",
  (() => {
    const g = gate({ inviterReachable: false });
    return !g.attempt && g.action === "inviter_unreachable" && g.userId === "inviter-1";
  })(),
);
check(
  "join note: no friend name to say — skip, not sent",
  (() => {
    const g = gate({ friend: null });
    return !g.attempt && g.action === "no_friend_name" && g.userId === "inviter-1";
  })(),
);
check(
  "join note: a fresh claim wins even if a stray prior-notified row exists",
  (() => {
    const g = gate({ priorInviterId: "someone-else" });
    return g.attempt && g.action === "sent";
  })(),
);

// 2026-09-20 code review: the turn-hijack cases. An invite someone else gave
// them, or an invite to an occasion, is ordinary conversation.
for (const t of [
  "My friend sent me an invite to his wedding next month",
  "Got an invite to a conference from a colleague, worth going?",
  "My sister got me an invitation to her housewarming",
  "A friend sent me an invite to join their Slack",
  "my wife got an invite to a gallery opening",
  "can you send me the invite link for the dinner",
  "invite my friend to the event on Sunday",
]) check(`someone else's invite isn't an ask: "${t}"`, !isInviteRequest(t));
for (const t of ["Can I get an invite for a friend?", "send me an invite link", "I want to invite my friend Sam", "how do I invite people"]) {
  check(`still an ask: "${t}"`, isInviteRequest(t));
}

// Counting is a question, not a reason to mint a code (it used to burn a slot).
check("count question detected", isInviteCountQuestion("how many invites do I have left"));
check("count question, other wording", isInviteCountQuestion("how many invites left?"));
check("a real ask is not a count question", !isInviteCountQuestion("can I get an invite for a friend"));
check("count questions still route to the invite step", isInviteRequest("how many invites do I have left"));

// A line whose variable is missing is never sent half-built.
check("missing inviter: no line at all", pickLine(WELCOME_INVITED, {}, () => 0) === "");
check("missing friend: no line at all", pickLine(INVITE_JOINED, { name: "Royce", left: 3 }, () => 0) === "");
check("filled line still works", pickLine(WELCOME_INVITED, { inviter: "Royce" }, () => 0).includes("Royce"));

// Grounding: ordinary replies must not be rewritten into invite copy.
const notFlagged = (draft: string, message: string) => !claimFails(draft, message);
check("dress code question isn't invite copy", notFlagged("Smart casual. I'll send the details once I have them.", "what's the dress code for Sunday?"));
check("joining a founders group isn't an invite claim", notFlagged("Depends what you want out of it. I can get a read on it.", "should I join that founders group?"));
check("getting a kid into a school isn't an invite claim", notFlagged("That's a lot. I'll send over anything I find.", "trying to get my daughter in to that school"));
check("getting into a dinner isn't an invite claim", notFlagged("I'll add you to the list.", "can you get me in to Sunday's dinner?"));
check("a real invite claim is still caught", claimFails("Sending that invite now, one sec.", "can I get an invite for my friend?"));
check("no fallback pile-on when they have none left", (() => {
  const rf = baseReplyFacts();
  addFact(rf, "known", "Co just told them all 5 of their invites are used.");
  return !codeChecks("I'll send you another invite once someone joins.", rf, turn("can I get an invite for a friend?")).some((c) => c.name === "no_invite_sent_claim" && !c.pass);
})());

console.log(`invite rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
