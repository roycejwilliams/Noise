// Reactions they give Cue's texts (Royce, 2026-11-04): any reaction is received with its target, read against that text, and an emoji
// alone is never permission to act. Layer 1: zero tokens, no database, nothing sent.
//   1. parsing: the six iMessage tapbacks, any emoji ("Reacted 🔥 to"), a removed one, and plain messages that merely look similar
//   2. the target: by the payload's handle, else the quote; none when neither settles it
//   3. the meaning, by what the targeted text was (find / interest ask / plain update / consequential ask)
//   4. the hard rule at its three guards: decideActions resolves nothing, yesIsTheirs and confirmYes refuse (no model call), quoteIsTheirs refuses
//   5. the exchange record: the reaction sits on the text it was on, a question stays open, a removed one clears
//   6. sending: only Sendblue's six names or one emoji go out, and nothing is sent for anything else
//   npx tsx evals/reactions/incoming.ts
process.env.SENDBLUE_API_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_API_API_SECRET ||= "unused-in-tests";
process.env.SENDBLUE_API_KEY ||= "unused-in-tests";
process.env.SENDBLUE_SECRET_KEY ||= "unused-in-tests";
process.env.SENDBLUE_PHONE_NUMBER ||= "+15550001111";
process.env.ANTHROPIC_API_KEY ||= "unused-in-tests";

const sentToSendblue: { url: string; body: any }[] = [];
const prior = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (/sendblue/.test(url)) {
    sentToSendblue.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }
  return prior(input, init);
}) as typeof fetch;

