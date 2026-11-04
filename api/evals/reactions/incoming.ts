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

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
