import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import pool from "../db/db.js";
import { tokenVersionValid } from "../routes/accountRules.js";

export const userRole = (role: string) => {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      const currentRole = req.user?.role;
      if (role !== currentRole) {
        return res
          .status(403)
          .send({ message: "Forbidden. Does not have correct role." });
      }
      return next();
    } catch (error) {
      next(error);
    }
  };
};

export const authenticateToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const token = bearer ?? req.cookies.token;

  if (!token) return res.status(401).send("Unauthorized");

  jwt.verify(
    token,
    process.env.JWT_SECRET_KEY!,
    async (err: Error | null, user: any) => {
      if (err) return res.status(403).send("Invalid or expired token");

      // Revocation check (2026-09-17) — a token used to be trusted for its
      // full year of life with no way to invalidate one already issued.
      // /auth/logout and an OTP lock both bump users.token_version; a token
      // signed with an older version number is refused here even though its
      // signature and expiry are still fine. A token minted before the `tv`
      // claim existed carries no tv at all and is treated as version 0,
      // matching the column's default, so nobody already signed in gets
      // logged out by this shipping.
      try {
        const { rows } = await pool.query(
          `SELECT token_version FROM users WHERE id = $1`,
          [user?.id],
        );
        if (!rows[0] || !tokenVersionValid(user?.tv, rows[0].token_version)) {
          return res.status(403).send("Invalid or expired token");
        }
      } catch (dbErr) {
        return next(dbErr);
      }

      req.user = user as UserProp;
      next();
    },
  );
};
