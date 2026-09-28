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
    .catch((err: Error) => console.error("llm_usage table init failed:", err));

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
    .catch((err: Error) => console.error("event_presence table init failed:", err));

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
  // lapse_*: the membership lapse clock (services/membershipLapse.ts);
  // lapse_exempt marks team accounts it never starts for.
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

  // Mo (2026-09-22) — see src/mo/. People worth inviting, found on
  // X and through web search, contacted only after a person approves.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS mo_prospects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        no SERIAL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('x', 'linkedin')),
        x_user_id TEXT UNIQUE,
        x_handle TEXT,
        name TEXT,
        bio TEXT,
        location TEXT,
        post_id TEXT,
        post_url TEXT,
        post_text TEXT,
        linkedin_url TEXT UNIQUE,
        headline TEXT,
        reason TEXT NOT NULL,
        evidence_quote TEXT NOT NULL,
        draft_reply TEXT,
        draft_dm TEXT,
        draft_email_subject TEXT,
        draft_email_body TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'shortlisted',
        channel TEXT,
        approved_by UUID,
        approved_at TIMESTAMPTZ,
        warmed_at TIMESTAMPTZ,
        warm_reply_id TEXT,
        contacted_at TIMESTAMPTZ,
        followed_up_at TIMESTAMPTZ,
        last_inbound_at TIMESTAMPTZ,
        last_dm_event_id TEXT,
        pending_question TEXT,
        invite_code TEXT,
        digest_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_prospects_status ON mo_prospects (status)`))
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS mo_suppression (
          key TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      ),
    )
    .then(() =>
      pool.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS mo_approver BOOLEAN NOT NULL DEFAULT false,
           ADD COLUMN IF NOT EXISTS mo_pending_no INTEGER,
           ADD COLUMN IF NOT EXISTS mo_pending_kind TEXT,
           ADD COLUMN IF NOT EXISTS mo_pending_at TIMESTAMPTZ`,
      ),
    )
    .catch((err: Error) => console.error("mo tables init failed:", err));

  // Mo reaching out as itself, two DM styles tested side by side (Jacqueline,
  // 2026-09-24), and Mo's team state: pause, what the team asked it to look
  // for, and the network's gaps as Co reports them (mo/team.ts).
  await pool
    .query(
      `ALTER TABLE mo_prospects ADD COLUMN IF NOT EXISTS dm_style TEXT, ADD COLUMN IF NOT EXISTS draft_why TEXT, ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ`,
    )
    .then(() =>
      pool.query(`CREATE TABLE IF NOT EXISTS mo_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`),
    )
    .then(() =>
      pool.query(
        `CREATE TABLE IF NOT EXISTS mo_focus (
          id BIGSERIAL PRIMARY KEY,
          text TEXT NOT NULL,
          asked_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      ),
    )
    .catch((err: Error) => console.error("mo team tables init failed:", err));

  // Living asks (services/askKind.ts, 2026-09-26): whether a search can find
  // it, and when they last brought it up, so what matters now is searched first.
  await pool
    .query(
      `ALTER TABLE ask_checkins ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'find',
         ADD COLUMN IF NOT EXISTS kind_checked_at TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS last_mentioned_at TIMESTAMPTZ`,
    )
    .catch((err: Error) => console.error("ask_checkins living-asks migration failed:", err));
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

  // Replies to Mo's emails (mo/emailReplies.ts, 2026-09-25): the thread to
  // answer in, and each received email handled once however often Resend
  // retries the post.
  // Which opening Mo used (mo/draft.ts OPENERS, 2026-09-25), to see which lands.
  await pool
    .query(`ALTER TABLE mo_prospects ADD COLUMN IF NOT EXISTS opener TEXT`)
    .catch((err: Error) => console.error("mo_prospects.opener migration failed:", err));
  // Mo as an extension of Co (2026-09-26): who a prospect became once they
  // joined, what they said to Mo before joining (their own words), and the
  // event they were invited for, so Co's first conversations don't start
  // cold (services/extensions.ts handoff).
  await pool
    .query(
      `ALTER TABLE mo_prospects ADD COLUMN IF NOT EXISTS joined_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
         ADD COLUMN IF NOT EXISTS their_words JSONB NOT NULL DEFAULT '[]',
         ADD COLUMN IF NOT EXISTS invited_for TEXT`,
    )
    .then(() =>
      pool.query(
        `UPDATE mo_prospects sp SET joined_user_id = ic.used_by FROM invite_codes ic
         WHERE sp.invite_code = ic.code AND sp.joined_user_id IS NULL AND ic.used_by IS NOT NULL`,
      ),
    )
    .catch((err: Error) => console.error("mo_prospects handoff migration failed:", err));
  await pool
    .query(`ALTER TABLE mo_prospects ADD COLUMN IF NOT EXISTS last_email_message_id TEXT`)
    .catch((err: Error) => console.error("mo_prospects.last_email_message_id migration failed:", err));
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS mo_email_inbound (
        email_id TEXT PRIMARY KEY,
        prospect_id UUID REFERENCES mo_prospects(id) ON DELETE SET NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    )
    .catch((err: Error) => console.error("mo_email_inbound table init failed:", err));
  // The team never sends anything by hand (Royce, 2026-09-24): anyone left
  // waiting on an approver to post a LinkedIn note goes back into Mo's own
  // outreach (an email from Co if there's a public address).
  await pool
    .query(`UPDATE mo_prospects SET status = 'approved', channel = NULL, updated_at = NOW() WHERE status = 'manual_pending'`)
    .catch((err: Error) => console.error("mo manual_pending cleanup failed:", err));

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
    .catch((err: Error) => console.error("emotion_signals table init failed:", err));

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
}
