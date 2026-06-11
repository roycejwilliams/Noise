import cookieParser from "cookie-parser";
import cors from "cors";
import "dotenv/config";
import express from "express";
import helmut from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import { runMigrations } from "./db/migrations.js";
import { registerJobs } from "./jobs/index.js";
import { authenticateToken } from "./middleware/auth.js";
import { corsOptions } from "./middleware/cors.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { applicationLimiter, authLimiter, limiter } from "./middleware/rateLimiter.js";
import applicationsRouter from "./routes/applications.js";
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
import { configureSocket } from "./socket/index.js";

const app = express();
app.set("trust proxy", 1);
const port = "8080";

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });

configureSocket(io);
runMigrations();

// Stripe webhook needs raw body for signature verification — must run before express.json()
app.use("/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());
app.use(helmut());
app.use(cors(corsOptions));
app.use(limiter);
app.use("/auth", authLimiter);
app.post("/applications", applicationLimiter);
app.use(cookieParser());

// Routes
app.use("/applications", applicationsRouter);
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

app.use(errorHandler);

registerJobs();

httpServer.listen(port, () => {
  console.log(`Listening on port: ${port}`);
});
