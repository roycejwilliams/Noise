import { renderRead } from "../services/opportunityRead.js";
import type { TierMatch } from "../services/tieredRecommendation.js";
import { formLabel } from "../services/findForm.js";
import { CO_WHY } from "../services/coVoice.js";
import { draftAgain, draftProactive, nameTokens, type Facts, type OutputRules } from "../harness/proactive.js";
import { renderEventDetails } from "../services/eventDetails.js";
import { stripClosingQuestion } from "../services/offerFollowUp.js";
import { IDENTITY_RULE, stripUngroundedIdentity } from "../services/identityGuard.js";
import { identityDropped } from "../services/guardDrops.js";
import { isShortNotice } from "../services/eventSurfacingSweep.js";
import { audienceSayings, audienceTokens, isGroupAimed } from "../services/eventAudience.js";

// Layer 7 (2026-09-14): this file only drafts. The event/opportunity found by
// the sweep (eventSurfacingSweep.ts) becomes an "event_offer" candidate, and
// src/harness/proactive.ts decides whether it goes out today and sends it.
//
// One match per text, always (Royce, 2026-08-30): a friend mentions ONE
// thing, not a list. Ask-first by default: the tease hints and asks, and the
// name/link only go out once they say yes (routes/sendblue.ts). Short notice
// (today or tomorrow) skips the tease and reveals directly: link as its own
// message first for the iMessage preview, then the drafted line.

// No stated ask means askText was built from their profile; the draft must
// not claim they said it.
// Asks are orders, goals are direction (Royce, 2026-10-09): a find for something they asked for is Co doing what they said; a find
// from where they're headed is something Co noticed for them, never framed as their request.
export function describeAsk(askText: string, fromProfile: boolean): string {
  return fromProfile
    ? `They didn't ask for this. You noticed it for them, from where they're headed (what they've shared with you over time: ${askText}). Bring it up as something you noticed for them; never say or imply they asked for it or were looking for it.`
    : `They asked you for this: "${askText}". This is you doing what they asked: you found it for them.`;
}

