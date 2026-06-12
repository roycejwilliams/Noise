import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

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
  const token = req.cookies.token;

  if (!token) return res.status(401).send("Unauthorized");

  jwt.verify(
    token,
    process.env.JWT_SECRET_KEY!,
    (err: Error | null, user: any) => {
      if (err) return res.status(403).send("Invalid or expired token");

      req.user = user as UserProp;
      next();
    },
  );
};
