import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

// Gates the internal team dashboard (/checklist) and its supporting API
// routes (/api/checklist, /api/circles-test, /api/dynamic-test). Unlike the
// public tester-facing flow (phone/call pages, which real anonymous testers
// must be able to reach without any credential), these routes expose real
// testers' PII/psychographic profile data and can trigger a real SMS send or
// override real consent state — co-test's URL has no other access control,
// so this is the only thing standing between "team-only" and "public
// internet" for them.
export function requireInternalAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.CO_TEST_DASHBOARD_PASSWORD;
  if (!expected) {
    // Fail closed — an unset password must never mean "no auth required."
    console.error("CO_TEST_DASHBOARD_PASSWORD is not set — refusing internal-dashboard request.");
    return res.status(503).send("Dashboard auth is not configured.");
  }

  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");
    const password = separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
    if (password.length === expected.length) {
      try {
        if (timingSafeEqual(Buffer.from(password), Buffer.from(expected))) return next();
      } catch {
        // fall through to 401
      }
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="co-test dashboard"');
  return res.status(401).send("Authentication required.");
}
