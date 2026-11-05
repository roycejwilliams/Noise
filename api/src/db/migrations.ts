import pool from "./db.js";

// Sequential + awaitable (2026-09-17 code review): every statement below
// used to fire as its own unawaited pool.query(...).catch(...) chain, so
// ~85 DDL statements ran concurrently at boot with no ordering guarantee —
// an ALTER on a table could race ahead of the CREATE TABLE the same boot was
// still running, fail, and just get logged with nothing to retry it until
// the next deploy. Each statement below is now awaited in the order it's
// written, and this function is async so server.ts can await the whole pass
// before accepting traffic instead of racing requests against schema setup.
// Each individual statement keeps its existing fail-open behavior (log and
// move on) — that's a deliberate, pre-existing convention in this file (see
// e.g. the old postgis migration, which failed every boot for weeks without
// ever crashing the server) — so this function itself only rejects if
// something outside a statement's own try/catch throws, not for an
// individual DDL failure.
export async function runMigrations(): Promise<void> {
  // Harness decision log (2026-09-14) — see src/harness/core.ts. One row
  // per gated AI decision in any layer: what was proposed, which hard
  // checks passed or failed, and what actually happened.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS harness_decisions (
        id BIGSERIAL PRIMARY KEY,
        layer SMALLINT NOT NULL,
        decision TEXT NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        outcome TEXT NOT NULL,
        action TEXT,
        proposal JSONB,
        checks JSONB NOT NULL DEFAULT '[]',
        confidence TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() =>
      Promise.all([
        pool.query(`CREATE INDEX IF NOT EXISTS idx_harness_decisions_user ON harness_decisions (user_id, created_at DESC)`),
        pool.query(`CREATE INDEX IF NOT EXISTS idx_harness_decisions_decision ON harness_decisions (layer, decision, created_at DESC)`),
      ]),
    )
    .catch((err: Error) => console.error("harness_decisions table init failed:", err));

  // What each Claude request cost (2026-09-23), one row per request, written
  // by services/llmUsage.ts. Token counts by billing type; no message text.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS llm_usage (
        id BIGSERIAL PRIMARY KEY,
        function_id TEXT NOT NULL,
        trace_id TEXT,
        model TEXT NOT NULL,
        input_uncached INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        web_searches INTEGER NOT NULL DEFAULT 0,
        cost_usd NUMERIC(12, 6),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage (created_at DESC, function_id)`))
    // Who each call was for (2026-10-23, cost per member): nullable, no foreign key, so a usage row never blocks removing a
    // member and a row for a call about no single member stays null.
    .then(() => pool.query(`ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS user_id UUID`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage (user_id, created_at DESC) WHERE user_id IS NOT NULL`))
    // A request that failed says so (2026-10-29: a rejected key wrote five days of $0 rows): its kind and status, never its message.
    .then(() => pool.query(`ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS error TEXT`))
    .catch((err: Error) => console.error("llm_usage table init failed:", err));

  // Each model request's prompt and answer, ours only (2026-10-18): Langfuse gets no text, so the trace id it shows is
  // looked up here (services/llmTraceText.ts). 14 days, then the daily job deletes it; it goes with the member (cascade on
  // delete, deleted on archive and on any removal they ask for). Images are stored as a marker, never their bytes.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS llm_trace_text (
        id BIGSERIAL PRIMARY KEY,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        function_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        input TEXT,
        output TEXT
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_llm_trace_text_trace ON llm_trace_text (trace_id)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_llm_trace_text_user ON llm_trace_text (user_id, created_at)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_llm_trace_text_time ON llm_trace_text (created_at)`))
    .catch((err: Error) => console.error("llm_trace_text table init failed:", err));

  // Dated corrections (2026-09-23): when someone corrects something on
  // their profile, the old value comes off co_profiles and the change is
  // kept here with its date (services/profileExtraction.ts storeProfile).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS profile_corrections (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT,
        quote TEXT NOT NULL,
        corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_profile_corrections_user ON profile_corrections (user_id, corrected_at DESC)`))
    // What they corrected or removed through Co itself (services/whatCoKnows.ts, 2026-10-12): which item it was, and whether it was
    // removed. The rebuilds (snapshot, claims, threads, profile extraction) read these to never put it back.
    .then(() => pool.query(`ALTER TABLE profile_corrections ADD COLUMN IF NOT EXISTS item_ref TEXT, ADD COLUMN IF NOT EXISTS removed BOOLEAN NOT NULL DEFAULT false`))
    .catch((err: Error) => console.error("profile_corrections table init failed:", err));

  // Who is at a Co event (2026-09-23, services/eventPresence.ts): when Co
  // asked, when their shared location was first seen, and when they
  // arrived or left. Times only, never coordinates.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_presence (
        event_api_id TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asked_at TIMESTAMPTZ,
        sharing_seen_at TIMESTAMPTZ,
        near_since TIMESTAMPTZ,
        arrived_at TIMESTAMPTZ,
        arrived_via TEXT CHECK (arrived_via IN ('location', 'text')),
        away_since TIMESTAMPTZ,
        left_at TIMESTAMPTZ,
        PRIMARY KEY (event_api_id, user_id)
      )`,
    )
    // The pre-arrival text and opt-in location, per event (services/preArrival.ts, 2026-09-30).
    .then(() => pool.query(`ALTER TABLE event_presence ADD COLUMN IF NOT EXISTS pre_arrival_sent_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS location_yes_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS location_yes_quote TEXT, ADD COLUMN IF NOT EXISTS location_stopped_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS not_going_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS far_note_sent_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS met_someone_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS met_quote TEXT`))
    // The member brief (services/eventBrief.ts): their yes or no to being named in it, asked once when they RSVP.
    .then(() => pool.query(`ALTER TABLE event_presence ADD COLUMN IF NOT EXISTS name_asked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS name_ok BOOLEAN, ADD COLUMN IF NOT EXISTS name_ok_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS name_ok_quote TEXT, ADD COLUMN IF NOT EXISTS brief_sent_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS name_ask_until TIMESTAMPTZ`))
    // The shareable-asks question beside it at RSVP (services/askSharing.ts): which asks were offered, in the order shown.
    .then(() => pool.query(`ALTER TABLE event_presence ADD COLUMN IF NOT EXISTS share_asked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS share_ask_ids TEXT[], ADD COLUMN IF NOT EXISTS share_answered_at TIMESTAMPTZ`))
    // The no-show flow (services/eventNoShow.ts, 2026-10-23): when they were asked if they made it, and how that settled.
    .then(() => pool.query(`ALTER TABLE event_presence ADD COLUMN IF NOT EXISTS noshow_asked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS noshow_settled_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS noshow_outcome TEXT`))
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS event_follow_throughs (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        people_count INT NOT NULL DEFAULT 0,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, event_id)
      )`))
    // Files a member sends Co (services/memberFiles.ts): theirs alone, read once, deleted on their ask. The text is the only copy.
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS member_files (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        n INT NOT NULL,
        name TEXT,
        sha256 TEXT NOT NULL,
        bytes INT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, sha256),
        UNIQUE (user_id, n)
      )`))
    // The partner readout, once built (services/partnerReadoutSend.ts): frozen counts and the page, the team's yes, the host's
    // email the team gave, and the read-only link (only its hash is kept). One per event.
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS partner_readouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id TEXT NOT NULL UNIQUE,
        event_name TEXT NOT NULL,
        stats JSONB NOT NULL,
        text TEXT NOT NULL,
        html TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','withdrawn')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ,
        approved_by TEXT,
        host_email TEXT,
        link_token_hash TEXT UNIQUE,
        link_expires_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        withdrawn_at TIMESTAMPTZ
      )`))
    .then(() => pool.query(`ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS vouched_by UUID REFERENCES users(id) ON DELETE SET NULL`))
    // What Co holds about a member, each claim labelled (user_said / co_inferred) with a lifetime (services/claims.ts).
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS member_claims (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('user_said','co_inferred')),
        kind TEXT NOT NULL,
        quote TEXT,
        said_on DATE NOT NULL,
        confirmed_on DATE NOT NULL,
        expires_on DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_member_claims_user ON member_claims (user_id, expires_on)`))
    // When a member's claims were last refreshed: the window for the next read starts here, and a member whose claims all expired is not re-read every night.
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS member_claims_state (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, refreshed_at TIMESTAMPTZ NOT NULL)`))
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS event_briefs (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        named_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        confirmed_count INT NOT NULL DEFAULT 0,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`))
    .catch((err: Error) => console.error("event_presence table init failed:", err));

  // What came of each promise Co made on a call, tied to that call by a
  // transcript fingerprint (services/callKey.ts), so the after-call text for
  // that call is the one that reports it (2026-09-24).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS call_promise_results (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        call_key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_call_promise_results_call ON call_promise_results (user_id, call_key)`))
    // A redelivered end-of-call must not list the same result twice.
    .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_call_promise_results ON call_promise_results (user_id, call_key, md5(content))`))
    .catch((err: Error) => console.error("call_promise_results table init failed:", err));

  // Test events and test locations for test members, co-test and local only
  // (services/testNumbers.ts). Never on production.
  await (async () => {
    const { testNumbersEnabled } = await import("../services/testNumbers.js");
    if (!testNumbersEnabled()) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS co_test_events (api_id TEXT PRIMARY KEY, name TEXT NOT NULL, start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ, timezone TEXT, venue TEXT, address TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, url TEXT, guest_user_ids UUID[] NOT NULL DEFAULT '{}')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS co_test_locations (user_id UUID PRIMARY KEY, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, accuracy DOUBLE PRECISION, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })().catch((err: Error) => console.error("test event tables init failed:", err));

  // True between claiming the day-of ask and it actually going out, so a
  // server killed in between leaves a marker that services/strandedClaims.ts
  // clears for a retry (2026-09-24). Old rows default to false: already sent.
  await pool
    .query(`ALTER TABLE event_presence ADD COLUMN IF NOT EXISTS ask_pending BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("event_presence.ask_pending migration failed:", err));

  // A heads-up about an event Co doesn't run names no one until both people
  // say yes (2026-09-23): marks those nudges so replies never name the other
  // person early.
  await pool
    .query(`ALTER TABLE event_guest_match_nudges ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("event_guest_match_nudges.anonymous migration failed:", err));

  await pool
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

  await pool
    .query(
      `ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS hume_chat_group_id TEXT`,
    )
    .catch((err: Error) =>
      console.error("co_profiles.hume_chat_group_id migration failed:", err),
    );

  await pool
    .query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT`,
    )
    .catch((err: Error) =>
      console.error("users.subscription_status migration failed:", err),
    );

  await pool
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

  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS intent JSONB DEFAULT '[]'::jsonb`)
    .catch((err: Error) =>
      console.error("co_profiles.intent migration failed:", err),
    );

  // Replaces a dead migration that added `coordinates geometry(Point,4326)`
  // assuming PostGIS — confirmed live, 2026-09-02: PostGIS was never
  // installed and isn't even available to install on this Postgres
  // (pg_available_extensions has no postgis entry; Railway's managed image
  // only ships pgvector), so that column migration has been silently
  // failing every single deploy since it was added. geocoding.ts's plain
  // lat/lng + haversine radius filter needs no extension at all.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS geocode_cache (
        query TEXT PRIMARY KEY,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) =>
      console.error("geocode_cache migration failed:", err),
    );

  // Timezone-aware proactive contact (Royce, 2026-09-02: a real "thinking
  // about you" text arrived at 2am Pacific — jobs/index.ts's crons fired at
  // fixed UTC hours with zero regard for the recipient's actual local time).
  // timezone lazily backfills onto the same geocode_cache row geocodeCity()
  // already maintains, resolved via the offline geo-tz package (see
  // services/geocoding.ts's getTimezoneForCity) rather than a second cache
  // table or another Google API needing manual enablement.
  await pool
    .query(`ALTER TABLE geocode_cache ADD COLUMN IF NOT EXISTS timezone TEXT`)
    .catch((err: Error) =>
      console.error("geocode_cache.timezone migration failed:", err),
    );

  // Separate from last_surfaced_at (the 3-day cadence clock) — this bumps
  // on EVERY attemptEventSurfacing invocation regardless of outcome, purely
  // to stop the event-surfacing cron's new hourly local-hour-gated schedule
  // from re-running its expensive urgent/full tiered check on every hourly
  // tick inside a user's reasonable-hours window (~11 ticks/day instead of
  // 1) — see jobs/index.ts.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ`)
    .catch((err: Error) =>
      console.error("ask_checkins.last_attempted_at migration failed:", err),
    );

  // Retire PostGIS from production too (Royce, 2026-09-02: "It's settled" —
  // the app that was the only thing writing to co_profiles.coordinates is
  // being sunset). Confirmed before this went in: nothing in the codebase
  // ever reads coordinates (no SELECT, ST_Distance, ST_DWithin anywhere) —
  // the app-side write (routes/co.ts's now-removed POST /co/location) had
  // zero downstream consumer even while it was live. No-op on co-test,
  // where neither the column nor the extension exist in the first place.
  //
  // Guarded (2026-09-17): DROP COLUMN IF EXISTS / DROP EXTENSION IF EXISTS
  // are themselves idempotent no-ops once this has run once, but they still
  // did a catalog write attempt on every single boot forever. A cheap
  // existence check up front makes every boot after the first a single
  // read-only SELECT instead.
  try {
    const [{ rows: colRows }, { rows: extRows }] = await Promise.all([
      pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'co_profiles' AND column_name = 'coordinates'`,
      ),
      pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'postgis'`),
    ]);
    if (colRows[0] || extRows[0]) {
      await pool.query(`ALTER TABLE co_profiles DROP COLUMN IF EXISTS coordinates`);
      await pool.query(`DROP EXTENSION IF EXISTS postgis`);
    }
  } catch (err) {
    console.error("postgis teardown migration failed:", err);
  }

  await pool
    .query(`CREATE INDEX IF NOT EXISTS idx_co_profiles_city ON co_profiles (city)`)
    .catch((err: Error) =>
      console.error("co_profiles.city index migration failed:", err),
    );

  // Guarded (2026-09-17): this used to DROP + re-ADD the constraint on every
  // single boot regardless of whether the allowed set had actually changed —
  // ADD CONSTRAINT's default validation is a full table scan under a lock
  // that blocks concurrent writes to co_memories, paid on every deploy for
  // nothing. Now it compares the live definition (pg_get_constraintdef)
  // against the values below first and only touches the constraint when
  // they actually differ, and even then adds it NOT VALID (metadata-only)
  // before VALIDATE CONSTRAINT (a separate, non-exclusive-lock scan) instead
  // of one blocking ADD CONSTRAINT.
  try {
    const memoryTypes = [
      "call_transcript", "text_exchange", "check_in", "intent", "recap", "system", "placement",
      "call_offer_pending", "call_offer_resolved", "recommendation", "call_offer_declined_topic",
      "event_ask_solicitation", "calendar_follow_reach_out", "event_discovery_surfacing",
      "event_change_notification", "event_offer_pending", "event_offer_resolved",
      "recommendation_outcome", "companion_checkin", "event_checkin_outcome",
      "event_guest_match_nudge", "event_guest_match_optin", "event_intro_group_created",
      "event_intro_email_sent", "network_offer_pending", "network_offer_resolved",
      "network_intro_offer_pending", "recommendation_offered", "call_correction",
      // Written by code but missing here, so every write failed quietly
      // (found 2026-09-26): why a call failed, the closest miss Co
      // mentioned, whether a promise was kept, a held send, and what a
      // follow-up was about.
      "call_failure", "closest_miss_mentioned", "promise_result", "send_held", "followup_context",
      // What Co learned about how to be with them from their pushback (services/connectDots.ts).
      "co_lesson",
      // The text before a Co event (services/preArrival.ts).
      "event_pre_arrival",
      // The member brief and the question that lets it name them (services/eventBrief.ts).
      "event_brief", "event_brief_ask", "event_follow_through",
      // Written by the outreach agent removed on 2026-10-14; kept so its stored rows stay valid.
      "mo_member", "mo_member_offer",
      // What a web search kept, with its link, so "send it" works on a later turn
      // (services/researchFinds.ts, 2026-10-03).
      "research_find",
      // Their design taste for decks and other artifacts, and Co's one ask about it (services/designTaste.ts, 2026-10-11).
      "design_taste", "design_taste_asked",
      // What kind of room they've said they want (services/roomTaste.ts, 2026-10-09).
      "room_taste",
    ];
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'co_memories_memory_type_check' AND conrelid = 'co_memories'::regclass`,
    );
    const currentDef: string | undefined = rows[0]?.def;
    const currentValues = currentDef ? Array.from(currentDef.matchAll(/'([^']+)'/g)).map((m) => m[1]) : [];
    const same =
      !!currentDef &&
      currentValues.length === memoryTypes.length &&
      memoryTypes.every((v) => currentValues.includes(v));

    if (!same) {
      await pool.query(`ALTER TABLE co_memories DROP CONSTRAINT IF EXISTS co_memories_memory_type_check`);
      await pool.query(
        `ALTER TABLE co_memories ADD CONSTRAINT co_memories_memory_type_check
           CHECK (memory_type = ANY (ARRAY[${memoryTypes.map((v) => `'${v}'`).join(", ")}])) NOT VALID`,
      );
      await pool.query(`ALTER TABLE co_memories VALIDATE CONSTRAINT co_memories_memory_type_check`);
    }
  } catch (err) {
    console.error("co_memories.memory_type_check migration failed:", err);
  }

  await pool
    .query(`
      ALTER TABLE users ALTER COLUMN subscription_status SET DEFAULT 'inactive';
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_status_check;
      ALTER TABLE users ADD CONSTRAINT users_subscription_status_check
        CHECK (subscription_status = ANY (ARRAY['active','inactive','past_due','canceled']));
    `)
    .catch((err: Error) =>
      console.error("users.subscription_status migration failed:", err),
    );

  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`)
    .catch((err: Error) =>
      console.error("users.stripe_customer_id migration failed:", err),
    );

  // Gates whether Co can message a number yet — our Sendblue plan only allows
  // replying to contacts who have texted in first, so new self-serve
  // registrations must text in before their OTP is sent. Existing rows are
  // backfilled to true separately (one-time, not part of this migration) so
  // pre-existing accounts aren't newly blocked.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_verified BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) =>
      console.error("users.contact_verified migration failed:", err),
    );

  // Whether we actually know this person's real name/email yet. CoPatible no
  // longer runs a separate signup form (Framer or otherwise) — a brand-new
  // phone number gets a placeholder users row (see services/identity.ts)
  // instead of being dropped, and this is what gates asking for their name
  // and email over text before the normal Co conversation starts. Defaults
  // true so every pre-existing row (which already has real identity) is
  // unaffected — only identity.ts's placeholder-row insert sets it false.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_captured BOOLEAN NOT NULL DEFAULT true`)
    .catch((err: Error) =>
      console.error("users.identity_captured migration failed:", err),
    );

  // Separate from identity_captured — tracks whether the welcome/name-email
  // ask has actually gone out yet, so a placeholder row that already
  // received the ask gets its reply parsed as an answer, while one that
  // hasn't yet gets the ask instead of being re-parsed as gibberish. Same
  // default-true/false-only-on-placeholder-creation reasoning as above.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS intake_asked BOOLEAN NOT NULL DEFAULT true`)
    .catch((err: Error) =>
      console.error("users.intake_asked migration failed:", err),
    );

  // Co is referral-only (2026-09-17, Royce: "we're trying to grow so large
  // that we make a secret network" — a referral gate keeps who's in it tied
  // to who's already in it, instead of open signup). Same
  // default-true/false-only-on-placeholder-creation convention as
  // identity_captured/intake_asked above: every pre-existing row is
  // unaffected, only a brand-new placeholder row (services/identity.ts)
  // starts unverified and gets asked for a code before intake begins.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_verified BOOLEAN NOT NULL DEFAULT true`)
    .catch((err: Error) => console.error("users.invite_verified migration failed:", err));
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_asked BOOLEAN NOT NULL DEFAULT true`)
    .catch((err: Error) => console.error("users.invite_asked migration failed:", err));

  // Single-use invite codes (Royce, 2026-09-17: "referral code to join").
  // created_by is nullable for founder-seeded codes with no referring
  // member; used_by/used_at are set atomically on redemption
  // (services/inviteCodes.ts's row-locked transaction, same pattern as
  // routes/referrals.ts's existing referral-credit spend).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        used_by UUID REFERENCES users(id) ON DELETE SET NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("invite_codes table init failed:", err));
  // When the member who made a code was told their friend joined
  // (services/invites.ts claimJoinNotice), so the note goes out once.
  await pool
    .query(`ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS inviter_notified_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("invite_codes.inviter_notified_at migration failed:", err));

  // True no-answer/busy/failed/canceled calls (nobody and nothing picked up)
  // get a delayed follow-up text instead of an instant one — see
  // sendMissedCallFollowUp's call sites in co.ts and the follow-up cron.
  await pool
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

  // Marks calls the AMD callback flagged as an answering machine/voicemail.
  // The Hume chat_ended webhook still fires normally for these (we hang up
  // cleanly now instead of killing the call abruptly) — without this flag it
  // runs the full psychographic-extraction + follow-up-text pipeline against
  // a one-sided transcript of Co talking to a voicemail box, hallucinating a
  // "reflection" on lines Co itself said.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS voicemail_calls (
        call_sid TEXT PRIMARY KEY,
        detected_at TIMESTAMPTZ DEFAULT NOW()
      )`,
    )
    .catch((err: Error) =>
      console.error("voicemail_calls table init failed:", err),
    );

  // Post-call reflection text used to fire immediately at chat_ended — reads
  // as a scripted status update landing the second the call ends, not
  // something a person who was actually listening would do. One row per
  // call, send_at randomized 2h-2d out at chat_ended time (see
  // sendFollowUpText's caller), a cron polls for due rows and generates the
  // actual message text at send time (not schedule time) so it's a fresh
  // LLM call each send, not a stored/reused string. sent_at is the
  // once-only guard — the poller's WHERE clause excludes anything already
  // sent, and it's set in the same statement that sends, not after, so a
  // crash between send and mark-sent fails closed (skipped, not resent)
  // rather than risking a duplicate.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS post_call_follow_ups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        transcript TEXT NOT NULL,
        send_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_post_call_follow_ups_due
         ON post_call_follow_ups (send_at) WHERE sent_at IS NULL`,
      ),
    )
    .catch((err: Error) => console.error("post_call_follow_ups table/index init failed:", err));

  // Co Loop Stage 1 — long-term personal + career direction, captured
  // separately from goals_challenges (which is "what they're working toward
  // or struggling with" right now). Without this split there is no data that
  // distinguishes an immediate ask from a longer-horizon trajectory, which is
  // exactly the gap between "beyond a resume" matching and matching on
  // whatever's currently top of mind. trajectory_embedding is recomputed from
  // it the same way goal_embeddings is recomputed from goals — see
  // profileExtraction.ts storeProfile.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS long_term_direction TEXT`)
    .catch((err: Error) => console.error("co_profiles.long_term_direction migration failed:", err));
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS trajectory_embedding vector(1536)`)
    .catch((err: Error) => console.error("co_profiles.trajectory_embedding migration failed:", err));

  // Member time zone (Royce, 2026-10-07: "Co is time-aware at all times"). Additive: the zone is derived from the city and
  // stored with the city it came from (timezone_city), so a later city change re-derives it on the next read
  // (services/memberTime.ts memberZone). Backfill: src/scripts/backfillMemberZones.ts (dry run by default); reads also fill it.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS timezone TEXT, ADD COLUMN IF NOT EXISTS timezone_city TEXT`)
    .catch((err: Error) => console.error("co_profiles.timezone migration failed:", err));

  // Co Loop Stage 3 — an HNSW index on goal_embeddings. Every existing caller
  // of goal_embeddings (findBestCircleWithScore) only ever compares it in JS
  // across a handful of already-city/chapter-filtered candidates, so no index
  // was needed. relevance.ts's network-wide pre-filter is the first caller
  // that orders by <=> across the whole co_profiles table with no narrowing
  // WHERE clause first — same reasoning as the co_memories embedding index
  // above.
  await pool
    .query(`CREATE INDEX IF NOT EXISTS co_profiles_goal_embeddings_hnsw_idx
      ON co_profiles USING hnsw (goal_embeddings vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)`)
    .catch((err: Error) => console.error("co_profiles goal_embeddings index failed:", err));

  // Co Loop Stage 3 — every relevance call filterByStatedAsk confirms gets
  // logged here, even when nothing is ever acted on. This is the "prove it
  // before you build it" data: Stage 6 later validates these against what
  // actually happened before facilitation (Stage 4) is ever switched on.
  // ask_id correlates back to the id on the co_profiles.intent[] entry
  // (JSONB, not a normalized table, so this is a plain TEXT correlation key
  // rather than a real foreign key) — same id ask_checkins below uses, so
  // Stage 6 can resolve both in one pass. UNIQUE (person_id, candidate_id,
  // ask_id) makes re-sweeping the same ask idempotent — see
  // relevance.ts's sweepAllOpenAsks, which re-runs every open ask daily.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS relevance_edges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ask_id TEXT NOT NULL,
        ask_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retired', 'acted_on')),
        retired_at TIMESTAMPTZ,
        retired_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (person_id, candidate_id, ask_id)
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_relevance_edges_person_status ON relevance_edges (person_id, status)`,
      ),
    )
    .catch((err: Error) => console.error("relevance_edges table/index init failed:", err));

  // matching.ts extensions — scoreAgainstStatedAsk (replacing the old binary
  // filterByStatedAsk internals) grades every candidate 0-100 instead of a
  // hard pass/fail, so a "no strong match" ask is now distinguishable from
  // "three people were close." match_reason is the one-line grounding the
  // model gave for the score, so relevance_edges is actually readable, not
  // just a count. mutual flags whether the candidate's own stated ask/
  // offering plausibly points back at the asker — a two-way signal, not just
  // "do they satisfy what I asked for."
  await pool
    .query(`ALTER TABLE relevance_edges ADD COLUMN IF NOT EXISTS match_score INT`)
    .catch((err: Error) => console.error("relevance_edges.match_score migration failed:", err));
  await pool
    .query(`ALTER TABLE relevance_edges ADD COLUMN IF NOT EXISTS match_reason TEXT`)
    .catch((err: Error) => console.error("relevance_edges.match_reason migration failed:", err));
  // share_reason (2026-09-14): match_reason is built from the candidate's
  // private profile + memories and was being revealed to the asker and put
  // in intro emails. share_reason only draws on the candidate's own stated
  // ask/offering; it's the only reason network intros may show anyone.
  await pool
    .query(`ALTER TABLE relevance_edges ADD COLUMN IF NOT EXISTS share_reason TEXT`)
    .catch((err: Error) => console.error("relevance_edges.share_reason migration failed:", err));
  await pool
    .query(`ALTER TABLE relevance_edges ADD COLUMN IF NOT EXISTS mutual BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("relevance_edges.mutual migration failed:", err));

  // Co Loop Stage 5 — tracks the check-in cadence for a stated ask so it
  // never just goes stale after being captured once. One row per ask
  // (ask_id, same correlation key as relevance_edges above), inserted by
  // captureIntent. The check-in cron (jobs/index.ts) polls for rows where
  // last_checked_at (or created_at, for a never-checked row) is more than 21
  // days old and resolved_at is still null; resolved_at is set by Stage 6
  // once assessResolvedItems confirms the underlying ask is done, which also
  // stops any further check-ins.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS ask_checkins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ask_id TEXT NOT NULL,
        ask_text TEXT NOT NULL,
        last_checked_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, ask_id)
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_ask_checkins_pending ON ask_checkins (last_checked_at) WHERE resolved_at IS NULL`,
      ),
    )
    .catch((err: Error) => console.error("ask_checkins table/index init failed:", err));

  // Co Loop Stage 5 extensions — all four are context/cadence refinements on
  // the existing check-in loop, not new user-facing actions, so (per product
  // decision) they don't need the same "prove it first" bar Stage 4 does.
  // checkin_count drives both adaptive cadence (relevance.ts has no cadence
  // logic of its own — the cron in jobs/index.ts reads relevance_edges
  // directly) and escalating tone after repeated unresolved check-ins.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS checkin_count INT NOT NULL DEFAULT 0`)
    .catch((err: Error) => console.error("ask_checkins.checkin_count migration failed:", err));

  // Response-rate tracking — awaiting_response_since is set when a check-in
  // sends and cleared by the next inbound message from that person (see
  // sendblue.ts webhook), regardless of what that message says; the content
  // judgment (resolved or not) is Stage 6's job, this only measures whether
  // they engaged at all. responded_count/last_response_at are the resulting
  // signal, e.g. for spotting asks nobody bothers replying about.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS awaiting_response_since TIMESTAMPTZ`)
    .catch((err: Error) => console.error("ask_checkins.awaiting_response_since migration failed:", err));
  // What the ask is (services/askLifecycle.ts askIntent, Royce 2026-10-13): a question Co answers, or a lookout that stays open.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS intent TEXT, ADD COLUMN IF NOT EXISTS intent_why TEXT`)
    .catch((err: Error) => console.error("ask_checkins.intent migration failed:", err));
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS responded_count INT NOT NULL DEFAULT 0`)
    .catch((err: Error) => console.error("ask_checkins.responded_count migration failed:", err));
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS last_response_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("ask_checkins.last_response_at migration failed:", err));

  // "Luma & X asks need to surface periodically" (Royce, 2026-08-30) — the
  // event/opportunity surfacing cadence cron (jobs/index.ts) reuses this
  // same ask_checkins row (already one per active seeking ask) rather than
  // a parallel table, tracked separately from last_checked_at since
  // surfacing and check-in are different actions on different cadences.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS last_surfaced_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("ask_checkins.last_surfaced_at migration failed:", err));

  // Asks have a time limit (Royce, 2026-09-18). expires_at: the end of the
  // time frame they named, or a default lifespan renewed whenever they restate
  // it. An expired ask is closed with resolved_at (so every reader drops it)
  // and marked expired_at, to tell it apart from one that actually got
  // resolved. See services/askExpiry.ts.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("ask_checkins.expires_at migration failed:", err));
  await pool
    // An ask can name the goal it serves (the intent entry id of a goal). Stored only: no goal-progress reasoning yet (parked behind November).
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS serves_goal_id TEXT`)
    .catch((err: Error) => console.error("ask_checkins.serves_goal_id migration failed:", err));
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS closed_reason TEXT, ADD COLUMN IF NOT EXISTS closed_evidence TEXT, ADD COLUMN IF NOT EXISTS answered_checked_at TIMESTAMPTZ`)
    // The working set (services/workingSet.ts, 2026-10-09): empty runs in a row (backoff, then "searched, nothing found"), and which
    // version of the kind prompt read the ask.
    .then(() => pool.query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS empty_runs INT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS kind_version INT NOT NULL DEFAULT 1`))
    .catch((err: Error) => console.error("ask_checkins lifecycle columns migration failed:", err));
  // An ask whose empty runs weren't counted while its member was quiet (services/workingSet.ts nextEmptyRuns, 2026-10-14).
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS quiet_held_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("ask_checkins.quiet_held_at migration failed:", err));
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("ask_checkins.expired_at migration failed:", err));

  // Coverage-awareness extensions (profileExtraction.ts's getCoverageNudge) —
  // topics_covered persists which RAPPORT_TOPICS have been confirmed (topic
  // -> ISO timestamp), shared across call/text/check-in so a topic answered
  // on a call isn't re-judged by every subsequent text touchpoint, and so a
  // fully-covered profile can skip the coverage LLM call entirely.
  // topics_asked persists when Co last actually asked about a topic (whether
  // or not it got a real answer), so a dodged topic doesn't get re-surfaced
  // every single touchpoint.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS topics_covered JSONB NOT NULL DEFAULT '{}'::jsonb`)
    .catch((err: Error) => console.error("co_profiles.topics_covered migration failed:", err));
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS topics_asked JSONB NOT NULL DEFAULT '{}'::jsonb`)
    .catch((err: Error) => console.error("co_profiles.topics_asked migration failed:", err));

  // Double-text debounce (sendblue.ts webhook) — one row per phone number,
  // stamped the instant a webhook POST arrives, before withPhoneLock's
  // advisory lock is acquired. That ordering matters: once a phone's lock is
  // held, a second inbound message for that same phone can't run ANY code —
  // including a DB write — until the first one's lock is released, so a
  // still-queued message's arrival would otherwise be invisible to the
  // request currently waiting out its debounce window.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS phone_debounce (
        phone TEXT PRIMARY KEY,
        last_inbound_at TIMESTAMPTZ NOT NULL
      )`,
    )
    .catch((err: Error) => console.error("phone_debounce table init failed:", err));

  // Whether they'd rather text or talk, asked at the end of onboarding
  // (Royce, 2026-09-16). 'text' | 'call' | null (not asked or unclear).
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_preference TEXT`)
    .catch((err: Error) => console.error("users.contact_preference migration failed:", err));

  // Co's own events announced to nearby users on creation
  // (services/coEventAnnouncement.ts): one row per event and person.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_event_announcements (
        id BIGSERIAL PRIMARY KEY,
        event_api_id TEXT NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        gave_up_at TIMESTAMPTZ,
        UNIQUE (event_api_id, user_id)
      )`,
    )
    .catch((err: Error) => console.error("co_event_announcements table init failed:", err));

  // Issues test users report to Co (services/issueReports.ts). Test only:
  // written where CAPTURE_USER_ISSUES=true. Guarded here too (2026-09-17) —
  // this table used to get created in production as well, even though
  // services/issueReports.ts's captureEnabled() never lets prod write to it.
  // Same env check as captureEnabled, minus the CAPTURE_USER_ISSUES flag
  // itself (the table needs to exist before that flag is ever flipped on).
  if (process.env.RAILWAY_ENVIRONMENT_NAME === "dev" && process.env.RAILWAY_SERVICE_NAME === "co-test") {
    await pool
      .query(
        `CREATE TABLE IF NOT EXISTS user_reported_issues (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          message TEXT NOT NULL,
          summary TEXT NOT NULL,
          category TEXT NOT NULL,
          severity TEXT NOT NULL,
          conversation TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      )
      .catch((err: Error) => console.error("user_reported_issues table init failed:", err));
    // The morning "what broke" review's flags (harness/devReview.ts), dev only
    // like the reports above.
    await pool
      .query(
        `CREATE TABLE IF NOT EXISTS review_flags (
          id BIGSERIAL PRIMARY KEY,
          flag_key TEXT NOT NULL UNIQUE,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          flagged_at TIMESTAMPTZ NOT NULL,
          type TEXT NOT NULL,
          severity TEXT NOT NULL,
          snippet TEXT NOT NULL,
          decision_ids BIGINT[] NOT NULL DEFAULT '{}',
          cause TEXT NOT NULL,
          cause_confirmed BOOLEAN NOT NULL DEFAULT false,
          source TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      )
      .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_review_flags_flagged ON review_flags (flagged_at DESC)`))
      .catch((err: Error) => console.error("review_flags table init failed:", err));
  }

  // Co's own sent messages, by Sendblue handle (2026-09-28), so a reply can
  // thread under the thing being discussed (routes/sendblue.ts threadHandle).
  // user_id is matched from the number at send time; owner-scoped lookups only.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS outbound_messages (
        message_handle TEXT PRIMARY KEY,
        user_id UUID,
        content TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("outbound_messages table init failed:", err));
  // Who sent it: "co" (older rows also hold "mo" and "ops").
  await pool
    .query(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT 'co'`)
    .catch((err: Error) => console.error("outbound_messages.sender migration failed:", err));
  // Every link, read once (services/linkReader.ts, 2026-09-28). owner_key is
  // '' for public pages Co sent and the member's id for a link they texted,
  // so a member's own links stay theirs.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS link_reads (
        url TEXT NOT NULL,
        owner_key TEXT NOT NULL DEFAULT '',
        owner_user_id UUID,
        final_url TEXT,
        status TEXT NOT NULL,
        why TEXT,
        fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        summary TEXT,
        source TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (url, owner_key)
      )`,
    )
    .catch((err: Error) => console.error("link_reads table init failed:", err));
  // The page's own text, so Co can critique what they share (2026-09-29).
  await pool
    .query(`ALTER TABLE link_reads ADD COLUMN IF NOT EXISTS excerpt TEXT`)
    .catch((err: Error) => console.error("link_reads.excerpt migration failed:", err));
  // Details Co needs to do things for them that it must not guess (company,
  // role, LinkedIn), in their words. Owner-scoped (services/memberKit.ts).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_kit (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, key)
      )`,
    )
    .catch((err: Error) => console.error("member_kit table init failed:", err));
  await pool
    .query(`CREATE INDEX IF NOT EXISTS outbound_messages_user_sent ON outbound_messages (user_id, sent_at DESC)`)
    .catch((err: Error) => console.error("outbound_messages index failed:", err));

  // Sendblue delivery retries (2026-09-15): one inbound text is processed
  // once, keyed by Sendblue's message_handle, however many times the webhook
  // is delivered.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS inbound_webhook_handles (
        handle TEXT PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("inbound_webhook_handles table init failed:", err));
  // What arrived and whether its turn finished (2026-09-23): the restart
  // check (reportUnfinishedTurns) and the payload write in routes/sendblue.ts
  // relied on these columns since 2026-09-17, but nothing ever added them, so
  // both failed silently and a text lost to a restart was never noticed.
  await pool
    .query(`ALTER TABLE inbound_webhook_handles ADD COLUMN IF NOT EXISTS payload JSONB, ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("inbound_webhook_handles payload/finished_at migration failed:", err));
  // A retry owed for a text (a crashed turn, or an empty reply) and who took
  // it, so it runs once even across a restart (routes/sendblue.ts
  // replayOwedTurn, 2026-10-01 code review).
  await pool
    .query(`ALTER TABLE inbound_webhook_handles ADD COLUMN IF NOT EXISTS retry_due_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS retry_claimed_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("inbound_webhook_handles retry columns migration failed:", err));

  // Proactive check-in call cadence — user-set preference (7 or 14 days,
  // captured post-call via extractCheckinCadencePreference in
  // profileExtraction.ts) for Co to call back on its own, not just be
  // reachable via inbound calling. NULL means never asked or no preference
  // stated — proactive calling stays off for that person until it's
  // explicitly set, same opt-in-only posture triggerCallForUser already
  // enforces elsewhere. last_proactive_outreach_at is the shared cooldown
  // timestamp — proactiveCheckinCallJob.ts (co-test) writes it on every
  // successful call; prod's ask-checkin cron is meant to write it too once
  // this feature is ported there, so the two systems don't both reach out
  // within days of each other, but that port is deliberately a separate
  // follow-up, not part of this migration.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS checkin_call_cadence_days INT`)
    .catch((err: Error) => console.error("co_profiles.checkin_call_cadence_days migration failed:", err));
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS last_proactive_outreach_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("co_profiles.last_proactive_outreach_at migration failed:", err));

  // Backs the memory compaction job (Royce, 2026-09-01: "go ahead and have
  // that built" — Co's own suggestion, made while diagnosing a real
  // memory-continuity gap live with Royce, of "a compaction layer that
  // periodically distills and corrects the profile, weighted toward recent
  // signal"). Tracks the last time this ran per user, same pattern as
  // last_proactive_outreach_at/last_checked_at — services/memoryCompaction.ts
  // only recompacts a user once real new activity exists since this
  // timestamp, not on a blind timer.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS last_recap_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("co_profiles.last_recap_at migration failed:", err));

  // Companion check-in cadence (Royce, 2026-09-03: "how can we make it a
  // companion with what we have now" — every other proactive text has a
  // reason attached; this is the one that doesn't, seeded by the recap
  // above instead of an ask/event/outcome). Own column, own cadence,
  // separate from last_recap_at's "did we resummarize" clock — see
  // agent/companionCheckin.ts and the cron in jobs/index.ts.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS last_companion_checkin_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("co_profiles.last_companion_checkin_at migration failed:", err));
  // Offers held for a few days after a safety concern (services/safety.ts).
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS safety_hold_until TIMESTAMPTZ`)
    .catch((err: Error) => console.error("co_profiles.safety_hold_until migration failed:", err));

  // Real source of truth for a call's SID/status once calls are placed via
  // the media-stream bridge (services/mediaStreamBridge.ts) rather than
  // Hume's native /v0/evi/twilio integration — Hume's chat_ended webhook no
  // longer reliably carries twilio_metadata once we hold the Twilio leg
  // ourselves, so these columns (stamped by callTrigger.ts when a call is
  // placed) are what the webhook's idempotency guard and voicemail-flag
  // lookup key off of instead.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_sid TEXT`)
    .catch((err: Error) => console.error("users.call_sid migration failed:", err));
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_status TEXT`)
    .catch((err: Error) => console.error("users.call_status migration failed:", err));

  // Real gap found live, 2026-09-14 (Royce: "Call me" got a false "I can't
  // actually call" reply): call_status got stuck at 'in-progress' for days
  // straight after a real call, with nothing ever clearing it — Hume's
  // chat_ended webhook is the only writer that ever moves call_status OFF a
  // live value, and if it's ever missed (dropped delivery, a call that never
  // reached a real Hume session, etc.) the concurrent-call guard in
  // callTrigger.ts blocks every future call attempt for that user forever.
  // 'processing' already has its own 10-minute reclaim window based on this
  // same idea (see co.ts's chat_ended handler) — this is that same pattern
  // for the LIVE states. A dedicated timestamp, not users.updated_at: that
  // column can be (and is) touched by unrelated writes to the same row
  // (profile updates, intake, phone number changes), which would wrongly
  // reset the staleness clock even though no real call activity happened.
  // When an account got locked after 5 wrong OTP codes (routes/auth.ts).
  // Before this existed, a lock was permanent: nothing ever set
  // users.locked back to false, and nobody was told it happened.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("users.locked_at migration failed:", err));

  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS call_status_updated_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("users.call_status_updated_at migration failed:", err));

  // Someone asking for a call at a specific future time, not right now —
  // distinct from the existing explicit_request/would_benefit call-offer
  // flow, which only ever places a call immediately. scheduled_for is the
  // resolved absolute UTC instant to actually place the call (converted at
  // capture time via the stated local date/time + IANA timezone, not
  // resolved again later — DST doesn't shift an already-resolved UTC
  // instant). timezone/requested_text are kept for confirmation copy and
  // debugging a bad resolution, not re-parsed at call time.
  await pool
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
  // can tell "already reminded" from "not due yet" without touching status.
  await pool
    .query(`ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`)
    // When a call they booked was moved by a rule they set later (jobs/scheduledCall.ts): its reminder then says the new time.
    .then(() => pool.query(`ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS moved_at TIMESTAMPTZ`))
    .catch((err: Error) => console.error("scheduled_calls.reminder_sent_at migration failed:", err));

  // Event Curation — "Standing profile scored against full Luma guest list."
  // One row per (event, person) pair: for each matched Co user on an event's
  // guest list, who else on that SAME guest list is worth meeting, ranked.
  // event_id is Luma's own api_id (their ID scheme, not ours) — TEXT, not
  // UUID. A precompute, not live: services/eventScoring.ts writes this once
  // per event.created/guest.registered/guest.updated webhook, and the
  // one-time nudge (App Clip card stack, not yet built) reads it rather than
  // recomputing per request. UNIQUE (event_id, person_id) + the caller's own
  // ON CONFLICT DO UPDATE make re-scoring the same event idempotent, same
  // pattern as relevance_edges above — a guest list changes as people
  // register, so this needs to be safely re-runnable, not one-shot.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_guest_rankings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ranked_candidates JSONB NOT NULL,
        method_summary TEXT NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (event_id, person_id)
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE INDEX IF NOT EXISTS idx_event_guest_rankings_event ON event_guest_rankings (event_id)`,
      ),
    )
    .catch((err: Error) => console.error("event_guest_rankings table/index init failed:", err));

  // Cooldown guard for eventScoring.ts's ask-solicitation — without this, a
  // person with no stated ask got re-solicited every time scoreMatchedGroup
  // re-ran (guest.registered/guest.updated can each retrigger it), which
  // could mean several solicitation texts in one day for the same event.
  // One row per (event, person); checked before soliciting, not after.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_ask_solicitations (
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        solicited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, person_id)
      )`,
    )
    .catch((err: Error) => console.error("event_ask_solicitations table init failed:", err));

  // Minimal text-based version of the "one-time nudge" (Notion V1 board row
  // 9's eventual top-5 ranked card stack / App Clip) — Royce, 2026-09-07:
  // "build it fully" after confirming the ranking engine (event_guest_
  // rankings above) computed real, correctly-differentiated matches but
  // nothing ever told the person about their best one. One row per (event,
  // person) forever, not a cooldown — this is a genuinely one-time nudge,
  // not a recurring check-in, so once sent it's done regardless of how
  // many more times the guest list gets re-scored.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_guest_match_nudges (
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        score INT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, person_id)
      )`,
    )
    .catch((err: Error) => console.error("event_guest_match_nudges table init failed:", err));

  // Same idea for the in-room match nudge claim (2026-09-24): true from the
  // claim until the text is sent.
  await pool
    .query(`ALTER TABLE event_guest_match_nudges ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("event_guest_match_nudges.pending migration failed:", err));

  // Double opt-in handoff (Royce, 2026-09-07: "should Co make a group chat
  // once they've been opted in" + "not replying until it's asked a
  // question") — services/eventGuestMatchHandoff.ts. Records each person's
  // real decision (interested/declined) about a specific candidate, reusing
  // event_guest_match_nudges' shape as "has this person been told about
  // this candidate and asked yet" — a person can end up with a nudge row
  // either from the automatic scoring pass or from a direct reciprocal ask
  // once the OTHER side says yes first, so the same pending-reply check
  // covers both origins. PRIMARY KEY includes candidate_id, not just
  // (event_id, person_id) like the nudges table — a person could in theory
  // be asked about more than one candidate across a re-score.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_guest_match_opt_ins (
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('interested', 'declined')),
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, person_id, candidate_id)
      )`,
    )
    .catch((err: Error) => console.error("event_guest_match_opt_ins table init failed:", err));

  // What Co asked each member in the room, per pair (services/inRoomOffers.ts, 2026-10-07): a reply binds to the
  // offer it answers; a direct ask waits (queued) while they have another question open.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_match_offers (
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        candidate_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('nudge', 'direct_ask', 'additive')),
        candidate_id UUID REFERENCES users(id) ON DELETE CASCADE,
        candidate_ids UUID[] NOT NULL DEFAULT '{}',
        asker_id UUID REFERENCES users(id) ON DELETE CASCADE,
        event_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'open', 'answered')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        opened_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        answer TEXT,
        PRIMARY KEY (event_id, person_id, candidate_key)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS event_match_offers_open_idx ON event_match_offers (person_id, status, opened_at DESC)`))
    .catch((err: Error) => console.error("event_match_offers table init failed:", err));

  // The actual handoff once both sides are in — a real Sendblue group
  // iMessage thread (services/sendblue.ts's groups API), not a simulated
  // one. Co stays in it (Sendblue's group API only exposes add_recipient,
  // no leave/remove-self — confirmed live, 2026-09-07 — so this is a
  // deliberate design choice matching that constraint, not an oversight:
  // Co sits in quietly and only replies when directly mentioned, same
  // "silence by default" philosophy as companionCheckin.ts). event_name is
  // denormalized here (not looked up live from Luma each time) since a
  // stale name in an old group thread is harmless and this avoids a live
  // API call on every inbound group message.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_intro_groups (
        group_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        person_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        person_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("event_intro_groups table init failed:", err));

  // NO LONGER WRITTEN (2026-09-20): this held the "connect by text or email"
  // question, and event_intro_groups above held group threads. Co never
  // starts a group text (Sendblue can only reply to a number that has
  // already texted in), and the code that used both tables is gone. The
  // tables are left in place so no data is dropped; they were empty on
  // co-test. Introductions are one email to both people.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_intro_method_pending (
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, person_id, candidate_id)
      )`,
    )
    .catch((err: Error) => console.error("event_intro_method_pending table init failed:", err));

  // "Nudge Co users at events Co doesn't own" — captured from conversation
  // (extractPlannedEventMention, profileExtraction.ts), the same way
  // captureIntent captures asks. Needs its own table, not a JSONB array on
  // co_profiles, because the whole point is querying ACROSS users to find
  // whoever else mentioned roughly the same event — JSONB can't do that
  // efficiently. embedding + event_date drive the match (see
  // services/eventMatching.ts): embedding similarity within a date window,
  // not string matching, since two people describe the same event
  // differently ("TC Disrupt" vs "TechCrunch Disrupt SF").
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS planned_event_mentions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_name_raw TEXT NOT NULL,
        event_date DATE,
        event_location TEXT,
        embedding vector(1536),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() =>
      pool.query(`CREATE INDEX IF NOT EXISTS idx_planned_event_mentions_date ON planned_event_mentions (event_date)`),
    )
    // Provenance (2026-10-12, services/provenance.ts): 'stated' with their words. NULL is a row from before, read as unconfirmed.
    .then(() => pool.query(`ALTER TABLE planned_event_mentions ADD COLUMN IF NOT EXISTS provenance TEXT, ADD COLUMN IF NOT EXISTS quote TEXT`))
    .then(() =>
      pool.query(`CREATE INDEX IF NOT EXISTS planned_event_mentions_embedding_hnsw_idx
        ON planned_event_mentions USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`),
    )
    .catch((err: Error) => console.error("planned_event_mentions table/index init failed:", err));

  // "Proactive event-change/cancellation texts" — Event Updated carries the
  // event's current state, not a diff, so this stores the last-known
  // snapshot to diff against (eventChangeNotification.ts) rather than only
  // being able to say "something changed" with no specifics. One row per
  // event, overwritten on every update.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS luma_event_snapshots (
        event_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        start_at TIMESTAMPTZ NOT NULL,
        end_at TIMESTAMPTZ,
        location TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("luma_event_snapshots table init failed:", err));

  // "External event ingestion for Tier 2/3" — capture-only for now (Royce,
  // 2026-08-30): Tier 2 of the recommendation engine already does live
  // search against Luma's public discovery feed, so this doesn't need to
  // feed anything today. Just logs what Calendar Event Added told us, so
  // nothing is lost once/if a real caching or ingestion decision gets made.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS external_luma_events_seen (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id TEXT NOT NULL,
        raw_payload JSONB NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("external_luma_events_seen table init failed:", err));

  // "Surfaced-event matching" (Royce, 2026-08-30): a stronger, exact-match
  // alternative to planned_event_mentions' fuzzy embedding/date-window
  // matching — if Co itself surfaces the SAME real event (Tier 1/2 of the
  // recommendation engine) to two different people, that's a certain match
  // with zero ambiguity, no similarity threshold needed. See
  // eventMatching.ts's recordSurfacedEventAndMatch.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS surfaced_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_api_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        surfaced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() =>
      pool.query(`CREATE INDEX IF NOT EXISTS idx_surfaced_events_event ON surfaced_events (event_api_id)`),
    )
    .catch((err: Error) => console.error("surfaced_events table/index init failed:", err));

  // Unifies surfaced_events with planned_event_mentions' fuzzy matching
  // (Royce, 2026-08-30) — without an embedding + the event's own date,
  // surfaced_events could only exact-match against itself, never against a
  // self-reported mention of the same real event. event_date is the EVENT's
  // date (from Luma), not surfaced_at (when Co happened to recommend it) —
  // the date window logic needs the former.
  await pool
    .query(`ALTER TABLE surfaced_events ADD COLUMN IF NOT EXISTS event_date DATE`)
    .catch((err: Error) => console.error("surfaced_events.event_date migration failed:", err));
  await pool
    .query(`ALTER TABLE surfaced_events ADD COLUMN IF NOT EXISTS embedding vector(1536)`)
    .catch((err: Error) => console.error("surfaced_events.embedding migration failed:", err));
  await pool
    .query(`CREATE INDEX IF NOT EXISTS surfaced_events_embedding_hnsw_idx
      ON surfaced_events USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)`)
    .catch((err: Error) => console.error("surfaced_events embedding index failed:", err));

  // Dedicated table, not another co_memories row (Royce, 2026-08-30 code
  // review) — eventSurfacingSweep.ts's per-user tease backlog was originally
  // stored as co_memories rows keyed only by user_id. Two real bugs from
  // that: (1) a user can have more than one open ask_checkins row
  // (UNIQUE(user_id, ask_id), not per-user) processed in the same cron
  // cycle, so a shared per-user backlog let one ask's queued matches get
  // silently consumed by a completely different ask's turn; (2) every save
  // — including saving an empty backlog — INSERTed a new co_memories row
  // forever, since that table is designed as an append-only memory log, not
  // mutable state, so the backlog grew by one row per open ask per day with
  // no cleanup path. A real table keyed by (user_id, ask_id) with an upsert
  // fixes both: scoped correctly per ask, and one row per ask total.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_backlogs (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ask_id TEXT NOT NULL,
        items JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, ask_id)
      )
    `)
    .catch((err: Error) => console.error("event_backlogs table init failed:", err));

  // Pacing for proactive searching of users with no open stated ask
  // (2026-09-14). Same two clocks ask_checkins keeps per ask, kept per user.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS profile_surfacing_state (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_attempted_at TIMESTAMPTZ,
        last_surfaced_at TIMESTAMPTZ
      )`,
    )
    .catch((err: Error) => console.error("profile_surfacing_state table init failed:", err));

  // Network intro shortlist redesign (Royce, 2026-09-07: "how would you
  // implement the networking recommendation... if you just didn't get fed
  // this information but only know about my product purpose" — the answer
  // was two changes from the original per-event_id-hack version:
  // (1) one candidate at a time via a real backlog, same tease/reveal
  // pattern as event_backlogs above, not a bundled 1-5-name shortlist —
  // "Oh I was thinking about you" is a friend mentioning ONE thing; (2) a
  // real canonical-pair relationship table instead of a synthetic
  // "network:<edge_id>" event_id reused from event_guest_match_nudges —
  // that hack was the direct cause of a real bug (the same candidate
  // showing up as two separate pending nudges under two different
  // synthetic ids, once per relevance direction).
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS network_backlogs (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ask_id TEXT NOT NULL,
        items JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, ask_id)
      )
    `)
    .catch((err: Error) => console.error("network_backlogs table init failed:", err));

  // One row per real, undirected relationship between two people — never
  // two rows for the same pair, regardless of which direction (or which
  // of their asks) first surfaced it. person_a_id < person_b_id is
  // enforced so the pair is always canonicalized the same way on insert,
  // no matter which side of the relationship triggered it.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS network_introductions (
        person_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        person_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'suggested'
          CHECK (status IN ('suggested','a_interested','b_interested','both_interested','declined','introduced')),
        match_reason TEXT NOT NULL,
        ask_id TEXT,
        a_interested_at TIMESTAMPTZ,
        b_interested_at TIMESTAMPTZ,
        introduced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (person_a_id, person_b_id),
        CHECK (person_a_id < person_b_id)
      )
    `)
    .catch((err: Error) => console.error("network_introductions table init failed:", err));

  // Dedicated table + pgvector column, same pattern as surfaced_events above
  // (Royce, 2026-08-30 code review fix) — alreadyOfferedTier3 in
  // eventSurfacingSweep.ts used to regenerate an embedding for every past
  // Tier 3 opportunity name on EVERY dedup check, every day the sweep ran,
  // for every user with any Tier 3 history: pure recomputation of values
  // that never change. Storing the embedding once, at offer time, means
  // dedup only ever computes ONE fresh embedding (the new candidate) and
  // lets pgvector's <=> do the comparison against everything past in a
  // single query, the same way eventMatching.ts already does this for
  // real events instead of comparing in JS.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS tier3_offered_opportunities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        embedding vector(1536) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    .then(() =>
      pool.query(`CREATE INDEX IF NOT EXISTS tier3_offered_opportunities_embedding_hnsw_idx
        ON tier3_offered_opportunities USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`),
    )
    .catch((err: Error) => console.error("tier3_offered_opportunities table/index init failed:", err));

  // Backs the "any updates?" reactive reply (Royce, 2026-08-31: "once
  // someone joins the test copatible account, if they ask 'any updates' or
  // something similar just send them that"). scripts/notifyTesters.ts
  // writes the bullet content here every time it runs, independent of who
  // actually got texted — a tester who joins co-test later and asks about
  // updates should still get the latest one, even if they weren't around
  // for the original broadcast. sendblue.ts reads the single latest row.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS product_updates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    .catch((err: Error) => console.error("product_updates table init failed:", err));

  // Outcome-learning loop (Royce, 2026-09-02: "Co follows up" + the shared
  // "named someone?" classifier + wiring signal weighting into future
  // matching — Notion V1 board rows 7/12/13, fully unbuilt until now).
  // Same due-timestamp + nullable claim column + partial index convention
  // as post_call_follow_ups (jobs/postCallFollowUp.ts) — one row per
  // scheduled "who did you meet?" follow-up, snapshotting the TierMatch at
  // schedule time rather than joining back to co_memories later, same
  // denormalized-snapshot approach post_call_follow_ups.transcript uses.
  // Tier 1/2 only (see services/recommendationOutcome.ts) — a Tier 3
  // opportunity isn't something with attendees to "meet."
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS recommendation_outcome_followups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        ask_text TEXT NOT NULL,
        tier SMALLINT NOT NULL,
        match_name TEXT NOT NULL,
        match JSONB NOT NULL,
        send_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    .then(() =>
      pool.query(`
        CREATE INDEX IF NOT EXISTS idx_recommendation_outcome_followups_due
          ON recommendation_outcome_followups (send_at) WHERE sent_at IS NULL
      `),
    )
    .catch((err: Error) => console.error("recommendation_outcome_followups table init failed:", err));

  // Event Curation's own end-of-night check-in (Notion V1 board row 8, "who
  // did you meet that was interesting?") — sibling to
  // recommendation_outcome_followups above (same due-timestamp + nullable
  // claim column + partial index convention), but keyed off registration at
  // one of Co's own curated events + the event's real end_at (services/
  // eventCheckinFollowUp.ts), not off Co having merely recommended
  // something. Originally gated on a real Luma check-in (guest.checked_in_at)
  // instead of registration, changed 2026-09-07 (Royce, confirmed live:
  // Luma's API has no way to ever set check-in status, making that signal
  // both untestable and unreliable for a genuine attendee who just didn't
  // check in on Luma itself). UNIQUE(event_api_id, user_id) makes scheduling
  // idempotent — guest.registered/guest.updated can fire repeatedly for the
  // same guest without re-scheduling or double-sending.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_checkin_followups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        event_api_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        send_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (event_api_id, user_id)
      )
    `)
    .then(() =>
      pool.query(`
        CREATE INDEX IF NOT EXISTS idx_event_checkin_followups_due
          ON event_checkin_followups (send_at) WHERE sent_at IS NULL
      `),
    )
    .catch((err: Error) => console.error("event_checkin_followups table init failed:", err));

  // "No one should feel left out" (Royce, 2026-09-22): scheduled the same
  // way as event_checkin_followups (one row per matched guest, idempotent on
  // UNIQUE(event_api_id, user_id)), but due at end_at minus
  // MATCH_NUDGE_END_CUTOFF_MINUTES — right when maybeSendMatchNudge stops
  // sending real matches — instead of hours after the event, so this still
  // reads as "still at the event," not a next-day afterthought. See
  // services/eventUnmatchedFollowUp.ts.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_unmatched_followups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        event_api_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        send_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (event_api_id, user_id)
      )
    `)
    .then(() =>
      pool.query(`
        CREATE INDEX IF NOT EXISTS idx_event_unmatched_followups_due
          ON event_unmatched_followups (send_at) WHERE sent_at IS NULL
      `),
    )
    .catch((err: Error) => console.error("event_unmatched_followups table init failed:", err));

  // One-time idempotency marker for the SOLO "nothing stood out tonight"
  // acknowledgment only (services/eventUnmatchedFollowUp.ts) — a real pairing
  // is already tracked by event_guest_match_nudges (candidate_id NOT NULL
  // there, so a person with no pair can't be recorded in it). paired_with_id
  // is kept here too, purely for a human reading the table; the real
  // reply-handling state for a pairing lives in event_guest_match_nudges /
  // event_guest_match_opt_ins, reused as-is.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_unmatched_notices (
        event_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        paired_with_id UUID REFERENCES users(id) ON DELETE SET NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_id, person_id)
      )`,
    )
    .catch((err: Error) => console.error("event_unmatched_notices table init failed:", err));

  // One row per Hume chat (2026-09-22): the call post-processing claim
  // (routes/co.ts chat_ended). The per-user call_status claim stops
  // duplicates only until the member's next call moves call_status on; this
  // is keyed on the call itself, so a late redelivery of an old chat is
  // always recognized.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS call_processing (
        chat_id TEXT PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )`,
    )
    .catch((err: Error) => console.error("call_processing table init failed:", err));

  // Archive columns in the shared migrations (2026-09-22). They used to exist
  // only in co-test's own migrations, while shared queries (the companion and
  // recap crons, metrics) filter on users.archived_at, which would have failed
  // in production. Idempotent, so running it on co-test too is harmless.
  // lapse_*: the old membership lapse clock (removed 2026-10-14; the columns stay, unused).
  await pool
    .query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS archived_phone TEXT,
         ADD COLUMN IF NOT EXISTS archived_email TEXT,
         ADD COLUMN IF NOT EXISTS lapse_exempt BOOLEAN NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS lapse_started_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS lapse_close_at TIMESTAMPTZ`,
    )
    .catch((err: Error) => console.error("users archive/lapse columns migration failed:", err));
  // No membership lapse (Royce, 2026-10-14: "Going quiet earns less contact, never ejection"): the job is gone, so anyone on its
  // clock comes off it and a notice still waiting never goes. The lapse_* columns stay, unused (nothing reads them).
  await pool
    .query(`UPDATE users SET lapse_started_at = NULL, lapse_close_at = NULL WHERE lapse_started_at IS NOT NULL`)
    .then(() => pool.query(`UPDATE proactive_candidates SET status = 'skipped', updated_at = NOW() WHERE type = 'membership_lapse' AND status = 'pending'`))
    .catch((err: Error) => console.error("membership lapse wind-down failed:", err));

  // Open threads (2026-09-22) — see src/harness/memberThreads.ts. What each
  // member is in the middle of, in their words; opened and closed only with a
  // quote of theirs.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_threads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        opened_quote TEXT NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'resolved', 'changed')),
        feeling TEXT,
        due_date DATE,
        next_step TEXT NOT NULL DEFAULT 'check_in' CHECK (next_step IN ('check_in', 'look_up', 'remember', 'suggest_someone')),
        kind TEXT NOT NULL DEFAULT 'thread' CHECK (kind IN ('thread', 'commitment')),
        closed_quote TEXT,
        closed_at TIMESTAMPTZ,
        last_touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_member_threads_user ON member_threads (user_id, status)`))
    .catch((err: Error) => console.error("member_threads table init failed:", err));

  // Offers to write something up as a document, and the documents written (services/documentOffer.ts, 2026-10-07).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS document_offers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'offered' CHECK (source IN ('offered', 'asked')),
        status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted')),
        offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        accepted_at TIMESTAMPTZ
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_document_offers_user ON document_offers (user_id, offered_at DESC)`))
    .catch((err: Error) => console.error("document_offers table init failed:", err));

  // The team flag (users.mo_approver): who builds Co (services/extensions.ts isTeamMember). The outreach agent's own tables and
  // columns, removed with it on 2026-10-14, are left in place unused (branch archive/mo-backup-2026-10-14 has their migrations).
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mo_approver BOOLEAN NOT NULL DEFAULT false`)
    .catch((err: Error) => console.error("users.mo_approver migration failed:", err));

  // Living asks (services/askKind.ts, 2026-09-26): whether a search can find
  // it, and when they last brought it up, so what matters now is searched first.
  await pool
    .query(
      `ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'find',
         ADD COLUMN IF NOT EXISTS kind_checked_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS last_mentioned_at TIMESTAMPTZ`,
    )
    .catch((err: Error) => console.error("ask_checkins living-asks migration failed:", err));
  // The purpose boundary (services/askKind.ts): the connection part of an ask the model read as mixed, searched in place of the whole text.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS scope_connection TEXT`)
    .catch((err: Error) => console.error("ask_checkins.scope_connection migration failed:", err));
  // How each member likes to be texted (services/textingStyle.ts, 2026-09-26).
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS texting_style TEXT[] NOT NULL DEFAULT '{}'`)
    .catch((err: Error) => console.error("co_profiles.texting_style migration failed:", err));

  // A switch per ability (services/abilitySwitches.ts, 2026-09-25): turn
  // any one of Co's abilities off without a deploy.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS ability_switches (
        ability_id TEXT PRIMARY KEY,
        off BOOLEAN NOT NULL DEFAULT false,
        reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("ability_switches table init failed:", err));

  // What Co knows, as connected facts (services/coFacts.ts, 2026-09-26): Co's
  // own actions for each member, and what members want and offer, each with
  // an owner and who may see it. Filled from past records on every start
  // (idempotent), then written as things happen.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_facts (
        id BIGSERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject TEXT NOT NULL CHECK (subject IN ('co', 'member')),
        relation TEXT NOT NULL,
        object_label TEXT NOT NULL,
        object_key TEXT NOT NULL,
        url TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('owner', 'room', 'team')),
        source TEXT NOT NULL,
        happened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        meta JSONB NOT NULL DEFAULT '{}',
        embedding vector(1536),
        retired_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (owner_user_id, relation, object_key, happened_at)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_co_facts_owner ON co_facts (owner_user_id, subject, happened_at DESC)`))
    .then(async () => {
      const { backfillCoActions } = await import("../services/coFacts.js");
      const n = await backfillCoActions();
      if (n.texted || n.sent || n.tools) console.log(`co_facts backfill: ${n.texted} texted, ${n.sent} sent, ${n.tools} tool actions`);
    })
    .catch((err: Error) => console.error("co_facts init failed:", err));

  // Kinds of things a member told Co to stop suggesting ("no more
  // hackathons", 2026-09-22). Turning down one event only ever blocked that
  // one event; this is the lasting version, read by the personal fit check
  // (services/eventDetails.ts explainFit) on every search and sweep.
  await pool
    .query(`ALTER TABLE co_profiles ADD COLUMN IF NOT EXISTS avoid TEXT[] NOT NULL DEFAULT '{}'`)
    .catch((err: Error) => console.error("co_profiles.avoid migration failed:", err));

  // Coalesces duplicate scoring triggers (Royce, 2026-09-05 — found via real
  // guest-add testing) — Luma fires guest.registered AND guest.updated as two
  // separate webhooks for a single guest-add action (confirmed live,
  // ~3 microseconds apart), and routes/luma.ts's runScoringPass had no
  // debounce between them: both independently ran the full scoring pass,
  // each with its own real, billed LLM call per matched guest, for the exact
  // same underlying data. See services/eventScoring.ts's
  // tryClaimScoringDebounce.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_scoring_debounce (
        event_id TEXT PRIMARY KEY,
        last_triggered_at TIMESTAMPTZ NOT NULL
      )
    `)
    .catch((err: Error) => console.error("event_scoring_debounce table init failed:", err));

  // Deferred queue for event.updated/event.canceled notifications (Royce,
  // 2026-09-03) — these fire off a Luma webhook the instant a host edits or
  // cancels an event, which could land at any hour since it's the host's
  // action, not the recipient's (unlike calendar-follow or guest-registered
  // reach-outs, which stay immediate since the recipient just took an
  // action of their own). eventChangeDetection.ts's notifyMatchedGuests
  // sends right away when it's a reasonable hour for that person, and only
  // queues a row here otherwise. event_name/message are the already-composed
  // diff/cancellation text, snapshotted at webhook time — same
  // denormalized-snapshot convention as post_call_follow_ups.transcript.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_change_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_name TEXT NOT NULL,
        message TEXT NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    .then(() =>
      pool.query(`
        CREATE INDEX IF NOT EXISTS idx_event_change_notifications_pending
          ON event_change_notifications (created_at) WHERE sent_at IS NULL
      `),
    )
    // eventChangeDetection.ts writes event_id and the deferred cron reads it,
    // but the column was never added: every off-hours change/cancel notice
    // failed to queue and the cron failed every 15 minutes (found
    // 2026-09-18 in co-test logs).
    .then(() => pool.query(`ALTER TABLE event_change_notifications ADD COLUMN IF NOT EXISTS event_id TEXT`))
    .catch((err: Error) => console.error("event_change_notifications table init failed:", err));

  // Day-of QR check-in flow (Royce, 2026-09-10) — walk-ins who scan a venue
  // QR and text Co's fixed check-in phrase, resolved against whichever real
  // Luma event the phrase names, not tied to any single hardcoded event.
  // UNIQUE (event_api_id, person_id): a repeat scan/resend must be a no-op,
  // never a second name/email ask or a duplicate scoring-pool entry.
  // ask_text is filled in once the person answers the one-line ask question
  // (skipped entirely if they already had an active ask); followup_sent_at
  // marks the deferred post-event call-offer as sent, so it's a one-time
  // reach-out per checked-in person, not per cron tick.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_walkin_checkins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_api_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ask_text TEXT,
        checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        followup_sent_at TIMESTAMPTZ,
        UNIQUE (event_api_id, person_id)
      )
    `)
    .catch((err: Error) => console.error("event_walkin_checkins table init failed:", err));

  // Debounce for the "additive offer" nudge (Royce, 2026-09-10: a later
  // re-score must never silently swap someone's existing match — it sends a
  // separate "I found N more people who just checked in" offer instead, but
  // that offer must not re-fire once per new arrival during a busy stretch
  // of check-ins). One row per (event, already-matched person); a fresh
  // offer is only sent once the debounce window since last_offered_at has
  // cleared, same spirit as event_scoring_debounce above but scoped to this
  // specific nudge rather than the whole scoring pass.
  await pool
    .query(`
      CREATE TABLE IF NOT EXISTS event_walkin_offer_batches (
        event_api_id TEXT NOT NULL,
        person_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (event_api_id, person_id)
      )
    `)
    .catch((err: Error) => console.error("event_walkin_offer_batches table init failed:", err));

  // Layer 7 proactive harness (2026-09-14) — see src/harness/proactive.ts.
  // proactive_candidates: things Co could text about, produced by sweeps and
  // schedulers, never sent directly. proactive_sends: the send ledger and
  // idempotency key (UNIQUE user_id, target_key), written in the same
  // transaction as the send. proactive_user_state: pick-none hold and
  // skip-log dedup.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS proactive_candidates (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        priority INT NOT NULL DEFAULT 0,
        due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'pending',
        skip_reason TEXT,
        attempts INT NOT NULL DEFAULT 0,
        decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, target_key)
      )`,
    )
    .then(() =>
      pool.query(`CREATE INDEX IF NOT EXISTS idx_proactive_candidates_pending ON proactive_candidates (due_at) WHERE status = 'pending'`),
    )
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS proactive_sends (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          target_key TEXT NOT NULL,
          topic_key TEXT,
          candidate_id BIGINT,
          message TEXT,
          exempt BOOLEAN NOT NULL DEFAULT false,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, target_key)
        )`,
      ),
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_proactive_sends_user ON proactive_sends (user_id, sent_at DESC)`))
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS proactive_user_state (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          hold_until TIMESTAMPTZ,
          last_skip_reason TEXT,
          last_skip_at TIMESTAMPTZ
        )`,
      ),
    )
    // Spacing after payload first handed work to a task (harness/payloadFirst.ts);
    // unlike hold_until, a new candidate doesn't clear it.
    .then(() => pool.query(`ALTER TABLE proactive_user_state ADD COLUMN IF NOT EXISTS space_until TIMESTAMPTZ`))
    .catch((err: Error) => console.error("proactive harness tables init failed:", err));

  // Layer 7 (2026-09-14): which source rows have been handed to the proactive
  // harness (queued / sent / dropped / expired), separate from sent_at so a
  // dropped follow-up never looks like an open question to routing.
  for (const table of ["recommendation_outcome_followups", "event_checkin_followups", "post_call_follow_ups"]) {
    await pool
      .query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS harness_status TEXT`)
      .catch((err: Error) => console.error(`${table}.harness_status migration failed:`, err));
  }

  // Layer 1 intake harness (2026-09-14, src/harness/intake.ts). A valid
  // email sent before the name used to be dropped (users.email is only
  // written together with the name); it's held here instead. intake_retries
  // caps the "what's your name and email" loop.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS intake_partial_email TEXT`)
    .catch((err: Error) => console.error("users.intake_partial_email migration failed:", err));
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS intake_retries INT NOT NULL DEFAULT 0`)
    .catch((err: Error) => console.error("users.intake_retries migration failed:", err));

  // Deleting a user (co-test's "Start over", or removing a tester) failed on
  // these FKs, which were created without ON DELETE CASCADE (2026-09-15).
  await pool
    .query(
      `DO $$
       DECLARE r record;
       BEGIN
         FOR r IN
           SELECT c.conname, t.relname AS tbl, a.attname AS col
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND c.confdeltype = 'a'
             AND t.relname IN ('recommendation_outcome_followups', 'event_checkin_followups', 'referrals')
         LOOP
           EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
           EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE CASCADE', r.tbl, r.conname, r.col);
         END LOOP;
       END $$`,
    )
    .catch((err: Error) => console.error("users FK cascade migration failed:", err));

  // Emotion loop (2026-09-15) — see src/harness/emotion.ts. One row per
  // emotional moment: a Hume voice moment from a call, or a text read.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS emotion_signals (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('call', 'text')),
        emotion TEXT NOT NULL,
        intensity TEXT NOT NULL CHECK (intensity IN ('low', 'medium', 'high')),
        valence TEXT NOT NULL CHECK (valence IN ('negative', 'positive', 'mixed')),
        about TEXT,
        quote TEXT,
        memory_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_emotion_signals_user ON emotion_signals (user_id, created_at DESC)`))
    // Who the feeling is about: 'co' (Co itself) or 'life'. NULL on older rows,
    // classified from "about" at read time (harness/emotion.ts signalTarget).
    .then(() => pool.query(`ALTER TABLE emotion_signals ADD COLUMN IF NOT EXISTS target TEXT`))
    // Where a signal came from when it isn't a read of what they said:
    // 'frustration_score' is ElevenLabs' per-line score (2026-10-04,
    // harness/emotion.ts frustrationMoments). NULL for everything else.
    .then(() => pool.query(`ALTER TABLE emotion_signals ADD COLUMN IF NOT EXISTS basis TEXT`))
    .catch((err: Error) => console.error("emotion_signals table init failed:", err));

  // Voice flags (2026-10-03) — see src/services/voiceFlags.ts. One run per
  // call (claimed by conversation id, so a retried webhook doesn't run it
  // twice) and every flag it raised, kept or dropped with why, for the audit.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS voice_flag_runs (
        conversation_id TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        model TEXT,
        audio_bytes INT,
        flags INT,
        kept INT,
        ms INT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS voice_flags (
          id BIGSERIAL PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          at_secs REAL,
          quote TEXT,
          cue TEXT,
          feeling TEXT,
          valence TEXT,
          reading TEXT,
          confidence REAL,
          kept BOOLEAN NOT NULL,
          drop_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      ),
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_voice_flags_user ON voice_flags (user_id, created_at DESC)`))
    // Gemini's raw answer, so a failed flag insert loses nothing (review of #60).
    .then(() => pool.query(`ALTER TABLE voice_flag_runs ADD COLUMN IF NOT EXISTS raw JSONB`))
    .catch((err: Error) => console.error("voice_flags table init failed:", err));

  // ElevenLabs deletes (2026-10-18; schedule 2026-10-23) — see src/services/elevenLabsForget.ts. One row per conversation we stored:
  // when its copy at ElevenLabs falls due (due_at: 7 days for a member, 30 for the team and test numbers, from when ours was stored),
  // whether the member asked for it forgotten, whether it's deleted yet, how many attempts it took, and the last reason it was kept.
  // No transcript text: only a hash of what we received (null when nothing was stored: verify false), so a later pass can check our
  // stored copy is that transcript. user_id is plain data, no foreign key: the row outlives a deleted account until its delete lands.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS elevenlabs_deletions (
        conversation_id TEXT PRIMARY KEY,
        user_id UUID NOT NULL,
        transcript_sha256 TEXT,
        verify BOOLEAN NOT NULL DEFAULT true,
        last_outcome TEXT,
        status TEXT NOT NULL,
        window_kind TEXT NOT NULL DEFAULT 'member',
        due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        forget_requested_at TIMESTAMPTZ,
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions ADD COLUMN IF NOT EXISTS window_kind TEXT NOT NULL DEFAULT 'member'`))
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`))
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions ADD COLUMN IF NOT EXISTS forget_requested_at TIMESTAMPTZ`))
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions ADD COLUMN IF NOT EXISTS verify BOOLEAN NOT NULL DEFAULT true`))
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions ADD COLUMN IF NOT EXISTS last_outcome TEXT`))
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions ALTER COLUMN transcript_sha256 DROP NOT NULL`))
    // No foreign key on users: deleting the account must not take the queue with it (a failed delete is retried after).
    .then(() => pool.query(`ALTER TABLE elevenlabs_deletions DROP CONSTRAINT IF EXISTS elevenlabs_deletions_user_id_fkey`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_elevenlabs_deletions_due ON elevenlabs_deletions (status, due_at)`))
    .catch((err: Error) => console.error("elevenlabs_deletions table init failed:", err));

  // The after-call health check (2026-10-23) — see src/services/callHealth.ts. One row per call: flagged, the reasons as codes (never
  // anyone's words), when someone marked it reviewed, and when its late signals stopped being looked for. A flagged call is held at
  // ElevenLabs until reviewed.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS call_health (
        conversation_id TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL,
        flagged BOOLEAN NOT NULL DEFAULT false,
        reasons TEXT[] NOT NULL DEFAULT '{}',
        judged_by TEXT,
        reviewed_at TIMESTAMPTZ,
        late_done_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_call_health_open ON call_health (flagged, reviewed_at, ended_at)`))
    .catch((err: Error) => console.error("call_health table init failed:", err));

  // Tier 3 (paid X search) budget log (2026-09-15) — tieredRecommendation.ts.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS x_search_log (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_x_search_log_created ON x_search_log (created_at DESC)`))
    .catch((err: Error) => console.error("x_search_log table init failed:", err));

  // Tier 3's general web search budget log (2026-09-17) — services/webOpportunitySearch.ts.
  // Same shape as x_search_log, separate table: a different API with its own
  // cost, so it needs its own daily cap, not shared with X's budget.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS web_search_log (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_web_search_log_created ON web_search_log (created_at DESC)`))
    .catch((err: Error) => console.error("web_search_log table init failed:", err));

  // Tier 2's Luma search through Exa: its daily budget log (2026-10-18) — services/lumaViaExa.ts reserveLumaExaSearch. Who, which
  // share (request or sweep) and when; no query column, because what was searched is the member's want and this only counts.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS luma_exa_search_log (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_luma_exa_search_log_created ON luma_exa_search_log (created_at DESC)`))
    .catch((err: Error) => console.error("luma_exa_search_log table init failed:", err));

  // Current picture of each person (harness/personSnapshot.ts) and the
  // result of every suggestion (services/outcomes.ts), 2026-09-15.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS person_snapshots (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("person_snapshots table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_tasks (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        goal TEXT NOT NULL,
        their_words TEXT NOT NULL,
        steps JSONB NOT NULL DEFAULT '[]'::jsonb,
        plan_next TEXT,
        next_check_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'open',
        wakes INT NOT NULL DEFAULT 0,
        notes JSONB NOT NULL DEFAULT '[]'::jsonb,
        texts_sent INT NOT NULL DEFAULT 0,
        last_texted_at TIMESTAMPTZ,
        outcome TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_co_tasks_due ON co_tasks (next_check_at) WHERE status = 'open'`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_co_tasks_user ON co_tasks (user_id, status)`))
    // Deadlines and waking on their reply (2026-09-30).
    // Follow-ups handed to Co (2026-09-30): a follow-up task holds the check-in it may send.
    .then(() => pool.query(`ALTER TABLE co_tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'work', ADD COLUMN IF NOT EXISTS followup JSONB, ADD COLUMN IF NOT EXISTS target_key TEXT`))
    // Where a task came from (2026-10-04): 'promise' for one Co opened to keep a promise it made in a reply (services/promises.ts).
    .then(() => pool.query(`ALTER TABLE co_tasks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ask'`))
    .then(() => pool.query(`ALTER TABLE co_tasks ADD COLUMN IF NOT EXISTS deadline DATE, ADD COLUMN IF NOT EXISTS final_check_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS final_told BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS awaiting_reply BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS their_reply_at TIMESTAMPTZ`))
    // A job dispatched during a call (2026-11-02, services/coTasks.ts dispatchKeyFor): one open job per call and need, never two.
    .then(() => pool.query(`ALTER TABLE co_tasks ADD COLUMN IF NOT EXISTS dispatch_key TEXT`))
    .then(() => pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_co_tasks_dispatch_open ON co_tasks (user_id, dispatch_key) WHERE dispatch_key IS NOT NULL AND status = 'open'`))
    .catch((err: Error) => console.error("co_tasks table init failed:", err));
  // Goals a member handed Co (services/goalOwnership.ts, 2026-10-13): the items, which Co offered to take and which they picked, the
  // club-world read, and the check-in on the ledger. Co's pieces and the check-in are ordinary co_tasks rows carrying followup.goalId.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_goals (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        their_words TEXT NOT NULL,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        club_world BOOLEAN NOT NULL DEFAULT false,
        club_why TEXT,
        status TEXT NOT NULL DEFAULT 'offered',
        checkin_task_id BIGINT,
        offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        accepted_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_co_goals_user ON co_goals (user_id, status)`))
    // The dated moment they're counting on (their words), and the file they handed over for it with the words that handed it over.
    .then(() => pool.query(`ALTER TABLE co_goals ADD COLUMN IF NOT EXISTS moment JSONB, ADD COLUMN IF NOT EXISTS source_file INT, ADD COLUMN IF NOT EXISTS handed_over TEXT`))
    .catch((err: Error) => console.error("co_goals table init failed:", err));
  // Open loops (Royce, 2026-10-01: "Open loops are first-class state. Every
  // stated ask becomes a tracked outcome with a status"): one row per thing Co
  // is carrying for them, synced from tasks, working notes, asks and offers
  // (services/openLoops.ts). status_by says whether Co set the status itself.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS open_loops (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        status_by TEXT NOT NULL DEFAULT 'code',
        detail TEXT,
        due_date DATE,
        task_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        woke_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        UNIQUE (user_id, source, source_ref)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_open_loops_user ON open_loops (user_id) WHERE closed_at IS NULL`))
    // seen_at: changes up to here have been handled (a wake, or Co made them
    // itself); changed_at past it is pending. closed_reason: who closed it
    // and why ('co' is a tombstone the sync never reopens; 'stale' isn't done).
    // 2026-10-01 code review.
    .then(() => pool.query(`ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS closed_reason TEXT`))
    .then(() => pool.query(`UPDATE open_loops SET seen_at = COALESCE(woke_at, changed_at) WHERE seen_at IS NULL`))
    // The loop lifecycle (services/loopLifecycle.ts, 2026-10-06): last_confirmed_at is the last time the member said or did something about
    // it; decay_asked_at is the one "still on your plate?" ask. Rows from before this get their last touch as their confirmation, so the old
    // ones age out instead of looking fresh.
    .then(() => pool.query(`ALTER TABLE open_loops ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS decay_asked_at TIMESTAMPTZ`))
    .then(() => pool.query(`UPDATE open_loops SET last_confirmed_at = COALESCE(updated_at, changed_at, created_at) WHERE last_confirmed_at IS NULL`))
    .catch((err: Error) => console.error("open_loops table init failed:", err));
  // The search brief Co keeps while it helps someone find something (Royce,
  // 2026-09-30): "120 people" or a map pin refines the same search.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS search_briefs (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        brief JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("search_briefs table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_advice (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        gist TEXT NOT NULL,
        given_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        followed_up_at TIMESTAMPTZ
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_member_advice_user ON member_advice (user_id, given_at DESC)`))
    .catch((err: Error) => console.error("member_advice table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_milestones (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        then_quote TEXT,
        now_quote TEXT,
        happened_at TIMESTAMPTZ NOT NULL,
        marked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, key)
      )`,
    )
    .catch((err: Error) => console.error("member_milestones table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS suggestion_outcomes (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        item_key TEXT NOT NULL,
        item_name TEXT NOT NULL,
        result TEXT NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, item_key, result)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_suggestion_outcomes_user ON suggestion_outcomes (user_id, created_at DESC)`))
    // Provenance (2026-10-12, services/provenance.ts): 'stated' with their words, or 'inferred'. NULL is a row from before, read as inferred.
    .then(() => pool.query(`ALTER TABLE suggestion_outcomes ADD COLUMN IF NOT EXISTS provenance TEXT, ADD COLUMN IF NOT EXISTS quote TEXT`))
    .catch((err: Error) => console.error("suggestion_outcomes table init failed:", err));

  // Phone-number changes by text, confirmed with an emailed code
  // (services/phoneChange.ts, 2026-09-18). Its own code, attempts and lock,
  // so a change never touches the login code.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS phone_change_requests (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        new_number TEXT NOT NULL,
        code TEXT,
        expires_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        attempts INT NOT NULL DEFAULT 0,
        attempts_window_start TIMESTAMPTZ,
        locked BOOLEAN NOT NULL DEFAULT false,
        locked_at TIMESTAMPTZ,
        lock_count INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_phone_change_user ON phone_change_requests (user_id, created_at DESC)`))
    .catch((err: Error) => console.error("phone_change_requests table init failed:", err));

  // Everything Co sent directly, waiting on their reaction for two days
  // (services/offerReactions.ts, 2026-09-18).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS revealed_offers (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        item_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reaction TEXT,
        reacted_at TIMESTAMPTZ
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_revealed_offers_user ON revealed_offers (user_id, sent_at DESC)`))
    .catch((err: Error) => console.error("revealed_offers table init failed:", err));

  // Monitoring alert dedupe (harness/monitor.ts), 2026-09-15.
  await pool
    .query(`CREATE TABLE IF NOT EXISTS harness_alerts (signal_key TEXT PRIMARY KEY, sent_at TIMESTAMPTZ NOT NULL)`)
    .catch((err: Error) => console.error("harness_alerts table init failed:", err));

  // Login/OTP hardening (2026-09-17 code review, routes/auth.ts). A wrong-
  // guess window that survives issuing a new code (so asking for a fresh
  // code doesn't hand out fresh guesses), and a lock-escalation counter (a
  // repeat lockout gets a longer lock than the first one) — see
  // routes/accountRules.ts's decideOtpVerify/otpLockMinutes.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_attempts_window_start TIMESTAMPTZ`)
    .catch((err: Error) => console.error("users.otp_attempts_window_start migration failed:", err));
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lock_count INT NOT NULL DEFAULT 0`)
    .catch((err: Error) => console.error("users.lock_count migration failed:", err));

  // Session revocation (2026-09-17) — a verify-otp JWT used to live a full
  // year with no way to invalidate one already issued. token_version is
  // stamped into every new token's `tv` claim and bumped on logout and on an
  // OTP lock; middleware/auth.ts rejects a token whose `tv` doesn't match
  // the user's current value, so either one invalidates every token issued
  // before it. Existing users default to 0, matching the `tv: 0` fallback
  // middleware/auth.ts uses for a token minted before this claim existed —
  // nobody is logged out by this migration itself.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0`)
    .catch((err: Error) => console.error("users.token_version migration failed:", err));

  // Phone number uniqueness (2026-09-17, routes/users.ts) — PUT /users/:id
  // used to accept any phone_number with no verification, so an account
  // could be pointed at someone else's real number; Co's texts and calls
  // would then go to that other person. Two independent layers: users.ts no
  // longer accepts phone_number on that route at all (see accountRules.ts's
  // UPDATABLE_USER_FIELDS), and this is the database-level backstop for
  // every other write path.
  //
  // Only added if no duplicates exist today, so this never fails boot over
  // pre-existing data — CREATE UNIQUE INDEX would simply refuse to create
  // itself (and, unguarded, would fail this whole migration pass loudly on
  // every future boot until someone fixes the data). Duplicates are logged
  // instead so they can be resolved by hand; see the report for how.
  // CONCURRENTLY so this doesn't hold a lock that blocks reads/writes on
  // users while it builds, and it's skipped (not retried in the same
  // transaction) if a previous attempt left an INVALID index behind, which
  // CONCURRENTLY can do on failure — that stale index is dropped first so a
  // retry can actually succeed instead of permanently no-op'ing on IF NOT
  // EXISTS against a broken index.
  try {
    const { rows: dupes } = await pool.query(
      `SELECT phone_number, COUNT(*) AS n FROM users
       WHERE phone_number IS NOT NULL
       GROUP BY phone_number HAVING COUNT(*) > 1`,
    );
    if (dupes.length > 0) {
      console.error(
        `users.phone_number unique index skipped — ${dupes.length} phone number(s) shared by more than one account:`,
        dupes.map((d: { phone_number: string; n: string }) => `${d.phone_number} (${d.n})`).join(", "),
      );
    } else {
      const { rows: invalid } = await pool.query(
        `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'users_phone_number_unique_idx' AND NOT i.indisvalid`,
      );
      if (invalid[0]) {
        await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS users_phone_number_unique_idx`);
      }
      await pool.query(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_phone_number_unique_idx
         ON users (phone_number) WHERE phone_number IS NOT NULL`,
      );
    }
  } catch (err) {
    console.error("users.phone_number unique index migration failed:", err);
  }

  // Co passing messages between members, with consent both ways, and
  // reminders to follow up (services/relay.ts, 2026-09-28). Off unless
  // CO_RELAY=on. member_connections holds who's been introduced after both
  // said yes, the only people a relay can reach.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_connections (
        person_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        person_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (person_a, person_b),
        CHECK (person_a < person_b)
      )`,
    )
    .catch((err: Error) => console.error("member_connections table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_relays (
        id BIGSERIAL PRIMARY KEY,
        from_user UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("member_relays table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_reminders (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        what TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("member_reminders table init failed:", err));
  // Durable sends (2026-10-07, services/deferredSends.ts): sent_at/status are written only when a text actually went out.
  // queued_at claims a due reminder for sending (it may wait in deferred_sends for their morning); a relay's sent_at is
  // when it reached them, not when it was asked for.
  await pool
    .query(`ALTER TABLE member_reminders ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ`)
    .then(() => pool.query(`ALTER TABLE member_relays ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`))
    .catch((err: Error) => console.error("member_reminders/member_relays durable-send columns failed:", err));
  // A failed reminder send gives its claim back with a time to try again (services/relay.ts reminderDelivered, closure audit 11-02).
  await pool
    .query(`ALTER TABLE member_reminders ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`)
    .then(() => pool.query(`ALTER TABLE member_reminders ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ`))
    .catch((err: Error) => console.error("member_reminders retry columns failed:", err));
  // A text held for the member's hours (harness/proactive.ts sendExemptWhenAllowed, callFollowThrough's night hold). It used
  // to wait in an in-process timer that a restart or deploy lost. A minute cron sends due rows through sendExempt (STOP,
  // pause and hours checked again at send time); a row is claimed by bumping attempts, so two instances never both send it,
  // and (user_id, target_key) is the same idempotency key proactive_sends uses. after_kind/after_payload is what gets
  // recorded once it actually sends (a relay's status, a reminder's sent_at, an intro ask's pending offer).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS deferred_sends (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        phone_number TEXT NOT NULL,
        type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        messages JSONB NOT NULL,
        timezone TEXT,
        after_kind TEXT,
        after_payload JSONB,
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','skipped','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, target_key)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS deferred_sends_due ON deferred_sends (due_at) WHERE status IN ('queued','sending')`))
    .catch((err: Error) => console.error("deferred_sends table init failed:", err));

  // Google Calendar and Gmail, read-only (services/googleAuth.ts, 2026-09-28).
  // One connection per member; tokens AES-256-GCM encrypted; one-time connect
  // links (state + PKCE verifier, 15 minutes, single use); a cached summary.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS google_connections (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        refresh_token_enc TEXT,
        access_token_enc TEXT,
        access_expires_at TIMESTAMPTZ,
        scopes TEXT,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("google_connections table init failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS google_oauth_states (
        state TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_verifier_enc TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("google_oauth_states table init failed:", err));
  // The calendar grant (services/cueGrants.ts, the bounce, Royce 2026-10-15: free/busy only, its own grant, never the combined one):
  // its own one-time links and its own token, with a one-tap disconnect (only the hash of its token is kept).
  await pool
    .query(`ALTER TABLE google_oauth_states ADD COLUMN IF NOT EXISTS grant_kind TEXT NOT NULL DEFAULT 'google'`)
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS calendar_grants (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          refresh_token_enc TEXT,
          access_token_enc TEXT,
          access_expires_at TIMESTAMPTZ,
          scope TEXT NOT NULL,
          revoke_hash TEXT NOT NULL,
          connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      ),
    )
    .catch((err: Error) => console.error("calendar grant tables failed:", err));
  // The Docs grant (services/cueGrants.ts, Royce 2026-10-15: "drive.file gets its own grant in the published project, same pattern as
  // the calendar split").
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS docs_grants (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        refresh_token_enc TEXT,
        access_token_enc TEXT,
        access_expires_at TIMESTAMPTZ,
        scope TEXT NOT NULL,
        revoke_hash TEXT NOT NULL,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("docs grant table failed:", err));
  // The trigger's proposals (services/bounce.ts): one per want, ever; queued, then proposed when it went, then their answer.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS bounce_proposals (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        want_key TEXT NOT NULL,
        find_name TEXT NOT NULL,
        find_day DATE NOT NULL,
        gap_source TEXT NOT NULL CHECK (gap_source IN ('calendar', 'stated')),
        gap_from TIME NOT NULL,
        gap_to TIME NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'proposed', 'accepted', 'declined', 'dropped')),
        message TEXT,
        sent_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        answer_words TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, want_key)
      )`,
    )
    .catch((err: Error) => console.error("bounce_proposals failed:", err));
  // "Want me to keep an eye on it?" (Royce, 2026-10-15): the plan kept with the proposal, and the watch a yes starts. And the one
  // calendar offer per member, ever.
  await pool
    .query(`ALTER TABLE bounce_proposals ADD COLUMN IF NOT EXISTS plan JSONB, ADD COLUMN IF NOT EXISTS watch_until TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS watch_ended_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS watch_outcome TEXT`)
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS calendar_offers (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, want_key TEXT NOT NULL, offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`))
    .catch((err: Error) => console.error("bounce watch tables failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS google_snapshots (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        busy JSONB,
        waiting JSONB,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("google_snapshots table init failed:", err));
  // Search quality (2026-10-07, services/researchQuality.ts): every find shown, its fixed fields with check times, and what the
  // member did with it (yes, no, ignored, not_like_that). The outcomes rank the next finds.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS research_finds (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id INTEGER,
        find_type TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        reader TEXT NOT NULL,
        fields JSONB NOT NULL DEFAULT '[]'::jsonb,
        features JSONB NOT NULL DEFAULT '[]'::jsonb,
        checked_at TIMESTAMPTZ NOT NULL,
        shown_at TIMESTAMPTZ,
        outcome TEXT CHECK (outcome IN ('yes','no','ignored','not_like_that')),
        outcome_note TEXT,
        outcome_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS research_finds_user_shown ON research_finds (user_id, shown_at DESC)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS research_finds_pending ON research_finds (shown_at) WHERE outcome IS NULL`))
    .catch((err: Error) => console.error("research_finds table init failed:", err));
  // Delivery receipts (2026-10-08, services/deliveryReceipts.ts): every document Co delivers, what (title, version, the content
  // itself), how (PDF, Google Doc, or text when the PDF failed), when. Follow-ups read it: what's outstanding, what to quote, never
  // the same artifact twice. A text fallback stays pdf_pending until the PDF follows (retried by the minute cron).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS document_deliveries (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        doc_key TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        kind TEXT,
        content JSONB NOT NULL,
        content_hash TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('pdf_text','google_docs','text_fallback','email')),
        status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered','pdf_pending','pdf_failed')),
        line TEXT,
        link TEXT,
        task_id BIGINT,
        source TEXT NOT NULL,
        change_note TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        pdf_sent_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS document_deliveries_user ON document_deliveries (user_id, delivered_at DESC)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS document_deliveries_key ON document_deliveries (user_id, doc_key, version DESC)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS document_deliveries_retry ON document_deliveries (next_retry_at) WHERE status = 'pdf_pending'`))
    // A plan emailed to them is recorded too (channel 'email'): widen the check on tables made before it.
    .then(() => pool.query(`ALTER TABLE document_deliveries DROP CONSTRAINT IF EXISTS document_deliveries_channel_check`))
    .then(() => pool.query(`ALTER TABLE document_deliveries ADD CONSTRAINT document_deliveries_channel_check CHECK (channel IN ('pdf_text','google_docs','text_fallback','email'))`))
    // A Google Doc Co made keeps its Drive file ID (Google audit, 2026-10-11), so a later edit updates that Doc instead of re-uploading.
    .then(() => pool.query(`ALTER TABLE document_deliveries ADD COLUMN IF NOT EXISTS drive_file_id TEXT`))
    // Which grant made the Doc: 'docs' (Cue's Docs grant, 2026-10-15); null, the old combined grant, whose Docs are never updated in place.
    .then(() => pool.query(`ALTER TABLE document_deliveries ADD COLUMN IF NOT EXISTS drive_grant TEXT`))
    .catch((err: Error) => console.error("document_deliveries table init failed:", err));
  // Co pages (services/coPages): a hosted page at /d/<id>, one member's only (owner_user_id), private by its unguessable id. A page
  // expires (expires_at, 90 days after its last change); taken down or expired, its link answers 404 and its content is wiped
  // (data '{}', see store.ts), so nothing a member asked to remove is kept.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_pages (
        id TEXT PRIMARY KEY CHECK (length(id) = 24),
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        taken_down_at TIMESTAMPTZ NULL
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS co_pages_owner ON co_pages (owner_user_id, updated_at DESC)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS co_pages_expiry ON co_pages (expires_at) WHERE taken_down_at IS NULL`))
    // Keep and renewal (2026-10-11): kept = "keep this" (no expiry, expires_at 'infinity'); last_viewed_at = their link opened (an
    // artifact in use); expiry_warned_at = Co told them it's about to expire (once per lifetime, cleared on renewal).
    .then(() => pool.query(`ALTER TABLE co_pages ADD COLUMN IF NOT EXISTS kept BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ NULL, ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMPTZ NULL`))
    // Share links (2026-10-11): a separate view-only link to one artifact, made only when its owner asks, revocable any time. Every
    // one is a row here (the log of its creation), and revoked_at ends it.
    .then(() =>
      pool.query(`CREATE TABLE IF NOT EXISTS co_page_shares (
        id TEXT PRIMARY KEY CHECK (length(id) = 24),
        page_id TEXT NOT NULL REFERENCES co_pages(id) ON DELETE CASCADE,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        their_words TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ NULL
      )`),
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS co_page_shares_page ON co_page_shares (page_id) WHERE revoked_at IS NULL`))
    .catch((err: Error) => console.error("co_pages table init failed:", err));
  // The link card's picture (Royce, 2026-10-28, option C): the artifact's real first screen, the QA render of the version that ships
  // (services/coPages/store.ts), kept on its own row so it goes with the content: replaced on every version, wiped wherever data is
  // (take-down, expiry, a reset's old row, a placed photo deleted) and deleted with the row (the owner's account, by cascade).
  // preview_version: the version it shows; the card route serves it only for the current one.
  await pool
    .query(`ALTER TABLE co_pages ADD COLUMN IF NOT EXISTS preview BYTEA NULL, ADD COLUMN IF NOT EXISTS preview_version INT NULL`)
    .catch((err: Error) => console.error("co_pages.preview init failed:", err));
  // Member assets (services/memberAssets.ts, 2026-10-11): the pictures, logos and inspiration images a member texts Co, kept for
  // their own artifacts (a deck now). One member's only; viewable only through a live artifact of theirs that places it
  // (routes/coPage.ts /d/<page>/a/<asset>). Unused for 90 days, the bytes are wiped.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_assets (
        id TEXT PRIMARY KEY CHECK (length(id) = 24),
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        n INT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/gif','image/webp')),
        bytes BYTEA,
        description TEXT,
        sha256 TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        wiped_at TIMESTAMPTZ NULL,
        UNIQUE (owner_user_id, n)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS member_assets_owner ON member_assets (owner_user_id, created_at DESC)`))
    .catch((err: Error) => console.error("member_assets table init failed:", err));
  // A member's design system (services/designSystem.ts, 2026-10-12): every look signal they gave or Co read for them (a stated taste,
  // a correction, a confirmed reference read), folded on read. One member's only. A reference read waits unconfirmed until they
  // answer Co's confirm-the-read line (asked_at, confirmed).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_design_signals (
        id BIGSERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        context TEXT NOT NULL CHECK (context IN ('professional','personal')),
        source TEXT NOT NULL CHECK (source IN ('correction','stated','reference','preset','inferred')),
        vals JSONB NOT NULL,
        quote TEXT,
        ref TEXT,
        confirmed BOOLEAN NOT NULL DEFAULT true,
        asked_at TIMESTAMPTZ,
        font_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS member_design_signals_owner ON member_design_signals (owner_user_id, created_at DESC)`))
    // The image a reference read came from (2026-10-12): its words are data for the look, never the member's own words (deck source).
    .then(() => pool.query(`ALTER TABLE member_design_signals ADD COLUMN IF NOT EXISTS asset_n INT`))
    // What kind of reference it was (logo, inspiration, screenshot): a logo's words are their brand; the others' words are not theirs.
    .then(() => pool.query(`ALTER TABLE member_design_signals ADD COLUMN IF NOT EXISTS ref_kind TEXT`))
    // What each artifact was made with and what its design QA found, and every later change: first-shot acceptance, keeps and shares
    // are read from it with co_pages and co_page_shares (view artifact_design_metrics).
    .then(() =>
      pool.query(`CREATE TABLE IF NOT EXISTS artifact_design_log (
        id BIGSERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        page_id TEXT,
        medium TEXT NOT NULL CHECK (medium IN ('deck','page','doc')),
        event TEXT NOT NULL CHECK (event IN ('made','revised')),
        layout TEXT,
        tokens JSONB NOT NULL DEFAULT '{}'::jsonb,
        qa JSONB NOT NULL DEFAULT '{}'::jsonb,
        confirm_line TEXT,
        choices TEXT,
        audience TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`),
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS artifact_design_log_page ON artifact_design_log (page_id, created_at)`))
    .then(() => pool.query(`ALTER TABLE artifact_design_log ADD COLUMN IF NOT EXISTS context TEXT`))
    // The member's turns from their ask to the build (services/designSystem.ts turnsToBuild), for first-shot acceptance.
    .then(() => pool.query(`ALTER TABLE artifact_design_log ADD COLUMN IF NOT EXISTS turns_to_build INT`))
    // First shot (design audit, 2026-10-12: the view said ~90% where a design critic said 38%): no QA finding left standing (the
    // check's own font trouble aside), built within one member turn of the ask, and no correction or revision within 48 hours. A
    // correction is a design signal they gave as one (member_design_signals source 'correction') in that window. An artifact whose QA
    // never ran is unknown (first_shot NULL), never first shot. New columns go last so the view replaces in place.
    .then(() =>
      pool.query(`CREATE OR REPLACE VIEW artifact_design_metrics AS
        SELECT x.id, x.owner_user_id, x.page_id, x.medium, x.layout, x.made_at, x.settled,
               CASE WHEN NOT x.qa_ran THEN NULL ELSE (x.qa_unresolved = 0 AND COALESCE(x.turns_to_build, 0) <= 1 AND x.corrections = 0) END AS first_shot,
               x.kept, x.shares, x.qa_findings, x.turns_to_build, x.corrections, x.qa_unresolved
          FROM (
            SELECT m.id, m.owner_user_id, m.page_id, m.medium, m.layout, m.created_at AS made_at,
                   m.created_at < NOW() - INTERVAL '48 hours' AS settled,
                   COALESCE(p.kept, false) AS kept,
                   (SELECT COUNT(*) FROM co_page_shares s WHERE s.page_id = m.page_id)::int AS shares,
                   COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(m.qa->'findings') = 'array' THEN m.qa->'findings' ELSE '[]'::jsonb END), 0) AS qa_findings,
                   m.turns_to_build,
                   COALESCE(m.qa->>'ran', 'false') = 'true' AS qa_ran,
                   ((SELECT COUNT(*) FROM artifact_design_log r WHERE r.event = 'revised' AND r.page_id = m.page_id AND r.created_at < m.created_at + INTERVAL '48 hours')
                    + (SELECT COUNT(*) FROM member_design_signals c WHERE c.owner_user_id = m.owner_user_id AND c.source = 'correction' AND c.created_at > m.created_at AND c.created_at < m.created_at + INTERVAL '48 hours'))::int AS corrections,
                   (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.qa->'findings') = 'array' THEN m.qa->'findings' ELSE '[]'::jsonb END) f WHERE f->>'rule' IS DISTINCT FROM 'render')::int AS qa_unresolved
              FROM artifact_design_log m LEFT JOIN co_pages p ON p.id = m.page_id
             WHERE m.event = 'made'
          ) x`),
    )
    .catch((err: Error) => console.error("member_design_signals table init failed:", err));
  // Goal lifecycle (2026-10-08, services/goalEdges.ts): a goal is active (no row), done or stale. Stale and done goals stay on file
  // and stop generating searches. A set-aside made from context waits to be told to them (told_at NULL, hints counts replies that
  // carried the hint).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS goal_states (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        goal_hash TEXT NOT NULL,
        goal_text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','done','stale')),
        reason TEXT,
        source TEXT NOT NULL CHECK (source IN ('context','member','co')),
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        told_at TIMESTAMPTZ,
        hints INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, goal_hash)
      )`,
    )
    .catch((err: Error) => console.error("goal_states table init failed:", err));
  // Goal recheck (Royce, 2026-10-13, services/goalRecheck.ts): last_signal_at is the last time a goal showed life (their text named
  // it, they reacted to a find for it, a goal action); recheck_asked_at is when Co's one "still something to look for?" went out.
  // Existing rows start at NOW() plus a 0 to 6 day offset from the goal's hash (goalRecheck.ts backfillOffsetDays), so nobody is asked
  // anything for RECHECK_AFTER_DAYS after deploy and the goals on file then don't all come due on one day. Filled once (NULL only).
  // The default goes on before the fill, so a row written meanwhile gets NOW(), never NULL; NOT NULL only after the fill.
  await pool
    .query(`ALTER TABLE goal_states ADD COLUMN IF NOT EXISTS last_signal_at TIMESTAMPTZ`)
    .then(() => pool.query(`ALTER TABLE goal_states ALTER COLUMN last_signal_at SET DEFAULT NOW()`))
    .then(() => pool.query(`UPDATE goal_states SET last_signal_at = NOW() + ((('x' || substr(goal_hash, 1, 7))::bit(28)::int % 7) * INTERVAL '1 day') WHERE last_signal_at IS NULL`))
    .then(() => pool.query(`ALTER TABLE goal_states ALTER COLUMN last_signal_at SET NOT NULL`))
    .catch((err: Error) => console.error("goal_states last_signal_at init failed:", err));
  // Its own statement: a failure above can't skip it.
  await pool
    .query(`ALTER TABLE goal_states ADD COLUMN IF NOT EXISTS recheck_asked_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("goal_states recheck_asked_at init failed:", err));
  // Ask retirement (Royce, 2026-10-13, services/askRetire.ts): a find ask that restates a work or Co-task goal retires through the
  // recheck's ask-once flow. retire_due_at: the plan marked it; retire_goals: the goal hashes it's tied to (the recheck acts first);
  // retire_asked_at: the question went out; retire_hints: replies that carried it unasked; retire_hold_until: they said keep it;
  // retired_at: it idled (kind help); retire_told_at: the one stopped-looking note went out (or the goal's note covered it).
  await pool
    .query(
      `ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS retire_due_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS retire_goals TEXT[],
         ADD COLUMN IF NOT EXISTS retire_asked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS retire_hints INT NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS retire_hold_until TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS retire_told_at TIMESTAMPTZ`,
    )
    .catch((err: Error) => console.error("ask_checkins retirement columns init failed:", err));
  // The stopped-looking line, written once when it idles (services/askRetire.ts writeStopLine): retire_note for an ask, idle_note for a
  // goal the recheck idled; retired_with_goal: the goal an ask idled with (its note is the goal's, and it comes back with the goal).
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS retire_note TEXT, ADD COLUMN IF NOT EXISTS retired_with_goal TEXT`)
    .catch((err: Error) => console.error("ask_checkins retirement note columns init failed:", err));
  await pool
    .query(`ALTER TABLE goal_states ADD COLUMN IF NOT EXISTS idle_note TEXT`)
    .catch((err: Error) => console.error("goal_states.idle_note init failed:", err));
  // Own work and mixed requests (Royce, 2026-10-13, services/askSplit.ts): the split read of an own-work ask, kept so the 9am floor and
  // the hourly sweep read it once, not every run; read again only when the ask's text changes (split_read.text) or the read's version does.
  await pool
    .query(`ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS split_read JSONB`)
    .catch((err: Error) => console.error("ask_checkins.split_read init failed:", err));
  // The class of each send as the member's own rules count it (harness/notifyGate.ts, 2026-11-02): reply, requested, unsolicited or
  // checkin. NULL on older rows: their type's class is read instead.
  await pool
    .query(`ALTER TABLE proactive_sends ADD COLUMN IF NOT EXISTS notify_class TEXT`)
    .catch((err: Error) => console.error("proactive_sends.notify_class init failed:", err));
  // A team-side hold (services/teamHold.ts, 2026-11-02): the team quiets one member's Cue-started outreach until it expires. Who set it
  // and a fixed category (no free text about the member: never a hidden dossier, review of #363). Nothing member-facing reads this
  // table. lifted_at: lifted early. The 30-day cap is a CHECK too (added once, NOT VALID: additive, never rewrites a row).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS team_holds (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        set_by TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('tester', 'hard_moment', 'member_asked_offline', 'other')),
        set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        lifted_at TIMESTAMPTZ,
        lifted_by TEXT
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_team_holds_user ON team_holds (user_id, expires_at)`))
    .then(() =>
      pool.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_holds_max_30_days') THEN
             ALTER TABLE team_holds ADD CONSTRAINT team_holds_max_30_days CHECK (expires_at > set_at AND expires_at <= set_at + INTERVAL '30 days') NOT VALID;
           END IF;
         END $$`,
      ),
    )
    .catch((err: Error) => console.error("team_holds init failed:", err));
  // The room close's note on a Cue-suggested pair that didn't happen is written once per pair (services/roomMatching.ts runRoomCloses).
  await pool
    .query(`ALTER TABLE co_pairs ADD COLUMN IF NOT EXISTS close_noted_at TIMESTAMPTZ`)
    .catch((err: Error) => console.error("co_pairs.close_noted_at init failed:", err));
  // Restraint with memory (2026-10-08, services/kindRestraint.ts): the kind of each proactive send (find, intro_followup, deadline,
  // goal_nudge, member_commitment; NULL when untracked), and the kinds a member let pass twice in a row, which Co stopped sending until
  // they answer one (state 'suppressed'; 'enabled' after they answered). evidence: the proactive_sends ids behind it.
  await pool
    .query(`ALTER TABLE proactive_sends ADD COLUMN IF NOT EXISTS kind TEXT`)
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS member_kind_preferences (
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('find','intro_followup','deadline','goal_nudge','member_commitment')),
          state TEXT NOT NULL CHECK (state IN ('suppressed','enabled')),
          suppressed_at TIMESTAMPTZ,
          enabled_at TIMESTAMPTZ,
          reason TEXT,
          evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, kind)
        )`,
      ),
    )
    .catch((err: Error) => console.error("member_kind_preferences / proactive_sends.kind init failed:", err));
  // Member-state nudges (2026-10-08, services/memberStateNudges.ts): one row per thing Co carries for a member that can nudge (an intro,
  // a deadline, a goal, a commitment), with the fingerprint of the state it last nudged (or tried to) for. Same fingerprint: never
  // again; a new one re-arms it once.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS member_state_nudges (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        target_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','sent','dropped')),
        reason TEXT,
        queued_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, entry_key)
      )`,
    )
    .catch((err: Error) => console.error("member_state_nudges table init failed:", err));
  // Matching, taste-first (services/roomMatching.ts, 2026-10-12). co_pairs: one record per pair per event, a_id < b_id,
  // its whole lifecycle (suggested, asked each side, answers, both yes, intro sent, met and each side's own outcome,
  // declined, blocked by the value-line gate, expired at the end of the night) and the value lines Co wrote for each side.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS co_pairs (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','asked','both_yes','intro_sent','met','declined','blocked','expired')),
        origin TEXT NOT NULL DEFAULT 'co' CHECK (origin IN ('co','member')),
        asked_a_at TIMESTAMPTZ,
        asked_b_at TIMESTAMPTZ,
        a_answer TEXT CHECK (a_answer IN ('yes','no')),
        a_answered_at TIMESTAMPTZ,
        b_answer TEXT CHECK (b_answer IN ('yes','no')),
        b_answered_at TIMESTAMPTZ,
        both_yes_at TIMESTAMPTZ,
        intro_sent_at TIMESTAMPTZ,
        declined_at TIMESTAMPTZ,
        met_at TIMESTAMPTZ,
        a_outcome TEXT,
        a_outcome_note TEXT,
        b_outcome TEXT,
        b_outcome_note TEXT,
        outcome_at TIMESTAMPTZ,
        expired_at TIMESTAMPTZ,
        value_line_a TEXT,
        value_line_b TEXT,
        value_verdict TEXT CHECK (value_verdict IN ('strong','weak')),
        value_why TEXT,
        value_judged_at TIMESTAMPTZ,
        blocked_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (a_id < b_id),
        UNIQUE (event_id, a_id, b_id)
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS co_pairs_pair_idx ON co_pairs (a_id, b_id)`))
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS co_pairs_waiting_idx ON co_pairs (event_id, state)`))
    .catch((err: Error) => console.error("co_pairs table init failed:", err));
  // The matching kill switch: scope 'all' or one event's id. Read fresh on every check; never a feature toggle.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS matching_pauses (
        scope TEXT PRIMARY KEY,
        paused BOOLEAN NOT NULL DEFAULT true,
        reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("matching_pauses table init failed:", err));
  // The end of the night: one durable row per event, due at its end plus a buffer, claimed once by the cron.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS event_room_closures (
        event_id TEXT PRIMARY KEY,
        event_name TEXT,
        ends_at TIMESTAMPTZ NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        expired_offers INTEGER,
        expired_pairs INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS event_room_closures_due_idx ON event_room_closures (due_at) WHERE closed_at IS NULL`))
    .catch((err: Error) => console.error("event_room_closures table init failed:", err));
  // Intro emails: held by the matching pause (sent when it lifts) or failed (a few bounded retries). And every decline
  // already on record joins its pair, so a declined pair is never suggested again (idempotent backfill).
  await pool
    .query(`ALTER TABLE co_pairs ADD COLUMN IF NOT EXISTS intro_held_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS intro_attempts INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS intro_claimed_at TIMESTAMPTZ`)
    .then(() =>
      pool.query(
        `INSERT INTO co_pairs (event_id, a_id, b_id, origin, state, declined_at, a_answer, a_answered_at, b_answer, b_answered_at)
         SELECT o.event_id, LEAST(o.person_id, o.candidate_id), GREATEST(o.person_id, o.candidate_id), 'co', 'declined', o.decided_at,
                CASE WHEN o.person_id < o.candidate_id THEN 'no' END, CASE WHEN o.person_id < o.candidate_id THEN o.decided_at END,
                CASE WHEN o.person_id > o.candidate_id THEN 'no' END, CASE WHEN o.person_id > o.candidate_id THEN o.decided_at END
         FROM event_guest_match_opt_ins o
         WHERE o.status = 'declined' AND o.person_id <> o.candidate_id
         ON CONFLICT (event_id, a_id, b_id) DO UPDATE SET state = 'declined', declined_at = COALESCE(co_pairs.declined_at, EXCLUDED.declined_at), updated_at = NOW()
           WHERE co_pairs.declined_at IS NULL AND co_pairs.intro_sent_at IS NULL`,
      ),
    )
    .catch((err: Error) => console.error("co_pairs intro columns / decline backfill failed:", err));
  // The outcome record (services/roomMatching.ts, 2026-11-02): each side's own evidence of what happened after the intro (met,
  // useful, kept talking), each with its source, time and whether it was said or inferred. Empty is unknown. Nothing existing changes.
  await pool
    .query(`ALTER TABLE co_pairs ADD COLUMN IF NOT EXISTS a_evidence JSONB NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS b_evidence JSONB NOT NULL DEFAULT '{}'::jsonb`)
    .catch((err: Error) => console.error("co_pairs evidence columns failed:", err));
  // Network intro emails held by the matching pause (services/networkIntroNudge.ts retryHeldNetworkIntros).
  await pool
    .query(`ALTER TABLE network_introductions ADD COLUMN IF NOT EXISTS email_held_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS email_attempts INTEGER NOT NULL DEFAULT 0`)
    .catch((err: Error) => console.error("network_introductions held-email columns failed:", err));
  // The network intro email's claim (services/networkIntroNudge.ts): taken with 'introduced' before the send, so a claim no send
  // confirmed (the server died in between) is told apart from an intro made before email_sent_at existed, and only it is retaken.
  await pool
    .query(`ALTER TABLE network_introductions ADD COLUMN IF NOT EXISTS email_claimed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS email_outcome TEXT`)
    .catch((err: Error) => console.error("network_introductions email claim column failed:", err));
  // Network intros already made get their outcome record (services/roomMatching.ts NETWORK_PAIR_EVENT, 2026-11-03): the ones whose
  // intro went (email_sent_at, or made before the claim existed: the same "went" test as harness/northStar.ts NETWORK_SQL), as the send
  // now writes it. Idempotent (ON CONFLICT DO NOTHING); nothing existing changes.
  await pool
    .query(
      `INSERT INTO co_pairs (event_id, a_id, b_id, origin, state, a_answer, a_answered_at, b_answer, b_answered_at, both_yes_at, intro_sent_at, value_line_a, value_line_b)
       SELECT 'network', n.person_a_id, n.person_b_id, 'co', 'intro_sent', 'yes', n.introduced_at, 'yes', n.introduced_at, n.introduced_at,
              COALESCE(n.email_sent_at, n.introduced_at), left(n.match_reason, 500), left(n.match_reason, 500)
       FROM network_introductions n
       WHERE n.status = 'introduced' AND n.introduced_at IS NOT NULL AND (n.email_sent_at IS NOT NULL OR n.email_claimed_at IS NULL)
       ON CONFLICT (event_id, a_id, b_id) DO NOTHING`,
    )
    .catch((err: Error) => console.error("co_pairs network intro backfill failed (non-fatal):", err));
  // An in-room question still open when the room closes expires instead of binding a "yes" days later. 'sending': a direct ask
  // holding the member's one question slot while it is drafted and sent (services/inRoomOffers.ts claimAskSlot).
  await pool
    .query(`ALTER TABLE event_match_offers DROP CONSTRAINT IF EXISTS event_match_offers_status_check`)
    .then(() => pool.query(`ALTER TABLE event_match_offers ADD CONSTRAINT event_match_offers_status_check CHECK (status IN ('queued', 'sending', 'open', 'answered', 'expired'))`))
    .catch((err: Error) => console.error("event_match_offers expired status failed:", err));
  // Where each want is (services/wantPlace.ts, Royce 2026-10-15: "the place lives on the want, not the member"). One row per want
  // (an open ask, or a goal Co searches for), read once; place NULL means none (the home city stands in). noted_at: the one line saying
  // where their finds come from went out (or they set the place themselves).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS want_places (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        want_key TEXT NOT NULL,
        want_text TEXT NOT NULL,
        place TEXT,
        source TEXT NOT NULL CHECK (source IN ('their_words', 'told', 'corrected', 'none', 'removed')),
        quote TEXT,
        noted_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, want_key)
      )`,
    )
    .catch((err: Error) => console.error("want_places table failed:", err));
  // When a want is for (services/wantWhen.ts, the bounce, Royce 2026-10-15: "I'm in Chicago til Friday" sets the place AND the window),
  // and when they said they're free (stated gaps: proposed against, never held; a calendar gap is the only one that holds).
  await pool
    .query(`ALTER TABLE want_places ADD COLUMN IF NOT EXISTS window_start DATE, ADD COLUMN IF NOT EXISTS window_end DATE, ADD COLUMN IF NOT EXISTS window_quote TEXT`)
    // A window can be saved before the want's place is read ("unread": wantPlace.ts placeFor still reads it).
    .then(() => pool.query(`ALTER TABLE want_places DROP CONSTRAINT IF EXISTS want_places_source_check`))
    .then(() => pool.query(`ALTER TABLE want_places ADD CONSTRAINT want_places_source_check CHECK (source IN ('their_words', 'told', 'corrected', 'none', 'removed', 'unread'))`))
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS member_free_times (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          weekday TEXT CHECK (weekday IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
          on_date DATE,
          start_time TIME NOT NULL,
          end_time TIME NOT NULL,
          quote TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          removed_at TIMESTAMPTZ,
          CHECK ((weekday IS NULL) <> (on_date IS NULL))
        )`,
      ),
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS member_free_times_user ON member_free_times (user_id) WHERE removed_at IS NULL`))
    .catch((err: Error) => console.error("want windows / member_free_times failed:", err));
  // Where a want's place is on the map (services/placeResolve.ts, 2026-10-29: "Bay Area" was resolved to Houston for a Sacramento
  // member): the resolution, kept on the want's own row with the place and home it was made for (and the home's country then), so its
  // search uses these coordinates, a shared geocode_cache row is never read or written for it, and a correction (wantPlace.ts setPlace)
  // clears exactly this want's.
  await pool
    .query(
      `ALTER TABLE want_places ADD COLUMN IF NOT EXISTS resolved_for TEXT, ADD COLUMN IF NOT EXISTS resolved_home TEXT, ADD COLUMN IF NOT EXISTS resolved_status TEXT,
         ADD COLUMN IF NOT EXISTS resolved_label TEXT, ADD COLUMN IF NOT EXISTS resolved_lat DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS resolved_lng DOUBLE PRECISION,
         ADD COLUMN IF NOT EXISTS resolved_options JSONB, ADD COLUMN IF NOT EXISTS resolved_home_country TEXT, ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
    )
    .catch((err: Error) => console.error("want_places resolution columns failed:", err));
  // When a behavior first existed in this environment (Royce, 2026-10-15: "the new path should apply to wants created after the
  // behavior exists. A calendar cutoff invents a difference that isn't real"): written once, by the first deploy that has it.
  await pool
    .query(`CREATE TABLE IF NOT EXISTS feature_epochs (name TEXT PRIMARY KEY, since TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    .then(() => pool.query(`INSERT INTO feature_epochs (name) VALUES ('want_places') ON CONFLICT (name) DO NOTHING`))
    .catch((err: Error) => console.error("feature_epochs failed:", err));
  // Restraint counts from the first kind-tagged send (services/kindRestraint.ts loadKindHistory): this keeps that lookup an index read.
  await pool
    .query(`CREATE INDEX IF NOT EXISTS proactive_sends_kinded ON proactive_sends (sent_at) WHERE kind IS NOT NULL`)
    .catch((err: Error) => console.error("proactive_sends_kinded index init failed:", err));
  // One-time call links (services/callLink.ts, 2026-10-18): the outbound TwiML URL carries an opaque id, not the member's id and a
  // token, since Twilio logs the URL. Only the id's hash is kept; a row is deleted when it's used, and expired ones on the next dial.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS call_links (
        id_hash TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS call_links_expires ON call_links (expires_at)`))
    .catch((err: Error) => console.error("call_links table init failed:", err));
  // The voice read on calls (services/voiceRead.ts, 2026-10-23): runs only for a member who agreed to it, one by one
  // (default false, nobody is opted in by code), plus test numbers. Its stream links: Twilio logs TwiML, so the fork's
  // <Parameter> carries an opaque one-time id; only its hash is kept, with the member and the call's session on our side.
  await pool
    .query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_read_ok BOOLEAN NOT NULL DEFAULT false`)
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS voice_stream_links (
          id_hash TEXT PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      ),
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS voice_stream_links_expires ON voice_stream_links (expires_at)`))
    .catch((err: Error) => console.error("voice read init failed:", err));
  // The member's own yes to the voice read (services/voiceReadConsent.ts, 2026-10-28): users.voice_read_ok above is no longer read
  // (a database switch isn't consent). One row per member: when Cue asked, their answer and when, their yes in their own words
  // (dropped when they take it back), and when they took it back. New and empty: nothing existing is touched.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS voice_read_consents (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        asked_at TIMESTAMPTZ,
        answer TEXT CHECK (answer IN ('yes', 'no')),
        answered_at TIMESTAMPTZ,
        yes_quote TEXT,
        withdrawn_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("voice_read_consents init failed:", err));
  // Intros a member asked for by name (services/introRequestClose.ts, 2026-10-28): one row per request, the same for every outcome,
  // so that 7 days on an unresolved one gets the one neutral close. target_id is set only when one guest by that full name was found,
  // and is read only by the close check. The row is deleted once the close went or was dropped, or the intro was made.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS intro_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name_said TEXT NOT NULL DEFAULT '',
        event_id TEXT,
        target_id UUID REFERENCES users(id) ON DELETE SET NULL,
        asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        close_due_at TIMESTAMPTZ NOT NULL,
        close_queued_at TIMESTAMPTZ
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS intro_requests_due ON intro_requests (close_due_at) WHERE close_queued_at IS NULL`))
    .catch((err: Error) => console.error("intro_requests init failed:", err));
  // The member snapshot, built in shadow (services/memberSnapshot.ts, snapshot design 2026-10-29 step 2): its table, the marks table,
  // and a staleness trigger on every source table that exists (services/memberSnapshotSchema.ts). Additive; last, so every source
  // table above is there first. Anything already in place is skipped, so a boot runs no DDL once it's all there; what does run waits
  // at most a moment for a lock and is otherwise left for the next boot. Never blocks startup.
  await import("../services/memberSnapshotSchema.js")
    .then((S) => S.snapshotMigrations(pool))
    .then((r) => {
      if (r.missing.length || r.failed.length || r.deferred.length) console.error(`member snapshot triggers: ${r.triggers.length} on, missing tables ${r.missing.join(", ") || "none"}, failed ${r.failed.join(", ") || "none"}, deferred to the next boot ${r.deferred.length}`);
    })
    .catch((err: Error) => console.error("member snapshot init failed:", err));
  await concurrencyMigrations();
}

