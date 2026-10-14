// Guards: what holds a send, what a stored lesson says, what keeps sends owned, single, affordable and in cohort (cases 5, 6, 12, 14,
// 18, 19). 5 and 6 run the real code with its real model reads; pages and logs are fixtures, nothing is fetched or stored.
import "../../lib/requireMeter.js";
import { readFileSync } from "node:fs";
import { realSendCheckDeps, recheckFind, type OpenRead, type Recheck } from "../../../src/services/sendCheck.js";
import { checkLesson, HYPOTHESIS_MARK, type ReplyLog, type TheirText } from "../../../src/services/lessonCheck.js";
import type { TierMatch } from "../../../src/services/tieredRecommendation.js";
import { result, type GoldenCase } from "../types.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
// The day of the incident, mid-afternoon in LA: every fixture date is read against it.
const NOW = new Date("2026-10-13T21:00:00.000Z");
const ZONE = "America/Los_Angeles";

// Case 5 (2026-10-13): the send-time re-read of a dated find. The word list (closedOnPage) misses the AI Grant line, so the hold has to
// come from the model read (readOpenNow). The read is wrapped only to record whether it ran and what it said.
async function recheckWith(match: TierMatch, page: string): Promise<{ r: Recheck; read: OpenRead | null | "not called" }> {
  let read: OpenRead | null | "not called" = "not called";
  const r = await recheckFind(match, {
    now: NOW,
    zone: ZONE,
    // Production's own deps (realSendCheckDeps), with only the page and Luma reads swapped for the fixture: if production stops
    // wiring the open read, this case fails (review of the harness).
    deps: {
      ...realSendCheckDeps,
      luma: async () => null,
      page: async () => ({ text: page, gone: false }),
      openRead: realSendCheckDeps.openRead ? async (i) => (read = await realSendCheckDeps.openRead!(i)) : undefined,
    },
  });
  return { r, read };
}
const show = (label: string, x: { r: Recheck; read: OpenRead | null | "not called" }) =>
  `${label}: ${x.r.ok ? `sent (verified ${x.r.verified})` : `held (exit ${x.r.exit}): ${x.r.why}`}; open read: ${JSON.stringify(x.read)}`;

// Case 6 fixture: invented, same shape as the live case (fixtures/guards-lesson-cause.json).
type LessonFixture = { message: string; pushback: string; lesson: string; theirs: { at: string; text: string }[]; logs: (Omit<ReplyLog, "at"> & { at: string })[] };

