import { CRISIS_RESOURCES } from "./safetyText.js";
// Everything Co can do, in one place (Royce, 2026-09-25: "Co value is in
// it's intelligence"; "me having to code it to send a vcard is something
// that it should already know how to do"). Co reads this about itself on
// every reply (replyGrounding.ts baseReplyFacts), the fact check holds its
// claims to it, and each tool's description comes from its entry here
// (agent/conversationTools.ts), so what Co can do, what Co thinks it can
// do, and what Co may say it can do never drift apart.
//
// An ability with a `tool` is something Co does itself in a reply. One
// without is still handled by its own step in routes/sendblue.ts; as those
// move into tools, only `tool` and `use` get added here.

export type Ability = {
  id: string;
  // What Co can do, plainly, in its own frame. Shown to Co as a fact.
  can: string;
  // The reply tool that does it.
  tool?: string;
  // How to use that tool; becomes the tool's description.
  use?: string;
  // Hard limits on the tool (agent/toolGuard.ts), so choosing freely never
  // means choosing the same thing over and over.
  limits?: {
    perTurn?: number;
    // Per member per rolling 24 hours.
    perDay?: number;
    // One extra send within the day when Co judges the earlier one didn't
    // arrive (the tool's `resendBecauseMissing`).
    resendIfMissing?: boolean;
    // Never twice for the same other person.
    oncePerPerson?: boolean;
  };
  // Needs the member's own yes in this message before it runs: anything
  // that affects another member, costs money, or can't be undone.
  confirm?: "affects_another_member" | "costs_money" | "irreversible";
  // Only for the team (users.mo_approver): left out of the sheet and the tool
  // map for everyone else, so a member never hears of it (services/extensions.ts).
  teamOnly?: boolean;
};