// Concurrency audit (2026-10-12). Each step is idempotent and on its own: one failing never blocks the rest or startup.
export async function concurrencyMigrations(): Promise<void> {
  // A reset's old row points at the fresh id, so a change or keep that raced it follows it there (services/coPages/store.ts).
  await pool.query(`ALTER TABLE co_pages ADD COLUMN IF NOT EXISTS moved_to TEXT NULL`).catch((err: Error) => console.error("co_pages.moved_to init failed:", err));
  // One snapshot rebuild per member at a time, and the newer picture is never replaced by an older one (harness/personSnapshot.ts).
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS person_snapshot_claims (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        again BOOLEAN NOT NULL DEFAULT false
      )`,
    )
    .then(() => pool.query(`ALTER TABLE person_snapshots ADD COLUMN IF NOT EXISTS built_from TIMESTAMPTZ NULL`))
    .catch((err: Error) => console.error("person_snapshot_claims init failed:", err));
  // The same thread from the same words is open once (harness/memberThreads.ts). Copies already open are closed first, the oldest
  // kept, never deleted: status 'changed' with closed_at, so the rows stay on file.
  await pool
    .query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (PARTITION BY user_id, md5(opened_quote), md5(lower(text)) ORDER BY created_at, id) AS rn
         FROM member_threads WHERE status IN ('open', 'waiting')
       )
       UPDATE member_threads t SET status = 'changed', closed_at = NOW() FROM ranked WHERE t.id = ranked.id AND ranked.rn > 1`,
    )
    .then(() =>
      pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS member_threads_one_open ON member_threads (user_id, md5(opened_quote), md5(lower(text))) WHERE status IN ('open', 'waiting')`,
      ),
    )
    .catch((err: Error) => console.error("member_threads_one_open init failed:", err));
  // The GPT-Live trial's minute ledger (services/gptLive.ts): one row per session, written as it starts and about every minute after,
  // so the trial's total cap counts a call cut short by a restart. No user column (a member's deletion can't cascade into it) and
  // nothing prunes it. New and empty: nothing existing is touched.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS gpt_live_minutes (
        session_id TEXT PRIMARY KEY,
        seconds NUMERIC NOT NULL DEFAULT 0,
        ended_by TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("gpt_live_minutes init failed:", err));
  // Cue's contact card, by version (services/cardReissue.ts): when each version was first served (/co.vcf), and per member, what
  // happened when a version was pushed to them (sent, failed, held), so nobody gets a version twice and a retry only tries the members
  // it didn't reach. New and empty: nothing existing is touched.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS contact_card_versions (
        version INTEGER PRIMARY KEY,
        live_since TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS contact_card_sends (
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'held')),
          reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 1,
          sent_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, version)
        )`,
      ),
    )
    .catch((err: Error) => console.error("contact_card tables init failed:", err));
  // One live copy of a photo per member (services/memberAssets.ts keepAsset). Numbered images only: a cleaned-up copy is kept as -N
  // and may share its original's bytes. If copies already exist this fails and is logged; keepAsset works either way.
  await pool
    .query(`CREATE UNIQUE INDEX IF NOT EXISTS member_assets_one_live_copy ON member_assets (owner_user_id, sha256) WHERE wiped_at IS NULL AND n > 0`)
    .catch((err: Error) => console.error("member_assets_one_live_copy init failed (copies already on file?):", err.message));
}
