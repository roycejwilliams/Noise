import pool from "../../../api/src/db/db.js";

// co-test-only schema additions — deliberately NOT added to the shared
// api/src/db/migrations.ts. That file runs against whichever DATABASE_URL
// the calling service has (production's when api's server runs it, this
// service's own co_test DB when co-test's server runs it) — these columns/
// tables are meaningless in production and would just be dead weight there.
export function runTestMigrations() {
  // Which of the two agreed test cases a real-phone/iMessage session belongs
  // to. Nullable — a session can exist before the tester has tagged it.
  pool
    .query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS test_case TEXT
       CHECK (test_case IN ('intent_layer', 'circles'))`,
    )
    .catch((err: Error) => console.error("users.test_case migration failed:", err));

  // Distinguishes co-test's original browser-EVI sessions (synthetic user,
  // no real phone) from real-phone sessions (real number, real Twilio call,
  // real Sendblue OTP) — the same users table backs both.
  pool
    .query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS test_channel TEXT
       NOT NULL DEFAULT 'browser'
       CHECK (test_channel IN ('browser', 'phone'))`,
    )
    .catch((err: Error) => console.error("users.test_channel migration failed:", err));

  // Distinct from the shared users.contact_verified (means only "has texted
  // in first") — this means the tester has actually entered the correct OTP
  // in the phone-test page. Real-call requests are gated on this, not on
  // contact_verified alone, per the required text-in -> OTP -> call order.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("users.otp_verified migration failed:", err));

  // Marks a phone-test session created with no known phone number yet — the
  // entry screen is a single "Message Co to start" button (no name/phone
  // form, matching the Ditto pattern), so the row exists before we know who
  // it belongs to. Cleared (along with attaching the real number) the moment
  // an inbound text arrives from a number we don't already recognize — see
  // the claim logic in webhooks.ts's /sendblue/webhook. This assumes one
  // tester at a time, which matches how this internal tool is actually used;
  // it is not safe for concurrent testers (a second person's text could
  // claim the first person's pending session).
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_pending BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("users.phone_pending migration failed:", err));

  // Real-call state, mirroring the fields production's /co/call-status
  // webhook keeps in co_memories — kept directly on the row here since a
  // co-test session has exactly one active call at a time, and the phone
  // page polls this instead of holding a socket.io connection.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_sid TEXT`)
    .catch((err: Error) => console.error("users.call_sid migration failed:", err));

  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_status TEXT`)
    .catch((err: Error) => console.error("users.call_status migration failed:", err));

  // Smoke-test observability (Part 1, item 4) — set by the no-op tool's
  // tool_call handler and by the Control Plane response send, so the phone
  // page can show plainly whether the round trip actually happened on a
  // real Twilio-bridged call, not just whether the call connected.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smoke_test_tool_call_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("users.smoke_test_tool_call_at migration failed:", err));

  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smoke_test_tool_response_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("users.smoke_test_tool_response_at migration failed:", err));

  // Manual (human-input) checklist answers — one row per catalog item (see
  // checklist.ts for the fixed catalog of 5 auto + 7 manual items). Never
  // written to except by the tester's own form submit; the system never
  // infers or fabricates a value here.
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS checklist_responses (
        item_key TEXT PRIMARY KEY,
        value TEXT,
        filled_in BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("checklist_responses table init failed:", err));

  // Circles pipeline test (matching/Moderator/venue/poll) needs a third
  // channel alongside browser/phone for internally-seeded simulated members
  // — widen the existing CHECK rather than adding a new column, so
  // test_channel stays the single source of truth for "what kind of row is
  // this." Postgres has no ALTER-CHECK-in-place, so drop and recreate.
  pool
    .query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_test_channel_check`)
    .then(() =>
      pool.query(
        `ALTER TABLE users ADD CONSTRAINT users_test_channel_check
         CHECK (test_channel IN ('browser', 'phone', 'circles_sim'))`,
      ),
    )
    .catch((err: Error) => console.error("users.test_channel widen migration failed:", err));

  // is_simulated marks every row created by the Circles pipeline test
  // (seeded members, and any circle/moment formed from them) as internally
  // manufactured — not a naming convention (reserved 555-01XX numbers alone
  // were confirmed NOT sufficient to keep simulated data from being mistaken
  // for something real once a live process started acting on it in
  // production), a hard, queryable flag the dashboard/checklist can render
  // an unmissable banner from. Propagated onto circles/moments explicitly
  // wherever they're created from simulated members — never inferred.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("users.is_simulated migration failed:", err));

  pool
    .query(`ALTER TABLE circles ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("circles.is_simulated migration failed:", err));

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("moments.is_simulated migration failed:", err));

  // createMomentForCircle (ported from production's co.ts, see
  // src/services/venues.ts) writes these — present in production's schema,
  // never added to co-test's schema-only init.sql dump because nothing
  // exercised that code path here until the Circles port.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue_type TEXT`)
    .catch((err: Error) => console.error("moments.venue_type migration failed:", err));

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS vibe TEXT[]`)
    .catch((err: Error) => console.error("moments.vibe migration failed:", err));

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS neighborhood TEXT`)
    .catch((err: Error) => console.error("moments.neighborhood migration failed:", err));

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS candidate_windows JSONB`)
    .catch((err: Error) => console.error("moments.candidate_windows migration failed:", err));

  // Which fixed hand-designed scenario (A/B/C, see circlesSimulation.ts) a
  // simulated user belongs to, if any — orthogonal to test_channel
  // ('circles_sim' covers both the legacy randomized pool and fixed
  // scenarios). Null means the legacy randomized pool, used for general
  // stress-testing rather than a known-answer check.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS simulation_scenario TEXT`)
    .catch((err: Error) => console.error("users.simulation_scenario migration failed:", err));

  // One row per "Run matching" click against a fixed scenario — lets the
  // checklist dashboard show the last result (score, who got grouped, pass/
  // fail against the scenario's designed answer) without re-running after a
  // page reload. Not written to for the legacy randomized pool (scenario_id
  // null there would just be noise with nothing to check pass/fail against).
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_test_scenario_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scenario_id TEXT NOT NULL,
        final_score REAL,
        considered_candidates INTEGER NOT NULL DEFAULT 0,
        member_names TEXT[] NOT NULL DEFAULT '{}',
        excluded_names TEXT[] NOT NULL DEFAULT '{}',
        rejection_reason TEXT,
        passed BOOLEAN,
        expected_note TEXT,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("co_test_scenario_runs table init failed:", err));

  // Flags a circle as created by the real-test-user-vs-filler-pool feature
  // (dynamicPlacementTest.ts) — owner is a real, non-simulated user, some/
  // all other members are seeded filler users. Distinct from is_simulated
  // (false here, deliberately — this circle triggers a real Sendblue send)
  // so the Moderator-by-text intercept (scoped to is_simulated=true) never
  // mistakes it for the fully-fake sim harness, and so "reset filler pool"
  // can find and clean up exactly these circles without touching anything
  // else real.
  pool
    .query(`ALTER TABLE circles ADD COLUMN IF NOT EXISTS real_test_placement BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("circles.real_test_placement migration failed:", err));

  // One row per dynamic-variant diagnostic run (see dynamicPlacementTest.ts)
  // — same purpose as co_test_scenario_runs, but for filler pools generated
  // fresh from a real test user's actual captured intent instead of fixed
  // hand-designed content. generated_profiles snapshots what was actually
  // generated (name/goals/activities/chapters) since the pool itself gets
  // reset between rounds and otherwise wouldn't be inspectable later.
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_test_dynamic_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        real_user_id UUID NOT NULL,
        variant TEXT NOT NULL CHECK (variant IN ('A', 'B', 'C')),
        final_score REAL,
        considered_candidates INTEGER NOT NULL DEFAULT 0,
        member_names TEXT[] NOT NULL DEFAULT '{}',
        excluded_names TEXT[] NOT NULL DEFAULT '{}',
        rejection_reason TEXT,
        passed BOOLEAN,
        generated_profiles JSONB NOT NULL DEFAULT '[]'::jsonb,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("co_test_dynamic_runs table init failed:", err));
}
