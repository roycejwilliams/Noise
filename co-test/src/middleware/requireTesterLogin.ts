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
