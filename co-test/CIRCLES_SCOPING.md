# Scoping: porting the Circles pipeline into co-test

Follow-up project, not implemented as part of the real-phone/iMessage testing
build. This is an analysis of what it would take to test the Circles pipeline
(matching, venue booking, Moderator approval) the same isolated way Intent
Layer is now tested — real calls/texts, dev DB, dev config, no production
reads. Nothing here has been built.

## What exists today (production only)

- `api/src/services/matching.ts` — `findBestCircle`: scores candidates
  against `co_profiles` (life chapters, social energy, activity, goal
  embeddings, emotional state), gates on the 0.55 `min_group_score` floor,
  returns `null` (→ manual/Moderator placement) below it.
- `api/src/services/scheduling.ts` — `generateCandidateWindows`: the
  simultaneous-availability poll, derived from a venue's opening hours plus
  members' stated availability.
- `api/src/services/booking.ts` — `confirmMoment`, `requestVenueApprovalFromKeana`.
- `api/src/services/places.ts` — Google Places venue search/scoring, used by
  `selectVenueForCircle` (in `co.ts`) when no `co_venues` partner match exists.
- The Keana approve/reject-by-text branches inside `api/src/routes/sendblue.ts`
  (circle-placement approval, venue approval, replacement-matching on decline).
- Two 4-hour auto-approve crons — one for circle placement (`api/src/server.ts`),
  one for venue approval (`api/src/jobs/index.ts`) — both fire when Keana
  hasn't responded.

## What's already usable as-is

co-test's `init.sql` is a schema-only dump of the same database structure
production uses — `circles`, `circle_members`, `moments`, `moment_responses`,
`co_venues` all already exist in co-test's DB, unused today. `matching.ts`
and `scheduling.ts` are close to pure functions over that schema — porting
them is closer to an import than a rewrite.

## What would actually need building

1. **Venue selection** — `selectVenueForCircle`/`getCircleBookingContext`/
   `createMomentForCircle` (currently only in `co.ts`) would need a co-test
   copy, plus `GOOGLE_PLACES_API_KEY` wired into co-test's env, plus either
   seed data in co-test's (empty) `co_venues` table or reliance on live
   Google Places results for whatever test city is used.
2. **Moderator approval, ported into co-test's own `/sendblue/webhook`**
   (currently minimal — see `webhooks.ts`) — the classify-approve/reject
   branches for both circle placement and venue approval, plus the
   replacement-matching-on-decline logic.
3. **The two 4-hour auto-approve crons**, registered against co-test's DB.
4. **A distinct dev "Moderator" contact.** Production's approver is a real
   person (`KEANA_PHONE_NUMBER`) getting real approval texts. Reusing that
   same number for dev Circles testing mixes real production approval
   requests with test ones in the same thread — the same shared-resource
   problem Sendblue's webhook already has, but for a real person's inbox
   instead of an account setting. Needs either a second real approver
   (another team member's number) or the same tester acting as their own
   Moderator, clearly labeled.
5. **A new DB migrations file** (co-test-only, same pattern as
   `testMigrations.ts`) for anything `matching.ts`/`booking.ts` need that
   isn't already in `init.sql` (e.g. `co_profiles.coordinates`, which
   `init.sql` deliberately drops since PostGIS isn't installed there —
   `findBestCircle`'s proximity scoring degrades gracefully without it,
   city-only matching still works, but this should be a deliberate decision,
   not an accident).

## The operational tradeoff this introduces

Intent Layer's real-call test is minutes long — the Sendblue webhook only
needs to point at co-test for the duration of one call. Circles is
inherently multi-day: matching → Moderator approval (up to a 4hr wait) →
member accept/decline → venue approval (another possible 4hr wait) →
consensus poll. Testing it for real means the shared Sendblue webhook stays
pointed at co-test for the entire multi-day window, not a few minutes —
production texting is unavailable to real users for that whole span. This is
a materially bigger ask than the phone/iMessage work just shipped, and is
the main reason this is scoped as its own project rather than an add-on.

## Rough sizing

Venue selection + Moderator approval + crons is roughly comparable in size
to everything just built for Intent Layer (Parts 1–3 of the real-phone
work), plus the added complexity of coordinating multiple real test
participants through a days-long flow instead of a single call.
