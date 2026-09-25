// Mo's email opt-out link (src/mo/outreach.ts). Public, signed per
// prospect; a click puts them on the do-not-contact list for good.
import { Router } from "express";
import { unsubscribe } from "../mo/outreach.js";
import { handleInboundEmail } from "../mo/emailReplies.js";

export function createMoRouter(): Router {
  const router = Router();
  router.get("/unsubscribe", async (req, res) => {
    const ok = await unsubscribe(String(req.query.p ?? ""), String(req.query.t ?? "")).catch(() => false);
    res
      .status(ok ? 200 : 400)
      .type("html")
      .send(
        ok
          ? `<p style="font-family:system-ui;max-width:32rem;margin:4rem auto">Done. Co won't email you again.</p>`
          : `<p style="font-family:system-ui;max-width:32rem;margin:4rem auto">That link didn't work. Reply to the email with "stop" and we'll take care of it.</p>`,
      );
  });
  // Replies to Mo's outreach emails, posted by Resend (mo/emailReplies.ts).
  // The server hands this route the raw body so the signature can be checked.
  router.post("/email/inbound", async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
    // Resend signs with Svix, which sends either the svix-* headers or the
    // Standard Webhooks webhook-* ones (2026-09-25: first live posts were
    // refused; accept both).
    const h = (a: string, b: string) => req.header(a) ?? req.header(b) ?? undefined;
    const out = await handleInboundEmail(raw, {
      id: h("svix-id", "webhook-id"),
      timestamp: h("svix-timestamp", "webhook-timestamp"),
      signature: h("svix-signature", "webhook-signature"),
    }).catch((err: any) => {
      console.error("mo: inbound email failed:", err?.message ?? err);
      return { status: 200 as const, action: "error" };
    });
    if (out.status !== 200) {
      // Why a post was refused, and which signing headers it carried (names only).
      const signing = Object.keys(req.headers).filter((k) => /^(svix|webhook)-/.test(k));
      console.error(`mo: inbound email refused (${out.action}); body ${Buffer.isBuffer(req.body) ? "raw" : typeof req.body}, ${raw.length} bytes; signing headers: ${signing.join(", ") || "none"}`);
    }
    res.status(out.status).json({ ok: out.status === 200, action: out.action });
  });
  return router;
}