// A goal find said as if they'd asked for it (Royce, 2026-10-09: goal finds frame as "Co noticed this for you"). Only a claim that
// they asked or were looking: "you mentioned wanting X" ties it to their goal truthfully and passes (review of #128).
export const CLAIMS_THEY_ASKED = { pattern: /\byou(?:'d| had)? asked\b|\byou (?:wanted|asked) me to\b|\b(?:like|as) you (?:asked|requested|wanted)\b|\bper your (?:ask|request)\b|\byou(?:'re| are|'ve been| have been| were) (?:looking|searching|hunting) for\b|\byou were looking\b|\bthe (?:\w+ )?you asked (?:me )?(?:about|for)\b/i, reason: "says they asked for it or were looking for it, and they didn't: Cue noticed it for them" };

// What it is, from its form (services/findForm.ts): "an event on Saturday", "an opening, applications close Friday", never the
// generic "a real opportunity" (Royce, 2026-10-09).
function kindLabel(match: TierMatch, zone: string | null = null): string {
  return formLabel(match, zone);
}

function matchFacts(askText: string, fromProfile: boolean, match: TierMatch): Facts {
  return {
    why_you_are_texting: describeAsk(askText, fromProfile),
    kind: kindLabel(match),
    name: match.name,
    date: "event_date" in match ? match.event_date : null,
    application_deadline: "deadline" in match ? (match.deadline ?? null) : null,
    why_it_fits: match.whyItFits ?? match.reason,
    ...(isGroupAimed(match.audience) ? { who_it_is_for: match.audience } : {}),
  };
}

// An event aimed at a group says so, in plain words, always. Never a guess about who they are, and
// never a claim that it is or isn't for them.
export const AUDIENCE_RULE = `If who_it_is_for is given, or the event's details say its page speaks to a particular group ("Who it's for"), say plainly in a few words who it's for, as a fact about the event ("it's a women's hike club"), so they can tell whether it's for them. Never say or imply what they are: no "perfect for you", no "which you are", no "as a woman". Don't ask them. Every time, even if their ask uses that group's words: using a word is not being in the group.`;
// No "thinking about you" opener and no invented bridge to the rest of their life.
export const OFFER_HONESTY = `Never say you were thinking about them or about this. Connect it to something else in their life only when the event's own page says it is about that; an event is never "a way into" a community unless its page says so.`;
// Co as the subject, with them or this as the object: the member's own "thinking about getting outside" stays.
export const OFFER_FORBIDDEN = { pattern: /\b(?:thinking|thought) (?:about|of) (?:you|it|that|this)\b|\bon my mind\b|\bcrossed my mind\b/i, reason: "a claim about what Cue was doing, and a line that fits anyone" };
// Implying they are, or aren't, in the group the event is for.
export const IMPLIES_IDENTITY = { pattern: /\b(?:women|girls|ladies|men|guys|moms|dads|group)\b[^.]{0,50}\b(?:perfect|ideal|made|built|just) for you\b|\bwhich you are\b|\bsince you(?:'re| are) a\b|\bas a (?:woman|man|girl|guy|mom|dad)\b/i, reason: "implies who they are" };

// The reveal can use the real record; the tease can't (it names nothing).
// What it is comes from its own page (Royce, 2026-11-10): the page read at send (services/sendCheck.ts) when there is one. A post that
// listed it among other things (a roundup) only proves it was mentioned: it's labelled as that, never described as the thing itself.
// A roundup shared as a roundup (Royce, 2026-11-10): what it is, from the post's own words; nothing about the listed programs checked.
// A roundup shared as a roundup: the note every drafting path adds (the bundle, the single reveal, a bounce proposal), and the claim it
// may never make. Round-5 review: "open now", "taking applications", "still accepting", "closing", "spots", "open for/to/until" too.
export const ROUNDUP_NOTE = " (a post listing several places, not one program: say it's a list and what it covers, from the post's own words; never say any listed program's terms, availability or deadlines are checked or current; skip it if the list as a whole doesn't help what they're after)";
export const VERIFIED_CLAIM = /\b(?:verified|confirmed|checked|still open|open now|(?:applications?|apps) (?:are )?(?:still )?open|taking applications|(?:still )?accepting|closing|deadline is|due (?:on|by)|spots?|open (?:for|to|until))\b/i;
export const UNCHECKED_CLAIM = { pattern: VERIFIED_CLAIM, reason: "says something about a listed program's terms, availability or deadline that nobody checked" };
export const ROUNDUP_SHARED_FACT = "this link is a post listing several places, not one program's page: share it as that list, described from the post's own words (source_post); none of the listed programs' terms, availability or deadlines were checked";
function revealFacts(askText: string, fromProfile: boolean, match: TierMatch): Facts {
  const roundup = !!match.foundInRoundup;
  return {
    ...matchFacts(askText, fromProfile, match),
    details: match.details ? renderEventDetails(match.name, match.details) : null,
    ...(match.pageNow ? (match.pageIsAbout ? { a_page_about_it_read_at_send: match.pageNow.slice(0, 1500) } : { its_own_page_read_at_send: match.pageNow.slice(0, 1500) }) : {}),
    // The one read of what it is and what its facts support (services/opportunityRead.ts), made at the send-time read.
    ...(match.read ? { what_it_is_read_at_send: renderRead(match.name, match.read).join("\n") } : {}),
    ...(match.sendAsRoundup
      ? { where_it_was_found: ROUNDUP_SHARED_FACT, source_post: match.opportunity?.postText ?? null }
      : roundup
        ? { where_it_was_found: `a post listing several things, this among them (${match.foundInRoundup}); the post is not this thing's page and says nothing current about its terms` }
        : { source_post: match.opportunity?.postText ?? null }),
  };
}

// What a reveal's prices and counts may come from (Phase B, B4, 2026-10-10): its name, its own page's record (refreshed at send,
// services/sendCheck.ts), the post it came from, and what they said themselves. Never the fit read (whyItFits), which is a model's.
export function captionRecord(askText: string, match: TierMatch, own: string[] = []): string {
  return [match.name, askText, "event_date" in match ? match.event_date : "", "deadline" in match ? (match.deadline ?? "") : "", ...(match.details ? renderEventDetails(match.name, match.details) : []), match.opportunity?.postText ?? "", match.pageNow ?? "", ...own].join("\n");
}

// Tease: hint without naming it, one yes/no question.
export async function draftEventTease(
  person: { firstName: string },
  askText: string,
  fromProfile: boolean,
  match: TierMatch,
): Promise<{ text: string; rules: OutputRules } | null> {
  const text = await draftProactive({
    functionId: "agent.eventDiscoverySurfacing",
    firstName: person.firstName,
    facts: matchFacts(askText, fromProfile, match),
    task: `Something came up that fits them: ${kindLabel(match)}. Write a short text saying you came across something that made you think of them, tied to one concrete detail of what they're looking for (in plain words), without naming it, its host, its date, or what kind of gathering it is (don't say mixer, dinner, office hours, meetup, or any word from its name that they didn't use themselves). End with one yes/no question asking if they want the details. If it doesn't actually fit what they're looking for, return SKIP.`,
  });
  if (!text) return null;
  // Withhold the name and every word of it they didn't use themselves, so
  // "climate founders" can still describe what they want but "mixer" or
  // "office hours" can't give the event away (eval l01/l02, 2026-09-15).
  const distinctive = nameTokens(match.name).filter((t) => !askText.toLowerCase().includes(t));
  return {
    text,
    rules: {
      maxSentences: 2,
      maxChars: 260,
      mustNotInclude: [match.name, ...distinctive],
      // The date is step two as well ("something's happening on the 18th",
      // eval l01).
      forbidden: [{ pattern: /\b(\d{1,2}(st|nd|rd|th)|\d{1,2}\/\d{1,2}|(mon|tues|wednes|thurs|fri|satur|sun)day|tonight|tomorrow)\b/i, reason: "reveals when it is in a tease" }],
    },
  };
}

// The reveal's limit, measured on Co's words only (the link goes out as its
// own message first), and said to the model up front so it writes to it.
export const REVEAL_MAX_CHARS = 300;
export const REVEAL_LENGTH = `Keep it under ${REVEAL_MAX_CHARS - 40} characters: the name, when, and the one reason it fits, nothing more.`;

// Short-notice reveal: name it, when, and why it fits, upfront that it's
// short notice. The link (if any) goes out first as its own message.
// One find as the bundle composer (harness/bundleComposer.ts) and the single reveal both see it: its confirmed facts, the rules its
// caption is checked against, its link, and what a caption may say about who they are (identity grounding). Pure.
// roundup: it goes as a post listing several places (bundleComposer.ts frames it so).
// record: the thing's own words only (its name, page, post and structured record; never their ask or a fit read), for the goal check.
// applyRoute: a way to apply or register was read and its state supports going now (applyRouteOf). supports: the benefit kinds its read
// supports (services/opportunityRead.ts), absent when it has no read.
export type RevealItem = { facts: Facts; rules: OutputRules; url: string | null; grounding: string; name: string; fromProfile: boolean; shortNotice: boolean; roundup?: boolean; record?: string; applyRoute?: boolean; supports?: string[] };

// Pure: is there a checked way in, and does its state support "apply now"? Its own page (or event record) was read at send, it isn't a
// list or a page about it, and the record says it's open: an event record not sold out or waitlisted, or a page that says how to apply.
// A page that says it is open and how: "registration is open", "apply here", "RSVP by Nov 20", "open for applications" (a bare "registration" or "subject to host approval" says neither).
const ROUTE_WORDS = /\b(?:registration|applications?|sign-?ups?|rsvps?) (?:is |are )?(?:now )?open\b|\b(?:apply|register|rsvp|sign up|request to join) (?:here|now|today|by|before|at)\b|\bopen (?:for|to) (?:applications|registration|sign-?ups)\b|\bget tickets\b/i;
export function applyRouteOf(match: TierMatch): boolean {
  const url = "url" in match && match.url ? match.url : null;
  if (!url || match.sendAsRoundup || match.pageIsAbout || !match.checkedAt) return false;
  const d = match.details;
  if (d) return d.soldOut !== true && d.waitlist !== true && d.cancelled !== true && (!d.registration || d.registration === "open");
  return !!match.pageNow && ROUTE_WORDS.test(match.pageNow);
}
export function revealItem(askText: string, fromProfile: boolean, match: TierMatch, opts: { dots?: string[]; why?: string } = {}): RevealItem {
  const dots = opts.dots ?? [];
  const why = opts.why ?? "";
  const tokens = nameTokens(match.name);
  return {
    facts: { ...revealFacts(askText, fromProfile, match), ...(dots.length ? { how_this_connects_to_the_rest_of_their_life: dots.join(" / ") } : {}), ...(why ? { their_why: why } : {}) },
    rules: {
      maxSentences: 2,
      maxChars: REVEAL_MAX_CHARS,
      mustIncludeAny: tokens.length ? tokens : [match.name],
      forbidden: [OFFER_FORBIDDEN, IMPLIES_IDENTITY, ...(fromProfile ? [CLAIMS_THEY_ASKED] : []), ...(match.sendAsRoundup ? [UNCHECKED_CLAIM] : [])],
      // Prices and counts a caption states must be on its record (Phase B4, services/sendCheck.ts captionNumbersBacked).
      backedBy: captionRecord(askText, match, [...dots, why]),
      ...whoItIsFor(match),
    },
    url: "url" in match && match.url ? match.url : null,
    grounding: `${askText}\n${match.name}\n${dots.join("\n")}\n${why}`,
    name: match.name,
    fromProfile,
    shortNotice: isShortNotice(match),
    ...(match.sendAsRoundup ? { roundup: true } : {}),
    record: [match.name, ...(match.details ? renderEventDetails(match.name, match.details) : []), match.opportunity?.postText ?? "", match.pageNow ?? "", ...(match.read ? match.read.facts.map((f) => `${f.text} ${f.quote ?? ""}`) : [])].join("\n"),
    applyRoute: applyRouteOf(match),
    ...(match.read ? { supports: match.read.benefits.map((b) => b.kind) } : {}),
  };
}

export async function draftEventReveal(
  person: { firstName: string },
  askText: string,
  fromProfile: boolean,
  match: TierMatch,
  opts: { reminder?: boolean; again?: boolean; dots?: string[]; why?: string } = {},
): Promise<{ messages: string[]; text: string; rules: OutputRules } | null> {
  const url: string | undefined = "url" in match ? match.url : undefined;
  const dots = opts.dots ?? [];
  const why = opts.why ?? "";
  const item = revealItem(askText, fromProfile, match, { dots, why });
  const draft = () => draftProactive({
    functionId: "agent.eventDiscoverySurfacing.revealNowDraft",
    firstName: person.firstName,
    facts: item.facts,
    // Every event offer goes out with its details now (2026-09-18), so "short
    // notice" is only said when it's true.
    task: `${match.sendAsRoundup ? `This link is${ROUNDUP_NOTE.replace(/^ \(|\)$/g, " ")}. ` : ""}${IDENTITY_RULE} ${AUDIENCE_RULE} ${OFFER_HONESTY} Do not end with a question or an offer ("want me to grab you a spot?", "want this on your radar?"); a separate text after this one asks if it interests them. ` + (opts.reminder
      ? match.kind === "opportunity"
        ? `They were interested in this one when you mentioned it. This is a short heads-up that the deadline is coming up: name it and the deadline, in one or two sentences. Don't present it as new or re-explain it.${url ? " The link goes out as its own message right before yours; don't mention a link." : ""} If it doesn't fit anymore, return SKIP.`
        : `They already heard about this one from you. This is a short heads-up that it's coming up: name it and when it is, in one or two sentences. Don't present it as new or re-explain it.${url ? " The link goes out as its own message right before yours; don't mention a link." : ""} If it doesn't fit anymore, return SKIP.`
      : `${opts.again ? "You mentioned this to them over a month ago and they never replied; it's still open and still fits, so bring it up once more, lightly and with no pressure, as something you're circling back on. " : ""}Name it and when it is, and say in plain words why it fits them. ${REVEAL_LENGTH} ${CO_WHY.replace("Tie it back to their why", "Tie it back to their_why")}${dots.length ? " (if how_this_connects_to_the_rest_of_their_life shows it serves more than one thing they want, or should be framed differently for how they're doing, say that instead of a generic reason)" : ""}.${isShortNotice(match) ? " It's short notice, so be upfront about that so there's no pressure." : ""}${url ? " The link goes out as its own message right before yours; don't mention a link." : ""} If it doesn't actually fit, return SKIP.`),
  });
  // The follow-up question is its own text after the last offer (services/offerFollowUp.ts).
  // Nothing about who they are beyond what they said in their ask (identityGuard.ts).
  const finish = (text: string | null): string | null => {
    if (!text) return null;
    const grounded = stripUngroundedIdentity(text, item.grounding);
    identityDropped(text, grounded, "event_reveal");
    return grounded ? stripClosingQuestion(grounded) : null;
  };
  let body = finish(await draft());
  if (!body) return null;
  // Over the length limit: once more, told by how much, before a good offer is
  // lost (2026-10-08: seven Tier 2 offers dropped 10-04..10-06 at 359 to 507
  // chars, max 300). The link is its own message and never counts.
  if (body.length > REVEAL_MAX_CHARS) {
    const shorter = finish(await draftAgain({ draft: body, failed: `draft_length: ${body.length} chars (max ${REVEAL_MAX_CHARS}). Say the same thing in fewer words: its name, when, and the one reason it fits them` }, draft));
    if (shorter) body = shorter;
  }
  return { messages: url ? [url, body] : [body], text: body, rules: item.rules };
}

// When Co judged the event aimed at a group (the sweep's audience field), the text has to say so, always:
// whether a page's words mean a group is Co's call, and the member's own words never switch it off
// (a man who says "women" in his ask is not in a women's group).
export function whoItIsFor(match: TierMatch): { mustAlsoIncludeAny?: { words: string[]; reason: string; ignoring?: string[] } } {
  if (!isGroupAimed(match.audience)) return {};
  const words = audienceTokens(match.audience);
  if (!words.length) return {};
  const name = match.name;
  return { mustAlsoIncludeAny: { words: audienceSayings(words), reason: "the event is aimed at a group; the text should say who it's for", ignoring: [name, name.split(/[:|\u2014\u2013-]/)[0]] } };
}
