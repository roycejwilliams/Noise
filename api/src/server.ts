import cookieParser from "cookie-parser";
import cors from "cors";
import { randomInt } from "crypto";
import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import helmut from "helmet";
import { createServer } from "http";
import jwt from "jsonwebtoken";
import cron from "node-cron";
import { Server } from "socket.io";
import pool from "./db/db.js";
import { sendEmail, sendSMS } from "./otpActions.js";
import { createAiRouter } from "./routes/ai.js";
import { createAuthRouter } from "./routes/auth.js";
import { createCirclesRouter } from "./routes/circles.js";
import coRouter from "./routes/co.js";
import { createInvitesRouter } from "./routes/invites.js";
import { createMomentsRouter } from "./routes/moments.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createReferralsRouter } from "./routes/referrals.js";
import { sendblueRouter } from "./routes/sendblue.js";
import { stripeRouter } from "./routes/stripe.js";
import { createUsersRouter } from "./routes/users.js";

const app = express();
app.set("trust proxy", 1);
const port = "8080";

//wraps the express app in a native Node.js HTTP server
const httpServer = createServer(app);
//allows the connection to remain open for request
//creates a socket.io server that attachees to the http
//so both now run on the same port
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed =
        process.env.NODE_ENV === "production"
          ? origin === "https://br3w.app" ||
            /^https:\/\/brew-.*\.vercel\.app$/.test(origin)
          : origin === "http://localhost:3000";
      allowed
        ? callback(null, true)
        : callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  },
});

io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie ?? "";
  const token = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((c) => c.trim().split("=").map(decodeURIComponent)),
  )["token"];
  if (!token) return next(new Error("Unauthorized"));
  jwt.verify(
    token,
    process.env.JWT_SECRET_KEY!,
    (err: Error | null, user: any) => {
      if (err) return next(new Error("Invalid token"));
      (socket as any).user = user;
      next();
    },
  );
});

io.on("connection", (socket) => {
  const userId = (socket as any).user?.id as string;
  if (userId) socket.join(`user:${userId}`);

  socket.on("join:moment", (momentId: string) => {
    socket.join(`moment:${momentId}`);
  });

  socket.on("leave:moment", (momentId: string) => {
    socket.leave(`moment:${momentId}`);
  });
});

// Ensure notifications table exists (idempotent)
pool
  .query(
    `
  CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    moment_id UUID REFERENCES moments(id) ON DELETE CASCADE,
    moments_name TEXT,
    moment_image TEXT,
    friend_id UUID REFERENCES users(id) ON DELETE SET NULL,
    friend_first_name TEXT,
    friend_last_name TEXT,
    friend_username TEXT,
    friend_profile_image TEXT,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`,
  )
  .catch((err: Error) =>
    console.error("notifications table init failed:", err),
  );

//Used to control the rate of traffic sent or received by a network interface or service
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many requests, please try again in 15 minutes.",
  statusCode: 429,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many attempts, please try again in 15 minutes.",
  statusCode: 429,
});

// Applications — prevent spam submissions
const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
  statusCode: 429,
});

app.use(express.json());
//helps secure express apps by setting http response headers
app.use(helmut());
//CROSS ORIGIN RESOURCE SHARING
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed =
        process.env.NODE_ENV === "production"
          ? origin === "https://br3w.app" ||
            /^https:\/\/brew-.*\.vercel\.app$/.test(origin)
          : origin === "http://localhost:3000";
      allowed
        ? callback(null, true)
        : callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.use(limiter); // cover every route
app.use("/auth", authLimiter); // overrides global for auth
app.post("/applications", applicationLimiter); // only throttle new submissions, not admin reads/updates

//Will parse the cookie header upon request and exposes the
//cookies data property req.cookie
app.use(cookieParser());

// function to geneate a 6 digit verifcation code between 100000 to 999999
function generateOTP() {
  return randomInt(100000, 1000000);
}

declare global {
  namespace Express {
    interface Request {
      user?: UserProp; // Use a specific User type if you have one
    }
  }
}

//verify authenticatedToken
export const authenticateToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  //retrieve the value of a cookie named "token"
  const token = req.cookies.token;

  //if not the token the redirect back to home
  if (!token) return res.status(401).send("Unauthorized");

  //verifies the token
  jwt.verify(
    token,
    process.env.JWT_SECRET_KEY!,
    (err: Error | null, user: any) => {
      //token expired
      if (err) return res.status(403).send("Invalid or expired token");

      req.user = user as UserProp;
      //goes to the next function
      next();
    },
  );
};

// Defining user role
const userRole = (role: string) => {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      const userRole = req.user?.role;
      if (role !== userRole) {
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

// Get all applications (admin only)
app.get(
  "/applications",
  authenticateToken,
  userRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const applications = await pool.query("SELECT * FROM applications");
      const allApplications = applications.rows;
      return res.status(200).send({ success: true, data: allApplications });
    } catch (error) {
      next(error);
    }
  },
);

