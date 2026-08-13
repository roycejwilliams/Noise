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
          'call_transcript','text_exchange','check_in','intent','recap','system','placement',
          'call_offer_pending','call_offer_resolved','call_offer_declined_topic'
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

  // --- Confidence-gated circle placement + Co-run venue booking (ported from co-test) ---

  // Single atomic block, not a separate rename + ADD COLUMN IF NOT EXISTS —
  // those are two unawaited pool.query calls with no ordering guarantee
  // between them, so a plain ADD COLUMN could win the race and create the
  // new column first, permanently orphaning any existing keana_notified_at
  // data (the rename's own NOT EXISTS guard would then never fire again).
  pool
    .query(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'circles' AND column_name = 'keana_notified_at')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'circles' AND column_name = 'moderator_notified_at')
         THEN
           ALTER TABLE circles RENAME COLUMN keana_notified_at TO moderator_notified_at;
         ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'circles' AND column_name = 'moderator_notified_at')
         THEN
           ALTER TABLE circles ADD COLUMN moderator_notified_at TIMESTAMPTZ;
         END IF;
       END $$;`,
    )
    .catch((err: Error) =>
      console.error("circles.moderator_notified_at migration failed:", err),
    );

  // Backing the moderator venue-approval gate — mirrors circles.moderator_notified_at.
  // main never had a venue-approval notification column at all, so this always
  // takes the plain-ADD branch — same atomic-block shape kept for consistency
  // and so this stays correct if a keana_venue_notified_at column ever existed.
  pool
    .query(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'moments' AND column_name = 'keana_venue_notified_at')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'moments' AND column_name = 'moderator_venue_notified_at')
         THEN
           ALTER TABLE moments RENAME COLUMN keana_venue_notified_at TO moderator_venue_notified_at;
         ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'moments' AND column_name = 'moderator_venue_notified_at')
         THEN
           ALTER TABLE moments ADD COLUMN moderator_venue_notified_at TIMESTAMPTZ;
         END IF;
       END $$;`,
    )
    .catch((err: Error) =>
      console.error("moments.moderator_venue_notified_at migration failed:", err),
    );

  // Venue names the Moderator has rejected for this moment, so re-selection
  // after a reject excludes them instead of re-rolling the same pick.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS rejected_venues TEXT[] DEFAULT '{}'`)
    .catch((err: Error) =>
      console.error("moments.rejected_venues migration failed:", err),
    );

  // venue_type/vibe — persisted from the moment-generation LLM call so a
  // Moderator venue-rejection path can re-run venue selection later with the
  // same search criteria instead of guessing at what kind of venue was wanted.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue_type TEXT`)
    .catch((err: Error) => console.error("moments.venue_type migration failed:", err));

  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS vibe TEXT`)
    .catch((err: Error) => console.error("moments.vibe migration failed:", err));

  // The original neighborhood search term used for venue selection —
  // location_name gets overwritten with the selected venue's actual street
  // address once one's found, so it can't be reused to re-search on a
  // Moderator rejection.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS neighborhood TEXT`)
    .catch((err: Error) => console.error("moments.neighborhood migration failed:", err));

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

  // Confidence-gated Moderator escalation — a circle score barely clearing
  // its floor (min_group_score, matching.ts) sets this true so the
  // auto-approve sweep in jobs/index.ts skips it instead of silently
  // approving; confidence_note is the human-readable reason surfaced in the
  // Moderator notification.
  pool
    .query(`ALTER TABLE circles ADD COLUMN IF NOT EXISTS requires_moderator_reply BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("circles.requires_moderator_reply migration failed:", err));
  pool
    .query(`ALTER TABLE circles ADD COLUMN IF NOT EXISTS confidence_note TEXT`)
    .catch((err: Error) => console.error("circles.confidence_note migration failed:", err));

  // Same idea for moments — venue_fit_score is Co's own self-rated fit for
  // the selected venue (0-1, see scoreVenuesWithCo in places.ts), persisted
  // at moment creation so it's still available when the consensus cron
  // requests Moderator approval later. consensus_low_confidence is set when
  // the consensus cron had to force-lock a time window at the 48hr cutoff
  // without ever reaching a real majority. Either one sets
  // requires_moderator_reply — see requestVenueApprovalFromModerator in
  // booking.ts.
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS requires_moderator_reply BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("moments.requires_moderator_reply migration failed:", err));
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS confidence_note TEXT`)
    .catch((err: Error) => console.error("moments.confidence_note migration failed:", err));
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS venue_fit_score REAL`)
    .catch((err: Error) => console.error("moments.venue_fit_score migration failed:", err));
  pool
    .query(`ALTER TABLE moments ADD COLUMN IF NOT EXISTS consensus_low_confidence BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("moments.consensus_low_confidence migration failed:", err));

  // circle_name was varchar(50) — generateCircleTitle (circleInvite.ts)
  // returns "{title} {description}", which routinely exceeds 50 characters
  // and would otherwise throw a hard varchar-length error on every approval,
  // before the real invite text ever got sent.
  pool
    .query(`ALTER TABLE circles ALTER COLUMN circle_name TYPE TEXT`)
    .catch((err: Error) => console.error("circles.circle_name widen migration failed:", err));

  // is_circle_connector / trust_score-based connector demotion are no longer
  // written by any code path as of this migration (Co now books venues
  // directly — see services/booking.ts) — left as unused columns rather than
  // dropped, per this codebase's convention of not running destructive
  // schema changes for a few dead columns. Any circle mid-flight under the
  // old system (a connector already assigned, waiting to book) simply never
  // gets nudged or escalated again; nothing reads is_circle_connector going
  // forward, so those rows are inert, not broken.
}
