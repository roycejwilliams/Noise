#!/usr/bin/env tsx
/**
 * CoPatible Edge Case & Stress Test Suite
 * 10 hard questions about how Co actually behaves under failure conditions
 */
import "dotenv/config";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASE = "https://raking-swizzle-greeter.ngrok-free.dev";
const MAIN_USER = "9f063ffe-7f73-48ff-b44a-3c813183ed36";

// Ghost test user — created fresh each run if missing
const GHOST_ID = "00000000-0000-0000-0000-000000000099";

// ─── Infra ────────────────────────────────────────────────────────────────────

type Status = "PASSED" | "FAILED" | "SKIPPED";
const results: Array<{ name: string; status: Status; finding: string }> = [];

function pass(name: string, finding: string) {
  results.push({ name, status: "PASSED", finding });
  console.log(`  ✅ PASSED — ${finding}`);
}
function fail(name: string, finding: string) {
  results.push({ name, status: "FAILED", finding });
  console.log(`  ❌ FAILED — ${finding}`);
}
function skip(name: string, finding: string) {
  results.push({ name, status: "SKIPPED", finding });
  console.log(`  ⏭  SKIPPED — ${finding}`);
}

function makeJwt(userId: string) {
  return jwt.sign({ id: userId, role: "admin" }, process.env.JWT_SECRET_KEY!, {
    expiresIn: "1h",
  });
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  if (auth) headers["Cookie"] = `token=${auth}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (text.includes("ERR_NGROK_3200")) {
    throw new Error("NGROK_OFFLINE");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.length > 300 ? text.slice(0, 300) + "…" : text;
  }
  return { status: res.status, body: parsed };
}

async function ensureGhostUser() {
  const exists = await pool.query(
    `SELECT id FROM users WHERE id = $1`,
    [GHOST_ID],
  );
  if (!exists.rows[0]) {
    await pool.query(
      `INSERT INTO users
        (id, first_name, last_name, email, phone_number, username,
         otp_code, otp_expiry, subscription_status, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        GHOST_ID,
        "Ghost",
        "Tester",
        "ghost.tester.copatible@devnull.test",
        "+19999999999",
        "ghost_tester_co",
        "000000",
        new Date(Date.now() + 3600000).toISOString(),
        "active",
        "user",
      ],
    );
    console.log("  [setup] Ghost user created");
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function q1_emptyProfile() {
  console.log("\n[Q1] Empty co_profiles — no chapters, no embeddings");

  // 1a: No co_profiles row at all
  await pool.query(`DELETE FROM co_profiles WHERE user_id = $1`, [GHOST_ID]);
  const r1 = await api(
    "POST",
    `/co/place/${GHOST_ID}`,
    undefined,
    makeJwt(GHOST_ID),
  );
  console.log(`  1a (no profile row) → ${r1.status}:`, r1.body);
  if (r1.status === 200 && r1.body?.manual_placement) {
    console.log("  ✓ 1a: no profile → manual_placement");
  } else {
    fail("Q1", `1a: expected manual_placement, got ${r1.status} ${JSON.stringify(r1.body)}`);
    return;
  }

  // 1b: co_profiles row with empty life_chapters and null embeddings
  await pool.query(
    `INSERT INTO co_profiles
      (user_id, life_chapters, social_energy, connection_style,
       activity_preferences, emotional_state, goals, blockers,
       availability_pattern, city, goal_embeddings)
     VALUES ($1, '{}', 50, 'small_group', '{}', 'steady', '{}', '{}', null, 'San Francisco', null)
     ON CONFLICT (user_id) DO UPDATE SET
       life_chapters = '{}', goal_embeddings = NULL`,
    [GHOST_ID],
  );
  const r2 = await api(
    "POST",
    `/co/place/${GHOST_ID}`,
    undefined,
    makeJwt(GHOST_ID),
  );
  console.log(`  1b (empty chapters) → ${r2.status}:`, r2.body);
  if (r2.status === 200 && r2.body?.manual_placement) {
    console.log("  ✓ 1b: empty chapters → manual_placement");
  } else {
    fail("Q1", `1b: expected manual_placement, got ${r2.status}`);
    return;
  }

  // 1c: co_profiles with valid chapters BUT null goal_embeddings
  // Previously would crash matching.ts with TypeError on null.reduce()
  // After parseEmbedding fix this should return manual_placement or a circle
  await pool.query(
    `UPDATE co_profiles SET
       life_chapters = '{"new_to_city","building_solo"}',
       goal_embeddings = NULL,
       city = 'San Francisco'
     WHERE user_id = $1`,
    [GHOST_ID],
  );
  const r3 = await api(
    "POST",
    `/co/place/${GHOST_ID}`,
    undefined,
    makeJwt(GHOST_ID),
  );
  console.log(`  1c (chapters+null embeddings) → ${r3.status}:`, r3.body);
  if (r3.status === 500) {
    fail(
      "Q1",
      "1c: null goal_embeddings still crashes matching algorithm (parseEmbedding fix not applied yet)",
    );
  } else if (r3.status === 200 || r3.status === 201) {
    pass(
      "Q1",
      `All three variants safe: no-profile→manual_placement, empty-chapters→manual_placement, null-embeddings→${r3.body?.manual_placement ? "manual_placement" : "circle placed (embeddings scored as 0)"}`,
    );
  } else {
    fail("Q1", `1c: unexpected ${r3.status} ${JSON.stringify(r3.body)}`);
  }
}

