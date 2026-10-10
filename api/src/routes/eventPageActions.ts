// POST /e/:id/actions/{rsvp,reaction,comment,question,retract}: a member's structured actions on a Co event page
// (services/eventPages/actions.ts). Mounted at /e beside the content layer's GET /e/:id.
//
// Behind EVENT_PAGE_ACTIONS_ENABLED: off, every route here 404s. Members only: the member is read from the page's sealed token
// (the cookie set when they opened Co's link, scoped to this page's path), verified on every request; the page id and member id
// never come from the body, and nothing in the body can touch the page's content (only Co does, through applyInteractionUpdates).
// Answers JSON when the client asks for it (Accept: application/json), else a 303 back to the page's actions.
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { actionsEnabled, applyInteractionUpdates, realActionDeps, realUpdateDeps, takeAction, type ActionDeps, type ActionInput, type ActionResult, type UpdateDeps } from "../services/eventPages/actions.js";
import { memberOnRequest, pagePath, realIdentityDeps, type IdentityDeps } from "../services/eventPages/identity.js";

export type EventPageActionsDeps = { actions?: () => ActionDeps; updates?: () => UpdateDeps; identity?: IdentityDeps; env?: NodeJS.ProcessEnv };

const wantsJson = (req: Request) => /application\/json/i.test(String(req.get("accept") ?? "")) || req.is("application/json") === "application/json";

// A cross-site form post never acts (the cookie is SameSite=Lax too): when the browser says where it came from, it must be here.
function sameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin || origin === "null") return !origin;
  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

function inputFor(kind: string, body: any): ActionInput | null {
  const b = body && typeof body === "object" ? body : {};
  if (kind === "rsvp") return { kind, value: b.value };
  if (kind === "reaction") return { kind, value: b.value, on: b.on === undefined ? undefined : ["1", "true", "on", true, 1].includes(b.on) };
  if (kind === "comment" || kind === "question") return { kind, text: b.text };
  if (kind === "retract") return { kind, id: b.id };
  return null;
}

export function createEventPageActionsRouter(deps: EventPageActionsDeps = {}): Router {
  const router = express.Router();
  const identity = deps.identity ?? realIdentityDeps;

  // The flag: off, nothing under /e/:id/actions exists. Only that path: the page itself (GET /e/:id) is the content layer's.
  router.use("/:id/actions", (_req: Request, res: Response, next: NextFunction) => (actionsEnabled(deps.env) ? next() : res.status(404).send("Not found.")));
  router.use("/:id/actions", express.json({ limit: "16kb" }), express.urlencoded({ extended: false, limit: "16kb" }));

  router.post("/:id/actions/:kind", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const pageId = String(req.params.id ?? "");
    const json = wantsJson(req);
    const back = `${pagePath(pageId)}#actions`;
    const reply = (status: number, body: Record<string, unknown>) => (json ? res.status(status).json(body) : status < 400 ? res.redirect(303, back) : res.status(status).send(String(body.error ?? "Not found.")));

    const input = inputFor(String(req.params.kind ?? ""), req.body);
    if (!input || !pageId || pageId.length > 80) return reply(404, { ok: false, error: "Not found." });
    if (!sameOrigin(req)) return reply(403, { ok: false, error: "Not allowed." });
    const member = await memberOnRequest(req, null, pageId, identity).catch(() => null);
    // Not a member, or not this page's member: the page stays view-only.
    if (!member) return reply(401, { ok: false, error: "Members RSVP through the link Co texted them." });

    let r: ActionResult;
    try {
      r = await takeAction(pageId, member.userId, input, (deps.actions ?? realActionDeps)());
    } catch (err: any) {
      console.error("event page action failed:", err?.message ?? err);
      return reply(503, { ok: false, error: "That didn't save. Try again in a moment." });
    }
    if (!r.ok) return reply(r.status, { ok: false, error: r.error });
    // What the page derives from it (the headcount), for a script that wants to update in place. Never a write from here.
    const u = await applyInteractionUpdates(pageId, {}, (deps.updates ?? realUpdateDeps)()).catch(() => null);
    return reply(200, { ok: true, did: r.did, queued: r.queued ?? undefined, headcountLine: u && u.ok ? u.derived.headcountLine : null });
  });

  router.all("/:id/actions/*rest", (_req: Request, res: Response) => res.status(404).send("Not found."));
  return router;
}
