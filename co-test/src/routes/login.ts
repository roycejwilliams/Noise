import express, { Request, Response, NextFunction } from "express";
import { logoutTester, resetOwnData, startLogin, verifyLogin, verifyTesterSession } from "../services/testerAuth.js";
import { COOKIE_NAME } from "../middleware/requireTesterLogin.js";

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

router.post("/start", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_number } = req.body as { phone_number?: string };
    if (!phone_number) return res.status(400).json({ success: false, error: "phone_number is required." });
    const result = await startLogin(phone_number);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/verify", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_number, otp_code } = req.body as { phone_number?: string; otp_code?: string };
    if (!phone_number || !otp_code) {
      return res.status(400).json({ success: false, error: "phone_number and otp_code are required." });
    }
    const result = await verifyLogin(phone_number, otp_code);
    if (!result.success || !result.sessionToken) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.cookie(COOKIE_NAME, result.sessionToken, COOKIE_OPTIONS);
    return res.status(200).json({ success: true });
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
