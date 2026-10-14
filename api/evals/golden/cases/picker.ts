// Picker cases: the real picker model (services/sweepSelect.ts selectForMember) on a fixture member, with the real guard after it.
// No database, no sends.
import "../../lib/requireMeter.js";
import type { MemberKnowledge } from "../../../src/services/memberKnowledge.js";
import { goalHash } from "../../../src/services/goalEdges.js";
import { selectForMember, type SelectContext } from "../../../src/services/sweepSelect.js";
import { factsFromKnowledge } from "../../../src/services/sweepSelectContext.js";
import { result, type GoldenCase } from "../types.js";

// ---------------------------------------------------------------- 33 (26-32 are the check-in cases on another branch)
// 2026-10-14 09:08 PT: the picker rejected a live residency as "already_known ... against a closed goal". It wasn't: the member's
// active goals included applying to accelerators and raising pre-seed. What it likely leaned on: a past accelerator goal that had only
// been replaced by a newer active one, a closed one-off "find me a couple of accelerators", and a closed question about whether now is
// the time to raise; and the old cut of 6 active goals, which dropped the newest ones. Seven unrelated goals sit ahead of the relevant
// ones and are older, so the cut, were it back, would hide exactly the accelerator and funding goals. The find must not end rejected:
// send, hold, or a reject the guard or the claim check held all pass; a reject that survives fails.
// The clock is pinned (2026-10-13T21:00:00Z, the one the replay harness pins), so a recording replays on the same day.
const NOW = "2026-10-13T21:00:00Z";
const residencyClosedClaim: GoldenCase = {
  n: 33,
  id: "replaced-goal-uncited-reject",
  title: "A live residency is never rejected as closed or known without the record: a replaced goal and a closed one-off ask don't close the aim",
  status: { live: true },
  from: "2026-10-14 09:08 PT: the picker killed a16z Speedrun as 'against a closed goal'; Royce: 'a reject claiming closed or already known has to cite the actual record or the find survives'",
  run: async () => {
    const today = "2026-10-13";
    const goal = (text: string, state: "active" | "done" | "stale", reason: string | null = null, at = NOW) => ({ text, state, reason, told: true, onFile: true, hash: goalHash(text), source: "context" as const, verifiedAt: at });
    const OLD = "2026-09-20T17:00:00Z";
    const older = "get into an accelerator or residency (e.g. South Park Commons)";
    const newer = "apply to South Park Commons or a founder residency this winter";
    const k: MemberKnowledge = {
      userId: "u-ellis",
      asOf: NOW,
      identity: { firstName: "Ellis", city: "San Francisco", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: NOW },
      goals: [
        goal("host a small launch dinner in November", "active", null, OLD),
        goal("get the brand name and logo settled this month", "active", null, OLD),
        goal("make close friends in the city who build things", "active", null, OLD),
        goal("draft partnership notes for the launch partner", "active", null, OLD),
        goal("run a guest-list test of the matching at the dinner", "active", null, OLD),
        goal("start a weekly long run with friends", "active", null, OLD),
        goal("set up the company's bank account and bookkeeping", "active", null, OLD),
        goal("raise a pre-seed round from investors who understand consumer social products", "active", null, "2026-10-09T19:00:00Z"),
        goal(newer, "active", null, "2026-10-12T16:00:00Z"),
        goal("build the company full time while pursuing funding and an accelerator to support that path", "active", null, "2026-10-12T16:05:00Z"),
        goal(older, "stale", `replaced by a newer goal: "${newer}"`),
        goal("find a cofounder", "done", "they closed it"),
      ],
      asks: [],
      delivered: [
        { what: "Founder Fellows by Upfront Ventures", kind: "opportunity", at: "2026-10-12T17:30:00Z", via: ["ledger"], url: null, reaction: null, verifiedAt: "2026-10-12T17:30:00Z" },
        { what: "Pioneer accelerator", kind: "opportunity", at: "2026-10-02T18:00:00Z", via: ["ledger"], url: null, reaction: "they replied within a day", verifiedAt: "2026-10-02T18:00:00Z" },
      ],
      carrying: [],
      lessons: [],
      corrections: [],
      preferences: [],
      claims: [],
      restraint: null,
      exchanges: [
        { from: "member", text: "Can you find me a couple of accelerators with open applications?", call: false, verifiedAt: "2026-10-02T17:00:00Z" },
        { from: "co", text: "Two worth a look: Pioneer, rolling applications, and Founder Fellows at Upfront, 8 weeks with $75K on incorporation.", call: false, verifiedAt: "2026-10-02T17:05:00Z" },
        { from: "member", text: "Perfect, that's plenty for now. Thanks.", call: false, verifiedAt: "2026-10-02T17:20:00Z" },
        { from: "member", text: "Is now even the right time to raise, or should I wait until we have users?", call: false, verifiedAt: "2026-10-09T19:00:00Z" },
        { from: "co", text: "I'd start conversations now and raise once the November launch gives you numbers. Talking to angels early costs little.", call: false, verifiedAt: "2026-10-09T19:02:00Z" },
        { from: "member", text: "Makes sense. Branding this week, then back to the SPC application.", call: false, verifiedAt: "2026-10-12T16:00:00Z" },
      ],
      person: null,
      limits: null,
    };
    const facts = factsFromKnowledge(k);
    const c: SelectContext = {
      ...facts,
      today,
      weekday: "Tuesday",
      asks: [
        { id: "A1", text: "intros to angels who back consumer social", since: "2026-10-09" },
        { id: "A2", text: "find me a couple of accelerators with open applications", since: "2026-10-02", closed: true },
        { id: "A3", text: "whether now is the right time to pursue funding", since: "2026-10-09", closed: true },
      ],
      sent: [{ id: "S1", at: "Oct 12", what: "event_offer: Founder Fellows by Upfront Ventures just opened its 2nd cohort", reaction: null }],
      outcomes: [],
      discoveryLeft: 2,
      pool: [{ id: "C1", key: "a16z speedrun residency|2026-11-01", name: "a16z Speedrun Residency (SR008)", date: "2026-11-01", tier: 3, kind: "discovery", asks: [], details: "12-week residency in SF for early consumer and AI founders; up to $1M investment; applications open now, close Nov 1" }],
    };
    const misses: string[] = [];
    if ((facts.goalsPast ?? []).some((g) => g.text === older)) misses.push("fixture: the replaced accelerator goal reached the picker (it is hidden, #188)");
    if (!(facts.goals ?? []).includes(newer) || (facts.goals ?? []).indexOf(newer) > 2) misses.push(`fixture: the accelerator goal isn't in the lens near the top: ${JSON.stringify(facts.goals)}`);
    const r = await selectForMember(c, { userId: "u-ellis" });
    if (r.error) misses.push(`picker error: ${r.error}`);
    const j = r.judgments.find((x) => x.id === "C1");
    if (!j || j.verdict === "no_verdict") misses.push("no verdict for the residency");
    else if (j.verdict === "reject") misses.push(`the residency was rejected (${j.reason}${j.cites?.length ? `, cites ${j.cites.join(", ")}` : ""}): "${j.why.slice(0, 160)}"`);
    const cc = r.claimCheck;
    return result(misses, `C1 ${j?.verdict ?? "?"}/${j?.reason ?? "?"}${j?.claimed ? ` (claimed ${j.claimed})` : ""}${j?.cites?.length ? ` cites ${j.cites.join(",")}` : ""}: ${(j?.why ?? "").slice(0, 200)}${j?.guard ? ` [guard: ${j.guard}]` : ""}; claim check: ${cc ? `${cc.calls} call, ${cc.items} item(s), ${cc.input} in / ${cc.output} out, ${cc.read}` : "none"}`);
  },
};