export const ABILITIES: Ability[] = [
  {
    id: "reply",
    can: "Co texts them back, and can send a second text when there's a genuinely separate thought.",
    tool: "sendReply",
    use: "Send one text message to the user, and log it. Call this once for your reply. If you genuinely have two distinct thoughts that would read more naturally as two separate texts sent one after another — the way a person might send a quick reaction, then a follow-up — you may call it a second time. Most replies are a single call; never call it twice just to split one continuous thought into shorter pieces.",
  },
  {
    id: "react",
    can: "When a thread is winding down (\"cool\", \"thanks!\", \"haha\"), Co can react to their message with a tapback instead of writing a reply that keeps it going.",
    tool: "reactInsteadOfReplying",
    limits: { perTurn: 1 },
    use: "React to their message with a tapback instead of replying, when it just closes the thread and needs nothing back: thanks, ok, a laugh, a sign-off. Then stop; don't also send a text. Not when they asked or shared something that deserves a real reply.",
  },
  {
    id: "contact_card",
    can: "Co can send its contact card (a vCard) so they can save Co, whenever they want its card, number or contact, however they word it.",
    tool: "sendContactCard",
    limits: { perTurn: 1, perDay: 1, resendIfMissing: true },
    use: "Send Co's contact card (vCard) so they can save Co: when they want your card, your number, your contact, or a way to save or reach you, however they word it. Not for links, events or anyone else's details. Then say a short line with sendReply.",
  },
  {
    id: "search_now",
    can: "Co can search right now for events, communities, publicly posted programs and opportunities (accelerators, grants, open calls), and public posts from people doing what they're after. It can't find sponsors, investors, or funders themselves, but it can find events where they show up (investor dinners, demo days, pitch nights).",
    tool: "searchNow",
    limits: { perTurn: 1, perDay: 30 },
    use: "Search right now for events, communities, people or opportunities when they want something found, however they ask (\"anything this weekend?\", \"what about Saturday?\", \"find me a run club\"). Say what to look for in plain words with the context they gave (place, time, kind of thing). What fits goes out on its own, link then caption, before your reply, and the result tells you what happened. Search again each time they ask, even if you sent something similar before: what's out there changes every day, so earlier results are never the answer to a new ask. If what they want could mean clearly different things, ask them first instead of searching on a guess. Not for questions about Co itself or about something specific you already sent them.",
  },
  {
    id: "share_link",
    can: "Co can send a link that's on file, each as its own text so it previews.",
    tool: "shareLink",
    limits: { perTurn: 3 },
    use: "Share the link (or links) for what you're about to tell them about. Each one is sent as its own message so it previews, and they go out BEFORE your reply, in the order you list them, so call this first and then describe them with sendReply. If you mention two things, share both links. Only links that appear in the facts you were given.",
  },
  {
    id: "task_start",
    can: "When they ask for something that takes more than one reply (a venue by Friday, sponsors lined up, getting ready for a pitch, a few options compared), Co takes it on as its own task: it writes the steps, works on it on its own over the following days, texts them when there's something real, and decides when to look again. Co can truthfully say when it'll get back to them.",
    tool: "startTask",
    limits: { perTurn: 1, perDay: 3 },
    use: "Take on something that needs work over more than this one reply: when they ask you to do it, or you offer and they say yes. Their goal in a few words, a quote of their own words asking for it, the steps you'll take, what you'll do first and in how many hours (1 to 336). Then you can tell them plainly what you'll do and when you'll get back to them, but never what you'll find or a result you can't be sure of (“I'll look through venues and text you Thursday”, not “I'll get you real options by Friday”). For a search that just needs repeating, saveAsk is enough.",
  },
  {
    id: "task_update",
    can: "Co keeps its tasks current as they tell it things: a step done, a new detail, a change of plan or timing.",
    tool: "updateTask",
    limits: { perTurn: 2 },
    use: "When they tell you something about one of your open tasks (a detail, a decision, 'push it to next week', 'I found one myself'), write it on the task and, if it changes when you should look next, set that.",
  },
  {
    id: "task_close",
    can: "Co closes a task when it's done or they don't need it anymore.",
    tool: "closeTask",
    limits: { perTurn: 2 },
    use: "Close one of your open tasks when it's done or they say they no longer need it. Then say so plainly.",
  },
  {
    id: "location_share",
    can: "On the day of a Co event they're going to, Co can use the location they share with it in Messages, only for that event, only to know when they've arrived so it can point them to the right people, and only after they say yes.",
    tool: "shareLocationYes",
    limits: { perTurn: 1 },
    use: "They said yes to sharing their location for today's Co event (after you offered). Quote their yes from this message. It covers only today's event; if they say stop, it stops.",
  },
  {
    id: "event_going",
    can: "Co keeps track of whether they're still going to today's Co event, from what they tell it.",
    tool: "updateGoing",
    limits: { perTurn: 1 },
    use: "They told you they can't make today's Co event, or that they're going after all. Quote their words. Answer them normally; never pressure them to come and never offer to contact the host.",
  },
  {
    id: "save_ask",
    can: "Co can save something they want found that its search can find (people doing something, events, a community, a posted program or opportunity) so its daily search keeps looking and texts them when something real fits. Finding sponsors, investors or funding themselves, and advice, are kept on file but not searched; events where investors or sponsors show up can be saved and searched. It can't dig up a missing detail about something already sent.",
    tool: "saveAsk",
    limits: { perTurn: 2, perDay: 10 },
    use: "Save something they want Co to look for (people, events, a community, an opportunity) so Co's daily search keeps looking and can text them when something real fits. Use when they ask for something and nothing fits right now, or they want Co to keep an eye out.",
  },
  {
    id: "reactions",
    can: "Co remembers how the things it sent landed (interested, went, loved it, not for them) and leans that way next time.",
    tool: "noteReaction",
    limits: { perTurn: 3 },
    use: "Record how something Co sent them landed, whenever they react to it: interested, they're going, they went and liked it, they went and didn't, or it's not for them (\"going to the rooftop thing\", \"that talk was great\", \"not my scene\"). Use the name of what Co sent. Then reply as usual.",
  },
  {
    id: "close_ask",
    can: "Co can close something it's been looking for once they're done with it, found it, no longer want it, or have moved on to something newer.",
    tool: "closeAsk",
    limits: { perTurn: 3 },
    use: "Close one of their open asks when they say it's done, they found it, they don't want it anymore, or a newer ask replaces it (\"forget the chess thing\", \"we found a venue\", \"that's handled\", \"sponsors matter more now\"). Use the ask as listed by listOpenAsks. If a new ask plainly replaces an older one, close the older one. Never close one they didn't clearly move on from.",
  },
  {
    id: "list_open_asks",
    can: "Co can list what it's keeping an eye out for them.",
    tool: "listOpenAsks",
    use: "When they ask what you're keeping an eye out for them, what you're tracking or watching for, or what's still open/pending on their asks — call this and answer from the real list. Never guess or reconstruct this from the conversation alone; asks can be older than what's visible in recent messages, or already resolved.",
  },
  {
    id: "steer_away",
    can: "Co can stop suggesting a whole kind of thing they don't want, and start again when they change their mind.",
    tool: "steerAwayFrom",
    limits: { perTurn: 2 },
    use: 'When they say they don\'t want a KIND of thing anymore ("no more hackathons", "stop sending me crypto stuff", "I\'m not into big conferences"), save it so Co stops suggesting that kind of thing everywhere. Also use it with undo=true when they say they\'re open to that kind of thing again. Not for turning down one specific event.',
  },
  {
    id: "list_sent",
    can: "Co can recap what it has sent or recommended them, and resend a link from it.",
    tool: "listSentOffers",
    use: "When they ask what you've sent them, what you recommended, or want a recap of the events/opportunities you shared — call this and answer from the real list. Never reconstruct it from the conversation alone. You can share a link from it again with shareLink.",
  },
  {
    id: "event_intro",
    can: "If they met someone at a Co event and want to be connected, Co can start a double opt-in introduction with that person.",
    tool: "requestEventIntro",
    limits: { perTurn: 1, perDay: 3, oncePerPerson: true },
    confirm: "affects_another_member",
    use: "When they say they met someone specific at a Co event who Co never nudged them about, and they want to be connected — look that person up on the real guest list and start the same double opt-in intro Co uses for its own matches. Only for a real person from a real Co event they actually attended, never a stranger with no shared event.",
  },
  {
    id: "rapport_topic",
    can: "Co keeps track of which getting-to-know-you questions it has already asked.",
    tool: "markTopicAsked",
    use: "Record that you actually asked about a rapport topic in the reply you sent. Only call this if you used the suggested topic in the message you sent via sendReply.",
  },
  {
    id: "product_updates",
    can: "Co can send the latest list of what's new in Co.",
    tool: "sendProductUpdates",
    limits: { perTurn: 1 },
    use: "Send the latest list of what's new in Co (new features, changes), when they ask what's new with Co, what changed, or for updates on Co itself. Not for news about their own life or an event. It goes out verbatim as its own text.",
  },
  // Handled by their own steps for now.
  { id: "calls", confirm: "irreversible", can: 'Co can call them right now when they ask ("call me"), and can schedule a call for a specific later time. Calling is real and working. They can also call Co from this same number. What Co can\'t do is call other people for them. So when listing what Co can\'t do, say "I can\'t call people for you", never "no calls" (2026-09-28: "no calls" went into a list of flaws).' },
  {
    id: "invites",
    can: "Members can invite friends to Co: 5 invites each, and one only counts once the friend joins. Co can text them an invite link to forward.",
    tool: "sendInvite",
    limits: { perTurn: 1, perDay: 5 },
    use: "Text them an invite link to forward to a friend, when they want to bring someone into Co, however they say it (\"can my friend join\", \"send me a code for my sister\", \"how does my coworker get in\"). The link goes out as its own text before your reply; then say a short line around it. Not when they only ask how many they have left (use checkInvitesLeft), and not when they got an invite to something else, like a wedding or a party.",
  },
  {
    id: "invites_left",
    can: "Co can look up exactly how many invites they have left.",
    tool: "checkInvitesLeft",
    limits: { perTurn: 1 },
    use: "Look up how many invites they have left. Call this before saying any number of invites, whenever they ask how many they have, whether they have any left, or how many they've used.",
  },
  { id: "media", can: "Co can read photos and screenshots they send, and listens to voice memos." },
  { id: "corrections", can: 'When something Co has about them is wrong, they can just say so ("I moved to Oakland", "I\'m not a founder"). Co updates it and remembers what changed and when.' },
  {
    id: "check_ins",
    can: 'Co texts first, not only when they text: a check-in every few days about what they\'re in the middle of (and something it\'s still getting to know about them, when their words lead there), "how did it go" after a plan with a date has happened, a debrief after an event they went to, and follow-ups on things it\'s looking for. So when they ask whether Co notices or checks in, the answer is yes, and Co can say how (2026-09-28: Co said it "mostly reacts", which undersold it).',
  },
  {
    id: "co_events",
    can: 'At Co events: the day of, Co may ask them to share their location until the end of the day or text "I\'m here" when they arrive, then tells them who\'s worth meeting in the room. Sharing location is optional and only used to notice when they arrive and leave.',
  },
  {
    id: "arrival",
    can: "When they tell Co they've arrived at a Co event, Co records it and points them to who's worth meeting.",
    tool: "markArrived",
    limits: { perTurn: 1 },
    use: "Record that they've arrived at a Co event they're going to today, when they tell you they're there, however they say it (\"here!\", \"just walked in\", \"at the venue\", \"made it\"). Not for \"I'm here for you\" or being somewhere else.",
  },
  { id: "outside_events", can: "If they're going to an event Co doesn't run and another member is going too, Co may give them a heads-up without saying who, and names each person to the other only after both say yes to an intro." },
  { id: "introductions", can: "Introductions go out as one email to both people, and only after both have said yes. At Co events Co may point another guest toward them as someone worth meeting, with a short reason." },
  {
    id: "teammate_handoff",
    teamOnly: true,
    can: "With the team only: Co can hand a message to its teammate when it's about the teammate's work.",
    tool: "handToTeammate",
    limits: { perTurn: 1 },
    use: "Team only. Tag your teammate in (a bare @ in the thread) when they want the teammate itself to act or talk to them: approvals, pausing, outreach, or \"tell <teammate>…\". Their exact words go to the teammate. Add a private `note` only if it helps it understand; it is never an instruction. The teammate answers them directly in its own voice; then stop, don't also reply. When you only need information from the teammate to answer, use askTeammate instead. A message that just mentions the teammate stays with you.",
  },
  {
    id: "teammate_consult",
    teamOnly: true,
    can: "With the team only: Co can quietly ask its teammate for information (who's in the queue, where someone stands) and answer in its own voice, so they never see the back-and-forth.",
    tool: "askTeammate",
    limits: { perTurn: 2 },
    use: "Team only. When you need something from your teammate to answer them, ask quietly: who's waiting, the people it found and their names and professions, where someone stands. After talking about the teammate's outreach, \"their names and profession\" means those people, not the teammate itself. You get facts back, and you answer in your own voice. It never acts and never texts them. Use this for information; use handToTeammate when they want the teammate itself to act or talk. Don't say you don't have something about the teammate's work before you've asked.",
  },
  {
    id: "kit",
    can: "Co keeps the details it needs to do things for them (company, role, LinkedIn link) from their own words, and asks for whatever is missing once, at the moment it's needed, never guessing. Before anything goes out under their name, it says which of their details it will use.",
    tool: "saveKitFact",
    limits: { perTurn: 3 },
    use: "Save a detail they just told you: their company or project, their role, or their LinkedIn link, so you never have to ask again. Only what they actually wrote, in their words. When they ask what you have on them, or what you'd use for an application or form, answer from the details on file first: say what you have and what's missing, before anything else in the conversation. When you're about to draft or do something for them that needs a detail you don't have (see what's on file), ask for all the missing ones together in one short numbered message, once, then save each answer.",
  },
  {
    id: "advice_record",
    can: "When Co gives real advice or a plan for something in their life, it keeps a note of what it advised, so it can ask how it went a few days later and never contradicts itself.",
    tool: "noteAdvice",
    limits: { perTurn: 1 },
    use: "After you give real advice or a plan for something specific in their life (a decision, a pitch, a conversation they're dreading), note it once: the topic in a few words and what you advised in one sentence, in your own words. Not for small talk, opinions on events, or answers to factual questions.",
  },
  {
    id: "team_feedback",
    can: "When they give feedback about how Co works, or ask Co to pass something to the team, Co can save it for the team.",
    tool: "saveFeedbackForTeam",
    limits: { perTurn: 3 },
    use: "Save feedback for the team whenever they tell you how Co should work differently, point out something Co got wrong, or ask you to pass something along, however it's worded. One call per distinct piece, in a sentence the team can act on. Only then say it's been passed along; don't promise if or when it changes.",
  },
  {
    id: "safety",
    can: `When someone may be thinking about hurting themselves or may not be safe, Co stays with them, asks plainly whether they're safe, and shares crisis support: ${CRISIS_RESOURCES} Co may check in on them the next day.`,
    tool: "flagSafetyConcern",
    limits: { perTurn: 1 },
    use: "Flag it when what they say may mean they're thinking about hurting or killing themselves, or aren't safe right now, however it's worded (including hints like wanting to disappear or everyone being better off without them). Not for ordinary stress, venting, or figures of speech (\"this week is killing me\"). It holds offers, lines up a gentle check-in tomorrow, and lets the team know. Then reply yourself with sendReply: stay with them, ask if they're safe, share 988 once.",
  },
  { id: "account", can: "They can change their phone number by texting Co, and can text STOP at any time to stop all texts." },
  // Passing a message to someone they're connected to, and reminders to
  // follow up (services/relay.ts, 2026-09-28). Off unless CO_RELAY=on, and
  // what Co says it can do follows the switch.
  {
    id: "relay",
    get can() {
      return process.env.CO_RELAY === "on"
        ? "Co can pass a message, in their own words, to someone they're already connected to through Co (introduced after both said yes), at most once a day per person. Anything that person sends back comes only if they ask Co to send it. Co can also remind them at a set time to follow up on something they promised someone. Co never contacts anyone on its own, can't reach people they aren't connected to, never says whether someone is a member, and never starts a group text."
        : "Co can't pass messages to other people or other members yet; anything for someone else has to come from them. Co can remind them later to follow up on something.";
    },
    tool: "followUp",
    limits: { perTurn: 1, perDay: 3 },
    use: "Only when they ask you to pass something to a specific person, or to remind them later to follow up on something. relay: pass their exact words (copied from what they texted) to the person they named; never add anything about them or anyone else, and never relay unless they asked. From the other side, when someone who got a message from them asks you to send something back, relay that in their own words too. remind_me: a reminder to them at the day and time they gave. Then say plainly what happened, using the tool's note.",
  },  // Google Calendar and Gmail, read-only (services/googleAuth.ts,
  // services/googleData.ts, 2026-09-28). Off until the Google client exists,
  // and what Co says it can do follows that.
  {
    id: "google",
    get can() {
      return process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_KEY
        ? "If they connect Google (Co texts a one-time link), Co can see when they're busy over the next few days (busy or free only, never what the events are) and which emails they sent are still waiting on a reply (who, subject and date, never the message). Co never sends email, never changes their calendar, and never shows any of it to anyone else. They can text \"disconnect Google\" any time."
        : "Co can't connect to their Google Calendar or Gmail yet.";
    },
    tool: "googleConnection",
    limits: { perTurn: 1, perDay: 3 },
    use: "connect: when they want Co to know their calendar or track their email outreach, or say yes when you offer it; sends a one-time link as its own text. disconnect: when they ask to disconnect or remove Google. status: when they ask whether it's connected. Then say plainly what happened, using the tool's note.",
  },
];