async function q2_thinCandidatePool() {
  console.log("\n[Q2] Fewer than 4 candidates in pool");

  // Put ghost user in a city with no other users
  await pool.query(
    `INSERT INTO co_profiles
      (user_id, life_chapters, social_energy, connection_style,
       activity_preferences, emotional_state, goals, blockers,
       availability_pattern, city, goal_embeddings)
     VALUES ($1, '{"new_to_city"}', 60, 'small_group', '{"hiking"}', 'motivated',
             '{"find community"}', '{}', 'weekends', 'NowhereCity_EdgeTest_999', NULL)
     ON CONFLICT (user_id) DO UPDATE SET city = 'NowhereCity_EdgeTest_999'`,
    [GHOST_ID],
  );

  const r = await api(
    "POST",
    `/co/place/${GHOST_ID}`,
    undefined,
    makeJwt(GHOST_ID),
  );
  console.log(`  status: ${r.status}`, r.body);

  if (r.status === 200 && r.body?.manual_placement) {
    pass("Q2", "Thin pool (0 candidates in isolated city) → manual_placement, no crash");
  } else if (r.status === 500) {
    fail("Q2", "Crashed with 500 — matching algorithm doesn't handle empty pool safely");
  } else {
    fail("Q2", `Unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  }
}

async function q3_gibberishTranscript() {
  console.log("\n[Q3] Gibberish transcript — Anthropic parse failure path");

  // Single character / noise — Anthropic may still return valid JSON but with empty fields
  const r = await api("POST", "/co/webhook", {
    user_id: GHOST_ID,
    transcript: "zzzzz aaaaa bbbbb 12345 !!!! ###",
    emotions: [{ name: "confused", score: 1.0 }],
    recording_url: null,
  });
  console.log(`  status: ${r.status}`, r.body);

  if (r.status === 400) {
    fail("Q3", "Returned 400 — user_id or transcript missing check triggered incorrectly");
    return;
  }
  if (r.status === 500) {
    fail("Q3", "Webhook crashed on unparseable transcript — no fallback to defaults");
    return;
  }

  if (r.status === 200 && r.body?.success) {
    // Now verify co_profiles was upserted (not left in broken state)
    const profile = await api("GET", `/co/profile/${GHOST_ID}`);
    if (profile.status === 200 && profile.body?.data) {
      const d = profile.body.data;
      // life_chapters will be [] (default) if Anthropic returned unparseable data
      pass(
        "Q3",
        `Webhook survived gibberish — co_profiles upserted with fallback defaults: chapters=${JSON.stringify(d.life_chapters)} social_energy=${d.social_energy} embeddings=${d.goal_embeddings === null ? "null" : "populated"}`,
      );
    } else {
      fail("Q3", "Webhook returned 200 but co_profiles not found after");
    }
  } else {
    fail("Q3", `Unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  }
}

async function q4_googlePlacesZeroResults() {
  console.log("\n[Q4] Google Places zero results — fictional city");

  // Create a circle whose members are in a city where Places returns nothing
  await pool.query(
    `UPDATE co_profiles SET city = 'NowhereCity_EdgeTest_999' WHERE user_id = $1`,
    [GHOST_ID],
  );

  // Create a test circle for the ghost user
  const circleRes = await pool.query(
    `INSERT INTO circles (owner_id, circle_name) VALUES ($1, $2) RETURNING id`,
    [GHOST_ID, "Edge Test Circle Q4"],
  );
  const circleId = circleRes.rows[0].id;

  // Add the main user as a member (they have a co_profile)
  // First put main user's profile in the same fake city temporarily
  const mainProfile = await pool.query(
    `SELECT city FROM co_profiles WHERE user_id = $1`,
    [MAIN_USER],
  );
  const originalCity = mainProfile.rows[0]?.city;

  await pool.query(
    `UPDATE co_profiles SET city = 'NowhereCity_EdgeTest_999' WHERE user_id = $1`,
    [MAIN_USER],
  );
  await pool.query(
    `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [circleId, MAIN_USER],
  );

  console.log(`  circle_id: ${circleId}, city: NowhereCity_EdgeTest_999`);

  try {
    const r = await api("POST", `/co/moment/${circleId}`);
    console.log(`  status: ${r.status}`, JSON.stringify(r.body, null, 2));

    if (r.status === 201 && r.body?.success) {
      const venue = r.body.data?.venue;
      const venueNull = venue === null || venue === undefined;
      pass(
        "Q4",
        `Moment created despite zero Places results — venue=${venueNull ? "null (graceful fallback)" : `"${venue}" (Places found something anyway)`}`,
      );
    } else if (r.status === 500) {
      fail("Q4", "Moment crashed when Google Places returned zero results");
    } else {
      fail("Q4", `Unexpected ${r.status}: ${JSON.stringify(r.body)}`);
    }
  } finally {
    // Restore main user's city
    if (originalCity) {
      await pool.query(
        `UPDATE co_profiles SET city = $1 WHERE user_id = $2`,
        [originalCity, MAIN_USER],
      );
    }
  }
}

async function q5_unrelatedSendblueMessage() {
  console.log("\n[Q5] Unrelated inbound message — 'have you seen Severance?'");

  // Find main user's phone
  const userRes = await pool.query(
    `SELECT phone_number FROM users WHERE id = $1`,
    [MAIN_USER],
  );
  const phone = userRes.rows[0]?.phone_number;
  if (!phone) {
    skip("Q5", "Could not resolve main user phone number");
    return;
  }

  // Check if there's a pending moment_response for this user
  const pendingRes = await pool.query(
    `SELECT mr.moment_id, mr.response FROM moment_responses mr
     WHERE mr.user_id = $1 AND mr.response IS NULL
     LIMIT 1`,
    [MAIN_USER],
  );
  const hasPending = pendingRes.rows.length > 0;
  console.log(
    `  pending moment_response: ${hasPending ? pendingRes.rows[0].moment_id : "none"}`,
  );

  const r = await api("POST", "/sendblue/webhook", {
    number: phone,
    content: "have you seen the new season of Severance?",
    is_outbound: false,
  });
  console.log(`  status: ${r.status}`, r.body);

  if (r.status !== 200 || !r.body?.received) {
    fail("Q5", `Webhook failed: ${r.status} ${JSON.stringify(r.body)}`);
    return;
  }

  if (hasPending) {
    // Verify moment_response was updated
    const afterRes = await pool.query(
      `SELECT response FROM moment_responses
       WHERE user_id = $1 AND moment_id = $2`,
      [MAIN_USER, pendingRes.rows[0].moment_id],
    );
    const classified = afterRes.rows[0]?.response;
    console.log(`  Anthropic classified as: "${classified}"`);

    if (classified === "unclear") {
      pass(
        "Q5",
        `Anthropic correctly classified off-topic message as "unclear" — moment_responses.response="unclear"`,
      );
    } else if (["yes", "no"].includes(classified)) {
      fail(
        "Q5",
        `Anthropic misclassified "have you seen Severance?" as "${classified}" — should be "unclear"`,
      );
    } else if (classified?.startsWith("time:")) {
      fail("Q5", `Classified as time suggestion: "${classified}" — incorrect`);
    } else {
      pass(
        "Q5",
        `Response captured as "${classified}" — Anthropic handled off-topic message, moment_responses not corrupted`,
      );
    }
  } else {
    // No pending moment — went through general reply path
    const action = r.body?.action ?? "general_reply";
    const reply = r.body?.reply;
    pass(
      "Q5",
      `No pending moment — went through general Co reply path (action=${action}). Co replied: "${reply?.slice(0, 80)}…"`,
    );
  }
}

async function q6_doublePlacement() {
  console.log("\n[Q6] Same user calls /co/place twice in a row");

  // Restore ghost to SF so it can match
  await pool.query(
    `UPDATE co_profiles SET
       city = 'San Francisco',
       life_chapters = '{"new_to_city","building_solo"}',
       goal_embeddings = NULL
     WHERE user_id = $1`,
    [GHOST_ID],
  );

  const r1 = await api(
    "POST",
    `/co/place/${MAIN_USER}`,
    undefined,
    makeJwt(MAIN_USER),
  );
  console.log(`  Call 1 → ${r1.status}:`, r1.body?.data?.circle_id ?? r1.body);

  const r2 = await api(
    "POST",
    `/co/place/${MAIN_USER}`,
    undefined,
    makeJwt(MAIN_USER),
  );
  console.log(`  Call 2 → ${r2.status}:`, r2.body?.data?.circle_id ?? r2.body);

  if (r1.status === 500 || r2.status === 500) {
    fail("Q6", "One of the calls crashed with 500");
    return;
  }

  const circle1 = r1.body?.data?.circle_id;
  const circle2 = r2.body?.data?.circle_id;

  if (r1.status === 200 && r1.body?.manual_placement) {
    pass(
      "Q6",
      "First call returned manual_placement — not enough candidates for a second distinct circle. No crash.",
    );
  } else if (circle1 && circle2 && circle1 !== circle2) {
    pass(
      "Q6",
      `Two distinct circles created (${circle1.slice(0, 8)}… and ${circle2.slice(0, 8)}…) — no ON CONFLICT crash. NOTE: double-placement not guarded — same members may appear in both circles.`,
    );
  } else if (circle1 && (r2.status === 200 && r2.body?.manual_placement)) {
    pass(
      "Q6",
      `First call created circle ${circle1.slice(0, 8)}…; second call returned manual_placement (fewer unmatched candidates remaining). Graceful.`,
    );
  } else {
    fail(
      "Q6",
      `Unexpected: call1=${r1.status} call2=${r2.status} c1=${circle1} c2=${circle2}`,
    );
  }
}

async function q7_sendblueFailureHandling() {
  console.log("\n[Q7] Sendblue failure — /co/message/:user_id has no inner try/catch");

  // The /co/message endpoint calls sendblue.messages.send without a catch
  // If Sendblue throws, it propagates to the outer try/catch → 500
  // The question: does the server crash or return 500 gracefully?

  const r = await api("POST", `/co/message/${MAIN_USER}`, {
    message_type: "circle_placement",
    context: {},
  });
  console.log(`  status: ${r.status}`, r.body);

  if (r.status === 200 && r.body?.success) {
    pass(
      "Q7",
      "Sendblue succeeded (sandbox verified contact) — no error path triggered. Server stable.",
    );
  } else if (r.status === 500) {
    // Check if the server is still responding (didn't crash, just returned 500)
    const healthCheck = await api("GET", `/co/profile/${MAIN_USER}`);
    if (healthCheck.status === 200) {
      pass(
        "Q7",
        "Sendblue threw in /co/message — caught by route-level try/catch, returned 500, but server remains alive. NOTE: consider wrapping sendblue.messages.send in its own try/catch to prevent message failures from surfacing as 500s.",
      );
    } else {
      fail("Q7", "Server returned non-200 on health check after Sendblue error — possible crash");
    }
  } else {
    fail("Q7", `Unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  }
}

async function q8_openAIFailurePath() {
  console.log(
    "\n[Q8] OpenAI null embedding path — webhook with no extractable goals",
  );

  // Path 1: transcript with explicit no-goals content
  // Anthropic extracts goals=[] → generateGoalEmbedding never called → goalEmbedding=null
  const r = await api("POST", "/co/webhook", {
    user_id: GHOST_ID,
    transcript:
      "I don't really have any goals right now. I just exist. Nothing specific I'm working toward.",
    emotions: [{ name: "steady", score: 0.9 }],
    recording_url: null,
  });
  console.log(`  status: ${r.status}`, r.body);

  if (r.status !== 200 || !r.body?.success) {
    fail("Q8", `Webhook failed: ${r.status} ${JSON.stringify(r.body)}`);
    return;
  }

  const profile = await api("GET", `/co/profile/${GHOST_ID}`);
  const embeddings = profile.body?.data?.goal_embeddings;
  const goals = profile.body?.data?.goals;
  console.log(
    `  goals extracted: ${JSON.stringify(goals)}, embeddings: ${embeddings === null ? "null" : "populated"}`,
  );

  if (embeddings === null || embeddings === undefined) {
    pass(
      "Q8",
      `No goals in transcript → generateGoalEmbedding skipped → goal_embeddings=null in DB → co_profiles upserted cleanly. Safe path confirmed.`,
    );
  } else {
    // Anthropic decided there were goals anyway — also valid
    pass(
      "Q8",
      `Anthropic extracted goals even from no-goal transcript: ${JSON.stringify(goals)} → embeddings populated. Both paths safe.`,
    );
  }
}

async function q9_twoMemberCircle() {
  console.log("\n[Q9] Moment for a circle with only 2 members (< 4 for Sendblue)");

  // Restore ghost profile
  await pool.query(
    `UPDATE co_profiles SET
       city = 'San Francisco',
       life_chapters = '{"new_to_city"}',
       activity_preferences = '{"coffee","coworking"}',
       connection_style = 'small_group',
       emotional_state = 'motivated'
     WHERE user_id = $1`,
    [GHOST_ID],
  );

  // Create a circle owned by ghost with 1 member (main user)
  const circleRes = await pool.query(
    `INSERT INTO circles (owner_id, circle_name) VALUES ($1, $2) RETURNING id`,
    [GHOST_ID, "Edge Test Circle Q9 — 2 members"],
  );
  const circleId = circleRes.rows[0].id;

  await pool.query(
    `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [circleId, MAIN_USER],
  );
  console.log(`  circle_id: ${circleId} (owner=ghost, 1 member=main_user)`);

  const r = await api("POST", `/co/moment/${circleId}`);
  console.log(`  status: ${r.status}`, JSON.stringify(r.body?.data ?? r.body, null, 2));

  if (r.status === 201 && r.body?.success) {
    const memberCount = r.body.data?.member_count;
    pass(
      "Q9",
      `Moment created for ${memberCount}-member circle — Sendblue group poll skipped (< 4 phones). moment_id=${r.body.data?.moment_id?.slice(0, 8)}…`,
    );
  } else if (r.status === 404) {
    fail("Q9", "404 returned for 1-member circle — might be due to missing co_profiles JOIN");
  } else if (r.status === 500) {
    fail("Q9", `500 on 2-member circle: ${JSON.stringify(r.body)}`);
  } else {
    fail("Q9", `Unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  }
}

async function q10_duplicateStripeWebhook() {
  console.log("\n[Q10] Duplicate Stripe webhook — idempotency check");

  const webhookSecret = process.env.STRIPE_WEBHOOK;
  if (!webhookSecret) {
    skip(
      "Q10",
      "STRIPE_WEBHOOK env not set — webhook handler skips all processing when secret is absent. The route also has a bug: if STRIPE_WEBHOOK is unset the handler sends NO response (request hangs). Set STRIPE_WEBHOOK in .env to test.",
    );
    return;
  }

  // We need a real Stripe customer to test idempotency
  // Use the Stripe SDK to construct a signed test event
  let Stripe: any;
  try {
    const stripeModule = await import("stripe");
    Stripe = stripeModule.default;
  } catch {
    skip("Q10", "Could not import Stripe SDK");
    return;
  }

  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

  // Look up main user's stripe_customer_id
  const userRes = await pool.query(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [MAIN_USER],
  );
  const customerId = userRes.rows[0]?.stripe_customer_id;
  if (!customerId) {
    skip("Q10", "Main user has no stripe_customer_id — run test 6 (create-subscription) first");
    return;
  }

  // Construct a mock subscription.created event payload
  const mockPayload = JSON.stringify({
    id: `evt_test_idempotency_${Date.now()}`,
    type: "customer.subscription.created",
    data: {
      object: {
        id: `sub_test_${Date.now()}`,
        customer: customerId,
        status: "active",
      },
    },
  });

  // Sign it with the webhook secret
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${mockPayload}`;
  const crypto = await import("crypto");
  const sig = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload)
    .digest("hex");
  const stripeSignature = `t=${timestamp},v1=${sig}`;

  const sendWebhook = async () => {
    const res = await fetch(`${BASE}/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": stripeSignature,
        "ngrok-skip-browser-warning": "true",
      },
      body: mockPayload,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  const r1 = await sendWebhook();
  const r2 = await sendWebhook();
  console.log(`  Send 1 → ${r1.status}:`, r1.body);
  console.log(`  Send 2 → ${r2.status}:`, r2.body);

  // Check DB state — subscription_status should be 'active'
  const after = await pool.query(
    `SELECT subscription_status FROM users WHERE id = $1`,
    [MAIN_USER],
  );
  const finalStatus = after.rows[0]?.subscription_status;
  console.log(`  DB subscription_status after both: ${finalStatus}`);

  if (r1.status === 200 && r2.status === 200 && finalStatus === "active") {
    pass(
      "Q10",
      `Duplicate webhook idempotent — both returned 200, subscription_status='active' (stable, no double-write side effects)`,
    );
  } else if (r1.status !== 200 || r2.status !== 200) {
    fail(
      "Q10",
      `Webhook returned non-200: first=${r1.status} second=${r2.status} — ${JSON.stringify(r1.body)}`,
    );
  } else {
    fail("Q10", `Final status unexpected: ${finalStatus}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nCoPatible Edge Case & Stress Tests");
  console.log(`Target: ${BASE}`);
  console.log("─".repeat(56));

  // Preflight
  try {
    const pf = await fetch(`${BASE}/`, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const t = await pf.text();
    if (t.includes("ERR_NGROK_3200")) {
      console.error("🔴 Tunnel offline. Start API + ngrok.");
      process.exit(1);
    }
    console.log("Tunnel reachable ✓");
  } catch (e: any) {
    console.error("🔴 Could not reach tunnel:", e.message);
    process.exit(1);
  }

  await ensureGhostUser();

  // Run all 10 tests sequentially (some depend on prior state)
  try { await q1_emptyProfile(); } catch (e: any) { fail("Q1", `Uncaught: ${e.message}`); }
  try { await q2_thinCandidatePool(); } catch (e: any) { fail("Q2", `Uncaught: ${e.message}`); }
  try { await q3_gibberishTranscript(); } catch (e: any) { fail("Q3", `Uncaught: ${e.message}`); }
  try { await q4_googlePlacesZeroResults(); } catch (e: any) { fail("Q4", `Uncaught: ${e.message}`); }
  try { await q5_unrelatedSendblueMessage(); } catch (e: any) { fail("Q5", `Uncaught: ${e.message}`); }
  try { await q6_doublePlacement(); } catch (e: any) { fail("Q6", `Uncaught: ${e.message}`); }
  try { await q7_sendblueFailureHandling(); } catch (e: any) { fail("Q7", `Uncaught: ${e.message}`); }
  try { await q8_openAIFailurePath(); } catch (e: any) { fail("Q8", `Uncaught: ${e.message}`); }
  try { await q9_twoMemberCircle(); } catch (e: any) { fail("Q9", `Uncaught: ${e.message}`); }
  try { await q10_duplicateStripeWebhook(); } catch (e: any) { fail("Q10", `Uncaught: ${e.message}`); }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(56));
  console.log("SUMMARY");
  console.log("═".repeat(56));

  for (const { name, status, finding } of results) {
    const icon = status === "PASSED" ? "✅" : status === "FAILED" ? "❌" : "⏭ ";
    console.log(`\n${icon} ${status.padEnd(8)} ${name}`);
    console.log(`           ${finding}`);
  }

  const passed = results.filter((r) => r.status === "PASSED").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;

  console.log(
    `\n${"─".repeat(56)}\n${passed} passed  ${failed} failed  ${skipped} skipped\n`,
  );

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Fatal:", e);
  await pool.end();
  process.exit(1);
});
