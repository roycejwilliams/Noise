import { CRISIS_RESOURCES } from "./safetyText.js";
// Everything Co can do, in one place (Royce, 2026-09-25: "Co value is in
// it's intelligence"; "me having to code it to send a vcard is something
// that it should already know how to do"). Co reads this about itself on
// every reply (the snapshot's section 6, services/memberSnapshot.ts; its `sheet` lines), the fact check holds its
// claims to it, and each tool's description comes from its entry here
// (agent/conversationTools.ts), so what Co can do, what Co thinks it can
// do, and what Co may say it can do never drift apart.
//
// An ability with a `tool` is something Co does itself in a reply. One
// without is still handled by its own step in routes/sendblue.ts; as those
// move into tools, only `tool` and `use` get added here.

export type Ability = {
  id: string;
  // What Co can do, plainly, in its own frame. The call audit (harness/callGrounding.ts) and the member's list read it.
  can: string;
  // The line Co reads about itself in the capability sheet (capabilitySheet: the snapshot's section 6, or the reply's facts when there's
  // no snapshot), trimmed so the sheet says what Cue can do and its limits without restating each tool's how-to (that lives in `use`;
  // capability-sheet trim, 2026-10-31). One line can cover a group: it sits on the group's first ability that is never left out by a
  // situation, and the others carry null. Every member ability has one or the other (evals/capabilities/rules.ts), so a new ability
  // can't be left out of the sheet by accident. Team-only abilities fall back to `can`.
  sheet?: string | null;
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
  // "their_yes": they asked for it, or said yes to Co's offer, in this message (a yes-gated action only runs on a yes).
  confirm?: "affects_another_member" | "costs_money" | "irreversible" | "their_yes";
  // Only for the team (users.mo_approver): left out of the sheet and the tool
  // map for everyone else, so a member never hears of it. None today.
  teamOnly?: boolean;
  // Also runs on a phone call (services/callTools.ts takes its call toolset from these entries, so the call
  // briefing's list and the tools enabled on a call are the same list). Every tool runs by text.
  onCall?: true;
  // An ability without a tool that also works on a call (talking itself). Tool abilities use onCall.
  surfaces?: Surface[];
  // How the tool is used on a call, when that differs from texting (shareLink on a call takes the names of things on file, since
  // the call's prompt carries no links). Becomes the call tool's description.
  callUse?: string;
};

