import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import type { Server } from "socket.io";
import Stripe from "stripe";
import pool from "../db/db.js";

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

export function stripeRouter(
  io: Server,
  authenticateToken: RequestHandler,
): Router {
  const router = Router();

  //POST /payments/create-subscription — creates a Stripe customer + subscription for a user
  router.post(
    "/create-subscription",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user!.id!;

        const userInfo = await pool.query(`SELECT * FROM users WHERE id = $1`, [
          userId,
        ]);
        const user: UserProp = userInfo.rows[0];

        if (!user) return res.status(404).send("User not found.");

        // Create Stripe customer
        const customer = await stripeClient.customers.create({
          name: `${user.first_name} ${user.last_name}`,
          email: user.email,
          phone: user.phone_number,
          metadata: { user_id: userId },
        });

        // Store customer ID immediately
        await pool.query(
          `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
          [customer.id, userId],
        );

        // Create Checkout Session — returns a URL for the user to pay
        const session = await stripeClient.checkout.sessions.create({
          customer: customer.id,
          mode: "subscription",
          line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
          success_url: `${process.env.APP_SCHEME}://payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.APP_SCHEME}://payment-canceled`,
        });

        // Return the checkout URL — app opens this in Safari
        return res.status(200).json({
          checkoutUrl: session.url,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  //POST /payments/webhook — handles Stripe events (payment success, cancellation)
  // Body is kept raw (unparsed) by server.ts's app-level express.raw() applied
  // to this exact path before the global express.json() — required for Stripe
  // signature verification. Do NOT add another express.raw() here: body-parsers
  // consume the request stream once, so a second raw() on an already-consumed
  // stream hangs the request instead of parsing it.
  router.post(
    "/webhook",
    async (req: Request, res: Response, next: NextFunction) => {
      if (!process.env.STRIPE_WEBHOOK) {
        console.error("STRIPE_WEBHOOK is not configured — rejecting webhook.");
        return res.status(500).send("Webhook not configured.");
      }

      let event: Stripe.Event;
      try {
        event = stripeClient.webhooks.constructEvent(
          req.body,
          req.headers["stripe-signature"]!,
          process.env.STRIPE_WEBHOOK,
        );
      } catch (error) {
        console.error("Stripe webhook signature verification failed:", error);
        return res.status(400).send("Webhook signature verification failed.");
      }

      try {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId = subscription.customer;

        // 1. Fetch user from the database
        const userInfo = await pool.query(
          `SELECT * FROM users WHERE stripe_customer_id = $1`,
          [stripeCustomerId],
        );
        const user: UserProp = userInfo.rows[0];

        if (!user) {
          return res.status(404).send("User not found.");
        }

        switch (event.type) {
          case "customer.subscription.created":
            const subscriptionCreated = event.data.object;
            if (subscriptionCreated) {
              await pool.query(
                `UPDATE users SET subscription_status = 'active' WHERE id = $1`,
                [user.id],
              );
              // Notify app — subscription is live
              io.to(`user:${user.id}`).emit("subscription:active");
              return res.status(200).json({ message: "Subscription created." });
            }
            break;

          case "customer.subscription.deleted":
            const subscriptionDeleted = event.data.object;
            if (subscriptionDeleted) {
              await pool.query(
                `UPDATE users SET subscription_status = 'canceled' WHERE id = $1`,
                [user.id],
              );
              // Notify app — subscription canceled
              io.to(`user:${user.id}`).emit("subscription:canceled");
              return res
                .status(200)
                .json({ message: "Subscription canceled." });
            }
            break;

          case "customer.subscription.updated":
            const subscriptionUpdated = event.data
              .object as Stripe.Subscription;
            const status = subscriptionUpdated.status;
            if (status) {
              await pool.query(
                `UPDATE users SET subscription_status = $1 WHERE id = $2`,
                [status, user.id],
              );
              // Notify app — subscription status changed
              io.to(`user:${user.id}`).emit("subscription:updated", { status });
              return res.status(200).json({ message: "Subscription updated." });
            }
            break;
          default:
            console.log(`Unhandled event type ${event.type}`);
        }
        return res.status(200).json({ received: true });
      } catch (error) {
        next(error);
      }
    },
  );

  //GET /payments/status/:user_id — returns subscription status for a user
  router.get(
    "/status/:user_id",
    authenticateToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // 1. Extract the user_id from the URL path parameters
        const { user_id } = req.params;

        if (req.user?.id !== user_id) {
          return res
            .status(403)
            .send("Unauthorized: You can only access your own account");
        }

        // 2. Fetch the user from the database
        const userInfo = await pool.query(`SELECT * FROM users WHERE id = $1`, [
          user_id,
        ]);
        const user: UserProp = userInfo.rows[0];

        if (!user) {
          return res.status(404).send("User not found.");
        }

        // Validation check: ensure the user actually has a Stripe Customer ID
        if (!user.stripe_customer_id) {
          return res
            .status(400)
            .send("User does not have a linked Stripe customer.");
        }

        // 3. Fetch active subscriptions for this customer from Stripe
        const subscriptions = await stripeClient.subscriptions.list({
          customer: user.stripe_customer_id,
          status: "all", // Or 'active' depending on your specific needs
          limit: 1,
        });

        if (subscriptions.data.length === 0) {
          return res.status(200).json({
            message: "No subscription found for this user.",
            status: "none",
          });
        }

        const subscription = subscriptions.data[0];

        // 4. Return the subscription details
        return res.status(200).json({
          message: "Subscription status retrieved successfully.",
          subscriptionId: subscription.id,
          status: subscription.status, // e.g., 'active', 'past_due', 'canceled'
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
