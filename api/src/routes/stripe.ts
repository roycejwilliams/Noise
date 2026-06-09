import express, { NextFunction, Request, Response } from "express";
import Stripe from "stripe";
import pool from "../db/db.js";

//POST /payments/create-subscription — creates a Stripe customer + subscription for a user
//POST /payments/webhook — handles Stripe events (payment success, cancellation)
//GET /payments/status/:user_id — returns subscription status for a user

const router = express.Router();
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

router.post(
  "/create-subscription",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.body;

      // 1. Fetch user from the database
      const userInfo = await pool.query(`SELECT * FROM users WHERE id = $1`, [
        userId,
      ]);
      const user: UserProp = userInfo.rows[0];

      if (!user) {
        return res.status(404).send("User not found.");
      }

      // 2. Create Stripe customer (clean up template literals)
      const customer = await stripeClient.customers.create({
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        phone: user.phone_number,
      });

      if (customer) {
        // 3. Create Stripe subscription
        const subscription = await stripeClient.subscriptions.create({
          customer: customer.id,
          payment_behavior: "error_if_incomplete",
          items: [{ price: process.env.STRIPE_PRICE_ID }],
        });

        // 4. Update database (fixed missing quotes around 'active')
        await pool.query(
          `UPDATE users SET stripe_customer_id = $1, subscription_status = 'active' WHERE id = $2`,
          [customer.id, userId],
        );

        // 5. Complete the request-response cycle
        return res.status(200).json({
          message: "Subscription created successfully.",
          subscriptionId: subscription.id,
        });
      }
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/status/:user_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Extract the user_id from the URL path parameters
      const { user_id } = req.params;

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
