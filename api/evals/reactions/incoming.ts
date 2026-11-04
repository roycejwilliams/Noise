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
  const v = (s: string) => R.parseReaction(s);
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
  const r = R.parseReaction(`Liked ${Q("Dana is going Thursday and builds climate hardware like you. Want me to introduce you two…")}`)!;
  const t = R.pickTarget(r, sent);
  check("the target is found by its quote, with its handle", t?.handle === "h-intro" && t.how === "quote");
  check("the payload's handle wins when it names one of Cue's texts", R.pickTarget(r, sent, "h-find")?.handle === "h-find");
  check("a handle that isn't Cue's is ignored, the quote settles it", R.pickTarget(r, sent, "someone-elses")?.handle === "h-intro");
  check("nothing is guessed when the quote matches nothing", R.pickTarget(R.parseReaction(`Liked ${Q("a text from last year")}`)!, sent) === null);
  check("nothing is guessed from a photo reaction without a handle", R.pickTarget(R.parseReaction("Loved an image")!, sent) === null);
}

// 3. the meaning
{
  const tgt = (text: string) => ({ handle: "h", text, how: "quote" as const });
  const mean = (verb: string, text: string | null) => R.interpretReaction(R.parseReaction(`${verb} ${Q(text ?? "x")}`)!, text === null ? null : tgt(text));
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
  check("a removed reaction says nothing", R.interpretReaction(R.parseReaction(`Removed a heart from ${Q(INTRO)}`)!, tgt(INTRO)).meaning === "removed");
  check("an unmatched text is unclear and not guessed", R.interpretReaction(R.parseReaction(`Liked ${Q("zzz long gone")}`)!, null).meaning === "unclear");
  const all = [...["Loved", "Liked", "Disliked", "Laughed at", "Emphasized", "Questioned"].flatMap((v) => [INTRO, FIND, UPDATE].map((t) => mean(v, t))), R.interpretReaction(R.parseReaction(`Reacted 🔥 to ${Q(INTRO)}`)!, tgt(INTRO))];
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
  check("real messages that merely start like a tapback are not reactions", real.every((m) => R.parseReaction(m) === null), real.filter((m) => R.parseReaction(m)).join(" | "));
  check("... and so a yes in them still counts as theirs", Y.yesIsTheirs("yes please introduce me to Dana", real[0]) === true && Y.yesIsTheirs("Yes book it", real[2]) === true);
  check("the exact media strings are reactions", ["Loved an image", "Liked a photo", "Emphasized a video", "Loved a voice message", "Liked a link", "Loved a sticker", "Loved an attachment"].every((m) => R.parseReaction(m) !== null));
  check("Reacted needs a real emoji", R.parseReaction(`Reacted 🔥 to ${Q("x yes")}`)?.emoji === "🔥" && R.parseReaction(`Reacted 🫡 to ${Q("hello there")}`) !== null && R.parseReaction(`Reacted yes to ${Q("hello there")}`) === null);
  check("a straight-quoted string is not taken for a reaction", R.parseReaction('Liked "Want me to intro you to Dana?"') === null);
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
  const heart = R.interpretReaction(R.parseReaction(`Loved ${Q("Want to come to Friday's dinner? 8pm")}`)!, { handle: "h", text: "Want to come to Friday's dinner? 8pm", how: "quote" });
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
  check("a removal is read as removed, and the route ends the turn on it (code, in routes/sendblue.ts)", R.parseReaction(`Removed a heart from ${Q(INTRO)}`)?.removed === true && (await import("node:fs")).readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8").includes('action: "reaction_removed"'));
}
{
  // Sendblue's emoji form
  check("text-style characters are not sendable; their emoji forms are", ["©", "☺", "❤", "‼", "✍"].every((x) => !T.sendableReaction(x)) && ["©️", "☺️", "❤️", "✍️", "✈️", "🫡", "🔥"].every(T.sendableReaction));
  check("❤️ still goes as love, bare ❤ too", T.reactionFor("❤️") === "love" && T.reactionFor("❤") === "love");
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
