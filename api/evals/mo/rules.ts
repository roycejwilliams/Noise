// Model-free checks for Mo (src/mo/): the fit gates, the drafts,
// approver commands, reply handling, the outreach clock, the do-not-contact
// list, OAuth signing, opt-out tokens, and what the team is told. No model,
// no DB, no network.
//
//   npx tsx evals/mo/rules.ts
import "dotenv/config";
import { readFileSync } from "fs";
import {
  checkMoDraft,
  clearStop,
  clearYes,
  inCity,
  namesAMember,
  nextOutreachStep,
  plainYes,
  plainNo,
  plainDone,
  quoteIsTheirs,
  suppressionKeys,
  placeOk,
  locationInCity,
  neutralPronouns,
  hasGenderedPronoun,
  MO,
} from "../../src/mo/rules.js";
import { oauthSignature } from "../../src/mo/xApi.js";
import { queryLeaks } from "../../src/mo/find.js";
import { sendingStatus, tokenMatches, unsubscribeToken, codeMessage, moHours } from "../../src/mo/outreach.js";
import { reviewText, questionText, who, namesThisItem } from "../../src/mo/review.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");

// ------------------------------------------------ fit gates
const post = "Hosting another design-engineer dinner in the Mission next week, 12 people who ship 0 to 1 products";
check("a quote copied from their post counts", quoteIsTheirs("design-engineer dinner in the Mission", post));
check("words they didn't write never count", !quoteIsTheirs("hosting founder salons every month", post));
check("a too-short quote doesn't count", !quoteIsTheirs("the Mission", post));
check("SF in their profile location counts", inCity("San Francisco, CA", "shipping a new thing"));
check("SF in the post counts", inCity(null, post));
check("no city signal, no invite", !inCity("Earth", "shipping a new thing today"));
check("'sf' as a word, not inside another word", !inCity(null, "transforming onboarding flows"));

