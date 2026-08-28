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


  // Tool-access login (distinct from the shared users.identity_captured,
  // which now gates the in-app "request a real call" step). A tester has to
  // prove they control a real phone number, via a real OTP, before test.copatible.com
  // shows anything but the login form — see services/testerAuth.ts. The
  // token is opaque and long-lived (see testerAuth's TTL), stored on the row
  // it authenticates rather than a separate sessions table since this is a
  // handful of real testers at a time, not a real user base.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_session_token TEXT`)
    .catch((err: Error) => console.error("users.login_session_token migration failed:", err));

  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_session_expiry TIMESTAMPTZ`)
    .catch((err: Error) => console.error("users.login_session_expiry migration failed:", err));

  pool
    .query(`CREATE INDEX IF NOT EXISTS idx_users_login_session_token ON users (login_session_token)`)
    .catch((err: Error) => console.error("idx_users_login_session_token migration failed:", err));

  // Someone asking for a call at a specific future time, not right now —
  // distinct from the existing explicit_request/would_benefit call-offer
  // flow, which only ever places a call immediately. scheduled_for is the
  // resolved absolute UTC instant to actually place the call (converted at
  // capture time via the stated local date/time + IANA timezone, not
  // resolved again later — DST doesn't shift an already-resolved UTC
  // instant). timezone/requested_text are kept for confirmation copy and
  // debugging a bad resolution, not re-parsed at call time.
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS scheduled_calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_text TEXT NOT NULL,
        timezone TEXT NOT NULL,
        scheduled_for TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
        call_sid TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_scheduled_calls_due ON scheduled_calls (scheduled_for) WHERE status = 'pending'`,
      ),
    )
    .catch((err: Error) => console.error("scheduled_calls table/index init failed:", err));

  // Heads-up text sent shortly before a scheduled call actually fires —
  // separate timestamp from scheduled_calls.created_at so the reminder job
  // can tell "already reminded" from "not due yet" without touching status
  // (status still only ever means pending/processing/completed/failed/
  // cancelled — a reminder having gone out doesn't change any of that).
  pool
    .query(`ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("scheduled_calls.reminder_sent_at migration failed:", err));

  // Nothing previously honored STOP — a user who texted it would just get a
  // normal Co reply and keep receiving texts and calls. Gates every outbound
  // send in webhooks.ts and both cron jobs; set back to false on START/UNSTOP.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("users.sms_opted_out migration failed:", err));
}
