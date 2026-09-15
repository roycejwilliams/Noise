import express, { Request, Response, NextFunction } from "express";
import { checkTextLogin, logoutTester, resetOwnData, startTextLogin, verifyTesterSession } from "../services/testerAuth.js";
import { COOKIE_NAME } from "../middleware/requireTesterLogin.js";

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

const PENDING_COOKIE = "co_test_login_pending";

// POST /api/login/start — a fresh sign-in code for the "Text Co" button.
router.post("/start", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, code, textInNumber } = await startTextLogin();
    res.cookie(PENDING_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: 15 * 60 * 1000 });
    return res.status(200).json({ success: true, code, text_in_number: textInNumber });
  } catch (error) {
    next(error);
  }
});

// GET /api/login/check — polled by the login page until the text arrives.
router.get("/check", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[PENDING_COOKIE];
    if (!token) return res.status(200).json({ success: true, status: "expired" });
    const result = await checkTextLogin(token);
    if (result.status === "signed_in") {
      res.clearCookie(PENDING_COOKIE);
      res.cookie(COOKIE_NAME, result.sessionToken, COOKIE_OPTIONS);
      return res.status(200).json({ success: true, status: "signed_in" });
    }
    return res.status(200).json({ success: true, status: result.status });
  } catch (error) {
    next(error);
  }
});

router.get("/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await verifyTesterSession(req.cookies?.[COOKIE_NAME]);
    return res.status(200).json({ success: true, loggedIn: !!session });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await verifyTesterSession(req.cookies?.[COOKIE_NAME]);
    if (session) await logoutTester(session.userId);
    res.clearCookie(COOKIE_NAME);
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Self-service "start over" — requires being logged in (only ever clears the
// caller's own row, see testerAuth.ts's resetOwnData), then logs them out
// since their row (and the session token pointing at it) no longer exists.
router.post("/reset", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await verifyTesterSession(req.cookies?.[COOKIE_NAME]);
    if (!session) return res.status(401).json({ success: false, error: "Not logged in." });
    const result = await resetOwnData(session.userId);
    res.clearCookie(COOKIE_NAME);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