// ------------------------------------------------ where they are (2026-09-23 live run)
check("a profile location outside SF rules them out, whatever the post says", !placeOk("Switzerland", true) && !placeOk("la/chi", true) && !placeOk("New York", true));
check("an SF profile location counts", placeOk("San Francisco, CA", undefined) && placeOk("SF", true));
check("an SF location the judge says is wrong doesn't count", !placeOk("San Francisco, CA", false));
check("no location: only if the judge places them in SF", placeOk(null, true) && !placeOk(null, false) && !placeOk(null, undefined) && !placeOk("", undefined));
check("'Bay Area' and nearby cities count as SF", locationInCity("Oakland, CA") && locationInCity("Bay Area"));
{
  const f = src("mo/find.ts");
  check("the judge is asked whether they're really in SF, not just mentioning it", /a passing mention like "after my trip to SF" doesn't count/.test(f) && /if \(!placeOk\(p\.author\.location, j\.inCity\)\)/.test(f));
  check("LinkedIn quotes are checked against the headline AND the snippet shown", /quoteIsTheirs\(li\.quote, shown\)/.test(f) && /"snippet" \(the result's text as shown, copied exactly\)/.test(f));
}

// ------------------------------------------------ name or "they", never a guessed pronoun
check("'He is personally hosting' becomes 'They are personally hosting'", neutralPronouns("He is personally hosting an in-person event.") === "They are personally hosting an in-person event.");
check("'She's co-hosting with her team' becomes neutral", neutralPronouns("She's co-hosting with her team") === "They're co-hosting with their team");
check("'bringing him in' becomes 'bringing them in'", neutralPronouns("worth bringing him in") === "worth bringing them in");
check("words containing 'he' are left alone", neutralPronouns("the chess tournament he founded, then") === "the chess tournament they founded, then" && neutralPronouns("hosting the event") === "hosting the event");
check("no gendered pronoun survives", !hasGenderedPronoun(neutralPronouns("He said his cofounder told him she'd host herself")));

// ------------------------------------------------ drafts stay true to the post
{
  const d = src("mo/draft.ts");
  check("every draft set is checked against the post and against each other", /const consistency = await checkDraftsAgainstPost\(i\.postText/.test(d) && /contradict the post or another message/.test(d));
  check("if that check fails to run, the drafts are rejected (never sent unchecked)", /catch \{\s*return \{ ok: false, problem: "check failed" \};/.test(d));
}

// ------------------------------------------------ member names never leave
const members = [{ first: "Jordan", last: "Reyes" }, { first: "Ellis", last: null }];
check("a member's full name is caught", namesAMember("Jordan Reyes would love to meet you", members, { name: "Noor", postText: post }) === "Jordan Reyes");
check("a member's first name is caught", namesAMember("Ellis thinks you'd fit", members, { name: "Noor", postText: post }) === "Ellis");
check("the prospect's own name isn't a leak", namesAMember("Jordan, loved the dinner post", members, { name: "Jordan Lee", postText: post }) === null);
check("a clean draft passes", namesAMember("Loved the dinner post. Want an invite?", members, { name: "Noor", postText: post }) === null);
{
  const leaks = (q: string) => queryLeaks(q, ["looking for a technical cofounder for my climate hardware startup"], ["jordan", "reyes"]);
  check("a search can't carry a member's name", leaks('"jordan" founder SF'));
  check("a search can't carry a member's ask word for word", leaks("technical cofounder for my climate hardware"));
  check("a search on the general theme is fine", !leaks('("climate" OR "hardware") cofounder "San Francisco"'));
}

// ------------------------------------------------ drafts
const bad = (kind: "reply" | "dm" | "email", t: string) => checkMoDraft(kind, t).filter((c) => !c.pass).map((c) => c.name);
check("a good public reply passes", bad("reply", "The 12-person cap is the right call. Small enough that everyone actually talks.").length === 0);
check("the warm-up reply never pitches the club", bad("reply", "Love this. You should join our club.").includes("reply_no_pitch"));
check("the warm-up reply never carries a link", bad("reply", "Great thread https://example.com").includes("reply_no_link"));
check("a good DM passes", bad("dm", "Hey, I'm Mo. I scout interesting people for Co, and your post on design-engineer dinners put you on my radar. Want me to send you an invite?").length === 0);
check("the short DM passes", bad("dm", "I'm Mo. My job is to find people who should be in Co's private social network. Your post about design dinners led me to you. I think you're one of them. Want to know why?").length === 0);
check("a DM has to say it's Mo", bad("dm", "Co runs a small invite-only club in SF. Would you like an invite?").includes("dm_says_its_mo"));
check("the 'why' has no link or code", bad("why", "You host rooms like that. https://x.co/ABCDEFGH").includes("why_no_link"));
check("the DM never carries a code before they say yes", bad("dm", "Here's your code 6VGF76VK. Want in?").includes("dm_no_code"));
check("the DM asks rather than assumes", bad("dm", "Co runs a small club in SF. You're in.").includes("dm_asks"));
check("the DM has a length limit", bad("dm", `${"x".repeat(MO.maxDmChars)}?`).includes("dm_length"));
check("the email carries the code slot", bad("email", "Co runs a small club in SF. Text Co to join.").includes("email_has_code_slot"));
check("the email carries Co's number", bad("email", "Your code is {{CODE}}. Text it to Co.").includes("email_has_phone_slot"));
check("a complete email passes", bad("email", "Saw your dinner post.\n\nYour code is {{CODE}}. Text it to Co at {{PHONE}}.\n\nCo").length === 0);
check("the email carries no planted link", bad("email", "Your code is {{CODE}}, text {{PHONE}}. More at https://evil.example").includes("email_no_link"));
check("no em dashes anywhere", bad("dm", "Loved it — want an invite?").includes("dm_no_em_dash"));

// ------------------------------------------------ approvers answer in plain words (no command syntax)
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check("'yes' approves", plainYes("yes") && plainYes("Yes!") && plainYes("yeah go ahead") && plainYes("looks good"));
check("'no' skips", plainNo("no") && plainNo("skip") && plainNo("pass") && plainNo("not this one"));
check("'sent' marks a hand-sent note", plainDone("sent") && plainDone("done") && plainDone("I sent it"));
check("a change request is neither yes nor no", !plainYes("yes but make the DM shorter") && !plainNo("no, make it warmer"));
check("an unrelated text is none of these", !plainYes("what's on this weekend?") && !plainNo("what's on this weekend?") && !plainDone("what's on this weekend?"));
{
  const r = src("mo/review.ts");
  check("only approvers are ever asked or answered", /if \(!me\?\.mo_approver\) return null;/.test(r));
  check("a text about something else goes to Co as usual", /if \(r\.intent !== "change"\) return null;/.test(r) && /if \(r\.intent !== "answer"\) return null;/.test(r));
  check("an edit has to pass the same draft checks", /redraftOutreach\(p, r\.instruction!\)/.test(src("mo/review.ts")) && /checkMoDraft\("dm", dm, \{ dmMax: dmMaxFor\(input\.style\) \}\)/.test(src("mo/draft.ts")));
  check("one open item per approver, cleared for everyone once handled", /WHERE mo_pending_no = \$1/.test(r));
  check("an item someone else already handled isn't acted on twice", /Someone already took care of that one\./.test(r));
  const route = src("routes/sendblue.ts");
  check("approver answers aren't logged as conversation", /if \(moReply !== null\) \{/.test(route) && !/moReply[\s\S]{0,300}logTextExchange/.test(route));
  const noor = { name: "Noor Haddad", x_handle: "noorbuilds" };
  check("after Co has texted them, 'yes' alone isn't taken as Mo's answer", !namesThisItem("yes", noor));
  check("'yes to Noor' is", namesThisItem("yes to Noor", noor) && namesThisItem("Mo, yes", noor) && namesThisItem("skip @noorbuilds", noor));
  check("that guard is in place", /if \(await coSpokeSince\(userId, me\.mo_pending_at\) && !namesThisItem\(text, p\)\) return null;/.test(r));
  check("no texts to approvers mention command syntax", !/"mo (yes|skip|edit|answer|sent)/i.test(r));
}

// ------------------------------------------------ their replies
check("'no thanks' is a stop", clearStop("no thanks, not for me"));
check("'stop' is a stop", clearStop("STOP"));
check("a bare 'no' is a stop", clearStop("no"));
check("'yes please' is a yes", clearYes("yes please"));
check("'I'm in' is a yes", clearYes("I'm in"));
check("a stop is never read as a yes", !clearYes("yes, stop messaging me"));
check("a question isn't a yes", !clearYes("what does it cost?"));
{
  const o = src("mo/outreach.ts");
  check("a clear stop wins before any model reads the reply", /if \(clearStop\(text\)\) return "no";\s*if \(clearYes\(text\)\) return "yes";/.test(o));
  check("the reply model can only answer yes, no, or question", /return w\.startsWith\("yes"\) \? "yes" : w\.startsWith\("no"\) \? "no" : "question";/.test(o));
  check("a no goes on the do-not-contact list", /kind === "no"\) \{\s*await suppressProspect\(p, "declined"\)/.test(o));
}

// ------------------------------------------------ the clock
{
  const d = (s: string) => new Date(s);
  const base = { channel: null, warmedAt: null, contactedAt: null, followedUpAt: null, lastInboundAt: null };
  const now = d("2026-10-01T18:00:00Z");
  check("approved → warm up first", nextOutreachStep({ ...base, status: "approved" }, now) === "warm");
  check("never contacted before approval", nextOutreachStep({ ...base, status: "shortlisted" }, now) === null);
  check("no DM the day after the warm-up", nextOutreachStep({ ...base, status: "warmed", warmedAt: d("2026-09-30T18:00:00Z") }, now) === null);
  check("DM two days after the warm-up", nextOutreachStep({ ...base, status: "warmed", warmedAt: d("2026-09-29T17:00:00Z") }, now) === "contact");
  check("one follow-up after a silent week", nextOutreachStep({ ...base, status: "contacted", channel: "dm", contactedAt: d("2026-09-24T17:00:00Z") }, now) === "follow_up");
  check("no follow-up once they've replied", nextOutreachStep({ ...base, status: "contacted", channel: "dm", contactedAt: d("2026-09-20T17:00:00Z"), lastInboundAt: d("2026-09-21T17:00:00Z") }, now) === null);
  check("never a second follow-up: silent after it → close", nextOutreachStep({ ...base, status: "contacted", channel: "dm", contactedAt: d("2026-09-10T17:00:00Z"), followedUpAt: d("2026-09-24T17:00:00Z") }, now) === "close_silent");
  check("hand-sent LinkedIn notes get no automatic follow-up", nextOutreachStep({ ...base, status: "contacted", channel: "manual", contactedAt: d("2026-09-10T17:00:00Z") }, now) === null);
  check("only during the day (10am to 6pm Pacific)", moHours(d("2026-10-01T18:00:00Z")) && !moHours(d("2026-10-01T06:00:00Z")));
  const o = src("mo/outreach.ts");
  check("a daily cap on warm-ups and on DMs/emails", /step === "warm" && warmedToday >= MO\.dailyCap/.test(o) && /outboundToday >= MO\.dailyCap/.test(o));
  check("the do-not-contact list is checked before every send", /step !== "close_silent" && \(await isSuppressed\(p\)\)/.test(o));
  check("only approved prospects are ever acted on", /WHERE status IN \('approved', 'warmed', 'contacted'\)/.test(o));
  check("the code goes out only after a yes", /kind === "yes" && p\.status !== "invited"/.test(o));
}

// ------------------------------------------------ do-not-contact keys
check("suppression covers X, email and LinkedIn", eq(suppressionKeys({ x_user_id: "42", email: " Noor@Example.com ", linkedin_url: "https://linkedin.com/in/noor/" }), ["x:42", "email:noor@example.com", "li:https://linkedin.com/in/noor"]));

// ------------------------------------------------ security
check(
  "OAuth 1.0a signature matches X's published example",
  oauthSignature(
    "POST",
    "https://api.twitter.com/1.1/statuses/update.json",
    {
      include_entities: "true",
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    },
    "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  ) === "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
);
{
  const saved = { a: process.env.MO_UNSUBSCRIBE_SECRET, b: process.env.JWT_SECRET };
  process.env.MO_UNSUBSCRIBE_SECRET = "test-secret";
  const id = "3f1c2b8e-1111-4222-8333-944455556666";
  check("an opt-out link works with its own token", tokenMatches(id, unsubscribeToken(id)));
  check("an opt-out token can't be reused for someone else", !tokenMatches("3f1c2b8e-1111-4222-8333-944455556667", unsubscribeToken(id)));
  check("a guessed token fails", !tokenMatches(id, "0".repeat(32)));
  delete process.env.MO_UNSUBSCRIBE_SECRET;
  delete process.env.JWT_SECRET;
  check("with no secret, no opt-out link is ever accepted", !tokenMatches(id, "anything"));
  if (saved.a !== undefined) process.env.MO_UNSUBSCRIBE_SECRET = saved.a;
  if (saved.b !== undefined) process.env.JWT_SECRET = saved.b;
  const o = src("mo/outreach.ts");
  check("opt-out compares tokens in constant time", /timingSafeEqual\(a, b\)/.test(o));
  check("email needs a signing secret and a postal address before it can send", /MO_POSTAL_ADDRESS && env\.API_URL && \(env\.MO_UNSUBSCRIBE_SECRET \|\| env\.JWT_SECRET\)/.test(o));
  check("an email address is used only if it's on their own page", /page && page\.toLowerCase\(\)\.includes\(r\.email\.toLowerCase\(\)\)/.test(o));
  const jobs = src("jobs/index.ts");
  check("Mo is off unless MO_ENABLED is true", /if \(moEnabled\(\)\) \{\s*cron\.schedule\("0 9 \* \* 1"/.test(jobs));
  const x = src("mo/xApi.ts");
  check("keys are read from the environment, never written in code", !/(consumer|access)_?(key|secret|token)\s*[:=]\s*["'][A-Za-z0-9]{10,}/i.test(x));
}

// ------------------------------------------------ what the team is told
{
  const off = sendingStatus({ MO_ENABLED: "false" } as any);
  const noKeys = sendingStatus({ MO_ENABLED: "true" } as any);
  const xOnly = sendingStatus({ MO_ENABLED: "true", X_MO_CONSUMER_KEY: "a", X_MO_CONSUMER_SECRET: "b", X_MO_ACCESS_TOKEN: "c", X_MO_ACCESS_SECRET: "d", X_MO_USER_ID: "1" } as any);
  check("says plainly when Mo is off", /switched off/.test(off));
  check("says nothing goes out without keys", /nothing goes out/.test(noKeys));
  check("says email isn't set up when only X is", /Email isn't set up/.test(xOnly));
  const p = { no: 3, source: "x", x_handle: "noor", name: "Noor Haddad", reason: "Hosts small builder dinners.", evidence_quote: "design-engineer dinner in the Mission", post_url: "https://x.com/noor/status/1", linkedin_url: null, draft_reply: "Great filter.", draft_dm: "Want an invite?" };
  const t = reviewText(p, 2, "Royce");
  check("the review says it's Mo, greets them, and names the person plainly", t.startsWith("Hey Royce, it's Mo. Found someone worth a look (1 of 2): Noor Haddad (@noor) on X."));
  check("without a name on file it still says it's Mo", reviewText(p, 1).startsWith("It's Mo. Found someone worth a look: Noor Haddad (@noor) on X."));
  check("the review shows their exact words, labeled", t.includes('They wrote: "design-engineer dinner in the Mission"'));
  check("the review links the real post", t.includes("https://x.com/noor/status/1"));
  check("the review shows exactly what Co would send", t.includes('My plan: Co replies to their post with "Great filter.", then I DM them a few days later: "Want an invite?"'));
  check("Mo gives its own read", t.includes("Why I think they'd fit: Hosts small builder dinners."));
  check("the review ends with one plain question", t.trim().endsWith("Want me to go for it? Yes, no, or tell me what to change."));
  check("no #numbers or codes in what approvers read", !/#\d/.test(t));
  const q = questionText({ ...p, pending_question: "Is it free?" }, "Jacqueline");
  check("a prospect's question is relayed word for word", q.startsWith("Hey Jacqueline, it's Mo.") && q.includes('wrote back to Co\'s DM: "Is it free?"') && /I'll send your next text to them word for word\./.test(q));
  // Mo is a person on the team (2026-09-24): first person, never "Mo" in the
  // third person, and Co is always the one prospects hear from.
  const moSrc = src("mo/review.ts");
  const moLines = [...moSrc.matchAll(/return `([^`]*)`/g)].map((m) => m[1]).concat(t, q, sendingStatus({ MO_ENABLED: "false" } as any));
  check("Mo never talks about itself in the third person", !moLines.some((l) => /\bMo (found|has|won't|will|is)\b/.test(l)));
  check("Mo's texts to the team read as first person", /I'll leave \$\{name\} alone/.test(moSrc) && /I've got \$\{name\} marked as sent/.test(moSrc) && /^I'm switched off/.test(sendingStatus({ MO_ENABLED: "false" } as any)));
  const { ENTITIES } = await import("../../src/services/entities.js");
  check("Co and Mo are defined once, as separate entities", ENTITIES.co.name === "Co" && ENTITIES.mo.name === "Mo" && /the people it finds/.test(ENTITIES.mo.talksTo) && ENTITIES.mo.never.includes("text a member") && ENTITIES.co.never.some((n) => /mention Mo .* to a member/.test(n)));
  // Co knows what it can do, so "what can you do?" gets a complete, true
  // answer (Royce, 2026-09-24), and never mentions Mo to a member.
  const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
  const facts = baseReplyFacts().facts.map((f: any) => f.text).join("\n");
  for (const [label, re] of [
    ["calls", /call them right now/], ["photos and voice memos", /read photos and screenshots.*voice memos/], ["corrections", /Co updates it and remembers what changed and when/],
    ["follow-ups", /keeps track of what they're in the middle of/], ["event arrival", /share their location until the end of the day or text "I'm here"/],
    ["outside-event intros", /heads-up without saying who/], ["privacy", /never shares what they've told it with other members/], ["phone change and STOP", /change their phone number by texting Co.*STOP/],
    ["invites", /invite friends to Co/], ["search", /search right now/],
  ] as const) check(`Co knows it can: ${label}`, re.test(facts));
  check("Co's facts never mention Mo", !/\bMo\b/.test(facts));
  const { MO_VOICE } = await import("../../src/mo/moVoice.js");
  check("Mo reaches out as itself but never texts members", /you reach out to them yourself, as Mo/.test(MO_VOICE) && /You never text a member/.test(MO_VOICE));
  check("people are named by name, not handle alone", who(p as any) === "Noor Haddad (@noor)");
  const o = src("mo/outreach.ts");
  check("the 'what went out' text is built only from recorded actions", /if \(line\[action\]\) report\.push/.test(o) && /Only what was recorded as actually happening/.test(o));
  const withLink = codeMessage("ABCDEFGH", "https://api.example/i/ABCDEFGH");
  check("a yes gets the invite link and the code", withLink.includes("https://api.example/i/ABCDEFGH") && withLink.includes("ABCDEFGH") && /already filled in/.test(withLink));
  check("without a public URL, the yes falls back to the code and Co's number", /Text it to Co at/.test(codeMessage("ABCDEFGH", null)));
  check("the first DM still never carries a link", bad("dm", "Loved the post. Want an invite? https://api.example/i/X").includes("dm_no_link"));
  const rv = src("mo/review.ts");
  check("an approval reply says when nothing can go out yet", /const blocked = sendingBlocked\(\);/.test(rv));
}

// ------------------------------------------------ Mo as a teammate (2026-09-24)
{
  const T = await import("../../src/mo/team.js");
  check("tag: 'Mo, ...' is for Mo", T.addressedToMo("Mo, what did you find?") && T.addressedToMo("hey mo how's Noor") && T.addressedToMo("@mo pause"));
  check("tag: 'Mo' inside a sentence to Co isn't", !T.addressedToMo("tell me more about mochi") && !T.addressedToMo("I saw Monica today"));
  const c = (t: string) => T.parseMoCommand(T.stripMo(t));
  check("tag: status", c("Mo, what did you find?")?.kind === "status" && c("Mo")?.kind === "status");
  check("tag: one person", JSON.stringify(c("Mo, how's Noor?")) === JSON.stringify({ kind: "person", query: "Noor" }));
  check("tag: steer the next search", JSON.stringify(c("Mo, find me designers who host events")) === JSON.stringify({ kind: "focus", text: "designers who host events" }));
  check("tag: pause and back on", c("Mo, pause")?.kind === "pause" && c("Mo, back on")?.kind === "resume");
  check("tag: what can you do", c("Mo, what can you do?")?.kind === "help");
  check("tag: a plain yes to what Mo asked isn't a command", c("Mo, yes") === null && c("mo no") === null);
  check("person: plain words for where they stand", T.prospectStatusLine({ name: "Noor Haddad", status: "invited" }) === "Noor Haddad said yes and has their invite, but hasn't joined yet.");
  check("joins: the team hears it in Mo's voice", T.joinText({ name: "Noor Haddad" }) === "It's Mo. Noor Haddad just joined with the invite I sent. They're Co's now.");
  check("gaps: general terms with counts", T.gapsLine([{ gap: "technical cofounders", members: 4 }, { gap: "designers who host events", members: 1 }]) === "The network's shortest on technical cofounders (4 members), designers who host events (1 member), so that's what I'm scouting for.");
  check("styles: which DM is landing", T.styleLine([{ style: "intro", reached: 4, yes: 1 }, { style: "curious", reached: 3, yes: 2 }]) === `So far 1 of 4 said yes to the full intro DM, and 2 of 3 said yes to the short "want to know why?" DM.`);
  check("help: says it's Mo and how to use it", T.moCapabilitiesText("Royce").startsWith("Hey Royce, it's Mo.") && /"Mo, pause" or "Mo, back on"/.test(T.moCapabilitiesText(null)));
  const rv = src("mo/review.ts"), fd = src("mo/find.ts"), ot = src("mo/outreach.ts"), ic = src("services/inviteCodes.ts"), dr = src("mo/draft.ts");
  check("wired: tags are handled before the approval flow", /if \(addressedToMo\(text\)\) \{\n\s+const cmd = parseMoCommand\(stripMo\(text\)\);/.test(rv));
  check("wired: paused means no new reviews, but questions still come through", /if \(await isMoPaused\(\)\) return null;/.test(rv) && rv.indexOf("status = 'question'") < rv.indexOf("if (await isMoPaused()) return null;"));
  check("wired: paused means no searches and no outreach", /if \(await isMoPaused\(\)\) return \{ shortlisted: 0 \};/.test(fd) && /if \(await isMoPaused\(\)\) return;/.test(ot));
  check("wired: a redeemed code tells Mo right away", /m\.noteProspectJoined\(candidate\)/.test(ic) && /await tellTeamAboutJoins\(joined\);/.test(ot));
  check("wired: searches use Co's gaps and the team's asks, not members' words", /What the network is short on right now \(from Co, general terms\)/.test(fd) && !/What members are looking for/.test(fd));
  check("wired: styles alternate and a yes to 'why?' gets the why", /const style = await nextDmStyle\(\);/.test(fd) && /p\.dm_style === "curious" && p\.draft_why \? `\$\{p\.draft_why\}/.test(ot) && /style === "curious"/.test(dr));
}

console.log(`mo rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
