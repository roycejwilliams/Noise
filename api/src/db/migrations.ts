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

}
