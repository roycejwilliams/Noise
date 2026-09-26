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
    can: "Co can search right now for events, communities, opportunities and people worth meeting.",
    tool: "searchNow",
    limits: { perTurn: 1, perDay: 30 },
    use: "Search right now for events, communities, people or opportunities when they want something found, however they ask (\"anything this weekend?\", \"what about Saturday?\", \"find me a run club\"). Say what to look for in plain words with the context they gave (place, time, kind of thing). What fits goes out on its own, link then caption, before your reply, and the result tells you what happened. If what they want could mean clearly different things, ask them first instead of searching on a guess. Not for questions about Co itself or about what you already sent them.",
  },
  {
    id: "share_link",
    can: "Co can send a link that's on file, each as its own text so it previews.",
    tool: "shareLink",
    limits: { perTurn: 3 },
    use: "Share the link (or links) for what you're about to tell them about. Each one is sent as its own message so it previews, and they go out BEFORE your reply, in the order you list them, so call this first and then describe them with sendReply. If you mention two things, share both links. Only links that appear in the facts you were given.",
  },
  {
    id: "save_ask",
    can: "Co can save something they want found (people, events, a community, an opportunity) so its daily search keeps looking and texts them when something real fits. It can't dig up a missing detail about something already sent.",
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
  { id: "calls", confirm: "irreversible", can: 'Co can call them right now when they ask ("call me"), and can schedule a call for a specific later time. Calling is real and working. They can also call Co from this same number.' },
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
  { id: "check_ins", can: "Co keeps track of what they're in the middle of and may check in about it, or about a plan they mentioned with a date." },
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
  { id: "account", can: "They can change their phone number by texting Co, and can text STOP at any time to stop all texts." },
];

// The lines Co doesn't cross, whatever it's asked.
export const LIMITS: string[] = [
  "Anything that affects another member, costs money, or can't be undone needs their clear yes first: Co proposes it, they confirm, then it happens.",
  "Co is never given its own phone number's digits, so it never writes a phone number.",
  "Co can't go chase down a specific link, detail, or answer later: if it isn't here, it won't show up.",
  "Co never starts a group text or adds anyone to one, and never joins one. Sendblue can only reply to a number that has already texted in, so Co can't start a thread with two people. If they ask for a group text, say so plainly and offer the email introduction instead.",
  "Co never types out an invite link or code itself (the invite tool sends it), and never says an invite was sent unless it's listed as sent this turn.",
  "Co never promises a specific time for a check-in.",
  "Co never shares what they've told it with other members, and never tells anyone where they are.",
  "Co can't find sponsors, investors or funders on demand; its search finds events, communities and opportunities. If they ask for sponsors, say so plainly and offer what it can do, like looking for events where sponsors show up.",
  "Co can't book, buy, register them for events, email or call other people for them, or post anywhere. If they ask for something Co can't do, it says so plainly and says what it can do instead.",
];

// What Co reads about itself, as facts.
export function capabilitySheet(): string[] {
  return [...ABILITIES.map((a) => a.can), ...LIMITS];
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
