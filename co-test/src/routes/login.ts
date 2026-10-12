import express, { Request, Response, NextFunction } from "express";
import { checkTextLogin, confirmTextLogin, logoutTester, resetOwnData, startTextLogin, verifyTesterSession } from "../services/testerAuth.js";
import { COOKIE_NAME } from "../middleware/requireTesterLogin.js";

const router = express.Router();

// Secure whenever the page was served over https (security review, 2026-10-12: it keyed on NODE_ENV, which co-test never sets).
// req.secure reads X-Forwarded-Proto behind Railway's proxy (server.ts sets trust proxy).
export function cookieOptions(req: Pick<Request, "secure">) {
  return {
    httpOnly: true,
    secure: req.secure || process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

const PENDING_COOKIE = "co_test_login_pending";

// POST /api/login/start {phone} — a fresh sign-in code for the "Text Co" button, good only from that phone.
router.post("/start", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const started = await startTextLogin((req.body as { phone?: unknown } | undefined)?.phone);
    if ("error" in started) return res.status(400).json({ success: false, error: started.error });
    const { token, code, textInNumber } = started;
    res.cookie(PENDING_COOKIE, token, { ...cookieOptions(req), maxAge: 15 * 60 * 1000 });
    return res.status(200).json({ success: true, code, text_in_number: textInNumber });
  } catch (error) {
    next(error);
  }
});

// GET /api/login/check — polled by the login page until the text arrives and Co has texted back the one-time code.
router.get("/check", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[PENDING_COOKIE];
    if (!token) return res.status(200).json({ success: true, status: "expired" });
    const result = await checkTextLogin(token);
    return res.status(200).json({ success: true, status: result.status });
  } catch (error) {
    next(error);
  }
});

// POST /api/login/confirm {code} — the code Co texted, typed into the browser that started the sign-in.
router.post("/confirm", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[PENDING_COOKIE];
    if (!token) return res.status(200).json({ success: true, status: "expired" });
    const result = await confirmTextLogin(token, (req.body as { code?: unknown } | undefined)?.code);
    if (result.status === "signed_in") {
      res.clearCookie(PENDING_COOKIE);
      res.cookie(COOKIE_NAME, result.sessionToken, cookieOptions(req));
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
