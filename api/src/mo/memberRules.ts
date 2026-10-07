// Member-facing Mo: the rules, in code, with no model and no database, so evals/mo/memberRules.ts can pin every one of
// them (Royce, 2026-10-05; spec: "Member-facing Mo: the club reaches out for you"). The model only proposes; these decide.
//
// An agent that approaches strangers on a member's behalf needs iron limits and a receipt for every contact, so every
// send goes through contactVerdict(), which re-checks all of it at the moment of sending, and every consent comes from
// readConsent()/readPicks(), which read the member's WHOLE message (the same machinery as the member brief).
import { checkMoDraft, quoteIsTheirs, suppressionKeys } from "./rules.js";
import { readNameAnswer } from "../services/eventBrief.js";

export const MEMBER_MO = {
  maxOpenBatches: 1,
  perBatch: 3,
  perMemberPerWeek: 5,
  huntsPerMemberPerWeek: 1,
  // Inside Mo's overall daily cap (mo/rules.ts MO.dailyCap): whichever is lower wins.
  clubPerDay: 10,
  strangerGapDays: 30,
  followUpAfterDays: 7,
  closeAfterFollowUpDays: 7,
  batchLifeDays: 3,
  // The member's hunt pauses itself when too many of the last contacts went badly.
  autoPauseWindow: 5,
  autoPauseBad: 2,
  retentionDays: 90,
  maxApproachChars: 420,
  sendFromHour: 10,
  sendUntilHour: 18,
};

// ---------------------------------------------------------------- consent (the member's own words, whole message)

// Which people in the open batch they chose, read STRICTLY: only a clean choice counts, anything else is null and Co asks
// again. A wrong yes here contacts a stranger the member turned down, so the grammar is small on purpose:
//   "1 and 3" / "1, 3" / "just 2" / "the first and the third"      -> those numbers
//   "all" / "everyone" / "all of them" / "all three"                -> everyone in the batch
//   "all but 2" / "everyone except 1"                               -> everyone else
//   "none" / "nobody" / "no one"                                    -> no one
// Any other word, any negation ("not", "don't", "no" with a number), a question mark, or a number beyond the list is null.
const FILLER = new Set(["yes", "ok", "okay", "sure", "please", "just", "only", "and", "the", "reach", "out", "to", "go", "ahead", "with", "for", "on", "them", "those", "these", "people", "person", "of", "me", "number", "numbers"]);
const ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, "1st": 1, "2nd": 2, "3rd": 3 };
export function readPicks(message: string, count: number): number[] | null {
  if (/\?/.test(message)) return null;
  const m = message.toLowerCase().replace(/[’‘]/g, "'");
  if (/n't|\bnot\b|\bnever\b|\bwithout\b|\bskip\b|\bdrop\b|\bexclude\b|\bminus\b/.test(m)) return null;
  const tokens = m.replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const joined = ` ${tokens.join(" ")} `;
  if (/^ (?:(?:yes|ok|okay|sure|please|just) )*(?:none|nobody|no one|none of them|nothing) (?:(?:for|now|thanks|thank|you) )*$/.test(joined)) return [];
  // all but N
  const butM = joined.match(/^ (?:(?:yes|ok|okay|sure|please) )*(?:all|everyone|all of them) (?:but|except) (?:number |numbers )?((?:\d+|first|second|third)(?: (?:and )?(?:\d+|first|second|third))*) $/);
  if (butM) {
    const out = new Set(butM[1].split(/ (?:and )?/).map((t) => (/^\d+$/.test(t) ? Number(t) : ORDINAL[t])));
    if ([...out].some((n) => !n || n < 1 || n > count)) return null;
    return all.filter((n) => !out.has(n));
  }
  if (tokens.includes("but") || tokens.includes("except")) return null;
  const hasAll = tokens.some((t) => ["all", "everyone"].includes(t));
  const nums: number[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) nums.push(Number(t));
    else if (ORDINAL[t]) nums.push(ORDINAL[t]);
    else if (t === "all" || t === "everyone" || t === "three" || t === "all") continue;
    else if (!FILLER.has(t)) return null;
  }
  if (hasAll) {
    // "all", "all of them", "all three": nothing else but fillers (so no numbers beside it)
    if (nums.length) return null;
    if (tokens.includes("three") && count !== 3) return null;
    return all;
  }
  if (tokens.includes("three")) return null;
  if (!nums.length) return null;
  if (nums.some((n) => n < 1 || n > count)) return null;
  return [...new Set(nums)].sort((a, b) => a - b);
}

// A yes to Mo or to its voice: the member brief's whole-message reader, plus the short phrases people actually use.
export function readMoConsent(quote: unknown, message: string): "yes" | "no" | null {
  const base = readNameAnswer(quote, message);
  if (base) return base;
  const m = String(message).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = String(quote ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 2 || !m.includes(q)) return null;
  if (m.split(" ").length <= 12 && /^(?:ok|okay|looks good|perfect|sounds good|go ahead|do it|that works)\b/.test(q) && !/\b(no|not|don't|never|leave|out|can't|skip|without|but|only|except)\b/.test(m)) return "yes";
  return null;
}
export const readConsent = readMoConsent;

// ---------------------------------------------------------------- the message that goes to a stranger

export type ApproachCheck = { ok: boolean; why: string | null };

