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
}