//create application
app.post(
  "/applications",
  async (req: Request<ApplicationProp>, res: Response, next: NextFunction) => {
    if (!req.body) {
      return res.status(400).send("Request body cannot be empty.");
    }

    const { first_name, last_name, email, work_link } = req.body;

    if (!first_name || !last_name || !email) {
      const missing = ["first_name", "last_name", "email"].find(
        (field) => !req.body[field],
      );

      return res.status(400).send(`${missing} is required.`);
    }

    try {
      const insertApp = await pool.query(
        "INSERT INTO applications (first_name, last_name, email, work_link) VALUES ($1, $2, $3, $4) RETURNING *",
        [first_name, last_name, email, work_link ?? null],
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

//OTP status merger
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

// Update application status by id (admin only)
app.put(
  "/applications/:id",
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

// Mount routers
app.use("/auth", createAuthRouter());
app.use("/users", createUsersRouter(authenticateToken));
app.use("/circles", createCirclesRouter(io, authenticateToken));
app.use(createMomentsRouter(io, authenticateToken));
app.use("/invites", createInvitesRouter(io, authenticateToken));
app.use("/notifications", createNotificationsRouter(authenticateToken));
app.use("/ai", createAiRouter(io, authenticateToken));
app.use("/referrals", createReferralsRouter(authenticateToken));
app.use("/co", coRouter);
app.use("/payments", stripeRouter(io, authenticateToken));
app.use("/sendblue", sendblueRouter(io));

//Node-cron is a lightweight task scheduler for Node.js applications
cron.schedule("*/15 * * * *", async () => {
  try {
    // 14-minute window centered around the 1-hour mark, strictly non-overlapping
    // with adjacent 15-minute ticks so each attendee gets exactly one reminder
    const windowStart = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 69 * 60 * 1000).toISOString();

    const upcoming = await pool.query(
      `SELECT m.id AS moment_id, m.moments_name, m.location_name, m.moment_start, ia.attendee_id
       FROM moments m
       JOIN invite_attendees ia ON m.id = ia.moment_id
       WHERE m.moment_start >= $1
       AND m.moment_start < $2
       AND ia.status = 'accepted'
       AND m.close_moment IS NOT TRUE`,
      [windowStart, windowEnd],
    );

    for (const row of upcoming.rows) {
      const attendee = await pool.query(
        `SELECT email, phone_number FROM users WHERE id = $1`,
        [row.attendee_id],
      );
      if (!attendee.rows[0]) continue;

      const time = new Date(row.moment_start).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      const momentUrl = `https://br3w.app/moments/${row.moment_id}`;

      await sendEmail({
        email: attendee.rows[0].email,
        moment_reminder: {
          moments_name: row.moments_name,
          location_name: row.location_name,
          time,
        },
        action_url: momentUrl,
      });
      await sendSMS({
        phone_number: attendee.rows[0].phone_number,
        moment_reminder: {
          moments_name: row.moments_name,
          location_name: row.location_name,
          time,
        },
        action_url: momentUrl,
      });
    }
  } catch (error) {
    console.error("Reminder cron error:", error);
  }
});

//Runs daily at 10 AM — pending invite nudges
cron.schedule("0 10 * * *", async () => {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    //Pending moment invites
    const pendingMoments = await pool.query(
      `SELECT ia.attendee_id, ia.moment_id, m.moments_name, m.moment_start
       FROM invite_attendees ia
       JOIN moments m ON ia.moment_id = m.id
       WHERE ia.status = 'pending'
       AND ia.created_at <= $1
       AND m.moment_start > NOW()`,
      [yesterday],
    );

    for (const row of pendingMoments.rows) {
      const attendee = await pool.query(
        `SELECT email, phone_number FROM users WHERE id = $1`,
        [row.attendee_id],
      );
      if (!attendee.rows[0]) continue;

      const time = new Date(row.moment_start).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      const momentUrl = `https://br3w.app/moments/${row.moment_id}`;

      await sendEmail({
        email: attendee.rows[0].email,
        moment_invite_reminder: { moments_name: row.moments_name, time },
        action_url: momentUrl,
      });
      await sendSMS({
        phone_number: attendee.rows[0].phone_number,
        moment_invite_reminder: { moments_name: row.moments_name, time },
        action_url: momentUrl,
      });
    }

    //Pending circle invites
    const pendingCircles = await pool.query(
      `SELECT im.member_id, im.circle_id, c.circle_name
       FROM invite_members im
       JOIN circles c ON im.circle_id = c.id
       WHERE im.status = 'pending'
       AND im.created_at <= $1`,
      [yesterday],
    );

    for (const row of pendingCircles.rows) {
      const member = await pool.query(
        `SELECT email, phone_number FROM users WHERE id = $1`,
        [row.member_id],
      );
      if (!member.rows[0]) continue;

      const circleUrl = `https://br3w.app/join?circle=${row.circle_id}`;

      await sendEmail({
        email: member.rows[0].email,
        circle_invite_reminder: { circle_name: row.circle_name },
        action_url: circleUrl,
      });
      await sendSMS({
        phone_number: member.rows[0].phone_number,
        circle_invite_reminder: { circle_name: row.circle_name },
        action_url: circleUrl,
      });
    }
  } catch (error) {
    console.error("Invite reminder cron error:", error);
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

httpServer.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
