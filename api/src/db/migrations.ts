import pool from "./db.js";

export function runMigrations() {
  pool
    .query(
      `
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
      moments_name TEXT,
      moment_image TEXT,
      friend_id UUID REFERENCES users(id) ON DELETE SET NULL,
      friend_first_name TEXT,
      friend_last_name TEXT,
      friend_username TEXT,
      friend_profile_image TEXT,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
    )
    .catch((err: Error) =>
      console.error("notifications table init failed:", err),
    );

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS suggested_time TEXT`)
    .catch((err: Error) =>
      console.error("moments.suggested_time migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue_booking_url TEXT`,
    )
    .catch((err: Error) =>
      console.error("moments.venue_booking_url migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moments ADD COLUMN IF NOT EXISTS booking_link_sent_at TIMESTAMPTZ`,
    )
    .catch((err: Error) =>
      console.error("moments.booking_link_sent_at migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moments ADD COLUMN IF NOT EXISTS consensus_nudge_sent_at TIMESTAMPTZ`,
    )
    .catch((err: Error) =>
      console.error("moments.consensus_nudge_sent_at migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moments ADD COLUMN IF NOT EXISTS connector_nudge_sent_at TIMESTAMPTZ`,
    )
    .catch((err: Error) =>
      console.error("moments.connector_nudge_sent_at migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moment_responses ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ`,
    )
    .catch((err: Error) =>
      console.error("moment_responses.responded_at migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS hume_chat_group_id TEXT`,
    )
    .catch((err: Error) =>
      console.error("co_profiles.hume_chat_group_id migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'polling'`,
    )
    .catch((err: Error) =>
      console.error("moments.status migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT`,
    )
    .catch((err: Error) =>
      console.error("users.subscription_status migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE circles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending_approval'`,
    )
    .catch((err: Error) =>
      console.error("circles.status migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE circles ADD COLUMN IF NOT EXISTS keana_notified_at TIMESTAMPTZ`,
    )
    .catch((err: Error) =>
      console.error("circles.keana_notified_at migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE moment_photos ALTER COLUMN uploader_id DROP NOT NULL`,
    )
    .catch((err: Error) =>
      console.error("moment_photos.uploader_id nullable migration failed:", err),
    );

  pool
    .query(
      `ALTER TABLE co_memories ADD COLUMN IF NOT EXISTS content_embedding vector(1536)`,
    )
    .then(() =>
      pool.query(`CREATE INDEX IF NOT EXISTS co_memories_embedding_hnsw_idx
        ON co_memories USING hnsw (content_embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`),
    )
    .catch((err: Error) =>
      console.error("Failed to set up co_memories embedding index:", err),
    );

  pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS intent JSONB DEFAULT '[]'::jsonb`)
    .catch((err: Error) =>
      console.error("co_profiles.intent migration failed:", err),
    );

  pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS coordinates geometry(Point,4326)`)
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_co_profiles_coordinates ON co_profiles USING GIST (coordinates)`,
      ),
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_co_profiles_city ON co_profiles (city)`,
      ),
    )
    .catch((err: Error) =>
      console.error("co_profiles.coordinates migration failed:", err),
    );

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue TEXT`)
    .catch((err: Error) =>
      console.error("moments.venue migration failed:", err),
    );

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS recap TEXT`)
    .catch((err: Error) =>
      console.error("moments.recap migration failed:", err),
    );

  pool
    .query(`
      ALTER TABLE co_memories DROP CONSTRAINT IF EXISTS co_memories_memory_type_check;
      ALTER TABLE co_memories ADD CONSTRAINT co_memories_memory_type_check
        CHECK (memory_type = ANY (ARRAY[
          'call_transcript','text_exchange','check_in','intent','recap','system','placement'
        ]));
    `)
    .catch((err: Error) =>
      console.error("co_memories.memory_type_check migration failed:", err),
    );

  // Source of truth for /co/webhook's voicemail-skip check now that Hume no
  // longer reliably populates twilio_metadata.call_sid on the chat_ended
  // webhook (calls are bridged through our own WebSocket, not Hume's native
  // Twilio integration, which is the only path that ever set it).
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_sid TEXT`)
    .catch((err: Error) => console.error("users.call_sid migration failed:", err));

  // Flags a call_sid as an answering-machine pickup (see /co/call-status's
  // AnsweredBy branch) so /co/webhook's chat_ended handler can skip full
  // extraction for it — a few seconds of Hume talking into a machine isn't a
  // real conversation worth building a profile from.
  pool
    .query(`CREATE TABLE IF NOT EXISTS voicemail_calls (
      call_sid TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    .catch((err: Error) => console.error("voicemail_calls table migration failed:", err));

  pool
    .query(`
      ALTER TABLE users ALTER COLUMN subscription_status SET DEFAULT 'inactive';
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_status_check;
      ALTER TABLE users ADD CONSTRAINT users_subscription_status_check
        CHECK (subscription_status = ANY (ARRAY['active','inactive','past_due','canceled']));
    `)
    .catch((err: Error) =>
      console.error("users.subscription_status migration failed:", err),
    );

  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`)
    .catch((err: Error) =>
      console.error("users.stripe_customer_id migration failed:", err),
    );

  // Gates whether Co can message a number yet — our Sendblue plan only allows
  // replying to contacts who have texted in first, so new self-serve
  // registrations must text in before their OTP is sent. Existing rows are
  // backfilled to true separately (one-time, not part of this migration) so
  // pre-existing accounts aren't newly blocked.
  pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_verified BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) =>
      console.error("users.contact_verified migration failed:", err),
    );

  // Tracks whether the "day of" reminder has gone out for a confirmed moment,
  // so the reminder cron (every 15 min) doesn't re-send it on every tick.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS day_of_reminder_sent_at TIMESTAMPTZ`)
    .catch((err: Error) =>
      console.error("moments.day_of_reminder_sent_at migration failed:", err),
    );

}
