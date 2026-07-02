import { randomInt } from "crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import pool from "../db/db.js";
import { authenticateToken, userRole } from "../middleware/auth.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import { normalizePhone } from "../utils/phone.js";

const router = express.Router();

function generateOTP() {
  return randomInt(100000, 1000000);
}

const otpMerge = (status: string) => {
  return async function (req: Request, res: Response, next: NextFunction) {
    if (!req.body) return res.status(400).send("Request body cannot be empty");

    if (status !== "accepted" && status !== "rejected") {
      return res
        .status(400)
        .send(
          "The server cannot process the request because the client sent invalid syntax or data ",
        );
    }

    try {
      const otp = generateOTP();
      if (!otp) return res.status(401).send("Unauthorized OTP.");

      const expiryAt = Date.now() + 300000;
      const expiryTimeStamp = new Date(expiryAt).toISOString();

      if (status === "accepted") {
        const accepted = await pool.query(
          `INSERT INTO users (application_id, first_name, last_name, email, phone_number, username, otp_code, otp_expiry)
        SELECT id, first_name, last_name, email, phone_number, split_part(email, '@', 1), $2, $3
        FROM applications
        WHERE id = $1
        RETURNING *;`,
          [req.params.id, otp, expiryTimeStamp],
        );

        const acceptedUser: UserProp = accepted.rows[0];

        await sendSMS({
          otp_code: otp.toString(),
          phone_number: acceptedUser.phone_number,
          status,
        });
        await sendEmail({
          otp_code: otp.toString(),
          email: acceptedUser.email,
          status,
        });

        return res.status(201).send({
          success: true,
          data: acceptedUser,
        });
      }

      if (status === "rejected") {
        const rejected = await pool.query(
          `UPDATE users SET status = 'pending' WHERE application_id = $1 RETURNING *`,
          [req.params.id],
        );

        const rejectedUser: UserProp | undefined = rejected.rows[0];

        if (rejectedUser) {
          await sendSMS({ phone_number: rejectedUser.phone_number, status });
          await sendEmail({ email: rejectedUser.email, status });
        } else {
          const app = await pool.query(
            `SELECT email, phone_number FROM applications WHERE id = $1`,
            [req.params.id],
          );
          if (app.rows[0]) {
            await sendSMS({ phone_number: app.rows[0].phone_number, status });
            await sendEmail({ email: app.rows[0].email, status });
          }
        }

        return res
          .status(200)
          .send({ success: true, message: "Application rejected" });
      }
    } catch (error) {
      next(error);
    }
  };
};

router.get(
  "/",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const applications = await pool.query("SELECT * FROM applications");
      return res
        .status(200)
        .send({ success: true, data: applications.rows });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/",
  async (req: Request<ApplicationProp>, res: Response, next: NextFunction) => {
    if (!req.body) {
      return res.status(400).send("Request body cannot be empty.");
    }

    const { first_name, last_name, email, phone_number, work_link, reason, referred_by } = req.body;

    if (!first_name || !last_name || !email || !phone_number) {
      const missing = ["first_name", "last_name", "email", "phone_number"].find(
        (field) => !req.body[field],
      );
      return res.status(400).send(`${missing} is required.`);
    }

    try {
      const insertApp = await pool.query(
        "INSERT INTO applications (first_name, last_name, email, phone_number, work_link, reason, referred_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        [first_name, last_name, email, normalizePhone(phone_number), work_link ?? null, reason ?? null, referred_by ?? null],
      );

      const createApp = insertApp.rows[0];

      await sendEmail({
        appsubmit: true,
        email: "roycewilliamsj@gmail.com",
        applicant: createApp,
      });

      return res.status(201).send({
        success: true,
        data: createApp,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  "/:id",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.body) {
      return res.status(400).send("Request body cannot be empty");
    }

    const { status } = req.body;

    if (status !== "accepted" && status !== "rejected")
      return res
        .status(400)
        .send(
          "The server cannot process the request because the client sent invalid syntax or data ",
        );

    try {
      const revealStatus = await pool.query(
        "UPDATE applications SET status = $2 WHERE id = $1 RETURNING *",
        [req.params.id, status],
      );

      const updateStatus: ApplicationProp = revealStatus.rows[0];

      if (updateStatus) {
        return otpMerge(updateStatus.status as string)(req, res, next);
      }

      return res.status(404).send({
        response: `User ${req.params.id} doesn't exist`,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