export const CASES: GoldenCase[] = [
  {
    n: 5,
    id: "stale-page",
    title: "A dated opening whose own page now says closed is held at send time; an open one still goes",
    status: { live: true },
    from: "2026-10-13: AI Grant 'applications open now' went out while its page said 'Applications for Batch 4 are closed'; fixed in #190",
    run: async () => {
      const misses: string[] = [];
      // The real aigrant.com text as read on 2026-10-13 (fixtures/guards-aigrant-page.txt).
      const closed = await recheckWith({ kind: "opportunity", form: "opening", name: "AI Grant", url: "https://aigrant.com/", tier: 3, source: "web", reason: "pre-seed funding for AI product founders" } as TierMatch, fixture("guards-aigrant-page.txt"));
      if (closed.r.ok) misses.push("AI Grant went out: the closed page didn't hold it");
      else {
        if (closed.r.exit) misses.push("AI Grant exited on page words: a closing line holds and is read again, never an exit");
        if (!/Applications for Batch 4 are closed/i.test(closed.r.why)) misses.push(`held, but the why doesn't quote the page's closed line: ${closed.r.why}`);
      }
      // Control: an invented open fellowship with a future deadline on file and on its page (fixtures/guards-open-fellowship-page.txt).
      const open = await recheckWith({ kind: "opportunity", form: "opening", name: "Harbor Light Fellowship", url: "https://harborlight.example/fellowship", tier: 3, source: "web", reason: "grant for first-time founders", deadline: "2026-12-15" } as TierMatch, fixture("guards-open-fellowship-page.txt"));
      if (!open.r.ok) misses.push(`the open fellowship was held: ${open.r.why}`);
      return result(misses, `${show("AI Grant", closed)} / ${show("Harbor Light", open)}`);
    },
  },
  {
    n: 6,
    id: "lesson-cause",
    title: "A lesson guessed from pushback names the reply check when the check caused it",
    status: { live: true },
    from: "2026-10-13: Co kept 'describe it in his terms' when the reply check's false 'Nothing's running on that right now' line caused the pushback; lessons checked against the logs since #190",
    run: async () => {
      const f = JSON.parse(fixture("guards-lesson-cause.json")) as LessonFixture;
      const logs: ReplyLog[] = f.logs.map((l) => ({ ...l, at: new Date(l.at) }));
      const theirs: TheirText[] = f.theirs.map((t) => ({ at: new Date(t.at), text: t.text }));
      // fence: identity strip; the fixture has no other member in it.
      const r = await checkLesson("golden-member", { message: f.message, pushback: f.pushback, lesson: f.lesson }, { logs, theirs, fence: { strip: (t) => t } });
      const misses: string[] = [];
      if (r.cause !== "check") misses.push(`cause "${r.cause}", not "check"`);
      if (r.text.startsWith(HYPOTHESIS_MARK)) misses.push("stored as a hypothesis though the log shows the check replaced the answer");
      if (!/\[cause, from the logs: [^\]]+\]$/.test(r.text)) misses.push("no [cause, from the logs: ...] suffix");
      return result(misses, `cause ${r.cause}; stored: ${r.text}`);
    },
  },
  {
    n: 12,
    id: "feedback-owner",
    title: "Feedback on a find lands on the find and the search that made it",
    status: { live: false, until: "phase 3 (discovery store: input events, discovery_sends unique index)", why: "there is no discovery store yet to own a find's feedback" },
    from: "Discovery plan, final case list: a member's reaction to a find must reach the search that produced it",
    // To build in phase 3: a member reply to a sent find ("not my thing", a tapback, "yes") is written as one input event keyed to that
    // find's discovery_sends row, and the search run that produced it can read it back. Assert: exactly one input event, owned by that
    // send (send id and search run id both set), and none written against any other find or member.
    run: async () => result(["not built yet: a reply to a sent find is stored as one input event owned by that find's discovery_sends row and its search run"], ""),
  },
  {
    n: 14,
    id: "duplicate-send",
    title: "The same find never goes to the same member twice",
    status: { live: false, until: "phase 3 (discovery store: input events, discovery_sends unique index)", why: "the unique index that makes a second send impossible lands with the discovery store" },
    from: "Discovery plan, final case list: a find re-found by a later search, or two dispatches racing, must not send twice",
    // To build in phase 3: two sends of one find (same member, same canonical url or Luma id) attempted concurrently and again a day
    // later. Assert: discovery_sends' unique index admits exactly one row, the second attempt comes back as already sent (never thrown
    // past the dispatcher), and only one text is handed to the sender.
    run: async () => result(["not built yet: a second send of the same find to the same member is refused by the discovery_sends unique index, one text out"], ""),
  },
  {
    n: 18,
    id: "cost-ceiling",
    title: "Discovery stops at its daily cost ceiling",
    status: { live: false, until: "phase 6 (cost guard enforced after the shadow-week baseline)", why: "the ceiling is set from the shadow week's measured spend, not yet taken" },
    from: "Discovery plan, final case list: search spend has a hard per-member and per-day ceiling (after-soak queue: search budget incl. spend side)",
    // To build in phase 6 (plan v2, cost guard): each discovery run records its cost per member (model tokens priced, paid searches).
    // Assert the recorded cost of the case's run is at or under its ceiling: the shadow-week baseline + 10%.
    run: async () => result(["not built yet: each discovery run records its cost per member (model tokens priced, paid searches); the case asserts the recorded cost is at or under its ceiling, the shadow-week baseline + 10% (Royce: ~$2 per member per day today)"], ""),
  },
  {
    n: 19,
    id: "cohort-only",
    title: "Cohort sends go only to the cohort",
    status: { live: false, until: "phase 6 (cohort sends)", why: "cohort sends aren't built" },
    from: "Discovery plan, final case list: a send scoped to a cohort never reaches a member outside it",
    // To build in phase 6: a cohort send with members in and out of the cohort (including an archived member and one who opted out).
    // Assert: texts are queued only for current, opted-in cohort members; no one outside it gets a row, and no cohort member's
    // details appear in another member's text.
    run: async () => result(["not built yet: with sends on for the cohort only (Royce plus test members Jordan, Noor, Ellis), the new loop sends nothing to any member outside the cohort; they stay on the old path"], ""),
  },
];
