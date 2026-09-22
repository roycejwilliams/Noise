// Mo's email opt-out link (src/mo/outreach.ts). Public, signed per
// prospect; a click puts them on the do-not-contact list for good.
import { Router } from "express";
import { unsubscribe } from "../mo/outreach.js";

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
  return router;
}