// The text a stranger will read. It is checked at the moment it is approved AND again at the moment it is sent.
export function approachProblem(text: string, o: { memberFirstName: string; memberMayBeNamed: boolean; otherMemberFirstNames: string[]; evidenceQuote?: string | null }): string | null {
  const failed = checkMoDraft("dm", text, { dmMax: MEMBER_MO.maxApproachChars }).find((c) => !c.pass);
  if (failed) return failed.reason ? `${failed.name}: ${failed.reason}` : failed.name;
  if (/[—–]/.test(text) || /!/.test(text)) return "has an em dash or an exclamation point";
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ")} `;
  if (!o.memberMayBeNamed && o.memberFirstName.trim().length >= 2 && t.includes(` ${o.memberFirstName.trim().toLowerCase()} `)) return "names the member, who didn't say they could be named";
  for (const n of o.otherMemberFirstNames) if (n.trim().length >= 3 && t.includes(` ${n.trim().toLowerCase()} `)) return `names another member (${n})`;
  if (/@[a-z0-9._-]+\.[a-z]{2,}|\b\d{3}[ .-]?\d{3}[ .-]?\d{4}\b/i.test(text)) return "carries an email or a phone number";
  if (!/\b(no worries|not for you|won'?t (write|message|reach)|ignore this|just say no|reply no|reply stop)\b/i.test(text)) return "has no easy way to say no";
  return null;
}

// ---------------------------------------------------------------- may this go out, right now

export type ContactState = {
  step: "approach" | "follow_up";
  now: Date;
  enabled: boolean; // Mo is on and Co's X send keys are set
  clubPaused: boolean;
  optIn: "yes" | "no" | null;
  memberPaused: boolean;
  autoPaused: boolean;
  voiceApproved: boolean;
  candidateStatus: string;
  approvedAt: Date | null;
  batchExpiresAt: Date | null;
  batchStatus: string;
  memberSentThisWeek: number;
  clubSentToday: number;
  teamDailyCap: number;
  strangerLastContactedAt: Date | null; // by anyone in the club, ever
  suppressed: boolean;
  contactedAt: Date | null;
  followedUpAt: Date | null;
  repliedAt: Date | null;
  approachTextOk: boolean;
  // The exact words the member approved, and what would be sent now: they must be the same.
  approvedText: string | null;
  textNow: string;
};

export function localHourOk(now: Date, zoneHour: number): boolean {
  return zoneHour >= MEMBER_MO.sendFromHour && zoneHour < MEMBER_MO.sendUntilHour;
}

// Every reason a contact is refused, in the order they are checked. The first one wins and is what the receipt says.
export function contactVerdict(s: ContactState & { localHour: number }): { ok: boolean; why: string | null } {
  const no = (why: string) => ({ ok: false, why });
  const days = (d: Date | null) => (d ? (s.now.getTime() - d.getTime()) / 86400_000 : Infinity);
  if (!s.enabled) return no("member Mo is switched off or its channel isn't set up");
  if (s.clubPaused) return no("Mo is paused");
  if (s.optIn !== "yes") return no("the member has not said yes to Mo");
  if (s.memberPaused) return no("the member told Mo to stop");
  if (s.autoPaused) return no("paused after too many contacts went badly");
  if (!s.voiceApproved) return no("the member hasn't approved the voice");
  // A first contact needs a live yes: an approved batch inside its window. A follow-up is the same yes carried on, one week later.
  if (s.step === "approach") {
    if (s.batchStatus !== "approved") return no(`the batch is ${s.batchStatus}, not approved`);
    if (!s.batchExpiresAt || s.batchExpiresAt <= s.now) return no("the batch has expired");
  }
  if (s.suppressed) return no("this person is on the do-not-contact list");
  if (!s.approvedAt) return no("the member didn't approve this person");
  if (!s.approachTextOk) return no("the message doesn't pass the message check");
  if (s.step === "approach" && s.approvedText !== null && s.approvedText !== s.textNow) return no("what would be sent is not the text the member approved");
  if (s.step === "approach" && s.approvedText === null) return no("no approved text on file for this person");
  if (!localHourOk(s.now, s.localHour)) return no("outside sending hours");
  if (s.memberSentThisWeek >= MEMBER_MO.perMemberPerWeek) return no(`already ${MEMBER_MO.perMemberPerWeek} contacts for this member this week`);
  if (s.clubSentToday >= Math.min(MEMBER_MO.clubPerDay, s.teamDailyCap)) return no("the club's daily limit is reached");
  if (s.step === "approach") {
    if (s.candidateStatus !== "approved") return no(`this person is ${s.candidateStatus}, not waiting for a first contact`);
    if (s.contactedAt) return no("already contacted");
    if (s.strangerLastContactedAt && days(s.strangerLastContactedAt) < MEMBER_MO.strangerGapDays) return no("someone in the club contacted this person in the last 30 days");
    return { ok: true, why: null };
  }
  if (s.candidateStatus !== "contacted") return no(`this person is ${s.candidateStatus}, not waiting for a follow-up`);
  if (s.repliedAt) return no("they replied");
  if (s.followedUpAt) return no("already followed up once");
  if (days(s.contactedAt) < MEMBER_MO.followUpAfterDays) return no("too soon for a follow-up");
  return { ok: true, why: null };
}

// A member whose recent contacts keep going badly (opt-outs, complaints) is paused before any more go out.
export function shouldAutoPause(recent: { bad: boolean }[]): boolean {
  const last = recent.slice(0, MEMBER_MO.autoPauseWindow);
  return last.filter((r) => r.bad).length >= MEMBER_MO.autoPauseBad;
}

// What a stranger the member can see about the person looks like: their public name or handle, one line on why, the
// quote that backs it.
export function evidenceIsTheirs(quote: string, postText: string): boolean {
  return quoteIsTheirs(quote, postText);
}

export { suppressionKeys };
