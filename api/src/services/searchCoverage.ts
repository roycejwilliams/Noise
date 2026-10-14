// What Co's daily search is really covering for one member right now (Royce, 2026-10-13: "The grounding rule reads real current
// state, not a hardcoded list. Open find asks and lookouts searched by the 9am floor count as running work"). The reply check reads
// it every turn (harness/replyGrounding.ts runningWorkLine), so "nothing's running" is only said when nothing is.
//   - asks: every open ask of kind 'find' (questions and look-outs alike), read with the same filter the 9am floor uses
//     (services/dailySweep.ts: person and unclassified asks are skipped there, and so here), with no cap: the floor searches them all.
//   - goals: the goals the latest daily run actually searched (its sweep.daily record: a goal its pace held shows as skipped there).
//   - held: why the floor won't search at all (paused, no phone, opted out, a safety hold). A held member's asks and goals are listed
//     as nothing; the codes stay internal and are never put in front of Co (runningWorkLine words it neutrally).

// hidden: how many searched asks or goals the member-safe strip left out (another member named in them, or the strip failing closed).
// They are still searched, so they still count as running, without their words.
export type SearchCoverage = { asks: string[]; goals: string[]; held: string[]; hidden?: number };
export const NO_COVERAGE: SearchCoverage = { asks: [], goals: [], held: [] };

// How far back a daily run still says what is being searched: a day and a half covers one missed morning's retry window.
const DAILY_RUN_MAX_AGE_HOURS = 36;

// Pure: the goals a sweep.daily record searched (status "searched"), by their text.
export function searchedGoals(proposal: any): string[] {
  const items = Array.isArray(proposal?.items) ? proposal.items : [];
  return [...new Set<string>(items.filter((i: any) => i?.kind === "goal" && i?.status === "searched" && typeof i.text === "string" && i.text.trim()).map((i: any) => String(i.text).trim()))];
}

// When their asks can't be read, nothing is known to be idle: one unnamed item counts as running, so a failed read never becomes a
// "nothing's running" denial (review of the 10-13 fixes).
export const UNREADABLE: SearchCoverage = { asks: [], goals: [], held: [], hidden: 1 };

export async function searchCoverage(userId: string, given?: import("./sourceFence.js").Fence): Promise<SearchCoverage> {
  // Read through the one source fence (services/sourceFence.ts): their own asks and Co's own record of its daily run, stripped of
  // other members' details there; anything blanked or unreadable is counted in hidden, never dropped (a failed read is never a denial).
  const F = await import("./sourceFence.js");
  const fence = given ?? (await F.memberFence(userId));
  const read = await F.readOpenFindAsks(fence).catch(() => null);
  if (!read) return UNREADABLE;
  const goalsRaw = await F.readLastDailyRun(fence, DAILY_RUN_MAX_AGE_HOURS).then((p) => searchedGoals(p)).catch(() => null);
  const goals = (goalsRaw ?? []).map(fence.strip).filter((g): g is string => !!g);
  const hidden = read.hidden + (goalsRaw ? goalsRaw.length - goals.length : 1);
  // What holds every search (the same reader the floor uses for asks): nothing is being searched while it holds, goals included.
  // A hold that can't be read isn't a hold: what's there stays counted.
  const any = read.asks.length + goals.length + hidden > 0;
  const held = any ? await import("../harness/proactive.js").then((P) => P.sweepHold(userId, "ask")).catch(() => null) : [];
  if (held === null) return { asks: read.asks, goals, held: [], hidden: hidden || 1 };
  return held.length ? { asks: [], goals: [], held } : { asks: read.asks, goals, held, ...(hidden ? { hidden } : {}) };
}