// Co's calling line is a different number from the one it texts from
// (Twilio vs Sendblue). Members are told the real calling number, never
// the number they text (2026-10-01 call review).
export function formatUsNumber(e164: string | null | undefined): string | null {
  const d = String(e164 ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
export function callLine(): string {
  const n = formatUsNumber(process.env.TWILIO_PHONE_NUMBER);
  return n
    ? `they call Cue at ${n}, which is Cue's calling line, a different number from the one Cue texts them from (calling the texting number doesn't reach Cue). Give that number when they ask how to call.`
    : "they can call Cue's calling line, which is a different number from the one Cue texts from; Cue doesn't have that number to hand right now, so don't make one up.";
}

export const ABILITIES: Ability[] = [
  {
    id: "reply",
    sheet: "Cue texts back (a second text only for a separate thought) or reacts with a tapback when a thread is winding down.",
    can: "Cue texts them back, and can send a second text when there's a genuinely separate thought.",
    tool: "sendReply",
    use: "Send one text message to the user, and log it. Call this once for your reply. If you genuinely have two distinct thoughts that would read more naturally as two separate texts sent one after another, the way a person might send a quick reaction, then a follow-up, you may call it a second time. Most replies are a single call, because each paragraph in it already goes out as its own text; a second call is for a thought you only had after the first went out, never to split one thought into pieces.",
  },
  {
    id: "react",
    sheet: null,
    can: "When a thread is winding down (\"cool\", \"thanks!\", \"haha\"), Cue can react to their message with a tapback instead of writing a reply that keeps it going.",
    tool: "reactInsteadOfReplying",
    limits: { perTurn: 1 },
    use: "React to their message with a tapback instead of replying, when it just closes the thread and needs nothing back: thanks, ok, a laugh, a sign-off. A reaction is a reply: pick the one emoji that fits this exact message, never a generic one when a specific one fits, never the same as your last reaction. If none fits, send a short text instead. Then stop; don't also send a text. Not when they asked or shared something that deserves a real reply.",
  },
  {
    id: "reaction_says_it",
    sheet: null,
    can: "When Cue's reaction to their text already says everything (they landed, a thanks, good news that needs no words), Cue can leave it at that and not text.",
    tool: "leaveItAtReaction",
    limits: { perTurn: 1 },
    use: "You already reacted to their text this turn. When that reaction says all there is to say (they've landed, a thanks, a sign-off, news that needs no words), end here and send nothing else, because a text that adds nothing is noise. Not when they asked something, shared something that deserves words, or are waiting on you for anything.",
  },
  {
    id: "contact_card",
    sheet: "Cue sends its contact card on request, a link on file as its own text, a recap of what it sent, and what's new in Cue.",
    can: "Cue can send its contact card (a vCard) so they can save Cue, whenever they want its card, number or contact, however they word it.",
    tool: "sendContactCard",
    limits: { perTurn: 1, perDay: 1, resendIfMissing: true },
    use: "Send Cue's contact card (vCard) so they can save Cue: when they want your card, your number, your contact, or a way to save or reach you, however they word it. Not for links, events or anyone else's details. Then say a short line with sendReply.",
  },
  // Co's own loop (agent/loop.ts): general tools it chains itself to find things.
  {
    id: "search_events",
    sheet: "Cue looks up events (Noise's own first, then the public feed), searches the web (venues, vendors, people, programs, events), reads pages, and searches the last week of X posts. Results are checked against their pages. It sends finds as links, each with a short caption, best first.",
    can: "Cue can look up events itself: Noise's own events and the public event feed for a city, for the days they asked about, then judge which fit.",
    onCall: true,
    tool: "searchEvents",
    limits: { perTurn: 3 },
    use: "Look up events in a place and time window: Noise's own events first, then the public Luma feed. Use it when they want something to go to (\"anything this weekend?\", \"AI events Thursday\"). Put `when` in their own words (\"this weekend\", \"Oct 10\") so the dates come out right, and `city` when they named one. You get back real events with their details, closest to what you asked first, plus openings (programs, grants, open calls) Cue's daily search already found and checked for them; nothing is sent. They're candidates, not answers: judge each against what they asked and who they are, and share only the ones that genuinely fit. The public feed is a short curated list (often a few events a day), so when it comes back thin, try webSearch for the same thing before telling them nothing's on.",
  },
  {
    id: "web_search",
    sheet: null,
    can: "Cue can search the web for venues to book, vendors (DJs, caterers, photographers), people, places, programs, and events the feed doesn't have; every result is checked against its own page.",
    tool: "webSearch",
    limits: { perTurn: 3 },
    use: "Search the web for one specific thing: a venue to book, a vendor, people, a place, a program, or events the feed doesn't have. Also when they ask about a company, product or public thing you don't know: look it up before you answer, rather than asking them what it is, because they asked you so they wouldn't have to explain it. When they ask you to research someone or something, search first, before you say or suggest anything about it; if nothing solid comes back, say so plainly and build nothing on it. Give up to 3 short queries at once, each a different angle, because they run at the same time and one round is much faster than three. Write each the way an expert would type it (3 to 7 words: the thing plus the area, or a listing site plus the thing), not their whole sentence, because long queries find less. Results come back already checked against their own pages, with only the facts those pages state; anything that didn't hold up comes back as dropped, with why. Look at what came back before searching again, and change one thing (the area, a synonym, a listing site like peerspace.com or thebash.com) rather than repeating yourself. Up to 4 queries a turn in all, so spend them where they add something.",
  },
  {
    id: "search_posts",
    sheet: null,
    can: "Cue can look through recent posts on X (the last week) for fresh announcements: open calls, programs taking applications, people building or hiring for what they're after.",
    tool: "searchPosts",
    limits: { perTurn: 2, perDay: 10 },
    use: "Look through the last week of posts on X for something just announced that the web won't have yet: an open call, a program taking applications, a cohort, a speaking slot, people building or hiring for exactly what they want. Use 2 to 4 distinctive keywords, with OR for real synonyms people post with (\"(founder dinner OR builder night)\"), not their sentence, and never their own city or a year they didn't say, because posts rarely mention either and those words make you miss them. You get the posts as written; nothing is sent. A post is the poster's claim: share one only when its own text backs what you say (the program, the deadline, the date), and say who posted it when that matters. X search has a shared daily budget, so use it when freshness matters, not for venues or vendors.",
  },
  {
    id: "read_page",
    sheet: null,
    can: "Cue can read a web page, including ones that only load in a real browser, to confirm a detail or find who to contact.",
    tool: "readPage",
    limits: { perTurn: 6 },
    use: "Read one page: a result you want to know more about (price, capacity, a contact email, whether outside DJs are allowed), or a link they sent. Pages that block simple reading are opened in a real browser. Use it before you recommend something or contact someone, because what you say about a place should come from its own page. Up to 6 a turn.",
  },
  {
    id: "read_document",
    sheet: null,
    can: "Cue can read a PDF or document they send, only for what helps connections: event details from a flyer or agenda, and who they are and what they're looking for.",
    tool: "readDocument",
    limits: { perTurn: 1, perDay: 6 },
    use: "They sent a PDF or document and want it used: call this with the file's number (leave it out for their newest). It returns event details from a flyer or agenda, and what the file says about who they are and what they're looking for, or says the file is about neither. Use event details as finds; save their own details through saveAsk or updateNotes, in their words. Never summarize, rewrite or edit a document; if the file is about neither, say so in one line and offer nothing else.",
  },
  {
    id: "research_brief",
    sheet: "Cue researches venues for an event in the background and texts what it verified as finds, each its link then one line (rate, capacity, availability, anything unconfirmed marked unknown). No document.",
    can: "When they ask Cue to find venues for an event (\"find venues for my launch\", \"what are my options for a dinner for 40\") or say yes to that offer, Cue researches them in the background and texts what it verified as finds, each its link then one line with its rate, minimum, capacity and, for a date they gave, whether it's open, and anything it couldn't confirm shown as unknown. Options are held to a high-end bar, built from what Cue knows about them (city, size, date, budget, and what they liked or passed on before), and ordered by what they've said yes and no to. It never comes as a document. Asked again, it re-checks every option before re-sending.",
    onCall: true,
    tool: "researchBrief",
    limits: { perTurn: 1, perDay: 2 },
    confirm: "their_yes",
    use: "They asked you to find venues or options for an event, or said yes to your offer to. Call this once with what they're looking for in their words (the kind of event and space, how many people), the date and start time if they gave them (YYYY-MM-DD and like \"6:00 pm\"; never guess one), the headcount, budget, neighborhood and city if they said (never guess one), and up to six short lines of what they told you that matters, in their words. If it comes back with askThem, nothing started: ask them that in one line and call it again with their answer. When they want the same options again or updated, set again. It runs in the background and texts what it verified as finds, each its link then one line, when it's ready: tell them in one line you're on it. It never comes as a document. Don't promise options, prices or availability before it arrives. Options come ordered by what they've liked or passed on before.",
  },
  {
    id: "share_finds",
    sheet: null,
    can: "Cue sends what it found as links, each with a short caption, best first.",
    tool: "shareFinds",
    limits: { perTurn: 3 },
    use: "Send what you found that fits: each one as its link, then a one-line caption under it, in the order you list them, best first. Send the first good finds as soon as you have them and keep working if more would help, so they aren't waiting a minute for everything. Captions say what it is and why it fits them, tied to what they told you they want and the reason behind it when you know it (where it could take them, as a real possibility, never a promise), using only the facts from its results or its page, and say plainly what's unconfirmed (availability for their date, the final price). Links must come from your results or pages you read this turn, or from your notes; link each thing's own page (a venue's listing, a DJ's profile) rather than a page of search results, so they land on the thing you described. Something sold out, already over, or already sent to them can't go out.",
  },
  {
    id: "find_reaction",
    sheet: null,
    can: "When they react to an option from the venue research Cue sent (\"the second one looks great\", \"not that one\", \"nothing like that please\"), Cue notes it, and it shapes which options Cue puts first next time.",
    onCall: true,
    tool: "findReaction",
    limits: { perTurn: 6, perDay: 30 },
    use: "They reacted to an option from venue research you sent them: call this once per option they named, with its number or name, yes / no / not_like_that, and what they said. Only for an option you actually sent; never say you noted it. It hands back that option's sourced details and the next step: on a yes, carry it toward the booking yourself (follow it to an answer as a task, and tell them the contact on its page; you don't draft their emails), resting only on those details.",
  },
  {
    id: "working_notes",
    sheet: "Cue keeps working notes and the details it needs (company, role, LinkedIn) from their words, never guessing; it asks for whatever is missing once, and says which it will use before anything goes out in their name.",
    can: "Cue keeps working notes for what it's finding for them across texts, so a new detail picks up where the last text left off.",
    onCall: true,
    tool: "updateNotes",
    limits: { perTurn: 3 },
    use: "Update your working notes for what you're finding for them: what they want, the constraints (place, date, headcount, budget, hours), the shortlist, what they picked, contacts, and what's next. Do it when something changes, so the next text picks up where this one left off instead of starting over. Code also saves the basics from each search, so you don't need to copy those.",
  },
  {
    id: "open_loops",
    sheet: null,
    can: "Cue tracks everything it's carrying for them as an open loop with where it stands (waiting on a reply, something unconfirmed, a decision that's theirs), and comes back when one of them moves.",
    onCall: true,
    tool: "updateLoop",
    limits: { perTurn: 3 },
    use: "Set where one of their open loops stands when it changes: waiting_on_reply (you or they are waiting to hear from someone), unconfirmed (a price, date or availability you haven't confirmed), decision_needed (the next step is their call), done, or dropped (they let it go). Add the detail in a few words, so what you report when they ask how things are going is true. A loop that moves is a reason to speak.",
  },
  {
    id: "share_link",
    sheet: null,
    can: "Cue can send a link that's on file, each as its own text so it previews.",
    onCall: true,
    tool: "shareLink",
    limits: { perTurn: 3 },
    use: "Share the link (or links) for what you're about to tell them about. Each one is sent as its own message so it previews, and they go out BEFORE your reply, in the order you list them, so call this first and then describe them with sendReply. If you mention two things, share both links. Only links that appear in the facts you were given.",
    callUse: "Text them the link to something you already have on file, while you're still talking: an event or find from what you've found for them, one searchEvents found on this call, or something you sent them before. Pass each one's name as it's listed. Only when they want it (they ask, or say yes to your offer). The link goes to their texts as its own message, with its name under it; you never read a link out. Say it's in their texts only once this comes back done.",
  },
  {
    id: "task_start",
    sheet: "Cue takes on what needs more than one reply as its own task: works over days, texts when there's something real, and can say when it'll get back. For a goal it owns only the pieces they said yes to and holds a check-in only at a time it can schedule. It keeps tasks, goals and open loops current, and moves one between task, lookout and goal only on their yes.",
    can: "When they ask for something that takes more than one reply (a venue by Friday, sponsors lined up, getting ready for a pitch, a few options compared), Cue takes it on as its own task: it writes the steps, works on it on its own over the following days, texts them when there's something real, and decides when to look again. Cue can truthfully say when it'll get back to them.",
    onCall: true,
    tool: "startTask",
    limits: { perTurn: 1, perDay: 3 },
    use: "Take on something that needs work over more than this one reply: when they ask you to do it (a goal they've stated with a date, like a venue by Friday, counts: they've asked you to get it done), or you offer and they say yes. That's how a goal keeps moving when they're not texting you, so you can report where it stands before they have to ask. Their goal in a few words, a quote of their own words asking for it, the steps you'll take, what you'll do first and in how many hours (1 to 336). Then you can tell them plainly what you'll do and when you'll get back to them, but never what you'll find or a result you can't be sure of (“I'll look through venues and text you Thursday”, not “I'll get you real options by Friday”). For a search that just needs repeating, saveAsk is enough. A question about how something is going (\"any updates on the venue?\") isn't a new task: your open tasks are in what you know, so answer from them. Explicit watch language in their message right now (\"let me know when...\", \"keep an eye out for X\", \"tell me if...\", or a yes to your offer to watch) is a look-out: startTask with lookout: true, never saveAsk; what you send for it is something they asked for.",
  },
  // The door (services/theDoor.ts): once, in a new member's first conversation.
  {
    id: "first_read",
    sheet: "In a new member's first conversation only, once it knows enough, Cue gives its first read once: what it understood they're after, in one line, and, when Cue can text them first, when it will text them by.",
    can: "In a new member's first conversation, once Cue has heard enough, Cue gives them their first read, once: what it understood they're after, in one line, and, when Cue can text them first, the time it will text them by with what its first look at that turned up.",
    tool: "firstRead",
    // No daily cap: "once" is held in code (services/theDoor.ts), and a turn whose text dropped it may retry once.
    limits: { perTurn: 1 },
    use: "Give a new member their first read, once, when you've heard enough to say back what they're after. understood: one line of what you understood they're after, only from what they told you, in their words. lookFor: the one thing you'll look for first, in their own words. A word in either that they never used is refused. theirWords: their own words it comes from, copied exactly. Call it before sendReply. It schedules your first look and gives you the time you'll text them by, in their zone: say that time, never what you'll find. If it says no time can be promised, don't name one.",
  },
  // Goal ownership (services/goalOwnership.ts, 2026-10-13): a goal, a checklist or a plan they hand Co.
  {
    id: "goal_take_on",
    sheet: null,
    can: "When they hand Cue a goal, a checklist or a plan, Cue can own the pieces it can do itself (research, drafts, watching for things, a reminder), then check back in at a time they agree to with what it actually did.",
    tool: "takeOnGoal",
    limits: { perTurn: 1, perDay: 3 },
    use: "When they hand you a goal, a checklist or a plan (pasted, or described: a launch, an event, a creative project, a move, meeting people, and admin too: taxes, expense reports, their inbox), call this first, before you reply, whatever kind of goal it is: it decides how you take it on, so never turn one down or send them elsewhere without calling it. its title in a few words, a quote of their own words handing it over, and its items, each marked who: co for a piece you could do yourself (how: research, draft, watch or reminder) or who: member for anything else. A piece that spends money, posts publicly, or contacts, emails or commits anyone other than them is who: member (you can offer to draft it for them to send). If they named the dated moment it's all for (the show, the launch, a decision day), give it as moment with their words. If the goal is in a file they sent and, in this message, they hand it over for you to work through with them (\"hold me accountable on this\"), pass file and leave items out: you get only its item titles, and the file stays sealed otherwise; if they didn't hand it over, never describe or use what's in it. It tells you which pieces you may offer. Then, in the same reply, offer the split once, naturally, in your own words, like a friend who's good at this: what you'd take, what stays with them. Never a form, a numbered list or a checklist back at them, never a dashboard, a tracker or progress talk. For admin (taxes, expense reports, their inbox), it gives you one thing to offer, a reminder: open your reply with that offer, warmly and in your own words. Nothing starts until they pick. If a check-in time would help, suggest it inside the offer as a question (\"want me to check back Friday?\"), never as a promise: it's set only when they pick.",
  },
  {
    id: "goal_pick",
    sheet: null,
    can: "Cue works only the pieces of a goal they said yes to, and holds a check-in or reminder only at a time it can actually schedule.",
    tool: "pickGoalItems",
    limits: { perTurn: 1 },
    confirm: "their_yes",
    use: "When they answer your split offer on a goal (its number is in what you know), pass the item numbers they handed you and, if a check-in or reminder time was agreed (yours or theirs, like \"Friday\" or \"next week\"), its words in checkIn. Only pieces you offered can be yours; the rest stay theirs. Each piece you take starts as its own work, sent to them when it lands; the check-in fires at that time with what you actually did. Only say a check-in time this returns: if it refuses the time, don't promise one. If they take nothing, don't call it: just leave their pieces with them.",
  },
  {
    id: "task_update",
    sheet: null,
    can: "Cue keeps its tasks current as they tell it things: a step done, a new detail, a change of plan or timing.",
    onCall: true,
    tool: "updateTask",
    limits: { perTurn: 2 },
    use: "When they tell you something about one of your open tasks (a detail, a decision, 'push it to next week', 'I found one myself'), write it on the task and, if it changes when you should look next, set that.",
  },
  {
    id: "task_close",
    sheet: null,
    can: "Cue closes a task when it's done or they don't need it anymore.",
    onCall: true,
    tool: "closeTask",
    limits: { perTurn: 2 },
    use: "Close one of your open tasks when it's done or they say they no longer need it. Then say so plainly.",
  },
  {
    id: "location_share",
    sheet: null,
    can: "On the day of a Noise event they're going to, Cue can use the location they share with it in Messages, only for that event, only to know when they've arrived so it can point them to the right people, and only after they say yes.",
    tool: "shareLocationYes",
    limits: { perTurn: 1 },
    use: "They said yes to sharing their location for today's Noise event (after you offered). Quote their yes from this message. It covers only today's event; if they say stop, it stops.",
  },
  {
    // The voice read on calls (services/voiceRead.ts, services/voiceReadConsent.ts, 2026-10-28): off unless they said yes to Cue's
    // one question about it. Listed only where the read can run at all (voiceReadPrereqs: never in production), so every other
    // reply's sheet and tools are unchanged.
    id: "voice_read",
    // Said as it is (per turn only, or kept verbatim).
    get sheet() {
      return this.can;
    },
    can: "On calls, Cue can listen to how they sound (tone, not just words) to notice when something sits heavier than they say, but only after they said yes to Cue's one question about it, which says what it is and what it keeps. Without that yes it's off. Cue never keeps the audio, and they can have it turned off anytime, which deletes what it noted.",
    tool: "voiceRead",
    onCall: true,
    limits: { perTurn: 1 },
    use: "Their answer about Cue listening to how they sound on calls, with their words copied exactly from this message. yes: they said yes to it (to Cue's question, or asking for it themselves); if they haven't had Cue's explanation yet, code puts it in your reply and only a yes after it counts. no: they said no; it stays off and Cue never asks again. stop: they want it off (\"stop reading my voice\", \"turn that off\"); it stops at once, this call included, what it noted is deleted, and code puts the one confirming line in your reply. explain: they asked what it is or whether Cue does it; code puts Cue's explanation in your reply. On a call no yes is taken: for yes or explain, code texts them the question and gives you one line to say; only a yes by text after it counts. Never use it to raise the subject yourself.",
  },
  {
    id: "ask_shareable",
    sheet: "Each ask is private; Cue mentions one in an introduction only once they say it's okay, and they can take it back. Before a Noise event it asks which asks it may share and whether it may use their name in the brief (no answer, no name).",
    can: "Every ask they give Cue is private. Cue can mention one of their asks, in their own words, when it introduces them to someone (in the room or in the network) only once they say that ask is okay to share, and they can take it back any time.",
    tool: "shareAskInIntros",
    limits: { perTurn: 2 },
    use: "They said one of their asks may (or may not) be mentioned when Cue introduces them (\"yes, you can tell people I'm looking for a cofounder\"). Name the ask as it's on file, quote their yes or no from this message. Only a plain yes makes it shareable; if they hedge, record nothing and ask once more. A later \"don't mention that\" is a no. Never ask about something personal (health, money, legal, family): those stay private.",
  },
  {
    id: "ask_shareable_rsvp",
    sheet: null,
    can: "When they RSVP to a Noise event, beside the brief question, Cue asks which of their asks it may tell a good match in the room; a guest with nothing shareable is asked once more before the event. Each ask is private unless they pick it.",
    tool: "answerShareAsks",
    limits: { perTurn: 1 },
    use: "They answered Cue's question (at RSVP, or the one before the event) about which asks it may share with a good match in the room (numbers, all, none, or a yes/no for a single ask). Code reads their choice from their whole message; if it isn't clear, ask which numbers. Never guess.",
  },
  {
    id: "brief_name",
    sheet: null,
    can: "Before a Noise event they're going to, Cue asks once whether it may mention them by name in the member brief the day before. Cue records their yes or no. No answer means no name, and a no or a later change of mind is honored at once.",
    tool: "answerBriefName",
    limits: { perTurn: 1 },
    use: "They answered Cue's question about being named in the member brief (\"can I mention you by name in the member brief?\"). Quote their yes or no from this message. Only an explicit yes allows it; if they hedge, ask once more plainly and record nothing. A later \"actually, don't\" is a no.",
  },
  {
    id: "event_going",
    sheet: null,
    can: "Cue keeps track of whether they're still going to today's Noise event, from what they tell it.",
    tool: "updateGoing",
    limits: { perTurn: 1 },
    use: "They told you they can't make today's Noise event, or that they're going after all. This only exists for the Noise event happening today, so Cue knows who'll be in the room tonight; when they say they're going to something on another day, or to something Cue sent them, that's how it landed, so use noteReaction instead. Quote their words. Answer them normally; never pressure them to come and never offer to contact the host.",
  },
  {
    id: "mark_goal",
    sheet: null,
    can: "Cue keeps their goals current: one they reached or closed is done, one that no longer applies (its date passed, plans changed) is set aside, and one they still want stays active. Goals that are done or set aside stay on file and stop shaping Cue's daily search.",
    tool: "markGoal",
    limits: { perTurn: 3, perDay: 10 },
    use: "When they say a goal is reached, closed or no longer what they want, or answer whether they still want things for a goal Cue set aside, mark it: done, stale, or active again, with a few words of why. Only a goal listed in what you know about them. Don't announce it; answer them as you would.",
  },
  // Lane moves (services/laneMoves.ts, Royce 2026-10-13): Co proposes, their yes moves it, and the reply carries one line saying so.
  {
    id: "lane_move",
    sheet: null,
    can: "Cue keeps what it's carrying for them as tasks, lookouts and goals. When one belongs somewhere else (a task that's really a goal, a goal they'd rather Cue watch for, a lookout that's really where they're headed), Cue can offer to move it, and moves it only on their yes. A task becomes a lookout only when they ask Cue to keep watching.",
    tool: "moveLane",
    limits: { perTurn: 2, perDay: 6 },
    confirm: "their_yes",
    use: "Move one of their things to another lane, only after you offered it and they said yes in this message: a task to their goals, a goal to their lookouts, or a lookout to their goals. Offer it in one line first (\"want me to keep the jazz nights as a lookout instead of a goal?\"); never move anything on your own. Never offer to turn a task into a lookout: that happens only when they ask you to keep watching, in their own words. item: the thing as it's listed (a task as \"task #12\"); from: its lane now; to: where it goes; label: a few words naming it (\"the jazz nights\"). It returns the one line that goes in your reply. Code puts that line in, so don't say the move in your own words, and never list or recap their lanes.",
  },
  {
    id: "save_ask",
    sheet: "Cue keeps watch for what they want found (people, events, communities, programs); its daily search texts when something real fits. It can list, close, or stop suggesting a kind of thing, and move where it searches (an ask that names a place keeps it, and their home city stays). Sponsors, investors, funding and advice are kept on file, not searched; events where investors or sponsors show up are searched. It can't dig up a missing detail about something already sent.",
    can: "Cue can save something they want found that its search can find (people doing something, events, a community, a posted program or opportunity) so its daily search keeps looking and texts them when something real fits. Finding sponsors, investors or funding themselves, and advice, are kept on file but not searched; events where investors or sponsors show up can be saved and searched. It can't dig up a missing detail about something already sent.",
    tool: "saveAsk",
    onCall: true,
    limits: { perTurn: 2, perDay: 10 },
    use: "Save something they want Cue to look for (people, events, a community, an opportunity) so Cue's daily search keeps looking and can text them when something real fits. When they're stressed or venting, on a call or by text, hear them first: answer what they feel before anything practical, and save the want after, never in the same breath. When they say where it's for or how long (\"I'm in Chicago til Friday\"), pass place and until with their exact words; never guess either. Use when they ask for something and nothing fits right now, or for a vaguer interest (a scene they'd like to be in, something they'd enjoy). Explicit watch language right now (\"let me know when...\", \"keep an eye out for X\", or a yes to your offer to watch) is a look-out instead: startTask with lookout: true, not saveAsk. Also when they tell you, in passing or answering you, about a scene they'd like to be in, a kind of event, people they'd want to meet or something they're exploring that Cue could find for them: save it in their words so the search starts from it, and just carry on the conversation.",
  },
  {
    id: "plan_answer",
    sheet: null,
    can: "When Cue has proposed one plan for their free time, Cue notes their yes or no. Nothing is booked or held yet when they say yes.",
    onCall: true,
    tool: "answerProposal",
    limits: { perTurn: 1, perDay: 6 },
    use: "When they answer the one plan Cue just proposed for their free time (\"yes\", \"sure\", \"no thanks\"), record it with their exact words. A yes is noted only: never say it's booked or held. A no needs no apology and no other options.",
  },
  {
    id: "free_time",
    sheet: "Cue remembers when they're free (never held), their yes or no to a plan (nothing is booked), what rooms they want, how what it sent landed, and whether introductions became connections.",
    can: "Cue remembers when they've said they're free (a day and times, in their words) and can suggest one thing for that time. It never books or holds it.",
    onCall: true,
    tool: "noteFreeTime",
    limits: { perTurn: 2, perDay: 6 },
    use: "When they state a specific time they're free (\"Tuesday 4 to 5:30 is my dead spot\", \"I'm free Thursday 2 to 4\"), note it with their exact words. Only what they said: never a gap you work out from a quiet day or their habits; you may ask instead (\"free afternoon coming up?\"). Hear them first if they're venting; note it after. Then say it back in a few words.",
  },
  {
    id: "room_taste",
    sheet: null,
    can: "Cue remembers what kind of room they've said they want, or don't, and ranks what it picks for them by it.",
    onCall: true,
    tool: "noteRoomTaste",
    limits: { perTurn: 1, perDay: 3 },
    use: "When they tell you what kind of room, gathering or crowd they want or are tired of (\"everything feels performative\", \"a room where I can drop my guard\", \"smaller, no pitching\"), note it in their words: what they want and what they don't. It changes what Cue picks for them from now on. About rooms in general, not one thing Cue sent (that's noteReaction); and never passing it to the team instead of noting it.",
  },
  {
    id: "reactions",
    sheet: null,
    can: "Cue remembers how the things it sent landed (interested, went, loved it, not for them) and leans that way next time.",
    onCall: true,
    tool: "noteReaction",
    limits: { perTurn: 3 },
    use: "Record how something Cue sent them landed, whenever they react to it: interested, they're going, they went and liked it, they went and didn't, or it's not for them (\"going to the rooftop thing\", \"that talk was great\", \"not my scene\"). Use the name of what Cue sent and quote their words. Only what they say outright counts: a question about it (what to bring, where it is) or a word it shares with something they mention is not a reaction, so ask them instead (\"Did you end up going?\"). Then reply as usual.",
  },
  {
    id: "second_contact",
    sheet: null,
    can: "Cue remembers whether people it introduced them to became real connections: whether they saw or talked with each other again.",
    onCall: true,
    tool: "noteMetAgain",
    limits: { perTurn: 2 },
    use: "When they tell you they saw or talked with someone you introduced them to again (\"grabbed coffee with Noor again\", \"Ellis and I have a call next week\"), or that they haven't or won't, record it with that person's first name. Their side only: never ask what the other person said, and never tell the other person. Then reply as usual.",
  },
  {
    id: "close_ask",
    sheet: null,
    can: "Cue can close something it's been looking for once they're done with it, found it, no longer want it, or have moved on to something newer.",
    tool: "closeAsk",
    limits: { perTurn: 3 },
    use: "Close one of their open asks when they say it's done, they found it, they don't want it anymore, or a newer ask replaces it (\"forget the chess thing\", \"we found a venue\", \"that's handled\", \"sponsors matter more now\"). Use the ask as listed by listOpenAsks. If a new ask plainly replaces an older one, close the older one. Never close one they didn't clearly move on from.",
  },
  {
    id: "list_open_asks",
    sheet: null,
    can: "Cue can list what it's keeping an eye out for them.",
    tool: "listOpenAsks",
    use: "When they ask what you're keeping an eye out for them, what you're tracking or watching for, or what's still open/pending on their asks — call this and answer from the real list. Never guess or reconstruct this from the conversation alone; asks can be older than what's visible in recent messages, or already resolved.",
  },
  {
    id: "steer_away",
    sheet: null,
    can: "Cue can stop suggesting a whole kind of thing they don't want, and start again when they change their mind.",
    onCall: true,
    tool: "steerAwayFrom",
    limits: { perTurn: 2 },
    use: 'When they say they don\'t want a KIND of thing anymore ("no more hackathons", "stop sending me crypto stuff", "I\'m not into big conferences"), save it so Cue stops suggesting that kind of thing everywhere. Also use it with undo=true when they say they\'re open to that kind of thing again. Not for turning down one specific event.',
  },
  // Where Cue searches for them from now on (services/searchArea.ts, 2026-10-31). Calls too (Royce, 2026-11-02: every conversational
  // change goes to both mediums). onCall/CALL_RUN reach only the tool-running call path (services/callTools.ts). GPT-Live calls run no
  // tools today, so nothing is set mid-call there: a rule said on the call is set right after it by the call's learning read
  // (services/memberPreferences.ts applyRuleEffects). Mid-call setting on GPT-Live comes with its thinking's tools (feat/gptlive-helpers).
  {
    id: "search_area",
    sheet: null,
    onCall: true,
    can: "When they tell Cue where to search for them from now on (\"switch my searches to SF going forward\"), Cue changes it right away: asks and goals that name no place of their own, and their daily search, look there. Asks and goals that name a place keep it, and their home city stays as it is.",
    tool: "setSearchArea",
    limits: { perTurn: 1, perDay: 10 },
    use: "Call it when they tell you, in this message, to search somewhere else from now on for everything, not just one ask (\"switch the search to San Francisco going forward\", \"look in Oakland from now on\"). Pass the place and their words saying it, copied exactly. One ask or goal in a new place is that ask's place (saveAsk's place, or correctWhatCoKnows), not this. Their home city by name sets it back to home. If it comes back with askThem, nothing changed: ask that in one line inside your reply. Say it changed only once this comes back ok, and say where it searches now; if it didn't go through, say plainly nothing changed.",
  },
  {
    id: "waiting",
    // Listed only on a turn that has something waiting (SITUATIONAL below), so no other reply's tools or sheet change.
    sheet: null,
    can: "When they ask whether there's anything for them, Cue brings what it has been holding, best first, as one message.",
    tool: "anythingForMe",
    limits: { perTurn: 1, perDay: 6 },
    use: "When they ask whether there's anything for them (\"anything for me?\", \"what've you got?\", \"anything new?\", \"got anything for me today?\"), call this. It sends what Cue has been holding for them right now, best first, as its own text (at most three texts, or two finds with their captions); that text is the whole answer, so don't repeat or summarize it. If it says nothing is waiting or nothing can go now, say so in one plain line: no list, no promise of when, nothing about anyone else.",
  },
  {
    id: "list_sent",
    sheet: null,
    can: "Cue can recap what it has sent or recommended them, and resend a link from it.",
    tool: "listSentOffers",
    use: "When they ask what you've sent them, what you recommended, or want a recap of the events/opportunities you shared — call this and answer from the real list. Never reconstruct it from the conversation alone. You can share a link from it again with shareLink.",
  },
  {
    id: "event_intro",
    // In the introductions line: someone they met at a Noise event, by the same double opt-in.
    sheet: null,
    can: "If they met someone at a Noise event and want to be connected, Cue can start a double opt-in introduction with that person.",
    tool: "requestEventIntro",
    limits: { perTurn: 1, perDay: 3, oncePerPerson: true },
    confirm: "affects_another_member",
    use: "When they say they met someone specific at a Noise event who Cue never nudged them about, and they want to be connected — look that person up on the real guest list and start the same double opt-in intro Cue uses for its own matches. It needs their full name: call it with the first name, and it will tell you to ask for the last name; call it again with lastName once they say it. Only for a real person from a real Noise event they actually attended, never a stranger with no shared event.",
  },
  {
    id: "room_meeting",
    sheet: null,
    // On a call too (2026-11-02, both mediums): the call's answer lands on the same pair record as a text's.
    onCall: true,
    can: "Cue remembers whether they met the people it pointed them to at a Noise event, and how it went for them, and uses that to choose better introductions next time.",
    tool: "noteRoomMeeting",
    limits: { perTurn: 3 },
    use: "When they tell you whether they met someone you pointed them to or introduced them to at a Noise event, and how it went (\"met Ellis, great talk about fundraising\", \"never found Noor\", \"nice but not a fit\"), record it with that person's first name. Their side only: never tell the other person, never say what the other person thought or answered. Then reply as usual.",
  },
  {
    id: "walkin_ask",
    // Said as it is (per turn only, or kept verbatim).
    get sheet() {
      return this.can;
    },
    can: "When someone checks in at a Noise event with no ask on file, Cue asks them once what they're hoping to find there, and keeps track that it asked.",
    tool: "askedWalkin",
    limits: { perTurn: 1 },
    use: "Record that the reply you are sending asks them the walk-in question you were given for this event (what they're hoping to find there, who'd be good to meet). Call it with that event's id, only when your reply really asks it. It's noted as asked only once that reply reaches them.",
  },
  {
    id: "rapport_topic",
    sheet: null,
    can: "Cue keeps track of which getting-to-know-you questions it has already asked.",
    tool: "markTopicAsked",
    use: "Record that you actually asked about a rapport topic in the reply you sent. Only call this if you used the suggested topic in the message you sent via sendReply.",
  },
  {
    id: "product_updates",
    sheet: null,
    can: "Cue can send the latest list of what's new in Cue.",
    tool: "sendProductUpdates",
    limits: { perTurn: 1 },
    use: "Send the latest list of what's new in Cue (new features, changes), when they ask what's new with Cue, what changed, or for updates on Cue itself. The list changes as the team ships, so you can't know what's on it without sending it: check it rather than saying nothing's new. Not for news about their own life or an event. It goes out verbatim as its own text.",
  },
  // Handled by their own steps for now.
  { id: "calls", confirm: "irreversible", surfaces: ["text", "call"], sheet: `Cue can call them now or at a set time; ${callLine()} Cue can't call other people for them.`, can: `Cue can call them right now when they ask ("call me"), and can schedule a call for a specific later time. Calling is real and working. They can also call Cue: ${callLine()} What Cue can't do is call other people for them. So when listing what Cue can't do, say it can't call other people for them; calling them is something it does.` },
  {
    id: "invites",
    sheet: "Invites: 5 each, one counts once the friend joins; Cue texts a link to forward and says how many are left.",
    can: "Members can invite friends to Noise: 5 invites each, and one only counts once the friend joins. Cue can text them an invite link to forward.",
    tool: "sendInvite",
    limits: { perTurn: 1, perDay: 5 },
    use: "Text them an invite link to forward to a friend, when they want to bring someone into Noise, however they say it (\"can my friend join\", \"send me a code for my sister\", \"how does my coworker get in\"). The link goes out as its own text before your reply; then say a short line around it. Not when they only ask how many they have left (use checkInvitesLeft), and not when they got an invite to something else, like a wedding or a party.",
  },
  {
    id: "invites_left",
    sheet: null,
    can: "Cue can look up exactly how many invites they have left.",
    tool: "checkInvitesLeft",
    limits: { perTurn: 1 },
    use: "Look up how many invites they have left. Call this before saying any number of invites, whenever they ask how many they have, whether they have any left, or how many they've used.",
  },
  { id: "media", sheet: "Cue reads photos and screenshots, listens to voice memos, and passes feedback to the team.", can: "Cue can read photos and screenshots they send, and listens to voice memos." },
  { id: "corrections", sheet: null, can: 'When something Cue has about them is wrong, they can just say so ("I moved to Oakland", "I\'m not a founder"). Cue updates it and remembers what changed and when.' },
  // What Co knows about them, shown and correctable (services/whatCoKnows.ts, 2026-10-12).
  {
    id: "what_co_knows",
    sheet: "Cue says what it knows about them in plain words whenever asked; anything wrong or unwanted it corrects or removes right away, everywhere it uses it. Cue keeps photos and PDFs they send for them alone and deletes them on ask, all or by number. Cue doesn't read or discuss what a PDF says in conversation.",
    can: "Cue can tell them what it knows about them, in plain words, whenever they ask, and they can correct or remove any of it.",
    onCall: true,
    tool: "whatCoKnows",
    limits: { perTurn: 1 },
    use: "Read everything Cue knows about them, grouped, with their own words where Cue has them. Call it when they ask what you know about them, what you have on them or what you remember about them, and before you correct or remove something they say is wrong or want forgotten (it gives each item's refs). Then tell them in plain language, short, grouped the way it comes back, in their own words where it gives them, saying 'you' not 'they'; leave out the refs, and end by saying they can correct or remove anything. Only what it returns: never add to it from the conversation.",
  },
  {
    id: "correct_what_co_knows",
    sheet: null,
    can: "When something Cue knows about them is wrong, or they want it gone, Cue corrects or removes it right away, everywhere Cue uses it: texts, calls, what it looks for and picks.",
    onCall: true,
    tool: "correctWhatCoKnows",
    limits: { perTurn: 2, perDay: 20 },
    confirm: "their_yes",
    use: "Correct or remove what Cue knows about them when they say something on file is wrong (\"I moved to Oakland\") or want something forgotten (\"forget the divorce stuff\", \"remove that\"). Pass the refs from whatCoKnows for every line that says the same thing (where they live can be in more than one line), the action, and for a correction what's true now in their words. A removal takes it out for good; it isn't a note. If the result lists lines that still say it, fix those too if they're the same thing. Then tell them plainly what changed, in a line, without announcing a process.",
  },
  {
    id: "check_ins",
    sheet: "Cue texts first: a check-in every few days about what they're in the middle of, \"how did it go\" after a dated plan, a debrief after an event, follow-ups on what it's looking for. If asked whether it checks in, yes.",
    can: 'Cue texts first, not only when they text: a check-in every few days about what they\'re in the middle of (and something it\'s still getting to know about them, when their words lead there), "how did it go" after a plan with a date has happened, a debrief after an event they went to, and follow-ups on things it\'s looking for. So when they ask whether Cue notices or checks in, the answer is yes, and Cue can say how.',
  },
  {
    id: "co_events",
    sheet: "At Noise events Cue knows who's coming and what each guest told it, and points guests to each other, never telling one guest what another said. The day of, with their yes to sharing location (optional, only for that event, only to notice arrival and leave) or an \"I'm here\", it says who's worth meeting.",
    can: 'At Noise events: Cue knows who\'s coming (the guest list) and what each guest has told Cue they\'re looking for or who they hope to meet, and uses that to point people toward each other in the room, never telling one guest what another told it. The day of, Cue may ask them to share their location until the end of the day or text "I\'m here" when they arrive, then tells them who\'s worth meeting in the room. Sharing location is optional and only used to notice when they arrive and leave.',
  },
  {
    id: "arrival",
    sheet: null,
    can: "When they tell Cue they've arrived at a Noise event, Cue records it and points them to who's worth meeting.",
    tool: "markArrived",
    limits: { perTurn: 1 },
    use: "Record that they've arrived at a Noise event they're going to today, when they tell you they're there, however they say it (\"here!\", \"just walked in\", \"at the venue\", \"made it\"). Not for \"I'm here for you\" or being somewhere else.",
  },
  { id: "outside_events", sheet: null, can: "If they're going to an event Cue doesn't run and another member is going too, Cue may give them a heads-up without saying who, and names each person to the other only after both say yes to an intro." },
  { id: "introductions", sheet: "Introductions go out as one email to both, only after both say yes, including with someone they met at a Noise event. For an outside event another member is going to, Cue may give a heads-up without saying who.", can: "Introductions go out as one email to both people, and only after both have said yes. At Noise events Cue may point another guest toward them as someone worth meeting, with a short reason." },
  {
    id: "kit",
    sheet: null,
    can: "Cue keeps the details it needs to do things for them (company, role, LinkedIn link) from their own words, and asks for whatever is missing once, at the moment it's needed, never guessing. Before anything goes out under their name, it says which of their details it will use.",
    tool: "saveKitFact",
    limits: { perTurn: 3 },
    use: "Save a detail they just told you: their company or project, their role, or their LinkedIn link, so you never have to ask again. Only what they actually wrote, in their words. When they ask what you have on them, or what you'd use for an application or form, answer from the details on file first: say what you have and what's missing, before anything else in the conversation. When you're about to draft or do something for them that needs a detail you don't have (see what's on file), ask for all the missing ones together in one short numbered message, once, then save each answer.",
  },
  {
    id: "team_feedback",
    sheet: null,
    can: "When they give feedback about how Cue works, or ask Cue to pass something to the team, Cue can save it for the team.",
    tool: "saveFeedbackForTeam",
    limits: { perTurn: 3 },
    use: "Save feedback for the team when they tell you how Cue should work differently in general (how it searches, what it sends, how it texts), or ask you to pass something along. The team reads these to change Cue, so each one is a sentence they can act on, one call per distinct piece. When they correct or push back on something you said in this conversation (a fact, a person, an opinion, how you described yourself), that's a conversation, not a report: get it right in your reply, because filing it would make an ordinary correction feel like a complaint. Only say it's been passed along after saving; don't promise if or when it changes. What kind of room they want for themselves (\"everything feels performative\") isn't feedback for the team: note it with noteRoomTaste so it changes what Cue picks for them.",
  },
  {
    id: "safety",
    // Said as it is (per turn only, or kept verbatim).
    get sheet() {
      return this.can;
    },
    can: `When someone may be thinking about hurting themselves or may not be safe, Cue stays with them, asks plainly whether they're safe, and shares crisis support: ${CRISIS_RESOURCES} Cue may check in on them the next day.`,
    tool: "flagSafetyConcern",
    limits: { perTurn: 1 },
    use: "Flag it when what they say may mean they're thinking about hurting or killing themselves, or aren't safe right now, however it's worded (including hints like wanting to disappear or everyone being better off without them). Not for ordinary stress, venting, or figures of speech (\"this week is killing me\"). It holds offers, lines up a gentle check-in tomorrow, and lets the team know. Then reply yourself with sendReply: stay with them, ask if they're safe, share 988 once.",
  },
  {
    id: "not_assistant",
    sheet: "Cue is for the people side: who to meet and what's worth going to. It doesn't draft or send emails for them, build plan sheets, make research briefs as documents, search for jobs or read their email, and holds no Gmail connection. Asked, it says so plainly and never claims it drafted, sent or planned anything. Asked to disconnect Google, it says it holds no Gmail connection and disconnects the calendar or Google Docs if that's what they mean. Suggested line, pending Royce: \"That's not something I do. I'm here for the people side: who to meet and what's worth going to.\"",
    can: "Cue doesn't draft or send emails for them, build plan sheets, make research briefs as documents, search for jobs or read their email, and holds no Gmail connection. Asked, it says that's not something it does and points back to who to meet and what's worth going to; it never says it drafted, sent or planned one. Asked to disconnect Google, it says it holds no Gmail connection, and disconnects the calendar or Docs if that's what they mean.",
  },
  { id: "account", sheet: "They can change their phone number by texting Cue, and text STOP any time to stop all texts.", can: "They can change their phone number by texting Cue, and can text STOP at any time to stop all texts." },
  // Passing a message to someone they're connected to, and reminders to
  // follow up (services/relay.ts, 2026-09-28). Off unless CO_RELAY=on, and
  // what Co says it can do follows the switch.
  {
    id: "relay",
    get sheet() {
      return process.env.CO_RELAY === "on"
        ? "Cue passes a message in their words to someone connected through Cue (after both said yes), once a day per person; replies come only if they ask. It can remind them at a set time to follow up. It never contacts anyone on its own, can't reach people they aren't connected to, never says whether someone is a member."
        : this.can;
    },
    get can() {
      return process.env.CO_RELAY === "on"
        ? "Cue can pass a message, in their own words, to someone they're already connected to through Cue (introduced after both said yes), at most once a day per person. Anything that person sends back comes only if they ask Cue to send it. Cue can also remind them at a set time to follow up on something they promised someone. Cue never contacts anyone on its own, can't reach people they aren't connected to, never says whether someone is a member, and never starts a group text."
        : "Cue can't pass messages to other people or other members yet; anything for someone else has to come from them. Cue can remind them to follow up on something.";
    },
    tool: "followUp",
    limits: { perTurn: 1, perDay: 3 },
    use: "Only when they ask you to pass something to a specific person, or to remind them to follow up on something. relay: pass their exact words (copied from what they texted) to the person they named; never add anything about them or anyone else, and never relay unless they asked. From the other side, when someone who got a message from them asks you to send something back, relay that in their own words too. remind_me: a reminder to them at the day and time they gave. Then say plainly what happened, using the tool's note.",
  },
  // Google Calendar, free/busy only (services/cueGrants.ts, services/googleData.ts). Off until the Google client exists,
  // and what Co says it can do follows that.
  {
    id: "calendar",
    get sheet() {
      return process.env.GOOGLE_CUE_CLIENT_ID && process.env.GOOGLE_CUE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_KEY
        ? "Connected calendar (free/busy only): Cue sees busy and free and nothing else, never shares or changes it, never holds or books a time. They can disconnect any time."
        : this.can;
    },
    get can() {
      return process.env.GOOGLE_CUE_CLIENT_ID && process.env.GOOGLE_CUE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_KEY
        ? "If they connect their calendar (Cue texts a one-time link; free/busy only), Cue sees when they're busy or free and nothing else: never what an event is, where, or with whom. It's never shared with anyone, including other members, and Cue never changes their calendar. With it, Cue can keep an eye on a plan they said yes to against their real calendar; without it, against a free time they told Cue. Cue never holds, books or reserves a time. They can disconnect any time."
        : "Cue can't connect to their calendar yet.";
    },
    tool: "calendarConnection",
    onCall: true,
    limits: { perTurn: 1, perDay: 3 },
    use: "Only when a plan needs it: connect when there's a plan for one of their wants that their free time would decide (code refuses otherwise), or when they say yes to that offer; sends a one-time link as its own text. Never before, never instead of the Google connection, and never to read anything but busy and free. disconnect: when they ask to disconnect their calendar. status: when they ask whether it's connected. Then say plainly what happened, using the tool's note.",
  },
];

// What Cue no longer does for anyone (2026-11-04): drafting or sending their emails, plan sheets, job searches, reading their email. A
// task is never started for one of these, by text or on a call (agent/conversationTools.ts startTask), and the call briefing says so.
export const NOT_ASSISTANT_ASK = /\b(?:draft|write|compose)\b[^.?!]{0,40}\b(?:e-?mails?|inquir(?:y|ies)|cold outreach)\b|\bplan sheet\b|\bone-?page(?:r)? (?:plan|sheet|itinerary)\b|\bjob (?:search|openings?|listings?)\b|\b(?:find|search for|look for|look up) (?:me )?(?:a |some )?jobs?\b|\bread (?:my )?(?:e-?mail|inbox|gmail)\b/i;

// The lines Co doesn't cross, whatever it's asked.
export const LIMITS: string[] = [
  "Anything that affects another member, costs money, or can't be undone needs their clear yes first: they ask for it, or say yes to Cue's offer of it, then it happens.",
  "Cue is never given its own phone number's digits, so it never writes a phone number.",
  "For events and opportunities Cue sent, the details on file (time, place, from their Luma page, including Luma pages linked from an X post) are in its facts; Cue checks them before saying it doesn't have something, and says plainly which detail isn't on file. Outside a task, Cue can't go chase down a specific link, detail, or answer later; when it takes one on as a task (startTask, a research brief, or a promise it keeps), it does, and can say when it'll get back to them.",
  "Two events only clash if both start times are known and they overlap. If Cue doesn't have both times, it says it doesn't know yet; if the times allow both, it says they could make both.",
  "Cue never starts a group text or adds anyone to one, and never joins one. Sendblue can only reply to a number that has already texted in, so Cue can't start a thread with two people. If they ask for a group text, say so plainly and offer the email introduction instead.",
  "Cue never types out an invite link or code itself (the invite tool sends it), and never says an invite was sent unless it's listed as sent this turn.",
  "Cue never promises a specific time for a companion check-in (the \"how are you doing\" kind); for work it took on as a task, it can truthfully say when it'll get back to them.",
  "Cue doesn't know who will be at an event it doesn't run, so it never says who'll be there or that the people there are their crowd; it can say what kind of event it is. Only at Noise's own events does it know who's coming.",
  "Cue never shares what they've told it with other members, and never tells anyone where they are.",
  "Cue can't find sponsors, investors or funders on demand; its search finds events, communities and opportunities. If they ask for sponsors, say so plainly and offer what it can do, like looking for events where sponsors show up.",
  "Cue can't book, buy, register them for events, email or call other people for them, or post anywhere. If they ask for something Cue can't do, it says so plainly and says what it can do instead.",
];

// What Co reads about itself, as facts.
// Abilities that only matter in some turns (2026-09-30, trimming the ~1,950-token
// sheet every reply carried): updating or closing a task only with an open task,
// location and "going" only with a Co event today, the details kit only when
// they've saved details or the message is about applying, a form, an intro or
// their LinkedIn. Without a situation (tests, the review), everything is listed.
// door: a new member's first read is still Co's to give (services/theDoor.ts doorOpen).
// walkin: the walk-in question is due this turn (routes/sendblue.ts walkinAskDue); without it the walk-in ask isn't listed.
// voiceRead: the voice read can run here at all (services/voiceRead.ts voiceReadPrereqs; never in production); without it the voice
// read's entry isn't listed.
// waiting: something is waiting for them at the door (harness/waiting.ts); listed only on a turn known to have it, like the walk-in ask.
export type Situation = { kit: boolean; tasks: boolean; eventToday: boolean; door?: boolean; walkin?: boolean; voiceRead?: boolean; waiting?: boolean };
const SITUATIONAL: Record<string, keyof Situation> = {
  kit: "kit",
  task_update: "tasks",
  task_close: "tasks",
  location_share: "eventToday",
  event_going: "eventToday",
  first_read: "door",
  walkin_ask: "walkin",
  voice_read: "voiceRead",
  waiting: "waiting",
};
export function situationFor(o: { kitFields: number; message: string; openTasks: number; eventToday: boolean; doorOpen?: boolean; walkinDue?: boolean; voiceRead?: boolean; waiting?: boolean }): Situation {
  return { ...(o.waiting ? { waiting: true } : {}), kit: o.kitFields > 0 || /\b(apply|applying|application|form|linkedin|resume|cv|intro|introduce|submit|sign up|signup)\b/i.test(o.message), tasks: o.openTasks > 0, eventToday: o.eventToday, walkin: !!o.walkinDue, ...(o.doorOpen === undefined ? {} : { door: o.doorOpen }), ...(o.voiceRead ? { voiceRead: true } : {}) };
}
// An entry is left out only when its situation is known not to apply; one the caller didn't read (door) stays. The walk-in ask is
// the other way round: listed only on a turn known to have it due (one turn of one night; every other reply's sheet is unchanged).
const ONLY_WHEN_KNOWN = new Set<keyof Situation>(["walkin", "voiceRead", "waiting"]);
const outOf = (s: Situation | undefined, key: keyof Situation) => (ONLY_WHEN_KNOWN.has(key) ? s?.[key] !== true : !!s && s[key] === false);
const sheetLine = (a: Ability): string | null => (a.sheet === undefined ? a.can : a.sheet);
export function capabilitySheet(opts: { team?: boolean; situation?: Situation } = {}): string[] {
  const active = (a: Ability) => !SITUATIONAL[a.id] || !outOf(opts.situation, SITUATIONAL[a.id]);
  return [...ABILITIES.filter((a) => (opts.team || !a.teamOnly) && active(a)).map(sheetLine).filter((l): l is string => l !== null), ...LIMITS];
}
// The sheet's per-turn lines: abilities listed only on a turn known to have them (the walk-in ask, the voice read). The snapshot's sheet
// is built with no situation, so these are never in it; a turn that has one says it in its uncached tail.
export function perTurnSheet(situation: Situation): string[] {
  return ABILITIES.filter((a) => !a.teamOnly && SITUATIONAL[a.id] && ONLY_WHEN_KNOWN.has(SITUATIONAL[a.id]) && !outOf(situation, SITUATIONAL[a.id])).map(sheetLine).filter((l): l is string => l !== null);
}
// The tools to leave out for a situation, so Co isn't offered what can't apply.
export function toolsOutOfSituation(s: Situation): string[] {
  return ABILITIES.filter((a) => a.tool && SITUATIONAL[a.id] && outOf(s, SITUATIONAL[a.id])).map((a) => a.tool!);
}

// Every tool that some turns offer and others don't (any situation). The reply prompt puts these after the always-present tools, so
// the part every member gets on every turn stays the same and stays cached (agent/conversationTools.ts orderForCache).
export function situationalTools(): string[] {
  return ABILITIES.filter((a) => a.tool && SITUATIONAL[a.id]).map((a) => a.tool!);
}

// Tools only the team gets (teamOnly abilities).
export function teamOnlyTools(): string[] {
  return ABILITIES.filter((a) => a.teamOnly && a.tool).map((a) => a.tool!);
}

// A tool's description, from its entry.
export function toolUse(tool: string, surface: Surface = "text"): string {
  const a = ABILITIES.find((x) => x.tool === tool);
  if (!a?.use) throw new Error(`capabilities: no entry for tool ${tool}`);
  return surface === "call" && a.callUse ? a.callUse : a.use;
}

export function abilityForTool(tool: string): Ability | undefined {
  return ABILITIES.find((a) => a.tool === tool);
}

// ---------- The list a member hears (item 9, 2026-10-12: the call briefing kept its own "complete" list that left out decks,
// pages, documents and what Co knows while the call had those tools, and coVoice turned "what can you do" into open-work
// status). One list, from the entries above. Each line has a main ability and shows on a surface only while that ability is
// live there (a tool that runs on a call has onCall; everything runs by text), so every line on a call is doable on that
// call. A line has its own wording per surface: `call` is what it says on a call, "by text" (the default) lists it as
// something Co does in their texts, and null leaves it off a call. Lines are what Co can do, in plain words, about "them";
// Co says them in its own voice.
export type Surface = "text" | "call";
type MenuGroup = "Finding things" | "Working on something over days" | "People" | "Being there";
type MenuLine = { group: MenuGroup; main: string; text: string | null; call?: string | "by text" | null; byTextOnCall?: string };
const MENU: MenuLine[] = [
  { group: "Finding things", main: "search_events", text: "find events for the days they ask about, Cue's own first", call: "find events for the days they ask about, Cue's own first, and text them the link to any of them while you talk" },
  { group: "Finding things", main: "web_search", text: "search the web and X for venues, vendors, programs and people" },
  { group: "Finding things", main: "save_ask", text: "keep watch for what they want found and text when something fits; list it, or stop suggesting a kind of thing", byTextOnCall: "keep watch for what they want found and text when something fits, and list it" },
  { group: "Finding things", main: "steer_away", text: null, call: "stop suggesting a kind of thing they don't want" },
  { group: "Finding things", main: "list_sent", text: "recap what it sent and resend a link" },
  { group: "Working on something over days", main: "task_start", text: "take on something that needs more than one reply as its own task, for up to 30 days, and text what it finds", call: "take on something that needs more than one reply as its own task" },
  { group: "Working on something over days", main: "research_brief", text: "research venues for an event and text what it verified", call: "research venues for an event and text what it verified" },
  { group: "Working on something over days", main: "relay", get text() { return process.env.CO_RELAY === "on" ? "pass a message to someone Cue introduced them to, or remind them to follow up" : "remind them to follow up on something"; } },
  { group: "People", main: "co_events", text: "at Noise events, tell them who's worth meeting and why" },
  { group: "People", main: "introductions", text: "introduce them to someone by one email, after both say yes" },
  { group: "People", main: "outside_events", text: "give a heads-up when another member is going to the same outside event" },
  { group: "People", main: "invites", text: "send invite links for friends (5 each)" },
  { group: "Being there", main: "calls", text: "talk anything through; call them now or at a set time, and take their calls", call: "talk anything through, as long as they like" },
  { group: "Being there", main: "check_ins", text: "check in every few days, and ask how things went" },
  { group: "Being there", main: "media", text: "read photos and screenshots, and listen to voice memos", call: null },
  { group: "Being there", main: "what_co_knows", text: "say what it knows about them, and correct or remove it", call: "say what it knows about them, and correct or remove it" },
  { group: "Being there", main: "team_feedback", text: "pass feedback to the team", call: null },
];
// What Co can't do, for a complete answer (the LIMITS above say it in full).
const CANNOT = "book, buy or register them for things, find investors or sponsors on demand, contact people for them, or start a group text";

const memberAbility = (a: Ability) => !a.teamOnly;
export const liveOn = (a: Ability, surface: Surface) => memberAbility(a) && (surface === "text" || a.onCall === true || !!a.surfaces?.includes("call"));

// The member's list for a surface. On a call, `here` is what this call can do (each line's main ability is live on the call)
// and `byText` is what Co does in their texts, offered and never done on the line. A line that's text-only by nature (photos,
// feedback) is left off a call.
export function capabilityMenu(surface: Surface): { here: { group: MenuGroup; line: string; main: string }[]; byText: string[] } {
  const byId = new Map(ABILITIES.map((a) => [a.id, a]));
  const live = (m: MenuLine, s: Surface) => { const a = byId.get(m.main); return !!a && liveOn(a, s); };
  if (surface === "text") return { here: MENU.filter((m) => m.text && live(m, "text")).map((m) => ({ group: m.group, line: m.text!, main: m.main })), byText: [] };
  const callWords = (m: MenuLine) => (m.call === undefined ? "by text" : m.call);
  return {
    here: MENU.filter((m) => { const w = callWords(m); return w !== null && w !== "by text" && live(m, "call"); }).map((m) => ({ group: m.group, line: callWords(m) as string, main: m.main })),
    byText: MENU.filter((m) => callWords(m) === "by text" && m.text && live(m, "text")).map((m) => m.byTextOnCall ?? m.text!),
  };
}

// ---------- What runs DURING a call and what waits for after it (Royce, 2026-10-29: "on certain things Cue should follow up
// immediately with the action over the phone"). The allow-list, enforced in code (services/callTools.ts builds a call's tools
// from it and refuses anything else), never only in the guide:
//   now    quick and certain: run inside the turn, with a tight timeout of their own (ms). Sending a link, event or find already
//          on file, saving what they want or think, starting work that runs after the call, keeping their notes and tasks
//          current. Past its timeout a tool keeps going on its own; a send that hasn't come back is owed right after the call.
//   after  slow or multi-step (a page, a deck, a document): started from the call, never waited on past a moment, made after
//          it and texted when ready.
// Never on a call, whatever the registry says: anything that needs another member's yes (an intro), anything that costs money,
// and everything not listed here (web research, reading pages: slow or multi-step, so a task or a promise
// picks it up right after the call).
export type CallRun = { run: "now"; kind: "send" | "save" | "start" | "read"; ms: number };
const SEND: CallRun = { run: "now", kind: "send", ms: 4000 };
const SAVE: CallRun = { run: "now", kind: "save", ms: 3000 };
const START: CallRun = { run: "now", kind: "start", ms: 3000 };
export const CALL_RUN: Readonly<Record<string, CallRun>> = {
  // Send what's on file: the link goes to their texts during the call.
  shareLink: SEND,
  calendarConnection: SEND,
  // A quick look: the event feed (no web search on a call) and what Cue knows about them.
  searchEvents: { run: "now", kind: "read", ms: 5000 },
  whatCoKnows: { run: "now", kind: "read", ms: 3000 },
  // Start work that runs after the call.
  startTask: START,
  // Their yes is a short model read first (services/theirYes.ts), so these get a little longer.
  researchBrief: { run: "now", kind: "start", ms: 5000 },
  // Their yes is a short model read first (services/theirYes.ts), so these get a little longer.
  saveAsk: START,
  // Save what they said: an event they're into, their notes, tasks, preferences, corrections and consent.
  noteReaction: SAVE,
  updateTask: SAVE,
  closeTask: SAVE,
  updateNotes: SAVE,
  updateLoop: SAVE,
  steerAwayFrom: SAVE,
  // Resolved against their home before it's kept (a geocoder read): the longer save timeout, as correctWhatCoKnows.
  setSearchArea: { run: "now", kind: "save", ms: 5000 },
  noteRoomTaste: SAVE,
  noteFreeTime: SAVE,
  answerProposal: SAVE,
  noteMetAgain: SAVE,
  noteRoomMeeting: SAVE,
  findReaction: SAVE,
  correctWhatCoKnows: { run: "now", kind: "save", ms: 5000 },
  voiceRead: SAVE,
  // Made after the call, delivered by text.
};
// Which tools change a member-facing setting or record (2026-10-31, reviews of #336). Only a tool that did, this turn, backs a reply
// that says Cue changed something (harness/replyGrounding.ts no_unbacked_change). The guard reads CHANGES_NOTHING, so a new tool backs a
// change by default (a true "I just updated the deck" is never cut for a missing list entry); every registry tool must be in exactly
// one of the two lists (evals/discovery/searchArea.ts), so a new one is a conscious choice.
// Nothing changed: reads, searches, sends (a link, a card, a draft, finds), the team note, the safety flag, bookkeeping.
export const CHANGES_NOTHING: ReadonlySet<string> = new Set([
  "sendReply", "reactInsteadOfReplying", "leaveItAtReaction", "markTopicAsked", "askedWalkin",
  "searchEvents", "webSearch", "searchPosts", "readPage", "readDocument",
  "listOpenAsks", "listSentOffers", "checkInvitesLeft", "whatCoKnows", "anythingForMe",
  "sendContactCard", "shareFinds", "shareLink", "sendProductUpdates",
  "saveFeedbackForTeam", "flagSafetyConcern",
]);
// Something changed: a setting, a record, a piece of work, an artifact. Also a share link made (shareArtifact), one of their invites used
// (sendInvite), and the connection tools, each of which can disconnect an account.
export const CHANGES_SOMETHING: ReadonlySet<string> = new Set([
  "setSearchArea", "correctWhatCoKnows", "steerAwayFrom", "saveAsk", "closeAsk", "saveKitFact", "noteRoomTaste", "noteFreeTime",
  "noteReaction", "noteMetAgain", "noteRoomMeeting", "findReaction", "updateNotes", "updateLoop",
  "startTask", "researchBrief", "updateTask", "closeTask", "takeOnGoal", "pickGoalItems", "markGoal", "moveLane", "updateGoing", "followUp", "firstRead",
  "answerProposal", "answerShareAsks", "shareAskInIntros", "answerBriefName", "requestEventIntro", "markArrived",
  "voiceRead", "shareLocationYes",
  "sendInvite", "calendarConnection",
]);

// What can never run on a call, even if it were listed above.
const NEVER_ON_CALL: ReadonlySet<NonNullable<Ability["confirm"]>> = new Set(["affects_another_member", "costs_money"]);
export const callRunFor = (tool: string): CallRun | null => CALL_RUN[tool] ?? null;

// GPT-Live calls (Royce, 2026-11-02: "Wire the existing helpers into the current GPT-Live call path"): the call's thinking gets the
// allow-list above, less what doesn't fit a GPT-Live call. Left out, with why:
//   - every "after" tool (a page, a deck, a document): on a call it carried on in this process past a short wait, so a restart or a
//     redeploy lost it, and nothing durable said it was owed. On GPT-Live that work is a task (startTask: a co_tasks row, written
//     before Cue says it started, whose own turn writes the document and texts it).
//   - what shares publicly, grants access, or deletes what can't come back (below): private, reversible work only.
//   - web search and page reads were never on the list: webSearch is an Exa search (12 s timeout) plus a Sonnet pick plus a read of each
//     result's page, too slow to wait on mid-turn, so on a call that work is a task too.
export const LIVE_CALL_LEFT_OUT: Readonly<Record<string, string>> = {
  calendarConnection: "grants access to their calendar",
};
export function liveCallToolNames(): string[] {
  return callToolNames().filter((t) => CALL_RUN[t]?.run === "now" && !LIVE_CALL_LEFT_OUT[t]);
}
// Tools whose done result is durable work that texts them later (a co_tasks row or a saved ask): only these back a spoken "I'll text
// you what I find" or "I've started on it" (services/callClaims.ts jobBacked).
export const startsWork = (tool: string): boolean => { const r = CALL_RUN[tool]; return !!r && r.run === "now" && r.kind === "start"; };

// The tools that run on a call: registry entries marked onCall that are on the allow-list above, never one that affects another
// member or costs money, never a team-only one (services/callTools.ts).
export function callToolNames(): string[] {
  return ABILITIES.filter((a) => a.onCall && a.tool && !a.teamOnly && CALL_RUN[a.tool] && !(a.confirm && NEVER_ON_CALL.has(a.confirm))).map((a) => a.tool!);
}

const grouped = (here: { group: MenuGroup; line: string }[]) => {
  const groups = [...new Set(here.map((h) => h.group))];
  return groups.map((g) => `${g}:\n${here.filter((h) => h.group === g).map((h) => `- ${h.line}`).join("\n")}`).join("\n");
};

// By text: they asked outright for the list ("what can you do", "what are all the things you can help with"). Answered
// directly and completely, never turned into where their open work stands (that's for "what are you", services/readTurn.ts).
export function capabilityListInstruction(): string {
  return `They asked for the list of what you can do. Answer that directly and completely, from this list and nothing else, in your own words and first person, grouped the way it is here, a short line each; the one or two that fit what they're after can come first. This is the one reply that can run longer than a few sentences. Don't turn it into where their open work stands, don't cut it to one sentence, and don't pitch or rate yourself. End with what you can't do, in one line: ${CANNOT}.\n${grouped(capabilityMenu("text").here)}`;
}

// On a call: the list the call briefing carries (services/callBriefing.ts), from the same entries as the call's tools.
export function callCapabilityList(): string {
  const m = capabilityMenu("call");
  return `On this call:\n${m.here.map((h) => `- ${h.line}`).join("\n")}\n\nIn their texts, not on this call (offer it; never do it on the line):\n${m.byText.map((l) => `- ${l}`).join("\n")}`;
}
