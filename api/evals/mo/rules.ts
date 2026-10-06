// Model-free checks for Mo (src/mo/): the fit gates, the drafts,
// the team agent and Mo as an extension, reply handling, the outreach clock, the do-not-contact
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
check("a good DM passes", bad("dm", "Hey, I'm Mo. I extend invitations to Co, and your post on design-engineer dinners put you on my radar. Want me to send you an invite?").length === 0);
check("the short DM passes", bad("dm", "I'm Mo. I extend invitations to Co, a private social club in San Francisco. Your post about design dinners led me to you. I think you belong. Want to know why?").length === 0);
check("a DM has to say it's Mo", bad("dm", "Co runs a small invite-only club in SF. Would you like an invite?").includes("dm_says_its_mo"));
check("the 'why' has no link or code", bad("why", "You host rooms like that. https://x.co/ABCDEFGH").includes("why_no_link"));
check("the DM never carries a code before they say yes", bad("dm", "Here's your code 6VGF76VK. Want in?").includes("dm_no_code"));
check("the DM asks rather than assumes", bad("dm", "Co runs a small club in SF. You're in.").includes("dm_asks"));
check("the DM has a length limit", bad("dm", `${"x".repeat(MO.maxDmChars)}?`).includes("dm_length"));
check("the email carries the code slot", bad("email", "Co runs a small club in SF. Text Co to join.").includes("email_has_code_slot"));
check("the email doesn't ask them to text a number (the button does)", bad("email", "Your code is {{CODE}}. Text it to Co at {{PHONE}}.").includes("email_no_number") && bad("email", "Your code is {{CODE}}. Text (415) 555-0100.").includes("email_no_number"));
check("a complete email passes", bad("email", "Saw your dinner post.\n\nIf you'd like in, here's your code: {{CODE}}.\n\nMo").length === 0);
check("the email carries no planted link", bad("email", "Your code is {{CODE}}. More at https://evil.example").includes("email_no_link"));
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
  check("a text about something else goes to Co as usual", /let reply = passed && !says\.length && !loose\.length \? null/.test(src("mo/teamAgent.ts")) && /notForMo: tool\(/.test(src("mo/teamAgent.ts")));
  check("an edit has to pass the same draft checks", /redraftOutreach\(p, instruction\)/.test(src("mo/review.ts")) && /checkMoDraft\("dm", dm, \{ dmMax: dmMaxFor\(input\.style\) \}\)/.test(src("mo/draft.ts")));
  check("one open item per approver, cleared for everyone once handled", /WHERE mo_pending_no = \$1/.test(r));
  check("an item someone else already handled isn't acted on twice", /Someone already took care of that one\./.test(r));
  const route = src("routes/sendblue.ts");
  check("approver answers aren't logged as conversation", /if \(ext !== null\) \{/.test(route) && !/ext\.reply[\s\S]{0,300}logTextExchange/.test(route));
  const noor = { name: "Noor Haddad", x_handle: "noorbuilds" };
  check("after Co has texted them, 'yes' alone isn't taken as Mo's answer", !namesThisItem("yes", noor));
  check("'yes to Noor' is", namesThisItem("yes to Noor", noor) && namesThisItem("@Mo yes", noor) && namesThisItem("skip @noorbuilds", noor));
  check("that guard is in place (unless they replied to Mo's own text or Co handed it over)", /if \(!forMo && pending && coSpoke && !namesThisItem\(text, pending\.p\)\) return null;/.test(r) && /const forMo = Boolean\(opts\.repliedTo\) \|\| Boolean\(opts\.handedOff\);/.test(r));
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
  check("Mo is off unless MO_ENABLED is true", /enabled: \(\) => moEnabled\(\)/.test(src("mo/extension.ts")) && /if \(!rt\?\.enabled\(\)\) continue;/.test(src("services/extensions.ts")) && /extensionJobs\(\)/.test(jobs));
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
  const { reviewMessages, firstSentence } = await import("../../src/mo/review.js");
  const m = reviewMessages(p, 2);
  const t = m.join("\n\n");
  check("tier format: the link comes first, on its own (so it shows a preview)", m[0] === "https://x.com/noor/status/1");
  check("tier format: then one line on who, what they wrote, and why", m[1] === `Noor Haddad (@noor) on X, 1 of 2. They wrote: "design-engineer dinner in the Mission" Hosts small builder dinners.`);
  check("tier format: then exactly what would go out", m[2] === 'Co replies to their post: "Great filter."\n\nThen I DM them: "Want an invite?"');
  check("tier format: one question last, on its own", m[3] === "Want me to go for it? Yes, no, or tell me what to change." && m.length === 4);
  check("when it isn't obvious who's texting, Mo says so first, briefly", reviewMessages(p, 1, "Mo here.")[1].startsWith("Mo here. Noor Haddad (@noor) on X. They wrote:"));
  check("short: Mo's reason is cut to one sentence", firstSentence("Hosts dinners. Also runs a newsletter and a podcast.") === "Hosts dinners." && firstSentence("x ".repeat(200)).length <= 180);
  check("curious style shows the why they'd get", reviewMessages({ ...p, dm_style: "curious", draft_why: "You host rooms like that." }, 1)[2].endsWith('If they ask why: "You host rooms like that."'));
  check("no #numbers or codes in what approvers read", !/#\d/.test(t));
  const q = questionText({ ...p, pending_question: "Is it free?" });
  check("a prospect's question is relayed word for word", q === 'Noor Haddad (@noor) wrote back: "Is it free?"\n\nWhat should I say? I\'ll send your answer word for word.');
  // Mo is a person on the team (2026-09-24): first person, never "Mo" in the
  // third person, and Co is always the one prospects hear from.
  const moSrc = src("mo/review.ts");
  const moLines = [...moSrc.matchAll(/return `([^`]*)`/g)].map((m) => m[1]).concat(t, q, sendingStatus({ MO_ENABLED: "false" } as any));
  check("Mo never talks about itself in the third person", !moLines.some((l) => /\bMo (found|has|won't|will|is)\b/.test(l)));
  check("Mo's texts to the team read as first person", /I'll leave \$\{firstName\(p\)\} alone/.test(moSrc) && /I'll email them from Co if I can find a public address/.test(moSrc) && /^I'm switched off/.test(sendingStatus({ MO_ENABLED: "false" } as any)));
  const { ENTITIES } = await import("../../src/services/entities.js");
  check("Co and Mo are defined once, as separate entities", ENTITIES.co.name === "Co" && ENTITIES.mo.name === "Mo" && /the people it finds/.test(ENTITIES.mo.talksTo) && ENTITIES.mo.never.includes("text a member") && ENTITIES.co.never.some((n) => /mention Mo .* to a member/.test(n)));
  // Co knows what it can do, so "what can you do?" gets a complete, true
  // answer (Royce, 2026-09-24), and never mentions Mo to a member.
  const { baseReplyFacts } = await import("../../src/harness/replyGrounding.js");
  const facts = baseReplyFacts().facts.map((f: any) => f.text).join("\n");
  for (const [label, re] of [
    ["calls", /call them right now/], ["photos and voice memos", /read photos and screenshots.*voice memos/], ["corrections", /Co updates it and remembers what changed and when/],
    ["follow-ups", /check-in every few days about what they\'re in the middle of/], ["event arrival", /share their location until the end of the day or text "I'm here"/],
    ["outside-event intros", /heads-up without saying who/], ["privacy", /never shares what they've told it with other members/], ["phone change and STOP", /change their phone number by texting Co.*STOP/],
    ["invites", /invite friends to Co/], ["search", /look up events itself/], ["web search", /search the web for venues to book/],
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
  check("person: plain words for where they stand", T.prospectStatusLine({ name: "Noor Haddad", status: "invited" }) === "Noor Haddad said yes and has their invite, but hasn't joined yet.");
  check("joins: the team hears it in Mo's voice", T.joinText({ name: "Noor Haddad" }) === "It's Mo. Noor Haddad just joined with the invite I sent. They're Co's now.");
  check("gaps: general terms with counts", T.gapsLine([{ gap: "technical cofounders", members: 4 }, { gap: "designers who host events", members: 1 }]) === "The network's shortest on technical cofounders (4 members), designers who host events (1 member), so that's what I'm scouting for.");
  check("styles: which DM is landing", T.styleLine([{ style: "intro", reached: 4, yes: 1 }, { style: "curious", reached: 3, yes: 2 }]) === `So far 1 of 4 said yes to the full intro DM, and 2 of 3 said yes to the short "want to know why?" DM.`);
  const rv = src("mo/review.ts"), fd = src("mo/find.ts"), ot = src("mo/outreach.ts"), ic = src("services/inviteCodes.ts"), dr = src("mo/draft.ts");
  check("wired: Mo reads the team's texts itself, no keyword parser", /runMoTeamTurn\(/.test(rv) && !/parseMoCommand|readAnswer/.test(rv + src("mo/team.ts")));
  check("wired: paused means no new reviews, but questions still come through", /if \(await isMoPaused\(\)\) return null;/.test(rv) && rv.indexOf("status = 'question'") < rv.indexOf("if (await isMoPaused()) return null;"));
  check("wired: paused means no searches and no outreach", /if \(await isMoPaused\(\)\) return \{ shortlisted: 0 \};/.test(fd) && /if \(await isMoPaused\(\)\) return;/.test(ot));
  check("wired: a redeemed code tells Mo right away", /m\.noteProspectJoined\(candidate, userId\)/.test(ic) && /await tellTeamAboutJoins\(joined\);/.test(ot));
  check("wired: searches use Co's gaps and the team's asks, not members' words", /What the network is short on right now \(from Co, general terms\)/.test(fd) && !/What members are looking for/.test(fd));
  check("LinkedIn keeps what the result showed, so redrafts can be checked against it", /NULL, \$9, \$10, \$12, \$13\) ON CONFLICT DO NOTHING`,\n\s+\[li\.name, li\.url, li\.headline, li\.reason, li\.quote, drafts\.dm, drafts\.emailSubject, drafts\.emailBody, style, drafts\.why, shown, opener, w\.event\]/.test(fd));
  // The team never sends anything by hand (Royce, 2026-09-24).
  check("never asks the team to send anything", !/yours to send|note would come from you|send this note for me|Text me "sent"/.test(rv) && !/manual_pending' ORDER BY/.test(rv));
  check("a yes on a LinkedIn-only person means an email from Co, not a task for you", /only on LinkedIn, which I can't message, so I'll email them from Co/.test(rv));
  check("leftover 'send this note' items go back into Mo's own outreach", /UPDATE mo_prospects SET status = 'approved', channel = NULL, updated_at = NOW\(\) WHERE status = 'manual_pending'/.test(src("db/migrations.ts")));
  check("LinkedIn skips the X warm-up and goes straight to reaching out", nextOutreachStep({ status: "approved", hasPost: false, channel: null, warmedAt: null, contactedAt: null, followedUpAt: null, lastInboundAt: null }, new Date()) === "contact" && nextOutreachStep({ status: "approved", hasPost: true, channel: null, warmedAt: null, contactedAt: null, followedUpAt: null, lastInboundAt: null }, new Date()) === "warm");
  const { MO_VOICE: V } = await import("../../src/mo/moVoice.js");
  check("Mo's definition: it sends everything itself", /You never ask the team to send, post, or forward anything for you/.test(V));
  check("wired: styles alternate and a yes to 'why?' gets the why", /const style = await nextDmStyle\(\);/.test(fd) && /p\.dm_style === "curious" && p\.draft_why \? `\$\{p\.draft_why\}/.test(ot) && /style === "curious"/.test(dr));
}

// ------------------------------------------------ Mo as an extension of Co (2026-09-26)
{
  const A = await import("../../src/mo/abilities.js");
  const TA = await import("../../src/mo/teamAgent.js");
  const H = await import("../../src/mo/handoff.js");
  const L = await import("../../src/mo/learn.js");
  const E = await import("../../src/services/extensions.js");
  const { guardTools } = await import("../../src/agent/toolGuard.js");
  const { setSwitchesForTest } = await import("../../src/services/abilitySwitches.js");
  const { z } = await import("zod");
  const ta = src("mo/teamAgent.ts");

  // 1. Same frame as Co
  const tools = [...new Set([...ta.matchAll(/^\s{4}(mo[A-Z]\w+): tool\(/gm)].map((m) => m[1]))];
  check("every Mo tool has an entry in Mo's registry", tools.length === A.MO_ABILITIES.length && tools.every((t) => A.moAbilityForTool(t)));
  check("tool descriptions come from the registry", tools.every((t) => ta.includes(`moToolUse("${t}")`)));
  check("reaching out needs the approver's own yes", A.moAbilityForTool("moApprove")?.confirm === "affects_another_member");
  const sheet = A.moCapabilitySheet().join(" ");
  check("Mo knows its hard lines", /never name a member/.test(sheet) && /send everything myself/.test(sheet) && /never text members/.test(sheet));
  check("Mo's tools go through Co's guard with Mo's registry", /abilityFor: moAbilityForTool/.test(ta));
  check("an answer to a prospect is the approver's own words", /deps\.answer\(pending!\.p, input\.text\)/.test(ta));
  {
    let ran = 0;
    const approveWith = (message: string, notes: string[] = []) =>
      guardTools({ moApprove: { inputSchema: z.object({}), execute: async () => ((ran += 1), { ok: true }) } } as any, { userId: "u", resolvedContent: message, dryRun: true, notDone: (w) => notes.push(w), abilityFor: A.moAbilityForTool });
    setSwitchesForTest({});
    const notes: string[] = [];
    const r1: any = await approveWith("hmm let me think", notes).moApprove.execute({ theirYes: "yes" }, {});
    check("guard: no approval without their yes in the message", r1.ok === false && ran === 0 && notes.length === 1);
    await approveWith("yes go for it").moApprove.execute({ theirYes: "yes go for it" }, {});
    check("guard: runs on their yes", ran === 1);
    setSwitchesForTest({ mo_approve: "testing" });
    const r3: any = await approveWith("yes").moApprove.execute({ theirYes: "yes" }, {});
    check("guard: a switched-off Mo ability doesn't run", r3.ok === false && ran === 1);
    setSwitchesForTest({});
  }
  check("reply: carries what the tools said", TA.finalReply("On it. Co replies to Noor's post first.", ["On it. Co replies to Noor's post first."], "Royce") === "On it. Co replies to Noor's post first.");
  check("reply: a paraphrase loses to the tools' own words", TA.finalReply("Done, I messaged Noor!", ["On it. Co replies to Noor's post first."], "Royce") === "On it. Co replies to Noor's post first.");
  check("reply: the opener only once", TA.finalReply("Hey Royce, it's Mo. Hey Royce, it's Mo. 2 people are waiting on your yes.", ["Hey Royce, it's Mo. 2 people are waiting on your yes."], "Royce") === "Hey Royce, it's Mo. 2 people are waiting on your yes.");
  {
    const pausedLine = "Paused. No new searches or outreach until you tell me to start again. If someone I already reached out to writes back, I'll still bring it to you.";
    const L = [{ text: pausedLine, mustInclude: ["paus", "write", "back"] }];
    check("reply: Mo can say a pause in its own words when the facts are there", TA.finalReply("Done, paused. Nothing new goes out, but if anyone writes back I'll still bring them to you.", [], "Royce", L) === "Done, paused. Nothing new goes out, but if anyone writes back I'll still bring them to you.");
    check("reply: ...and the exact receipt goes out when its facts aren't", TA.finalReply("Sure thing!", [], "Royce", L).includes(pausedLine));
  }
  check("reply: no spaced hyphen used as a dash either", !TA.finalReply("I can't push more out today - it's capped.", [], null).includes(" - "));
  check("Mo's replies are held to its facts, like Co's", /if \(reply && !onlyToolLines\(reply, \[\.\.\.says, \.\.\.loose\.map\(\(l\) => l\.text\)\]\)\) reply = await holdToFacts\(/.test(ta) && /for \(const c of moCapabilitySheet\(\)\) addFact\(rf, "capability", c\);/.test(ta));
  check("Mo's limits say it can't send faster or on demand", /I can't send faster, sooner, or on demand/.test(A.moCapabilitySheet().join(" ")));
  check("reply: no em dashes", !TA.finalReply("Paused — nothing new goes out.", [], null).includes("—"));
  const pl = TA.pendingLine({ kind: "review", p: { name: "Noor Haddad", source: "x", draft_dm: "Hi" } });
  check("prompt: says who Mo is waiting on and which tool fits", /Noor Haddad/.test(pl) && /moApprove/.test(pl) && /moSkip/.test(pl));
  check("prompt: a message for Co goes to Co", /notForMo/.test(TA.teamSystem({ approverFirst: "Royce", pending: null, coSpoke: false })));
  check("prompt: after Co spoke, a short yes is probably Co's", /probably an answer to Co/.test(TA.teamSystem({ approverFirst: "Royce", pending: { kind: "review", p: { name: "Noor", source: "x" } }, coSpoke: true })));

  // 2. Handoff
  const h = H.handoffLine({ source: "x", evidence_quote: "shipping a climate data tool with two friends", bio: "builder", invited_for: "Rooftop evening on Friday, October 10", their_words: [{ text: "sounds great, what's the vibe?" }] });
  check("handoff: what was public, their own words, and the event", !!h && h.includes("shipping a climate data tool") && h.includes("what's the vibe?") && h.includes("Rooftop evening"));
  check("handoff: ask, don't state; never how or who", !!h && /as a question/.test(h) && /never as a fact/.test(h) && /Never say how you know it/.test(h) && /never mention anyone called Mo/.test(h));
  check("handoff: nothing known, nothing said", H.handoffLine({ source: "x" }) === null);
  const rg = src("harness/replyGrounding.ts");
  check("handoff reaches Co as an instruction, never a citable fact", /for \(const line of handoff\.instructions\) addInstruction\(rf, line\);/.test(rg) && /for \(const k of handoff\.known\) addFact\(rf, "known", k\);/.test(rg));
  check("handoff: the only plain fact is how they got in", H.HANDOFF_FACT === "They came in on one of the club's own invitations, not through a friend's invite.");
  check("handoff: asked how they got in, Co says so plainly", !!h && /never pretend not to know/.test(h));
  check("joins record who they became", /noteProspectJoined\(candidate, userId\)/.test(src("services/inviteCodes.ts")) && /joined_user_id = ic\.used_by/.test(src("mo/outreach.ts")));
  check("a prospect's replies are kept in their own words", /their_words = \(their_words \|\| jsonb_build_array/.test(src("mo/outreach.ts")));

  // 3. The room
  const tm = src("mo/team.ts");
  check("room: from the next Co event's guests, general terms, leak rule", /export async function roomNeeds/.test(tm) && /getEventGuestList/.test(tm) && /return gaps\.filter\(\(g\) => !queryLeaks\(g\.gap, lines, nameList\)\)/.test(tm));
  check("room: guests' needs come ahead of the network's gaps", /put these ahead of the network's gaps/.test(src("mo/find.ts")));
  check("gaps: only asks a search can meet (not sponsors)", /a\.resolved_at IS NULL AND a\.kind = 'find' AND u\.archived_at IS NULL/.test(tm));

  // 4. Learning
  check("learn: an event or an intro yes means they took to Co", L.tookToCo({ replies: 0, events: 1, introYes: 0, daysSinceJoin: 3 }) === "active" && L.tookToCo({ replies: 0, events: 0, introYes: 1, daysSinceJoin: 3 }) === "active");
  check("learn: a week of near silence is quiet; less is early", L.tookToCo({ replies: 1, events: 0, introYes: 0, daysSinceJoin: 8 }) === "quiet" && L.tookToCo({ replies: 1, events: 0, introYes: 0, daysSinceJoin: 3 }) === "early");
  check("learn: the team sees counts only", L.outcomesLine([{ took: "active" }, { took: "active" }, { took: "quiet" }]) === "Of the 3 who joined through me, 2 have really taken to Co, 1 went quiet.");
  const fd2 = src("mo/find.ts");
  check("learn: lessons shape the search plan and the judging", /What's worked with people you invited before/.test(fd2) && /What's predicted people taking to the club before/.test(fd2));
  check("learn: lessons can't carry names", /lessons = lessons\.filter\(\(l\) => !queryLeaks\(l, source, nameList\)\)/.test(src("mo/learn.ts")));

  // 5. Extensions
  const mo = E.EXTENSIONS.find((e) => e.id === "mo");
  check("extension: Mo is registered with its abilities and voice", !!mo && mo.abilities === A.MO_ABILITIES && mo.voiceFile === "mo/moVoice.ts");
  const rt = mo ? await mo.load() : null;
  check("extension: Mo plugs in team texts, handoff and its jobs (the team's four, then member Mo's three, each a no-op unless MO_MEMBER_ENABLED)", !!rt?.teamText && !!rt?.handoff && (rt?.jobs ?? []).map((j) => j.name).join(",") === "mo find,mo digest,mo outreach,mo inbox,mo member offers,mo member hunts,mo member outreach");
  check("wired: texts, reply facts and jobs go through the registry", /handleTeamText\(user\.id, content, \{ \.\.\.\(repliedToExt \?/.test(src("routes/sendblue.ts")) && /extensionJobs\(\)/.test(src("jobs/index.ts")) && !/from "\.\.\/mo\//.test(src("jobs/index.ts") + src("routes/sendblue.ts")));
  check("monitor: each extension tool has a drift signal", /EXTENSIONS\.flatMap/.test(src("harness/monitor.ts")));
}

// ------------------------------------------------------------ socially aware, both of them (2026-09-28)
{
  const C = await import("../../src/services/capabilities.js");
  const X = await import("../../src/services/extensions.js");
  const G = await import("../../src/harness/replyGrounding.js");
  const memberSheet = C.capabilitySheet().join("\n");
  const teamSheetAll = [...C.capabilitySheet({ team: true }), ...X.teamSheet()].join("\n");
  check("a member's capability facts never include team-only abilities or Mo while member Mo is off", !/\bMo\b|teammate/i.test(memberSheet) && !C.ABILITIES.filter((a: any) => a.teamOnly).some((a: any) => memberSheet.includes(a.can)));
  {
    // With member Mo on, a member hears about it (and only its member-facing abilities), never the team's.
    const onSheet = (() => { const was = [process.env.MO_MEMBER_ENABLED, process.env.MO_ENABLED]; process.env.MO_MEMBER_ENABLED = "true"; process.env.MO_ENABLED = "true"; try { return C.capabilitySheet().join("\n"); } finally { process.env.MO_MEMBER_ENABLED = was[0]; process.env.MO_ENABLED = was[1]; if (was[0] === undefined) delete process.env.MO_MEMBER_ENABLED; if (was[1] === undefined) delete process.env.MO_ENABLED; } })();
    check("with member Mo on, a member's facts include its member-facing abilities and still no team-only ones", C.ABILITIES.filter((a: any) => a.id.startsWith("mo_member_")).every((a: any) => onSheet.includes(a.can)) && !C.ABILITIES.filter((a: any) => a.teamOnly).some((a: any) => onSheet.includes(a.can)) && !/teammate/i.test(onSheet));
    check("member Mo's tools are removed from the tool map while it is off", /if \(!memberMoOn\(\)\) for \(const name of memberMoTools\(\)\) delete/.test(src("agent/conversationTools.ts")) && C.memberMoTools().length === 6);
  }
  check("the team's facts say what Mo does, and not to pitch it as new", /Mo is Co's teammate/.test(teamSheetAll) && /don't pitch what Mo already does as a new idea/.test(teamSheetAll) && /never mention Mo to anyone else/.test(teamSheetAll));
  const tools = src("agent/conversationTools.ts");
  check("team-only tools are removed from the tool map for everyone else", /if \(!ctx\.isTeam\) for \(const name of teamOnlyTools\(\)\) delete/.test(tools) && C.teamOnlyTools().includes("handToTeammate"));
  check("team facts are added only for team members", /if \(await isTeamMember\(userId\)\.catch\(\(\) => false\)\) \{\s*for \(const line of teamSheet\(\)\)/.test(src("harness/replyGrounding.ts")));
  // The limit is said as what's true (it can't call other people), without quoting the old wrong phrase: quoted bad examples get copied.
  check("Co knows it texts first, and that it calls them but not other people", /Co texts first, not only when they text/.test(memberSheet) && /can't call other people for them; calling them is something it does/.test(memberSheet) && !/no calls/.test(memberSheet));
  check("any way of saying Co can't call is caught", ["And I can't act for you, no calls, no bookings.", "I can't make calls.", "No phone calls on my end.", "This is just text."].every((t) => G.callDenial(t)));
  check("...but the real limit, calling others for them, passes", ["I can't call people for you, but I can call you.", "No calls to sponsors from me, that has to be you.", "I can call you anytime."].every((t) => !G.callDenial(t)));
  check("Mo's texts are known by their opener, from before senders were saved", X.extensionByOpener("Hey Royce, it’s Mo. So on Harneet: want me to go for it?") === "mo" && X.extensionByOpener("Hey Royce, it's Mo.") === "mo" && X.extensionByOpener("Good pick. Tuesday at WorkOS.") === null);
  const sbs = src("services/sendblue.ts");
  check("every send records who sent it", /const sender = senderContext\.getStore\(\) \?\? "co";/.test(sbs) && /INSERT INTO outbound_messages \(message_handle, user_id, content, sender\)/.test(sbs) && /sendingAs\("mo", \(\) => sendblue\.messages\.send/.test(src("mo/review.ts")));
  check("a reply under Mo's own text goes to Mo, only for their own messages", /extensionForMessage\(user\.id, pressed\)/.test(src("routes/sendblue.ts")) && /WHERE message_handle = \$1 AND user_id = \$2/.test(src("services/extensions.ts")));
  const { awarenessLines } = await import("../../src/mo/teamAgent.js");
  const a = awarenessLines({ recent: "User said: hi", topic: "Harneet's outreach", pushback: "wrong person", lessons: ["answer the logistics"], repliedTo: "So on Harneet: go for it?", handedOff: true });
  check("Mo sees the thread, the topic, pushback, its lessons, and what it's replying to", /The thread so far/.test(a) && /Harneet's outreach/.test(a) && /pushing back on what you said: wrong person/.test(a) && /answer the logistics/.test(a) && /pressed Reply on your own text/.test(a) && /Co tagged you in/.test(a));
  check("Mo's lessons are its own, and saved from pushback with its own tool (no extra model read)", /saveLesson\(input\.userId, `\[Mo\] \$\{l\}`\)/.test(src("mo/teamAgent.ts")) && /noteLesson: tool\(/.test(src("mo/teamAgent.ts")) && !/readMoment\(/.test(src("mo/teamAgent.ts")));
}

// ------------------------------------------------------------ Mo's own voice (2026-09-28)
{
  const V = await import("../../src/mo/moVoice.js");
  const TA = await import("../../src/mo/teamAgent.js");
  const now = new Date("2026-09-28T20:00:00Z");
  check("Mo says who it is when Co spoke last, or it's been a while, and not otherwise", V.introNeeded({ sender: "co", sentAt: now }, now) && V.introNeeded({ sender: "mo", sentAt: new Date(now.getTime() - 7 * 3600_000) }, now) && !V.introNeeded({ sender: "mo", sentAt: new Date(now.getTime() - 3600_000) }, now) && V.introNeeded(null, now));
  check("no fixed greeting: the intro is short, varies, and is empty when not needed", V.MO_RULES.intro(false) === "" && new Set([0, 1, 2].map((m) => V.MO_RULES.intro(true, new Date(Date.UTC(2026, 8, 28, 20, m))))).size === 3 && ![0, 1, 2].some((m) => /^Hey /.test(V.MO_RULES.intro(true, new Date(Date.UTC(2026, 8, 28, 20, m))))));
  check("Mo has its own personality, as principles, not quoted lines", /sharp, upbeat one who goes out and finds people/.test(V.MO_VOICE) && /let the wording vary/.test(V.MO_VOICE) && !/"Hey [A-Z]/.test(V.MO_VOICE));
  check("the team turn tells Mo when to say it's Mo, never with a set greeting", /don't announce yourself; just talk/.test(TA.identityLine({ needsIntro: false } as any)) && /rather than as a set greeting/.test(TA.identityLine({ needsIntro: true } as any)) && !/open with "/.test(TA.teamSystem({ approverFirst: "Royce", pending: null, coSpoke: false, awareness: null } as any)));
  const moSrc2 = src("mo/review.ts") + src("mo/team.ts") + src("mo/teamAgent.ts");
  check("no team text is scripted to start with \"Hey <name>, it's Mo\"", !/Hey \$\{[a-zA-Z.]+\}, it'?s Mo/.test(moSrc2) && !/MO_RULES\.opener/.test(moSrc2));
}

{
  const { callsMo } = await import("../../src/mo/review.js");
  check("@Mo calls Mo in, anywhere in the text", callsMo("@Mo what's in the queue?") && callsMo("hey @mo hold off on Harneet") && callsMo("can you ask @Mo about it"));
  check("just mentioning Mo stays with Co", !callsMo("You have a partner named Mo that does that") && !callsMo("Mo already does that") && !callsMo("tell Mo to pause") && !callsMo("email me at x@mo.com") && !callsMo("@Moses"));
  const fs = await import("fs");
  const tools = fs.readFileSync(new URL("../../src/agent/conversationTools.ts", import.meta.url), "utf8");
  check("when Co brings Mo in, it tags a bare @Mo, and that isn't Co speaking", /const tag = "@Mo";/.test(tools) && /message: tag, asVoice: false/.test(tools) && /`Co tagged Mo: \$\{tag\}`/.test(tools));
}
{
  // Co and Mo talking to each other (Royce, 2026-09-28).
  const T = await import("../../src/mo/teamAgent.js");
  const R = await import("../../src/mo/review.js");
  const fs = await import("fs");
  const src = (f: string) => fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
  check("an action needs a quote of their own words, not Co's note", T.quoteIsTheirs("Pause on it", "Pause on it") && T.quoteIsTheirs("pause all outreach", "Pause all outreach this week") && !T.quoteIsTheirs("stand down on that", "Pause on it") && !T.quoteIsTheirs("", "yes") && !T.quoteIsTheirs(undefined, "yes"));
  check("every action Mo takes is held to their words when Co brought the message", ["moPause", "moResume", "moApprove", "moSkip", "moChangeDraft", "moSetFocus", "moSendAnswer"].every((n) => T.ACTS_ON_THEIR_WORD.includes(n)) && /needsTheirWords = viaCo && ACTS_ON_THEIR_WORD\.includes\(name\)/.test(src("mo/teamAgent.ts")));
  const t0 = new Date("2026-09-28T19:23:00Z");
  check("Mo keeps the floor while it spoke last; Co has it only after Co speaks", !R.coSpokeAfter({ sender: "mo", sentAt: new Date("2026-09-28T19:27:00Z") }, t0) && R.coSpokeAfter({ sender: "co", sentAt: new Date("2026-09-28T19:27:00Z") }, t0) && !R.coSpokeAfter({ sender: "co", sentAt: new Date("2026-09-28T19:20:00Z") }, t0) && !R.coSpokeAfter(null, t0));
  const consultSrc = src("mo/teamAgent.ts").slice(src("mo/teamAgent.ts").indexOf("export async function runMoConsult"));
  check("a quiet question is read-only: status only, never the next person, never an action", /deps\.status\(input\.approverFirst, true\)/.test(consultSrc) && !/deps\.(pause|approve|skip|change|answer|focus)/.test(consultSrc));
  check("asking Mo quietly makes no model call at all", !/generateText\(/.test(consultSrc));
  check("a reply that is only Mo's tool lines skips the extra fact check", T.onlyToolLines("Paused. Nothing new goes out.", ["Paused. Nothing new goes out."]) && !T.onlyToolLines("Paused. Also I found you three great people.", ["Paused."]) && !T.onlyToolLines("hi", []));
  check("Mo's half of the thread is in the record Co reads, and messages to Mo are marked", /`Mo replied: \$\{content\.slice\(0, 2000\)\}`/.test(src("services/sendblue.ts")) && /\[to \$\{ext\.extension === "mo" \? "Mo" : ext\.extension\}\]/.test(src("routes/sendblue.ts")));
  const caps = await import("../../src/services/capabilities.js");
  check("asking Mo quietly is team-only, like the handoff", caps.teamOnlyTools().includes("askTeammate") && caps.teamOnlyTools().includes("handToTeammate") && !caps.capabilitySheet({ team: false } as any).join(" ").includes("quietly ask its teammate"));
}
console.log(`mo rules: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