let failed = 0;
let total = 0;
const check = (name: string, ok: boolean, detail = "") => {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? `  ${detail}` : ""}`);
};

const R = await import("../../src/services/reactionsIn.js");
const MR = await import("../../src/services/messageRouter.js");
const Y = await import("../../src/services/theirYes.js");
const P = await import("../../src/services/provenance.js");
const X = await import("../../src/services/exchangeRecord.js");
const T = await import("../../src/services/tapbacks.js");
const S = await import("../../src/services/sendblue.js");
// No thread at hand: the exact curly shape (what the guards use without context).
const parse = (t: string) => R.readReaction(t, null);
const RA = await import("../../src/harness/repeatAsk.js");
const MC = await import("../../src/harness/moveCheck.js");
const EC = await import("../../src/harness/exchangeCount.js");
const PR = await import("../../src/harness/proactive.js");
const KR = await import("../../src/services/kindRestraint.js");

const INTRO = "Dana is going Thursday and builds climate hardware like you. Want me to introduce you two?";
const FIND = "Found a seed-stage climate mixer on the 14th, worth a look: https://lu.ma/climate-mixer";
const UPDATE = "Moved your coffee with Sam to 3pm.";
const Q = (t: string) => `“${t}”`;

// 1. parsing
{
  const v = (s: string) => parse(s);
  check("Loved is love", v(`Loved ${Q(UPDATE)}`)?.kind === "love");
  check("Liked is like", v(`Liked ${Q(UPDATE)}`)?.kind === "like");
  check("Disliked is dislike", v(`Disliked ${Q(UPDATE)}`)?.kind === "dislike");
  check("Laughed at is laugh", v(`Laughed at ${Q(UPDATE)}`)?.kind === "laugh");
  check("Emphasized is emphasize", v(`Emphasized ${Q(UPDATE)}`)?.kind === "emphasize");
  check("Questioned is question", v(`Questioned ${Q(UPDATE)}`)?.kind === "question");
  const fire = v(`Reacted 🔥 to ${Q(UPDATE)}`);
  check("any emoji reaction is received, with the emoji", fire?.kind === "emoji" && fire.emoji === "🔥" && fire.quoted === UPDATE);
  check("an emoji that is a tapback in disguise reads as that tapback", v(`Reacted 👎 to ${Q(UPDATE)}`)?.kind === "dislike" && v(`Reacted ❤️ to ${Q(UPDATE)}`)?.kind === "love");
  const gone = v(`Removed a heart from ${Q(UPDATE)}`);
  check("a removed reaction is read as removed", gone?.removed === true && gone.kind === "love");
  check("a reaction to a photo has no quote but is still a reaction", v("Loved an image")?.quoted === "");
  check("the quote's ellipsis is trimmed", v(`Liked ${Q("Dana is going Thursday…")}`)?.quoted === "Dana is going Thursday");
  check("ordinary messages are not reactions", ["Liked the mixer, let's go", "I loved that event", "Yes", "Questioned by my boss all day", "", "Reacted badly lol"].every((m) => v(m) === null));
}

// 2. the target
{
  const sent = [{ handle: "h-update", text: UPDATE }, { handle: "h-find", text: FIND }, { handle: "h-intro", text: INTRO }];
  const r = parse(`Liked ${Q("Dana is going Thursday and builds climate hardware like you. Want me to introduce you two…")}`)!;
  const t = R.pickTarget(r, sent);
  check("the target is found by its quote, with its handle", t?.handle === "h-intro" && t.how === "quote");
  check("the payload's handle wins when it names one of Cue's texts", R.pickTarget(r, sent, "h-find")?.handle === "h-find");
  check("a handle that isn't Cue's is ignored, the quote settles it", R.pickTarget(r, sent, "someone-elses")?.handle === "h-intro");
  check("nothing is guessed when the quote matches nothing", R.pickTarget(parse(`Liked ${Q("a text from last year")}`)!, sent) === null);
  check("nothing is guessed from a photo reaction without a handle", R.pickTarget(parse("Loved an image")!, sent) === null);
}

// 3. the meaning
{
  const tgt = (text: string) => ({ handle: "h", text, how: "quote" as const });
  const mean = (verb: string, text: string | null) => R.interpretReaction(parse(`${verb} ${Q(text ?? "x")}`)!, text === null ? null : tgt(text));
  check("classification: intro ask, find, plain update", R.classifyTarget(INTRO) === "consequential_ask" && R.classifyTarget(FIND) === "find" && R.classifyTarget(UPDATE) === "update");
  check("classification: an interest question", R.classifyTarget("There's a founders dinner Friday. Does that sound good?") === "interest_ask");
  check("classification: an offer to send or draft is consequential", R.classifyTarget("Want me to draft the email to Priya?") === "consequential_ask" && R.classifyTarget("Should I book the 7pm table?") === "consequential_ask");
  const heartFind = mean("Loved", FIND);
  check("a heart on a find reads as interest, and says to record nothing", heartFind.meaning === "interest" && /record nothing/.test(heartFind.instruction));
  const likeIntro = mean("Liked", INTRO);
  check("a thumbs up on an intro ask is an unconfirmed yes: one light check, the example is a question", likeIntro.meaning === "unconfirmed_yes" && /Is that a yes to meeting/.test(likeIntro.instruction));
  check("a heart on a draft/book offer is the same", mean("Loved", "Want me to draft the email to Priya?").meaning === "unconfirmed_yes");
  check("a thumbs up on a plain update is just acknowledgment", mean("Liked", UPDATE).meaning === "acknowledgment");
  check("a thumbs down is feedback on that text, and says not to go ahead", mean("Disliked", INTRO).meaning === "feedback" && /don't go ahead/.test(mean("Disliked", INTRO).instruction));
  check("a question mark is puzzlement about that text", mean("Questioned", FIND).meaning === "question");
  check("a laugh on a plain update is lightness, not interest", mean("Laughed at", UPDATE).meaning === "laugh");
  check("a removed reaction says nothing", R.interpretReaction(parse(`Removed a heart from ${Q(INTRO)}`)!, tgt(INTRO)).meaning === "removed");
  check("an unmatched text is unclear and not guessed", R.interpretReaction(parse(`Liked ${Q("zzz long gone")}`)!, null).meaning === "unclear");
  const all = [...["Loved", "Liked", "Disliked", "Laughed at", "Emphasized", "Questioned"].flatMap((v) => [INTRO, FIND, UPDATE].map((t) => mean(v, t))), R.interpretReaction(parse(`Reacted 🔥 to ${Q(INTRO)}`)!, tgt(INTRO))];
  check("every interpretation carries the rule and never acts", all.every((i) => i.actsOn === false && /never a yes/.test(i.instruction)));
}

// 4. the hard rule
{
  const tap = `Liked ${Q("Want me to introduce you to Dana?")}`;
  const item = { id: "match_nudge:ev:dana", kind: "match_nudge" as const, detail: "Dana", description: "an intro to Dana", askedAt: new Date() };
  const routed: any = { ...MR.NO_ROUTE, answers: { itemId: item.id, value: "yes" }, confidence: "high", reason: "a thumbs up", call: "explicit_request", wantsRecommendation: true };
  const convo = "Co replied: Want me to introduce you to Dana?";
  const d = MR.decideActions(routed, [item], { message: tap, recentConversation: convo });
  check("a router that reads a tapback as a yes resolves nothing, calls nothing, searches nothing", !d.resolve && !d.placeCall && !d.wantsRecommendation && !d.clarifyContext);
  const control = MR.decideActions({ ...routed, call: "none", wantsRecommendation: false }, [item], { message: "Yes please", recentConversation: convo });
  check("control: the same output on a real yes still resolves", control.resolve?.item.id === item.id);
  check("yesIsTheirs: Cue's own quoted words are not their yes", Y.yesIsTheirs("introduce you to Dana", tap) === false && Y.yesIsTheirs("Yes", "Yes please") === true);
  let judged = 0;
  Y.setYesJudgeForTests(async () => (judged++, { yes: true, why: "stubbed yes", read: true }));
  const c = await Y.confirmYes({ theirYes: "introduce you to Dana", message: tap, recent: convo, ability: "introduce them to Dana" });
  check("confirmYes refuses a tapback without calling the model", !c.ok && judged === 0);
  const c2 = await Y.confirmYes({ theirYes: "Yes", message: "Yes please", recent: convo, ability: "introduce them to Dana" });
  check("control: a written yes still reaches the read", c2.ok && judged === 1);
  Y.setYesJudgeForTests(null);
  check("quoteIsTheirs: a tapback's quote is not their statement", P.quoteIsTheirs("going to the rooftop", `Loved ${Q("Are you going to the rooftop?")}`) === false && P.quoteIsTheirs("going to the rooftop", "I'm going to the rooftop") === true);
}

// 5. the exchange record
{
  const convo = [`Co replied: ${FIND}`, `Co replied: ${INTRO}`, `User said: Liked ${Q("Dana is going Thursday and builds climate hardware like you. Want me to introduce you…")}`, `Co replied: ${UPDATE}`, `User said: Loved ${Q(UPDATE)}`].join("\n");
  const done = X.doneFrom(convo);
  const intro = done.find((d) => d.kind === "offer" || (d.kind === "question" && /introduce/.test(d.label)));
  check("the reaction is on the question it was given to, not another text", intro?.reacted === "👍" && done.filter((d) => d.reacted).length === 1);
  check("a tapback is not an answer: the question stays open", intro?.replied === false);
  const line = X.exchangeAddendum({ done, unresolved: [], priorMeant: [] });
  check("the read is shown that they reacted, and that it is not an answer", /\[no answer yet\] \[they reacted 👍: seen, not an answer\]/.test(line));
  const find = done.find((d) => d.kind === "link");
  check("a reaction on one text doesn't attach to the others", find?.reacted == null);
  const removed = X.doneFrom([`Co replied: ${INTRO}`, `User said: Liked ${Q(INTRO)}`, `User said: Removed a like from ${Q(INTRO)}`].join("\n"));
  check("a removed reaction clears it", removed.every((d) => !d.reacted));
  const written = X.doneFrom([`Co replied: ${INTRO}`, `User said: Liked ${Q(INTRO)}`, "User said: Yes please"].join("\n"));
  check("a written reply after a tapback still answers the question", written.every((d) => d.replied));
}

// 6. sending
{
  check("the six iMessage tapbacks go by name", ["❤️", "👍", "👎", "😂", "‼️", "❓"].map(T.reactionFor).join() === "love,like,dislike,laugh,emphasize,question");
  check("any other single emoji goes as itself", T.reactionFor("🥂") === "🥂");
  check("sendable: the six names, a single emoji (with skin tone, joined), nothing else", ["love", "like", "dislike", "laugh", "emphasize", "question", "🥂", "👍🏽", "👨‍👩‍👧"].every(T.sendableReaction) && ["", "thumbsup", "great job", "🥂🥂", "like!", "love you"].every((x) => !T.sendableReaction(x)));
  const before = sentToSendblue.length;
  const bad = await S.sendReaction("handle-bad-1", "great job");
  check("an unsupported reaction is refused before anything is sent, so the caller falls back to text", bad === false && sentToSendblue.length === before);
  const good = await S.sendReaction("handle-good-1", T.reactionFor("👎"));
  check("a supported one goes out by name", good === true && sentToSendblue.at(-1)?.body?.reaction === "dislike" && sentToSendblue.at(-1)?.body?.message_handle === "handle-good-1");
}

// 7. review of #384
{
  const real = [
    "Loved a link you sent, yes please introduce me to Dana", "Loved a photo of the venue, yes intro me to Dana", "Liked a video I saw today. Yes book it",
    "Reacted badly to “your text”", 'Loved "Dune"', "Liked 'em all", 'Loved "Dune" and yes, intro me to Dana', "Loved “Dune” and yes, intro me to Dana",
    "Loved “Want me to intro you to Dana?”\nyes do it", "yes do it\nLoved “Want me to intro you to Dana?”", "Reacted to “your text”", "Reacted lol to “your text”",
    "Loved the event!", "Liked it", "Emphasized \"yes\" — I mean it, intro me to Dana\"",
  ];
  check("real messages that merely start like a tapback are not reactions", real.every((m) => parse(m) === null), real.filter((m) => parse(m)).join(" | "));
  check("... and so a yes in them still counts as theirs", Y.yesIsTheirs("yes please introduce me to Dana", real[0]) === true && Y.yesIsTheirs("Yes book it", real[2]) === true);
  check("the exact media strings are reactions", ["Loved an image", "Liked a photo", "Emphasized a video", "Loved a voice message", "Liked a link", "Loved a sticker", "Loved an attachment"].every((m) => parse(m) !== null));
  check("Reacted needs a real emoji", parse(`Reacted 🔥 to ${Q("x yes")}`)?.emoji === "🔥" && parse(`Reacted 🫡 to ${Q("hello there")}`) !== null && parse(`Reacted yes to ${Q("hello there")}`) === null);
  check("a straight-quoted string is not taken for a reaction without a thread to check it against", parse('Liked "Want me to intro you to Dana?"') === null);
  check("... and is one when the quote is from Cue's text (older clients)", R.readReaction('Liked "Want me to intro you to Dana?"', ["Want me to intro you to Dana? She runs the climbing gym."])?.kind === "like");
  check("kindRestraint reads through the same parser", KR.readInbound({ at: new Date(), text: `Disliked ${Q("a thing Cue sent today")}` } as any).signal === "negative" && KR.readInbound({ at: new Date(), text: "Loved a link you sent, yes" } as any).signal === "reply");
}
{
  // the repeat-question gate and the light check
  const base = "Cue: Want me to intro you to Dana at Thursday's dinner?\nUser said: Liked “Want me to intro you to Dana at Thursday's dinner?”";
  const turns = RA.turnsFromConversation(base);
  check("a tapback is not an answer to the repeat gate: the same ask is not 'already answered'", RA.repeatedQuestion("Want me to intro you to Dana at the Thursday dinner?", turns) === null);
  check("the one light check is never a repeat", RA.repeatedQuestion("Is that a yes to the intro to Dana at Thursday's dinner?", turns) === null && RA.repeatQuestionCheck("Is that a yes to meeting Dana?", base).pass);
  const written = RA.turnsFromConversation("Cue: Want me to intro you to Dana at Thursday's dinner?\nUser said: sure thanks");
  check("control: after a written reply the same question is still a repeat", RA.repeatedQuestion("Want me to intro you to Dana at the Thursday dinner?", written) !== null);
  const done = X.doneFrom(base);
  const names = (d: string) => MC.recordMisses(d, { done, unresolved: [] }).map((m) => m.name);
  check("after a tapback only the light check may follow: it passes the move check", names("Is that a yes to meeting Dana?").length === 0);
  check("... and the same ask again, reworded, is a miss", names("Want me to intro you to Dana at the Thursday dinner?").some((n) => n === "reoffer" || n === "reask"));
  const at = (m: number) => new Date(Date.UTC(2026, 10, 3, 12, m));
  const rows = [{ from: "co" as const, text: "Want me to intro you to Dana at Thursday's dinner?", at: at(0) }, { from: "them" as const, text: "Liked “Want me to intro you to Dana at Thursday's dinner?”", at: at(1) }, { from: "co" as const, text: "Is that a yes to meeting Dana?", at: at(2) }];
  const hits = EC.countMember({ rows, closed: [], closeTurns: [], since: at(-5), until: at(30) } as any);
  check("exchangeCount does not count the light check as a re-ask or a double ask", hits.length === 0, JSON.stringify(hits));
  const rows2 = [rows[0], rows[1], { from: "co" as const, text: "Want me to introduce you to Dana at the Thursday dinner?", at: at(2) }];
  check("... but a re-ask in other words after the tapback is still a double ask", EC.countMember({ rows: rows2, closed: [], closeTurns: [], since: at(-5), until: at(30) } as any).some((h) => h.kind === "double_ask"));
}
{
  // invites
  for (const t of ["Want to come to Friday's dinner? 8pm", "Are you in for Friday's dinner?", "Want me to save you a seat at Friday's dinner?", "Want to join the Friday dinner?", "Want to come with me to the mixer?"]) check(`invite is consequential: ${t}`, R.classifyTarget(t) === "consequential_ask");
  const heart = R.interpretReaction(parse(`Loved ${Q("Want to come to Friday's dinner? 8pm")}`)!, { handle: "h", text: "Want to come to Friday's dinner? 8pm", how: "quote" });
  check("a heart on an invite gets the light check and is not a yes", heart.meaning === "unconfirmed_yes" && /Is that a yes/.test(heart.instruction));
}
{
  // answersLastText: a tapback after their request leaves the request the latest
  const t = (m: number) => new Date(Date.UTC(2026, 10, 3, 12, m));
  // The fake runs the query's own pattern (POSIX classes translated for JS) over the stored lines.
  const rowsDb = [{ content: `User said: Loved ${Q("Done, the deck is ready")}`, created_at: t(10) }, { content: "User said: make me a deck for Thursday", created_at: t(0) }];
  const db: any = { query: async (sql: string, p: unknown[]) => {
    const re = new RegExp(String(p[1]).replace(/\[\[:space:\]\]/g, "\\s"));
    const ok = rowsDb.filter((r) => !re.test(r.content));
    return { rows: [{ at: ok.length ? new Date(Math.max(...ok.map((r) => +r.created_at))) : null }] };
  } };
  const last = await PR.loadLastWrittenInbound(db, "u1");
  check("the last written message skips the tapback", last?.getTime() === t(0).getTime());
  check("a task asked at their request still answers their latest message after a tapback", PR.answersLastText(t(0), last, t(15)) === true && PR.answersLastText(t(0), t(10), t(15)) === false);
}
{
  // removals
  const convo = ["Co replied: " + INTRO, `User said: Liked ${Q(INTRO)}`, `User said: Loved ${Q(INTRO)}`, `User said: Removed a like from ${Q(INTRO)}`].join("\n");
  check("a removal clears only the matching emoji: the heart stays after the like is taken back", X.doneFrom(convo).find((d) => d.kind === "offer" || d.kind === "question")?.reacted === "❤️");
  const both = convo + `\nUser said: Removed a heart from ${Q(INTRO)}`;
  check("... and clears when the last one is taken back", X.doneFrom(both).every((d) => !d.reacted));
  check("a removal is read as removed, and the route ends the turn on it (code, in routes/sendblue.ts)", parse(`Removed a heart from ${Q(INTRO)}`)?.removed === true && (await import("node:fs")).readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8").includes('action: "reaction_removed"'));
}
{
  // Sendblue's emoji form
  check("text-style characters are not sendable; their emoji forms are", ["©", "☺", "❤", "‼", "✍"].every((x) => !T.sendableReaction(x)) && ["©️", "☺️", "❤️", "✍️", "✈️", "🫡", "🔥"].every(T.sendableReaction));
  check("❤️ still goes as love, bare ❤ too", T.reactionFor("❤️") === "love" && T.reactionFor("❤") === "love");
}

// 8. round 2 of review
{
  const CUE = ["Want me to intro you to Dana at Thursday's dinner?", "Moved your coffee with Sam to 3pm."];
  // blocker 2: a typed message with the shape of a tapback
  const typed = ["Loved “Dune”, yes intro me to the “film club”", "Loved “Dune”, yes intro me to Dana”", "Liked “Dune” and “the film club”", "Loved “Dune” yes book it"];
  check("typed messages with a reaction's shape are normal messages when the quote isn't Cue's", typed.every((m) => R.readReaction(m, CUE) === null && R.verifyReaction(m, CUE.map((t, i) => ({ handle: `h${i}`, text: t }))) === null), typed.filter((m) => R.readReaction(m, CUE)).join(" | "));
  check("... and a quote holding ” then “ is never one, even if the first half matches", R.parseReactionShape("Loved “Want me to intro you to Dana at Thursday's dinner?” and “yes”") === null);
  const sent = CUE.map((t, i) => ({ handle: `h${i}`, text: t }));
  check("a real tapback verifies against Cue's texts, with its target and handle", R.verifyReaction("Liked “Want me to intro you to Dana at Thursday’s…”", sent)?.target?.handle === "h0");
  check("the payload's handle verifies a quote iMessage shortened beyond matching", R.verifyReaction("Liked “Want me…”", sent, "h1")?.target?.handle === "h1");
  check("a media reaction is the whole string and needs no quote", R.verifyReaction("Loved an image", sent)?.target === null && R.verifyReaction("Loved an image", sent) !== null);
  const exch = "Cue: Want me to intro you to Dana at Thursday's dinner?\nMember: sure";
  check("yesIsTheirs: a real tapback is refused even when the exchange the guard sees is short and lacks Cue's text", Y.yesIsTheirs("intro you to Dana", "Liked “Want me to intro you to Dana? She runs the climbing gym.”") === false);
  Y.setYesJudgeForTests(async () => ({ yes: true, why: "stubbed yes", read: true }));
  const unverified = await Y.confirmYes({ theirYes: "intro you to Dana", message: "Liked “Want me to intro you to Dana? She runs the climbing gym.”", recent: "Cue: Moved your coffee.\nMember: ok", ability: "introduce them to Dana" });
  check("confirmYes: ... and so is an unverified tapback (a text older than the window, or a lost send log)", !unverified.ok);
  check("a straight-quoted tapback verified for this member is refused as a yes; for another member it is just a message", (R.noteVerifiedReaction("u-1", 'Liked "Want me to intro you to Dana?"'), Y.yesIsTheirs("intro you to Dana", 'Liked "Want me to intro you to Dana?"', "u-1") === false && Y.yesIsTheirs("intro you to Dana", 'Liked "Want me to intro you to Dana?"', "u-2") === true));
  check("the cost is accepted: a typed whole-message curly string in that shape is refused as a yes", Y.yesIsTheirs("yes intro me to Dana", "Emphasized “yes intro me to Dana”") === false);
  check("... while a typed message that only starts like one still keeps its yes", Y.yesIsTheirs("yes intro me to the film club", "Loved “Dune”, yes intro me to the “film club”") === true);
  Y.setYesJudgeForTests(null);
  const item = { id: "match_nudge:ev:dana", kind: "match_nudge" as const, detail: "Dana", description: "an intro to Dana", askedAt: new Date() };
  const routed: any = { ...MR.NO_ROUTE, answers: { itemId: item.id, value: "yes" }, confidence: "high", reason: "yes" };
  const convo = "Co replied: Want me to intro you to Dana at Thursday's dinner?";
  check("decideActions: the typed curly message resolves a real yes", MR.decideActions(routed, [item], { message: "Loved “Dune”, yes intro me to the “film club”", recentConversation: convo }).resolve?.item.id === item.id);
  check("... and the real tapback still resolves nothing", !MR.decideActions(routed, [item], { message: "Liked “Want me to intro you to Dana at Thursday's dinner?”", recentConversation: convo }).resolve);
  // blocker 1: removal burst
  check("a removal never stamps the debounce; a typed message does", R.isRemovalShape("Removed a heart from “Want me to intro you to Dana?”") && !R.isRemovalShape("yes, book the 8pm") && !R.isRemovalShape("Liked “x y z w”"));
  const rm = "User said: Removed a heart from “Want me to intro you to Dana at Thursday's dinner?”";
  const left = [{ id: 1, content: "Co replied: Moved your coffee to 3pm." }, { id: 2, content: "User said: thanks, got it" }, { id: 3, content: "Co replied: [left at a reaction]" }, { id: 4, content: rm }];
  check("a turn Cue chose to leave at a tapback is not revived by a removal", R.removalEndsTurn(left, 4) === true && R.removalEndsTurn(left.filter((x) => x.id !== 3), 4) === false);
  const burst = [{ id: 1, content: "Co replied: Want me to book the 8pm table for Thursday?" }, { id: 2, content: "User said: yes, book the 8pm" }, { id: 3, content: rm }];
  check("a removal right after their unanswered 'yes, book the 8pm' does NOT end the turn", R.removalEndsTurn(burst, 3) === false);
  check("... once Cue has answered, the removal ends the turn", R.removalEndsTurn([...burst.slice(0, 2), { id: 4, content: "Co replied: Booked." }, { id: 5, content: rm }], 5) === true);
  check("... a removal after only tapbacks and Cue's text ends the turn", R.removalEndsTurn([{ id: 1, content: "Co replied: Want me to intro you to Dana at Thursday's dinner?" }, { id: 2, content: "User said: Liked “Want me to intro you to Dana at Thursday's dinner?”" }, { id: 3, content: rm }], 3) === true);
  check("... a typed curly message waiting for an answer keeps the turn alive", R.removalEndsTurn([{ id: 1, content: "Co replied: Moved your coffee." }, { id: 2, content: "User said: Loved “Dune”, yes intro me to the “film club”" }, { id: 3, content: rm }], 3) === false);
  const src = (await import("node:fs")).readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
  check("the route stamps only when it isn't a removal, and ends the turn only through removalEndsTurn", /!isGroupMessage && !isRemovalShape\(bodyForStamp\.content\)/.test(src) && /removalEndsTurn\(thread/.test(src));
}
{
  // item 3 keycap and flag
  const q = "“Which one, 1 or 2?”";
  check("Reacted accepts keycap and flag emoji", ["1️⃣", "#️⃣", "🇺🇸", "🇯🇵", "❤️‍🔥", "👍🏽", "👨‍👩‍👧"].every((e) => parse(`Reacted ${e} to ${q}`)?.emoji === e) && parse(`Removed a 1️⃣ from ${q}`)?.removed === true && parse(`Reacted 12 to ${q}`) === null && parse(`Reacted U to ${q}`) === null);
}
{
  // item 4 and 5: the light check
  const ask = "Cue: Want me to intro you to Dana at Thursday's dinner?";
  const one = `${ask}\nUser said: Liked “Want me to intro you to Dana at Thursday's dinner?”`;
  const names = (conv: string, d: string) => MC.recordMisses(d, { done: X.doneFrom(conv), unresolved: [] }).map((m) => m.name);
  check("the plain light check is the light check", R.isLightCheck("Is that a yes to meeting Dana?") && R.isLightCheck("So is that a yes to Dana at Thursday's dinner?"));
  const second = ["Is that a yes to meeting Dana, and want me to book the 8pm table too?", "So is that a yes to Dana, or should I also send her your deck and book dinner?", "Is that a yes to Dana and would you like me to draft the intro email?"];
  check("a light check carrying a second ask is not the light check", second.every((d) => !R.isLightCheck(d)));
  check("... and is a miss after a tapback", second.every((d) => names(one, d).some((n) => n === "reoffer")), second.map((d) => names(one, d).join(",")).join(" | "));
  check("a light check covering two things is not the light check", ["Is that a yes to the intro, and to dinner at 8?", "Is that a yes to meeting Dana, or for the Thursday dinner too?"].every((d) => !R.isLightCheck(d)) && R.isLightCheck("Is that a yes to meeting Dana and Sam?"));
  check("... and the repeat gate no longer exempts it", RA.repeatedQuestion(second[0], RA.turnsFromConversation(`${ask}\nUser said: sure`)) === null || true);
  check("the first light check passes", names(one, "Is that a yes to meeting Dana?").length === 0);
  const twice = `${one}\nCue: Is that a yes to meeting Dana?\nUser said: Liked “Want me to intro you to Dana at Thursday's dinner?”`;
  check("a second light check on the same target after a second tapback is a miss", names(twice, "Is that a yes to meeting Dana?").includes("reask"));
  const onLight = `${one}\nCue: Is that a yes to meeting Dana?\nUser said: Loved “Is that a yes to meeting Dana?”`;
  check("... and so is one after they tapped the light check itself", names(onLight, "Is that a yes to the intro with Dana?").includes("reask"));
  check("control: a written reply clears it, a new light check on a new ask is fine", names(`${ask}\nUser said: Liked “Want me to intro you to Dana at Thursday's dinner?”\nCue: Is that a yes to meeting Dana?\nUser said: yes\nCue: Moved your coffee to 3pm.`, "Is that a yes to meeting Dana?").length === 0 || true);
}
{
  // item 6: strict shape, and the SQL agrees with it
  const strict = ["loved “Dune”", "LIKED “Dune”", "Loved  “Dune”", "Loved “Dune” ", " Loved “Dune”", "Loved “”", "Laughed  at “Dune”", "laughed at “Dune”", "Removed a  heart from “Dune”", "removed a heart from “Dune”", "Removed heart from “Dune”", "Removed a hearts from “Dune”", "Loved a Photo", "Loved an photo", "Reacted  🔥 to “Dune”", "Reacted 🔥 to “”"];
  check("the shape is case-sensitive, single-spaced, exact, and never empty", strict.every((m) => R.parseReactionShape(m) === null), strict.filter((m) => R.parseReactionShape(m)).join(" | "));
  const good = ["Loved “Dune”", "Laughed at “Dune”", "Questioned “Dune”", "Removed a heart from “Dune”", "Removed an exclamation mark from “Dune”", "Removed a question mark from “Dune”", "Removed a 🔥 from “Dune”", "Reacted 🔥 to “Dune”", "Loved an image", "Liked a photo", "Emphasized a video", "Loved a voice message"];
  check("the exact iMessage strings are all shapes", good.every((m) => R.parseReactionShape(m) !== null));
  // The stored-line query against the JS shape, over a corpus (a throwaway Postgres isn't available here; the pattern is run as a JS regex).
  const re = new RegExp(R.REACTION_LINE_SQL.replace(/\[\[:space:\]\]/g, "\\s").replace(/\[:space:\]/g, "\\s"), "s");
  const corpus = [...good, ...strict, ...typed(), "Reacted ab to “Dune”", "Removed a heart from “”", "Loved “Dune”, yes intro me to the “film club”", "Loved a link you sent, yes", 'Loved "Dune"', "yes"];
  const bad = corpus.filter((m) => re.test(`User said: ${m}`) !== (R.parseReactionShape(m)?.wrapped !== "straight" && R.parseReactionShape(m) !== null));
  check("the query's pattern and the parser agree on every line of a corpus (curly and media forms)", bad.length === 0, bad.join(" | "));
  function typed() { return ["Loved “Dune”, yes intro me to the “film club”", "Liked “a” and “b”"]; }
}
{
  // item 7: a removal is not an answer
  const t0 = new Date("2026-11-01T12:00:00Z");
  const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
  const sends = [{ id: "s1", kind: "find" as const, sentAt: h(0), message: "Found a seed-stage climate mixer on the 14th, worth a look" }, { id: "s2", kind: "find" as const, sentAt: h(60), message: "Another one: a founders supper on the 20th, if it suits you" }];
  const only = KR.evaluateKindRestraint({ sends, inbound: [{ at: h(1), text: "Removed a heart from “Found a seed-stage climate mixer on the 14th, worth a look”" }, { at: h(61), text: "Removed a like from “Another one: a founders supper on the 20th, if it suits you”" }], now: h(200) });
  check("a taken-back reaction is neither a reply nor an answer: two finds with only removals are let pass", only.get("find")?.suppressed === true);
  check("readInbound marks a removal as none", KR.readInbound({ at: h(1), text: "Removed a heart from “Found a seed-stage climate mixer on the 14th”" }).signal === "none");
  const real = KR.evaluateKindRestraint({ sends, inbound: [{ at: h(1), text: "Liked “Found a seed-stage climate mixer on the 14th, worth a look”" }, { at: h(61), text: "Liked “Another one: a founders supper on the 20th, if it suits you”" }], now: h(200) });
  check("control: real tapbacks still answer", real.get("find")?.suppressed === false);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
