import "dotenv/config";
import pool from "../db/db.js";

// Reusable test-guest simulation tool (Royce, 2026-09-05) — sends a real
// inbound message through the actual POST /sendblue/webhook route, exactly
// as Sendblue would when a real person texts in (this route has no
// signature validation on inbound, unlike the Luma webhook). The whole real
// pipeline runs for real: identity capture for a brand-new number,
// captureIntent, every classifier, and a real LLM-drafted reply — which
// gets REALLY sent to that phone number via Sendblue. This is not a dry
// run. Meant to be run repeatedly against a real second test guest (e.g. to
// exercise guest-list scoring / the end-of-night check-in against different
// stated asks) without needing a live human to type each message by hand.
//
// Usage: tsx src/scripts/simulateInboundText.ts <phone_e164> "<message text>"
async function main() {
  const [, , phone, ...rest] = process.argv;
  const message = rest.join(" ");
  if (!phone || !message) {
    console.error('Usage: tsx src/scripts/simulateInboundText.ts <phone_e164> "<message text>"');
    process.exit(1);
  }

  // Stamped BEFORE the webhook call — bug fix, 2026-09-05 (found live: a
  // stale "Co replied:" row from an earlier, unrelated turn was still
  // sitting in the last-5 window and got reported back as if it were this
  // call's reply). Only a reply row created strictly after this timestamp
  // can actually be a response to the message being sent here.
  const sentAt = new Date();

  const port = process.env.PORT ?? 3000;
  const res = await fetch(`http://localhost:${port}/sendblue/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ number: phone, content: message, is_outbound: false }),
  });
  console.log(`[simulateInboundText] webhook responded ${res.status}`);

  // Co's real reply is debounced ~8s (routes/sendblue.ts's DEBOUNCE_MS) plus
  // however long generation takes — poll co_memories rather than guessing a
  // fixed sleep.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { rows } = await pool.query(
      `SELECT cm.content, cm.created_at FROM co_memories cm
       JOIN users u ON u.id = cm.user_id
       WHERE u.phone_number = $1 AND cm.memory_type = 'text_exchange' AND cm.created_at > $2
       ORDER BY cm.created_at DESC LIMIT 5`,
      [phone, sentAt.toISOString()],
    );
    const reply = rows.find((r: any) => typeof r.content === "string" && r.content.startsWith("Co replied:"));
    if (reply) {
      console.log(`[simulateInboundText] Co's reply (${reply.created_at.toISOString()}):`, reply.content);
      await pool.end();
      return;
    }
  }
  console.log("[simulateInboundText] no reply observed within 60s (may be a silent/no-send turn — check logs)");
  await pool.end();
}

main().catch((err) => {
  console.error("[simulateInboundText] failed:", err);
  process.exit(1);
});
