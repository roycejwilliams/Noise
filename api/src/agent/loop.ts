// Co's own loop for finding and doing things (Royce, 2026-10-01: "Instinct runs
// one agent loop with general tools ... chains them, and refines as I add
// details. Co instead runs fixed pipelines ... outside its own reasoning").
//
// A find request is worked inside the reply itself: Co searches events or the
// web, reads pages, judges what fits, shares the first good finds, refines,
// and keeps working notes (the search
// brief) across texts. The old reply search (searchNow and the pipeline behind
// it: the brief, the event tiers, the relevance gate, the fit check, the caption
// drafts) is gone from replies; the pipeline stays only for Co's multi-day
// tasks, voice calls and the daily sweep until they move onto these tools too.
// Replies have no other path
// (Royce, 2026-10-01: "no point holding" the old one once the loop won 4 of 5
// real asks to 0 of 5).
//
// The budget for one turn, and why:
// - steps 14: a find turn measured at search, read two pages, refine once,
//   share, read, share, answer, update notes is ~10 steps; 14 leaves room for
//   one more refine without letting it wander. Plain replies stop in 1 to 2.
// - web searches 4 queries (each ~$0.06), given up to 3 at once and run in
//   parallel: three angles in one round plus one refine. First live run
//   (2026-10-01) had them one per step, ~35s each, and the first find took ~2 min.
// - page reads 6 (no model cost; a few seconds each, browser fallback ~4s).
// - event searches 3 (the feed is cached; cheap).
// - X post searches 2 a turn and 10 a day per member, inside the shared daily X
//   budget the sweep also uses: fresh announcements, not a default.
// - seconds 75 from the start of the turn: one parallel web round, a couple of
//   page reads and a share fit inside it; past it, tools say to share what's
//   there and answer. The first find is shared as soon as it's good, so the
//   wait isn't the whole budget.
// - dollars: bounded by the counts above, about $0.55 at the most.
export const LOOP_BUDGET = { steps: 14, webSearches: 4, pageReads: 6, eventSearches: 3, seconds: 75 };

// How to work a request, given to Co when it's finding something (the why is
// part of each line: research guidance, 2026-10-01).
export const LOOP_GUIDE = `They want something found or done. Work it the way a sharp friend would, inside this reply:
- Start from your working notes (above) so you don't ask for what they already told you. If what they want could mean clearly different things and a search can't cover them, ask first rather than searching on a guess; a broad ask ("anything this weekend?") isn't ambiguous, so search wide and show a couple of different kinds.
- When they ask you to look again or wonder whether there's anything else, search again now rather than asking whether to: what's out there changes every day, so earlier results are never the answer to a new ask.
- Search, then look at what came back and judge it yourself against what they asked: results are candidates, not answers. When results are thin or off, change one thing and try again (another angle, a nearby area, a listing site) rather than telling them nothing's out there; use the searches you have before saying you hit a wall.
- Read the page of anything you're about to recommend or anyone you're about to contact, so what you say about it comes from its page.
- Share the first good finds as soon as you have them (shareFinds), then keep going only if more would help. Three real options beat ten maybes.
- End with a short reply: what you checked, what's still unconfirmed (availability, final price), and the one question that would sharpen the next search, if there is one.
- When what they want changes (a headcount, an area, what they picked), update your notes.
- If the goal isn't closed in this reply (a price unconfirmed, a choice that's theirs, a deadline coming), take it on with startTask if it isn't already one of your tasks, so it keeps moving and you report back before the deadline without being asked.`;