// ---------------------------------------------------------------- 39
// The claim check's other side: a reject with a cite that really is about this find stands. They said they already applied to this
// residency; the picker leaves it out citing their text, and the claim check confirms the text is about this very thing.
const appliedAlready: GoldenCase = {
  n: 39,
  id: "already-applied-cited",
  title: "A reject citing their own words about this very find stands (the claim check confirms it)",
  status: { live: true },
  from: "Review of the picker guard (2026-10-14): golden 33 replays a send, so CI never ran the claim check on a cited reject",
  run: async () => {
    const at = new Date().toISOString();
    const k: MemberKnowledge = {
      userId: "u-ellis",
      asOf: at,
      identity: { firstName: "Ellis", city: "San Francisco", zone: "America/Los_Angeles", timeZone: "America/Los_Angeles", verifiedAt: at },
      goals: [{ text: "apply to South Park Commons or a founder residency this winter", state: "active", reason: null, told: true, onFile: true, hash: goalHash("apply to South Park Commons or a founder residency this winter"), verifiedAt: at }],
      asks: [],
      delivered: [],
      carrying: [],
      lessons: [],
      corrections: [],
      preferences: [],
      claims: [],
      restraint: null,
      exchanges: [
        { from: "member", text: "Already applied to a16z Speedrun last week, the SR008 residency. Waiting to hear back, so no need to send it.", call: false, verifiedAt: "2026-10-12T17:00:00Z" },
        { from: "co", text: "Good luck with it. I'll keep looking for the others.", call: false, verifiedAt: "2026-10-12T17:01:00Z" },
      ],
      person: null,
      limits: null,
    };
    const c: SelectContext = {
      ...factsFromKnowledge(k),
      today: "2026-10-13",
      weekday: "Tuesday",
      asks: [],
      sent: [],
      outcomes: [],
      discoveryLeft: 2,
      pool: [{ id: "C1", key: "a16z speedrun residency|2026-11-01", name: "a16z Speedrun Residency (SR008)", date: "2026-11-01", tier: 3, kind: "discovery", asks: [], details: "12-week residency in SF for early consumer and AI founders; applications close Nov 1" }],
    };
    const r = await selectForMember(c, { userId: "u-ellis" });
    const j = r.judgments.find((x) => x.id === "C1");
    const misses: string[] = [];
    if (r.error) misses.push(`picker error: ${r.error}`);
    if (!j || j.verdict === "send") misses.push(`it was sent though they said they already applied (${j?.verdict})`);
    else if (j.verdict !== "reject" || !(j.cites ?? []).length) misses.push(`not a cited reject (${j.verdict}/${j.reason}${j.guard ? `: ${j.guard}` : ""}); the case needs one to exercise the claim check`);
    else if ((r.claimCheck?.calls ?? 0) !== 1) misses.push("the claim check didn't read the cite");
    return result(misses, `C1 ${j?.verdict}/${j?.reason} cites ${(j?.cites ?? []).join(",")}: ${(j?.why ?? "").slice(0, 160)}${j?.guard ? ` [${j.guard}]` : ""}; claim check ${r.claimCheck?.calls ?? 0} call, ${r.claimCheck?.read ?? ""}`);
  },
};

export const CASES: GoldenCase[] = [residencyClosedClaim, appliedAlready];
