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

// The member's yes or no to a question, with the quote the model picked. The whole message is read: "yes but not
// them" is never a yes. No answer is no.
export const readConsent = readNameAnswer;

// Which people in the open batch they chose. Replies are numbers ("1 and 3"), "all", or "none"; a number after
// skip/not/except/no is left out; anything unclear is null, and Co asks again.
export function readPicks(message: string, count: number): number[] | null {
  const m = ` ${message.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (/\b(none|nobody|no one|nothing|none of them|skip all|skip them all|not any)\b/.test(m)) return [];
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const hasAll = /\b(all|all of them|everyone|all three|all of these|each)\b/.test(m);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, first: 1, second: 2, third: 3 };
  const tokens = m.trim().split(" ");
  const picked = new Set<number>();
  const out = new Set<number>();
  let negate = false;
  for (const t of tokens) {
    if (/^(skip|not|except|without|no|drop|exclude|but|minus)$/.test(t)) {
      negate = true;
      continue;
    }
    const n = /^\d+$/.test(t) ? Number(t) : words[t];
    if (n && n >= 1 && n <= count) (negate ? out : picked).add(n);
    else if (!/^(and|the|then|a|me|please|on|of|with|just|only|yes|ok|okay|sure|reach|out|to|them|number|numbers|people|person|go|ahead|for|same|as|that|this|those|these|one|two|three|first|second|third)$/.test(t)) {
      // a word that isn't about the choice: still fine (names), it just doesn't pick anyone
    }
    if (n) negate = false;
  }
  const base = hasAll ? new Set(all) : picked;
  const result = [...base].filter((n) => !out.has(n)).sort((a, b) => a - b);
  if (!hasAll && picked.size === 0 && out.size === 0) return null;
  if (!hasAll && picked.size === 0 && out.size > 0) return null; // "skip 2" alone is not a choice of who to reach
  return result;
}

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
  enabled: boolean; // MO_MEMBER_ENABLED and the channel is configured
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
  if (s.batchStatus !== "approved") return no(`the batch is ${s.batchStatus}, not approved`);
  if (!s.batchExpiresAt || s.batchExpiresAt <= s.now) return no("the batch has expired");
  if (s.suppressed) return no("this person is on the do-not-contact list");
  if (!s.approvedAt) return no("the member didn't approve this person");
  if (!s.approachTextOk) return no("the message doesn't pass the message check");
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
