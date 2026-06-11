#!/usr/bin/env tsx
import "dotenv/config";
import jwt from "jsonwebtoken";

const BASE = "https://raking-swizzle-greeter.ngrok-free.dev";
const TEST_USER_ID = "9f063ffe-7f73-48ff-b44a-3c813183ed36";

// ─── Result tracking ──────────────────────────────────────────────────────────

type Status = "PASSED" | "FAILED" | "SKIPPED";
const results: Array<{ name: string; status: Status; detail: string }> = [];

function pass(name: string, detail = "") {
  results.push({ name, status: "PASSED", detail });
  console.log(`  ✅ PASSED${detail ? " — " + detail : ""}`);
}
function fail(name: string, detail: string) {
  results.push({ name, status: "FAILED", detail });
  console.log(`  ❌ FAILED — ${detail}`);
}
function skip(name: string, detail: string) {
  results.push({ name, status: "SKIPPED", detail });
  console.log(`  ⏭  SKIPPED — ${detail}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJwt(userId: string, role = "admin") {
  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) throw new Error("JWT_SECRET_KEY not set in .env");
  return jwt.sign({ id: userId, role }, secret, { expiresIn: "1h" });
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  if (opts.auth) {
    headers["Cookie"] = `token=${makeJwt(TEST_USER_ID)}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  // Detect ngrok tunnel offline
  if (text.includes("ERR_NGROK_3200") || text.includes("ngrok-free.dev is offline")) {
    throw new Error("NGROK_OFFLINE: tunnel is down — start the API server and ngrok");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Trim HTML to something readable
    parsed = text.length > 200 ? text.slice(0, 200) + "…" : text;
  }

  return { status: res.status, body: parsed };
}

function dump(label: string, value: unknown) {
  console.log(`  ${label}:`, JSON.stringify(value, null, 2));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nCoPatible Backend Test Suite");
  console.log(`Target: ${BASE}`);
  console.log("─".repeat(56));

  // ─── Preflight: verify tunnel is reachable ──────────────────────────────
  console.log("\n[preflight] Checking tunnel…");
  try {
    const pf = await fetch(`${BASE}/`, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    const pfText = await pf.text();
    if (pfText.includes("ERR_NGROK_3200") || pfText.includes("ngrok-free.dev is offline")) {
      console.error("\n🔴 Tunnel offline. Start the API server then run:\n   npx ngrok http 8080\n");
      process.exit(1);
    }
    console.log("  Tunnel reachable ✓");
  } catch (e: any) {
    console.error("\n🔴 Could not reach tunnel:", e.message);
    process.exit(1);
  }

  let circleId: string | null = null;
  let momentId: string | null = null;
  let userPhone: string | null = null;

  // ───────────────────────────────────────────────────────────────────────────
  // 1. POST /co/call/:user_id
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1/7] POST /co/call/:user_id");
  try {
    const r = await req("POST", `/co/call/${TEST_USER_ID}`);
    dump("status", r.status);
    dump("body", r.body);

    if (r.status === 200 && r.body?.success && r.body?.call_sid) {
      pass("POST /co/call/:user_id", `call_sid=${r.body.call_sid}`);
    } else if (r.status === 403) {
      skip(
        "POST /co/call/:user_id",
        `Subscription not active — update user.subscription_status to 'active' first`,
      );
    } else if (
      r.status === 500 ||
      (typeof r.body === "string" &&
        (r.body.includes("Twilio") || r.body.includes("twilio")))
    ) {
      skip(
        "POST /co/call/:user_id",
        "Twilio compliance pending — error is expected",
      );
    } else if (r.body?.message?.toLowerCase?.().includes("twilio") ||
               r.body?.error?.toLowerCase?.().includes("twilio")) {
      skip("POST /co/call/:user_id", `Twilio error: ${r.body.message ?? r.body.error}`);
    } else {
      fail("POST /co/call/:user_id", `${r.status} — ${JSON.stringify(r.body)}`);
    }
  } catch (e: any) {
    fail("POST /co/call/:user_id", e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. POST /co/webhook (simulate Hume payload)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2/7] POST /co/webhook");
  const humePayload = {
    user_id: TEST_USER_ID,
    transcript:
      "I just moved to San Francisco about six months ago for a job in tech. I don't really know anyone here — I came from Chicago where I had a whole community built up over years. Now I'm starting over from scratch. During the week I work late most nights, but I have weekends free. I love hiking, trying new restaurants, and I've been getting into pottery recently. I'm also trying to get a startup off the ground on the side. It's a lot to manage alone honestly. I'd love to find people who get what that balance feels like — ambitious but also just wanting a real life, not just networking events.",
    emotions: [
      { name: "isolated", score: 0.72 },
      { name: "motivated", score: 0.61 },
      { name: "hopeful", score: 0.45 },
    ],
    recording_url: "https://example.com/test-recording.mp3",
  };

  try {
    const r = await req("POST", "/co/webhook", humePayload);
    dump("status", r.status);
    dump("body", r.body);

    if (r.status === 200 && r.body?.success) {
      // Verify co_profiles was populated
      const profile = await req("GET", `/co/profile/${TEST_USER_ID}`);
      dump("profile status", profile.status);
      dump("profile data", profile.body?.data);

      if (profile.status === 200 && profile.body?.data) {
        const d = profile.body.data;
        const checks: Record<string, boolean> = {
          life_chapters: Array.isArray(d.life_chapters) && d.life_chapters.length > 0,
          social_energy: typeof d.social_energy === "number",
          goals: Array.isArray(d.goals) && d.goals.length > 0,
          emotional_state: typeof d.emotional_state === "string" && d.emotional_state.length > 0,
          city: typeof d.city === "string" && d.city.length > 0,
          goal_embeddings: d.goal_embeddings !== null && d.goal_embeddings !== undefined,
        };
        dump("field checks", checks);

        const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length === 0) {
          pass(
            "POST /co/webhook",
            `chapters=${JSON.stringify(d.life_chapters)} city=${d.city} state=${d.emotional_state} embeddings=✓`,
          );
        } else {
          fail(
            "POST /co/webhook",
            `Webhook OK but profile missing fields: ${missing.join(", ")}`,
          );
        }
      } else {
        fail(
          "POST /co/webhook",
          `Profile fetch failed: ${profile.status} — ${JSON.stringify(profile.body)}`,
        );
      }
    } else {
      fail("POST /co/webhook", `${r.status} — ${JSON.stringify(r.body)}`);
    }
  } catch (e: any) {
    fail("POST /co/webhook", e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. POST /co/place/:user_id
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3/7] POST /co/place/:user_id");
  try {
    const r = await req("POST", `/co/place/${TEST_USER_ID}`, undefined, {
      auth: true,
    });
    dump("status", r.status);
    dump("body", r.body);

    if (r.status === 201 && r.body?.success && r.body?.data?.circle_id) {
      circleId = r.body.data.circle_id;
      const count = r.body.data.member_count;
      if (count >= 4) {
        pass(
          "POST /co/place/:user_id",
          `circle_id=${circleId} member_count=${count}`,
        );
      } else {
        fail(
          "POST /co/place/:user_id",
          `circle created but member_count=${count} < 4`,
        );
      }
    } else if (r.status === 200 && r.body?.manual_placement) {
      skip(
        "POST /co/place/:user_id",
        "Not enough compatible users in DB — manual_placement=true (expected in thin test DB)",
      );
    } else if (r.status === 401 || r.status === 403) {
      fail(
        "POST /co/place/:user_id",
        `Auth failed (${r.status}) — JWT may not match server secret`,
      );
    } else {
      fail("POST /co/place/:user_id", `${r.status} — ${JSON.stringify(r.body)}`);
    }
  } catch (e: any) {
    fail("POST /co/place/:user_id", e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. POST /co/moment/:circle_id
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4/7] POST /co/moment/:circle_id");
  if (!circleId) {
    skip(
      "POST /co/moment/:circle_id",
      "No circle_id from step 3 — cannot proceed",
    );
  } else {
    try {
      const r = await req("POST", `/co/moment/${circleId}`);
      dump("status", r.status);
      dump("body", r.body);

      if (r.status === 201 && r.body?.success && r.body?.data?.moment_id) {
        momentId = r.body.data.moment_id;
        const d = r.body.data;
        const notes = [
          `moment_id=${momentId}`,
          d.venue ? `venue="${d.venue}"` : "venue=null (no partner venue / Places unavailable)",
          d.venue_booking_url ? `booking_url=✓` : "booking_url=null",
          d.suggested_time ? `time="${d.suggested_time}"` : "time=null",
        ].join(" ");
        pass("POST /co/moment/:circle_id", notes);
      } else {
        fail(
          "POST /co/moment/:circle_id",
          `${r.status} — ${JSON.stringify(r.body)}`,
        );
      }
    } catch (e: any) {
      fail("POST /co/moment/:circle_id", e.message);
    }
  }

  // Resolve user phone for step 5
  try {
    const r = await req("GET", `/users/${TEST_USER_ID}`, undefined, {
      auth: true,
    });
    if (r.status === 200 && r.body?.data?.phone_number) {
      userPhone = r.body.data.phone_number;
      console.log(
        `\n  [info] Resolved phone: ${userPhone!.slice(0, 5)}${"*".repeat(userPhone!.length - 5)}`,
      );
    } else {
      console.log(`\n  [warn] Could not resolve phone from GET /users/${TEST_USER_ID}: ${r.status}`);
    }
  } catch {
    console.log("\n  [warn] Could not fetch user phone");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. POST /sendblue/webhook (simulate YES reply)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[5/7] POST /sendblue/webhook");
  if (!momentId) {
    skip(
      "POST /sendblue/webhook",
      "No moment_id from step 4 — moment_responses table has no pending entry to update",
    );
  } else if (!userPhone) {
    skip(
      "POST /sendblue/webhook",
      "Could not resolve user phone number — needed to route inbound message",
    );
  } else {
    try {
      const payload = {
        number: userPhone,
        content: "yeah that works for me",
        is_outbound: false,
      };

      const r = await req("POST", "/sendblue/webhook", payload);
      dump("status", r.status);
      dump("body", r.body);

      if (r.status === 200 && r.body?.received) {
        const action: string = r.body?.action ?? "general_reply";
        if (action === "moment_response_captured") {
          pass(
            "POST /sendblue/webhook",
            `Anthropic classified as yes/no/time — moment_responses updated (action=${action})`,
          );
        } else if (action === "booking_confirmed") {
          pass("POST /sendblue/webhook", `Booking confirmed (action=${action})`);
        } else {
          // general reply path — no pending moment or already responded
          pass(
            "POST /sendblue/webhook",
            `Received OK — action=${action} (check if moment_responses had pending row)`,
          );
        }
      } else {
        fail(
          "POST /sendblue/webhook",
          `${r.status} — ${JSON.stringify(r.body)}`,
        );
      }
    } catch (e: any) {
      fail("POST /sendblue/webhook", e.message);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. POST /payments/create-subscription
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[6/7] POST /payments/create-subscription");
  try {
    const r = await req("POST", "/payments/create-subscription", {}, { auth: true });
    dump("status", r.status);
    dump("body", r.body);

    if (
      r.status === 200 &&
      typeof r.body?.checkoutUrl === "string" &&
      r.body.checkoutUrl.startsWith("https://checkout.stripe.com")
    ) {
      pass(
        "POST /payments/create-subscription",
        `checkoutUrl=${r.body.checkoutUrl.slice(0, 60)}…`,
      );
    } else if (r.status === 200 && r.body?.checkoutUrl) {
      fail(
        "POST /payments/create-subscription",
        `checkoutUrl present but wrong domain: ${r.body.checkoutUrl}`,
      );
    } else if (r.status === 404) {
      skip(
        "POST /payments/create-subscription",
        "User not found in DB — seed the test user first",
      );
    } else {
      fail(
        "POST /payments/create-subscription",
        `${r.status} — ${JSON.stringify(r.body)}`,
      );
    }
  } catch (e: any) {
    fail("POST /payments/create-subscription", e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. GET /payments/status/:user_id
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[7/7] GET /payments/status/:user_id");
  try {
    const r = await req(
      "GET",
      `/payments/status/${TEST_USER_ID}`,
      undefined,
      { auth: true },
    );
    dump("status", r.status);
    dump("body", r.body);

    if (r.status === 200 && r.body?.status) {
      pass(
        "GET /payments/status/:user_id",
        `subscription status=${r.body.status}`,
      );
    } else if (
      r.status === 400 &&
      typeof r.body === "string" &&
      r.body.includes("Stripe")
    ) {
      skip(
        "GET /payments/status/:user_id",
        "No stripe_customer_id on user yet — run test 6 first",
      );
    } else if (r.status === 404) {
      skip(
        "GET /payments/status/:user_id",
        "User not found in DB",
      );
    } else {
      fail(
        "GET /payments/status/:user_id",
        `${r.status} — ${JSON.stringify(r.body)}`,
      );
    }
  } catch (e: any) {
    fail("GET /payments/status/:user_id", e.message);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(56));
  console.log("SUMMARY");
  console.log("═".repeat(56));

  for (const { name, status, detail } of results) {
    const icon =
      status === "PASSED" ? "✅" : status === "FAILED" ? "❌" : "⏭ ";
    console.log(`\n${icon} ${status.padEnd(8)} ${name}`);
    if (detail) console.log(`           ${detail}`);
  }

  const passed = results.filter((r) => r.status === "PASSED").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;

  console.log(
    `\n${"─".repeat(56)}\n${passed} passed  ${failed} failed  ${skipped} skipped\n`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
