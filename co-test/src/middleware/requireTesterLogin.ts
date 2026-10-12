import type { NextFunction, Request, Response } from "express";
import { verifyTesterSession } from "../services/testerAuth.js";

const COOKIE_NAME = "co_test_session";

export { COOKIE_NAME };

// Gates the actual testing tool (call/phone pages and their APIs) behind a
// real, phone-verified login — see services/testerAuth.ts. This is a tool-
// access gate, not a re-implementation of phone.ts's own OTP step (which
// tests production's real text-in-first onboarding and is unaffected by
// this — a logged-in tester still goes through that flow unmodified once
// they're in).
export async function requireTesterLoginPage(req: Request, res: Response, next: NextFunction) {
  const session = await verifyTesterSession(req.cookies?.[COOKIE_NAME]);
  if (!session) return res.redirect("/");
  (req as any).testerId = session.userId;
  next();
}

export async function requireTesterLoginApi(req: Request, res: Response, next: NextFunction) {
  const session = await verifyTesterSession(req.cookies?.[COOKIE_NAME]);
  if (!session) return res.status(401).json({ success: false, error: "Not logged in." });
  (req as any).testerId = session.userId;
  next();
}

// Whose data a signed-in tester may reach (security review, 2026-10-11). Any member can sign in here by texting the login code,
// so a user id in the URL or body is never trusted on its own: it must be the tester's own, or the tester is on the team
// (users.mo_approver, api/src/services/extensions.ts isTeamMember). Anything else answers 404, the same as an id that doesn't exist,
// so the route never confirms another member's id.
export async function mayReach(testerId: string, targetId: string | undefined, isTeam: (id: string) => Promise<boolean> = defaultIsTeam): Promise<boolean> {
  if (!targetId) return false;
  if (targetId === testerId) return true;
  return isTeam(testerId).catch(() => false);
}
const defaultIsTeam = async (id: string) => (await import("../../../api/src/services/extensions.js")).isTeamMember(id);

// For routes whose target is a URL param (/api/phone/:user_id/..., /api/session/:sessionId/...).
export function requireOwnOrTeam(param: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const target = req.params[param];
    if (typeof target === "string" && (await mayReach((req as any).testerId, target))) return next();
    return res.status(404).json({ success: false, error: "Session not found." });
  };
}

// Whether the signed-in tester is on the team; false on any error.
export const isTeamFor = (testerId: string | undefined): Promise<boolean> => (testerId ? defaultIsTeam(testerId).catch(() => false) : Promise.resolve(false));

// Team-only routes (shared tooling, not one member's own data).
export async function requireTeam(req: Request, res: Response, next: NextFunction) {
  if (await defaultIsTeam((req as any).testerId).catch(() => false)) return next();
  return res.status(404).json({ success: false, error: "Not found." });
}
