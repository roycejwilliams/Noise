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

  // Unused — was set when the Connector was texted a booking task, removed
  // along with that flow. Left in place rather than dropped.
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

  // Unused — was the 4hr-nudge clock for an unresponsive Connector, removed
  // along with that flow. Left in place rather than dropped.
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

  // Gates whether a member has consented to their circle placement. The
  // curated moment isn't revealed to a member until they accept — declining
  // marks them 'declined' (kept, not deleted, so it also serves as the
  // replacement-attempt counter) and triggers a rematch attempt for the group.
  pool
    .query(
      `ALTER TABLE circle_members ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending', 'accepted', 'declined'))`,
    )
    .catch((err: Error) =>
      console.error("circle_members.status migration failed:", err),
    );

  // Every ON CONFLICT DO NOTHING against moment_responses throughout the
  // codebase silently assumed this constraint already existed — without it,
  // duplicate (moment_id, user_id) rows could be (and were) inserted.
  pool
    .query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'moment_responses_moment_user_unique'
         ) THEN
           ALTER TABLE moment_responses
             ADD CONSTRAINT moment_responses_moment_user_unique UNIQUE (moment_id, user_id);
         END IF;
       END $$;`,
    )
    .catch((err: Error) =>
      console.error("moment_responses unique constraint migration failed:", err),
    );

  // Lets us look up the venue's real phone number and a Maps link at
  // booking-confirmation time, without a fresh (less precise) name search —
  // Google Places was already queried once at moment creation; this just
  // keeps the same result identifiable later.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue_place_id TEXT`)
    .catch((err: Error) =>
      console.error("moments.venue_place_id migration failed:", err),
    );

  // True no-answer/busy/failed/canceled calls (nobody and nothing picked up)
  // get a delayed follow-up text instead of an instant one — see
  // sendMissedCallFollowUp's call sites in co.ts and the follow-up cron.
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS pending_call_followups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        call_sid TEXT NOT NULL,
        call_status TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
    )
    .catch((err: Error) =>
      console.error("pending_call_followups table init failed:", err),
    );

  // Backing the moderator venue-approval gate — mirrors circles.keana_notified_at.
  // Consensus is reached, but nothing texts the Connector until Keana approves
  // the selected venue via the same approve/reject reply pattern circle
  // placement already uses.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS keana_venue_notified_at TIMESTAMPTZ`)
    .catch((err: Error) =>
      console.error("moments.keana_venue_notified_at migration failed:", err),
    );

  // Venue names Keana has rejected for this moment, so re-selection after a
  // reject excludes them instead of re-rolling the same pick.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS rejected_venues TEXT[] DEFAULT '{}'`)
    .catch((err: Error) =>
      console.error("moments.rejected_venues migration failed:", err),
    );

  // venue_type/vibe — persisted from the moment-generation LLM call so the
  // Keana venue-rejection path can re-run venue selection later (a fresh
  // request, not the original one) with the same search criteria instead of
  // guessing at what kind of venue was wanted.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue_type TEXT`)
    .catch((err: Error) => console.error("moments.venue_type migration failed:", err));

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS vibe TEXT`)
    .catch((err: Error) => console.error("moments.vibe migration failed:", err));

  // The original neighborhood search term used for venue selection —
  // location_name gets overwritten with the selected venue's actual street
  // address once one's found, so it can't be reused to re-search on a
  // Keana rejection (confirmed: would search Places for an address string
  // instead of a neighborhood).
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS neighborhood TEXT`)
    .catch((err: Error) => console.error("moments.neighborhood migration failed:", err));

  // Unused — was part of the Connector booking-task reassignment loop,
  // removed once Co stopped asking anyone to book a table. Left in place
  // rather than dropped, per a deliberate choice not to run destructive
  // schema migrations for a few dead columns.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS tried_connector_ids UUID[] DEFAULT '{}'`)
    .catch((err: Error) =>
      console.error("moments.tried_connector_ids migration failed:", err),
    );

  // Marks calls the AMD callback flagged as an answering machine/voicemail.
  // The Hume chat_ended webhook still fires normally for these (we hang up
  // cleanly now instead of killing the call abruptly) — without this flag it
  // runs the full psychographic-extraction + follow-up-text pipeline against
  // a one-sided transcript of Co talking to a voicemail box, hallucinating a
  // "reflection" on lines Co itself said.
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS voicemail_calls (
        call_sid TEXT PRIMARY KEY,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      )`,
    )
    .catch((err: Error) =>
      console.error("voicemail_calls table init failed:", err),
    );

  // Candidate time windows offered by the simultaneous availability poll —
  // computed once from the venue's real opening hours + the circle's stated
  // schedule preferences, and stored here so every member's poll text and
  // the consensus cron's tally are reading the exact same option set.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS candidate_windows JSONB`)
    .catch((err: Error) => console.error("moments.candidate_windows migration failed:", err));

  // Which candidate_windows indices (1-based) a member said work for them —
  // separate from `response`, which keeps its existing yes/no/time/booked/
  // unclear meaning; a windows-poll reply sets response = 'windows' as a
  // sentinel and the actual picks land here.
  pool
    .query(`ALTER TABLE moment_responses ADD COLUMN IF NOT EXISTS selected_windows INT[]`)
    .catch((err: Error) =>
      console.error("moment_responses.selected_windows migration failed:", err),
    );

}
