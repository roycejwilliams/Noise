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
import { mapStripeSubscriptionStatus } from "./accountRules.js";

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WebhookUser = { id: string; stripe_customer_id: string | null };

// Returns the stored customer when it still exists in this Stripe account
// (not deleted, not from test mode on a live key), otherwise creates one and
// stores it. user_id goes in the customer's metadata so the webhook can find
// the user from the customer too.
async function getOrCreateCustomer(user: UserProp, userId: string): Promise<string> {
  if (user.stripe_customer_id) {
    try {
      const existing = await stripeClient.customers.retrieve(user.stripe_customer_id);
      if (!("deleted" in existing && existing.deleted)) return existing.id;
    } catch (err: any) {
      if (err?.code !== "resource_missing") throw err;
    }
  }
  const customer = await stripeClient.customers.create({
    name: `${user.first_name} ${user.last_name}`,
    email: user.email,
    phone: user.phone_number,
    metadata: { user_id: userId },
  });
  await pool.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [customer.id, userId]);
  return customer.id;
}

// Stored customer id first, then user_id from the subscription's metadata
// (set at checkout), then user_id from the customer's metadata (set when the
// customer was created).
async function findWebhookUser(
  subscription: Stripe.Subscription,
  stripeCustomerId: string | undefined,
): Promise<WebhookUser | null> {
  if (stripeCustomerId) {
    const { rows } = await pool.query(
      `SELECT id, stripe_customer_id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
      [stripeCustomerId],
    );
    if (rows[0]) return rows[0];
  }

  const byId = async (userId: unknown): Promise<WebhookUser | null> => {
    if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
    const { rows } = await pool.query(`SELECT id, stripe_customer_id FROM users WHERE id = $1`, [userId]);
    return rows[0] ?? null;
  };

  const fromSubscription = await byId(subscription.metadata?.user_id);
  if (fromSubscription) return fromSubscription;

  if (stripeCustomerId) {
    try {
      const customer = await stripeClient.customers.retrieve(stripeCustomerId);
      if (!("deleted" in customer && customer.deleted)) {
        return await byId(customer.metadata?.user_id);
      }
    } catch (err: any) {
      console.error(`Stripe webhook: couldn't read customer ${stripeCustomerId}:`, err?.message ?? err);
    }
  }
  return null;
}

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

        // Reuse the Stripe customer this user already has (2026-09-17). Every
        // call used to create a new customer and overwrite stripe_customer_id,
        // so someone who paid in an earlier checkout had a subscription on a
        // customer we no longer stored: its webhooks 404ed, Stripe retried
        // and eventually disabled the endpoint.
        const customerId = await getOrCreateCustomer(user, userId);

        // Create Checkout Session — returns a URL for the user to pay
        const session = await stripeClient.checkout.sessions.create({
          customer: customerId,
          mode: "subscription",
          client_reference_id: userId,
          // Lets the webhook find the user from the subscription itself, even
          // if stripe_customer_id ever points at a different customer.
          subscription_data: { metadata: { user_id: userId } },
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

      // Only subscription events carry a Stripe.Subscription. Anything else
      // is acknowledged without a user lookup (other event types used to be
      // looked up as if they were subscriptions and could 404).
      if (
        event.type !== "customer.subscription.created" &&
        event.type !== "customer.subscription.updated" &&
        event.type !== "customer.subscription.deleted"
      ) {
        console.log(`Unhandled event type ${event.type}`);
        return res.status(200).json({ received: true });
      }

      try {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeCustomerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id;

        const user = await findWebhookUser(subscription, stripeCustomerId);

        // Never 404 here (2026-09-17): Stripe treats repeated non-2xx replies
        // as a broken endpoint and disables it, which stops every other
        // user's webhooks too. An unknown customer is logged and acknowledged.
        if (!user) {
          console.error(
            `Stripe webhook ${event.id} (${event.type}): no user for customer ${stripeCustomerId ?? "none"} / subscription ${subscription.id}; acknowledged without changes.`,
          );
          return res.status(200).json({ received: true, matched: false });
        }

        // Stripe's own status mapped onto the four users.subscription_status
        // allows (2026-09-17). subscription.created used to write 'active'
        // for every new subscription, but Checkout subscriptions start
        // 'incomplete' until the first payment succeeds; subscription.updated
        // wrote the raw status, which broke the CHECK constraint and 500ed.
        const rawStatus = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;
        const mapped = mapStripeSubscriptionStatus(rawStatus);
        if (!mapped.known) {
          console.error(
            `Stripe webhook ${event.id}: unknown subscription status "${rawStatus}" for user ${user.id}; stored as inactive.`,
          );
        }
        const status = mapped.status;

        // When the paying customer isn't the one stored (an older checkout
        // created a second customer), point the user at the paying one so
        // /payments/status and later checkouts use it.
        if (status === "active" && stripeCustomerId && user.stripe_customer_id !== stripeCustomerId) {
          await pool.query(
            `UPDATE users SET subscription_status = $1, stripe_customer_id = $2 WHERE id = $3`,
            [status, stripeCustomerId, user.id],
          );
        } else {
          await pool.query(
            `UPDATE users SET subscription_status = $1 WHERE id = $2`,
            [status, user.id],
          );
        }

        switch (event.type) {
          case "customer.subscription.created":
            if (status === "active") io.to(`user:${user.id}`).emit("subscription:active");
            else io.to(`user:${user.id}`).emit("subscription:updated", { status });
            return res.status(200).json({ message: "Subscription created." });
          case "customer.subscription.deleted":
            io.to(`user:${user.id}`).emit("subscription:canceled");
            return res.status(200).json({ message: "Subscription canceled." });
          default:
            io.to(`user:${user.id}`).emit("subscription:updated", { status });
            return res.status(200).json({ message: "Subscription updated." });
        }
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