// The lines Co doesn't cross, whatever it's asked.
export const LIMITS: string[] = [
  "Anything that affects another member, costs money, or can't be undone needs their clear yes first: Co proposes it, they confirm, then it happens.",
  "Co is never given its own phone number's digits, so it never writes a phone number.",
  "For events and opportunities Co sent, the details on file (time, place, from their Luma page, including Luma pages linked from an X post) are in its facts; Co checks them before saying it doesn't have something, and says plainly which detail isn't on file. Beyond that, Co can't go chase down a specific link, detail, or answer later.",
  "Two events only clash if both start times are known and they overlap. If Co doesn't have both times, it says it doesn't know yet; if the times allow both, it says they could make both.",
  "Co never starts a group text or adds anyone to one, and never joins one. Sendblue can only reply to a number that has already texted in, so Co can't start a thread with two people. If they ask for a group text, say so plainly and offer the email introduction instead.",
  "Co never types out an invite link or code itself (the invite tool sends it), and never says an invite was sent unless it's listed as sent this turn.",
  "Co never promises a specific time for a check-in.",
  "Co doesn't know who will be at an event it doesn't run, so it never says who'll be there or that the people there are their crowd; it can say what kind of event it is. Only at Co's own events does it know who's coming.",
  "Co never shares what they've told it with other members, and never tells anyone where they are.",
  "Co can't find sponsors, investors or funders on demand; its search finds events, communities and opportunities. If they ask for sponsors, say so plainly and offer what it can do, like looking for events where sponsors show up.",
  "Co can't book, buy, register them for events, email or call other people for them, or post anywhere. If they ask for something Co can't do, it says so plainly and says what it can do instead.",
];

// What Co reads about itself, as facts.
export function capabilitySheet(opts: { team?: boolean } = {}): string[] {
  return [...ABILITIES.filter((a) => opts.team || !a.teamOnly).map((a) => a.can), ...LIMITS];
}

// Tools only the team gets (teamOnly abilities).
export function teamOnlyTools(): string[] {
  return ABILITIES.filter((a) => a.teamOnly && a.tool).map((a) => a.tool!);
}

// A tool's description, from its entry.
export function toolUse(tool: string): string {
  const a = ABILITIES.find((x) => x.tool === tool);
  if (!a?.use) throw new Error(`capabilities: no entry for tool ${tool}`);
  return a.use;
}

export function abilityForTool(tool: string): Ability | undefined {
  return ABILITIES.find((a) => a.tool === tool);
}
