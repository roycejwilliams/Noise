import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import express, { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import pool from "../db/db.js";
import { sendEmail, sendSMS } from "../otpActions.js";
import { authenticateToken } from "../middleware/auth.js";
import { generateGoalEmbedding } from "../services/embeddings.js";
import { findBestCircle } from "../services/matching.js";
import { findBestVenue } from "../services/places.js";
import sendblue from "../services/sendblue.js";

const router = express.Router();

const twilioClient = twilio(
  process.env.TWILIO_TEST_SID!,
  process.env.TWILIO_TEST_AUTH_TOKEN!,
);

// POST /co/call/:user_id — initiate outbound call to user
router.post(
  "/call/:user_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;

      const userResult = await pool.query(
        `SELECT phone_number, subscription_status FROM users WHERE id = $1`,
        [user_id],
      );

      const user = userResult.rows[0];

      if (!user) return res.status(404).send("User not found.");

      if (user.subscription_status !== "active") {
        return res
          .status(403)
          .send("User does not have an active subscription.");
      }

      //api call for hume and twilio connector
      const webhookUrl = `https://api.hume.ai/v0/evi/twilio?config_id=${process.env.HUME_CONFIG_ID}&api_key=${process.env.HUME_API_KEY}`;

      const call = await twilioClient.calls.create({
        to: user.phone_number,
        from: process.env.TWILIO_PHONE_NUMBER!,
        url: webhookUrl,
      });

      return res.status(200).send({
        success: true,
        call_sid: call.sid,
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/webhook — Hume sends call transcript + emotions after call ends
router.post(
  "/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id, transcript, emotions, recording_url } = req.body;

      if (!user_id || !transcript) {
        return res.status(400).send("Missing required fields.");
      }

      // Step 1 — Store raw transcript in co_memories immediately
      await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content, emotional_context, audio_url)
         VALUES ($1, 'call_transcript', $2, $3, $4)`,
        [user_id, transcript, JSON.stringify(emotions), recording_url ?? null],
      );

      // Step 2 — Extract psychographic data from transcript using Anthropic
      // This is what populates co_profiles so the matching algorithm has data to work with
      const { text: rawExtraction } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt: `You are extracting psychographic profile data from a conversation transcript.
        
        Based on this transcript, extract the following fields and return ONLY valid JSON with no preamble or markdown:

        {
          "life_chapters": [], // array of applicable values from: new_to_city, building_solo, career_pivot, starting_over
          "social_energy": 0, // number 0-100 (0 = very introverted/quiet preference, 100 = very extroverted/high energy)
          "connection_style": "", // one of: small_group, medium_group, large_social
          "activity_preferences": [], // array of activities they mentioned or implied enjoying
          "goals": [], // array of things they are working toward
          "blockers": [], // array of challenges or struggles they mentioned
          "availability_pattern": "", // how often and when they want to connect (e.g. "weekday evenings", "weekends")
          "city": "", // city they are in or moving to
          "emotional_state": "" // one word describing their current emotional state (e.g. anxious, energized, overwhelmed, motivated, isolated, confident, focused, excited, lost, burnout)
        }

        Transcript:
        "${transcript}"`,
      });

      // Step 3 — Parse extracted data
      let extracted: any = {};
      try {
        const clean = rawExtraction.replace(/```json|```/g, "").trim();
        extracted = JSON.parse(clean);
      } catch {
        console.error(
          "Failed to parse psychographic extraction:",
          rawExtraction,
        );
      }

      // Sanitize against DB CHECK constraints before upsert
      const ALLOWED_CHAPTERS = ["new_to_city", "building_solo", "career_pivot", "starting_over"];
      const ALLOWED_STYLES = ["small_group", "medium_group", "large_social"];
      const safeChapters = (extracted.life_chapters ?? []).filter((c: string) => ALLOWED_CHAPTERS.includes(c));
      const safeStyle = ALLOWED_STYLES.includes(extracted.connection_style) ? extracted.connection_style : "small_group";

      // Step 4 — Generate goal embeddings via OpenAI
      let goalEmbedding: number[] | null = null;
      if (extracted.goals && extracted.goals.length > 0) {
        goalEmbedding = await generateGoalEmbedding(extracted.goals);
      }

      // Step 5 — Update co_profiles with extracted psychographic data
      // Use UPSERT — create profile if it doesn't exist, update if it does
      await pool.query(
        `INSERT INTO co_profiles (
          user_id, life_chapters, social_energy, connection_style,
          activity_preferences, emotional_state, goals, blockers,
          availability_pattern, city, goal_embeddings, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          life_chapters = EXCLUDED.life_chapters,
          social_energy = EXCLUDED.social_energy,
          connection_style = EXCLUDED.connection_style,
          activity_preferences = EXCLUDED.activity_preferences,
          emotional_state = EXCLUDED.emotional_state,
          goals = EXCLUDED.goals,
          blockers = EXCLUDED.blockers,
          availability_pattern = EXCLUDED.availability_pattern,
          city = EXCLUDED.city,
          goal_embeddings = EXCLUDED.goal_embeddings,
          updated_at = NOW()`,
        [
          user_id,
          safeChapters,
          extracted.social_energy ?? 50,
          safeStyle,
          extracted.activity_preferences ?? [],
          extracted.emotional_state ?? emotions?.[0]?.name ?? null,
          extracted.goals ?? [],
          extracted.blockers ?? [],
          extracted.availability_pattern ?? null,
          extracted.city ?? null,
          goalEmbedding ? `[${goalEmbedding.join(",")}]` : null,
        ],
      );

      return res.status(200).send({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

// GET /co/profile/:user_id
router.get(
  "/profile/:user_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT * FROM co_profiles WHERE user_id = $1`,
        [req.params.user_id],
      );

      if (!result.rows[0]) return res.status(404).send("Profile not found.");

      return res.status(200).send({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

// PUT /co/profile/:user_id
router.put(
  "/profile/:user_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allowed = [
        "life_chapters",
        "social_energy",
        "connection_style",
        "activity_preferences",
        "emotional_state",
        "goals",
        "blockers",
        "availability_pattern",
        "city",
        "trust_score",
        "trust_components",
      ];

      const filteredKeys = Object.keys(req.body).filter((key) =>
        allowed.includes(key),
      );

      const values = filteredKeys.map((key) => req.body[key]);

      const setClause = filteredKeys
        .map((key, index) => `${key} = $${index + 2}`)
        .join(", ");

      const result = await pool.query(
        `UPDATE co_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $1 RETURNING *`,
        [req.params.user_id, ...values],
      );

      if (!result.rows[0]) return res.status(404).send("Profile not found.");

      return res.status(200).send({ success: true, data: result.rows[0] });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/place — runs matching algorithm, creates Circle autonomously, notifies members
// This is the core of CoPatible — Co decides who belongs together
router.post(
  "/place/:user_id",
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user_id = req.params.user_id as string;

      // Pre-flight — skip placement if user is already in an active circle
      const existingMembership = await pool.query(
        `SELECT circle_id FROM circle_members WHERE member_id = $1 LIMIT 1`,
        [user_id],
      );
      if (existingMembership.rows[0]) {
        return res.status(200).send({
          success: false,
          message: "User is already in an active circle.",
        });
      }

      // Step 1 — Run matching algorithm
      // Returns array of user IDs or null if no valid group found
      const groupUserIds = await findBestCircle(user_id);

      // Step 2 — No match found — flag for manual placement by Keana
      if (!groupUserIds || groupUserIds.length < 4) {
        return res.status(200).send({
          success: false,
          manual_placement: true,
          message: "No qualifying circle found. Flagged for manual placement.",
        });
      }

      // Step 3 — Create a Circle autonomously using existing Circles API
      // Co names the circle based on the shared life chapter
      const userProfile = await pool.query(
        `SELECT life_chapters, city FROM co_profiles WHERE user_id = $1`,
        [user_id],
      );
      const profile = userProfile.rows[0];
      const primaryChapter = profile.life_chapters[0] ?? "new_to_city";
      const circleName = `Co Circle — ${primaryChapter.replace(/_/g, " ")}`;

      const circleResult = await pool.query(
        `INSERT INTO circles (owner_id, circle_name) VALUES ($1, $2) RETURNING *`,
        [user_id, circleName],
      );
      const circle = circleResult.rows[0];

      // Step 4 — Add all matched members to the circle
      for (const memberId of groupUserIds) {
        if (memberId === user_id) continue; // skip the owner
        await pool.query(
          `INSERT INTO circle_members (circle_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [circle.id, memberId],
        );
      }

      // Step 4.5 — Assign Circle Connector before notifications fire
      const existingConnector = await pool.query(
        `SELECT user_id FROM co_profiles
         WHERE user_id = ANY($1::uuid[]) AND is_circle_connector = TRUE
         LIMIT 1`,
        [groupUserIds],
      );

      if (!existingConnector.rows[0]) {
        const topTrust = await pool.query(
          `SELECT user_id FROM co_profiles
           WHERE user_id = ANY($1::uuid[])
           ORDER BY trust_score DESC
           LIMIT 1`,
          [groupUserIds],
        );

        if (topTrust.rows[0]) {
          const connectorId = topTrust.rows[0].user_id;
          await pool.query(
            `UPDATE co_profiles SET is_circle_connector = TRUE WHERE user_id = $1`,
            [connectorId],
          );
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'check_in', $2)`,
            [
              connectorId,
              `Co selected you as Circle Connector for circle ${circle.id}`,
            ],
          );
        }
      }

      // Step 5 — Notify all members via existing notification system
      for (const memberId of groupUserIds) {
        const memberResult = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [memberId],
        );
        const member = memberResult.rows[0];
        if (!member) continue;

        await sendEmail({
          email: member.email,
          invite_type: "received",
          invite_target: "circle",
          action_url: `https://copatible.app/circles/${circle.id}`,
        });

        await sendSMS({
          phone_number: member.phone_number,
          invite_type: "received",
          invite_target: "circle",
          action_url: `https://copatible.app/circles/${circle.id}`,
        });
      }

      // Step 6 — Store placement as a co_memory for each member
      for (const memberId of groupUserIds) {
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'check_in', $2)`,
          [
            memberId,
            `Co placed you in a circle: ${circleName}. Members: ${groupUserIds.length} people.`,
          ],
        );
      }

      return res.status(201).send({
        success: true,
        data: {
          circle_id: circle.id,
          circle_name: circleName,
          members: groupUserIds,
          member_count: groupUserIds.length,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /co/moment/:circle_id — Co creates a Moment for a placed circleß
// Uses member activity preferences to suggest the best experience
router.post(
  "/moment/:circle_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circle_id } = req.params;

      // Step 1 — Fetch all members of the associated circle
      const membersResult = await pool.query(
        `SELECT cm.member_id, cp.activity_preferences, cp.connection_style, cp.life_chapters, cp.city
         FROM circle_members cm
         JOIN co_profiles cp ON cp.user_id = cm.member_id
         WHERE cm.circle_id = $1`,
        [circle_id],
      );

      const members = membersResult.rows;
      if (!members.length) return res.status(404).send("Circle not found.");

      // Step 2 — Get the circle owner
      const circleResult = await pool.query(
        `SELECT owner_id FROM circles WHERE id = $1`,
        [circle_id],
      );
      const circle = circleResult.rows[0];
      if (!circle) return res.status(404).send("Circle not found.");

      // Step 3 — Find most common activity preferences across the group
      //combines the array of all members activity preferences
      const allActivities = members.flatMap((m) => m.activity_preferences);
      //acc holds the record pair
      const activityCount = allActivities.reduce(
        (acc: Record<string, number>, activity: string) => {
          acc[activity] = (acc[activity] || 0) + 1;
          return acc;
        },
        // starts with a empty object
        {},
      );

      ///Converts the object into an array of [key, value] pairs:
      const topActivities = Object.entries(activityCount)
        //If b is bigger than a → positive → b goes first → highest numbers first
        //If a is bigger than b → negative → a goes first
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 3)
        //Because the word activity is placed before the comma, JavaScript automatically assigns whatever is at index 0 to that variable.
        .map(([activity]) => activity);

      // Step 4 — Get dominant connection style
      const connectionStyles = members.map((m) => m.connection_style);
      //After checking all items, the array is rearranged so the most frequent styles are first:
      const dominantStyle =
        connectionStyles.sort(
          (a: string, b: string) =>
            connectionStyles.filter((s: string) => s === b).length -
            connectionStyles.filter((s: string) => s === a).length,
        )[0] || "small_group";

      // Step 5 — Get shared life chapters
      const allChapters = members.flatMap((m) => m.life_chapters);
      const uniqueChapters = [...new Set(allChapters)];

      // Step 6 — Use Anthropic to generate Moment context
      const city = members[0].city ?? "San Francisco";
      const groupSize = members.length + 1;

      const { text: rawMoment } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt: `You are Co, a life concierge creating a curated real-world experience for a small circle of people.

Circle details:
- Group size: ${groupSize} people
- City: ${city}
- Shared activities they enjoy: ${topActivities.join(", ")}
- Life chapters they are navigating: ${uniqueChapters.join(", ")}
- Connection style: ${dominantStyle}

Create a specific, curated Moment for this group. Return ONLY valid JSON with no preamble:

{
  "moments_name": "short evocative name for the experience",
  "description": "1-2 sentences MAX. Keep under 300 characters.",
  "venue_type": "one of: dinner | coworking | outdoor | social | experience",
  "neighborhood": "specific ${city} neighborhood that fits the vibe",
  "vibe": "3-4 words describing the atmosphere",
  "suggested_time": "day and time suggestion (e.g. Thursday 7pm)",
  "vibes": ["vibe1", "vibe2", "vibe3"]
}

Make it feel intimate, specific, and intentional. Not generic.`,
      });

      // Step 7 — Parse Anthropic response
      let momentData: any = {};
      try {
        const clean = rawMoment.replace(/```json|```/g, "").trim();
        momentData = JSON.parse(clean);
      } catch {
        console.error("Failed to parse moment data:", rawMoment);
        return res.status(500).send("Failed to generate moment.");
      }

      // Truncate description as safety measure
      momentData.description = momentData.description?.slice(0, 390) ?? "";

      // Step 7.5 — Find best venue
      // Priority: partner venues first, then Google Places
      let selectedVenue: any = null;

      const partnerVenue = await pool.query(
        `SELECT * FROM co_venues 
         WHERE city = $1 
         AND type = $2
         AND active = TRUE
         AND (capacity_max IS NULL OR capacity_max >= $3)
         ORDER BY RANDOM()
         LIMIT 1`,
        [city, momentData.venue_type, groupSize],
      );

      if (partnerVenue.rows[0]) {
        // Use CoPatible partner venue
        const contact: string = partnerVenue.rows[0].contact ?? "";
        const partnerBookingUrl = contact.startsWith("http")
          ? contact
          : `https://resy.com/cities/sf?query=${encodeURIComponent(partnerVenue.rows[0].name)}`;

        selectedVenue = {
          name: partnerVenue.rows[0].name,
          formatted_address: partnerVenue.rows[0].neighborhood,
          co_reason: "CoPatible partner venue",
          booking_method: partnerVenue.rows[0].booking_method,
          contact: partnerVenue.rows[0].contact,
          payment_tier: partnerVenue.rows[0].payment_tier,
          venue_booking_url: partnerBookingUrl,
        };
      } else {
        // Fall back to Google Places + Co scoring
        selectedVenue = await findBestVenue(
          momentData.venue_type,
          momentData.neighborhood,
          city,
          {
            vibe: momentData.vibe,
            life_chapters: uniqueChapters,
            connection_style: dominantStyle,
            group_size: groupSize,
          },
        );
      }

      // Step 8 — Create the Moment
      const momentStart = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const momentResult = await pool.query(
        `INSERT INTO moments
         (creator_id, moments_name, location, location_name, moment_start, visibility_type, description, circle_id, vibes, venue, suggested_time, status, venue_booking_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          circle.owner_id,
          momentData.moments_name,
          "(0,0)",
          selectedVenue?.formatted_address ??
            `${momentData.neighborhood} — ${momentData.venue_type}`,
          momentStart,
          "circle",
          momentData.description,
          circle_id,
          momentData.vibes ?? [],
          selectedVenue?.name ?? null,
          momentData.suggested_time ?? null,
          "polling",
          selectedVenue?.venue_booking_url ?? null,
        ],
      );

      const moment = momentResult.rows[0];

      // Step 8.5 — Seed moment_responses for each circle member (null = awaiting reply)
      for (const member of members) {
        await pool.query(
          `INSERT INTO moment_responses (moment_id, user_id) VALUES ($1, $2)`,
          [moment.id, member.member_id],
        );
      }

      // Step 9 — Notify all circle members, collect phones for consensus poll
      const memberPhones: string[] = [];
      for (const member of members) {
        const userResult = await pool.query(
          `SELECT email, phone_number FROM users WHERE id = $1`,
          [member.member_id],
        );
        const user = userResult.rows[0];
        if (!user) continue;

        memberPhones.push(user.phone_number);

        await sendEmail({
          email: user.email,
          invite_type: "received",
          invite_target: "moment",
          action_url: `https://copatible.app/moments/${moment.id}`,
        });

        await sendSMS({
          phone_number: user.phone_number,
          invite_type: "received",
          invite_target: "moment",
          action_url: `https://copatible.app/moments/${moment.id}`,
        });
      }

      // Step 9.5 — Send consensus poll to the group via Sendblue iMessage
      if (memberPhones.length >= 4) {
        const pollMessage = `${momentData.suggested_time ?? "This week"} — does that work for everyone? Reply YES or suggest another time.`;
        try {
          await sendblue.groups.sendMessage({
            numbers: memberPhones,
            content: pollMessage,
            from_number: process.env.SENDBLUE_PHONE_NUMBER!,
          });
        } catch (smsErr: any) {
          console.error("Sendblue group message failed (non-fatal):", smsErr?.message ?? smsErr);
        }
      }

      // Step 10 — Store co_memory for each member
      for (const member of members) {
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'intent', $2)`,
          [
            member.member_id,
            `Co created a Moment for your circle: ${momentData.moments_name} at ${selectedVenue?.name ?? momentData.neighborhood}. ${momentData.suggested_time}.`,
          ],
        );
      }

      return res.status(201).send({
        success: true,
        data: {
          moment_id: moment.id,
          moments_name: moment.moments_name,
          venue: selectedVenue?.name ?? null,
          venue_type: momentData.venue_type,
          neighborhood: momentData.neighborhood,
          vibe: momentData.vibe,
          suggested_time: momentData.suggested_time,
          location_name: moment.location_name,
          moment_start: moment.moment_start,
          circle_id,
          member_count: members.length,
          co_reason: selectedVenue?.co_reason ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

//POST /co/message/:user_id - Co sends a message to a user
router.post(
  "/message/:user_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id } = req.params;
      const { message_type, context } = req.body;

      // 2. Fetch the user from the database
      const userInfo = await pool.query(`SELECT * FROM users WHERE id = $1`, [
        user_id,
      ]);
      const user: UserProp = userInfo.rows[0];

      if (!user) {
        return res.status(404).send("User not found.");
      }

      const prompts: Record<string, string> = {
        circle_placement: `You are Co, an exclusive life concierge. Write a short iMessage to ${user.first_name}. Co has selected their circle. Tone: quiet confidence, like a private members club reaching out. No excitement, no exclamation points. Just certainty. 2 sentences max. No em dashes. Example tone: "Your circle is ready. Five people, same chapter, same city."`,

        moment_invite: `You are Co. Write a short iMessage to ${user.first_name}. Co has arranged an experience: ${context?.moments_name} at ${context?.venue}, ${context?.suggested_time}. Tone: like a personal concierge confirming a reservation. Brief, confident, specific. 2 sentences max. No em dashes.`,

        payment_link: `You are Co. Write a short iMessage to ${user.first_name} to secure their spot for ${context?.moments_name}. Include the payment link: ${context?.payment_url}. Tone: matter of fact, not salesy. Like confirming a dinner reservation deposit. 2 sentences max. No em dashes.`,

        check_in: `You are Co. Write a short iMessage to ${user.first_name} following up after their circle experience. Tone: like a thoughtful friend checking in, not a survey. One question only. 1 sentence max. No em dashes.`,

        life_concierge: `You are Co. ${user.first_name} said: "${context?.user_message}". Respond as Co — specific, warm, actionable. Co knows ${user.first_name} well. No filler phrases. 2 sentences max. No em dashes.`,
      };

      const prompt = prompts[message_type] ?? prompts.circle_placement;

      const { text: coMessage } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt,
      });

      await pool.query(
        `INSERT INTO co_memories (user_id, memory_type, content)
   VALUES ($1, 'text_exchange', $2)`,
        [user_id, coMessage],
      );

      let sendResult: any = null;
      try {
        sendResult = await sendblue.messages.send({
          number: user.phone_number,
          content: coMessage,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        const errMsg = smsErr?.message ?? String(smsErr);
        console.error(`Sendblue failed to send to ${user_id}:`, errMsg);
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2)`,
          [user_id, `Co failed to send message to ${user_id}: ${errMsg}`],
        );
      }

      return res.status(200).send({
        success: true,
        text_dateCreated: sendResult?.date_created ?? null,
      });
    } catch (error) {
      next(error);
    }
  },
);

//POST /message/group/:circle_id - Co sends a message to the whole circle
router.post(
  "/message/group/:circle_id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circle_id } = req.params;
      const { message_type, context } = req.body;

      // Fetch all members with phone numbers
      const groupMembers = await pool.query(
        `SELECT u.id, u.first_name, u.phone_number 
         FROM circle_members cm
         JOIN users u ON cm.member_id = u.id
         WHERE cm.circle_id = $1`,
        [circle_id],
      );

      const members = groupMembers.rows;

      if (members.length < 4) {
        return res.status(400).send("Not enough members in the group.");
      }

      const prompts: Record<string, string> = {
        circle_placement: `You are Co, an exclusive life concierge. Write a short group iMessage welcoming this circle of ${members.length} people. They were selected for each other. Tone: quiet confidence. No exclamation points. 2 sentences max. No em dashes.`,

        moment_invite: `You are Co. Write a short group iMessage to this circle about their upcoming experience: ${context?.moments_name} at ${context?.venue}, ${context?.suggested_time}. Tone: like a personal concierge confirming a reservation. 2 sentences max. No em dashes.`,

        payment_link: `You are Co. Write a short group iMessage to this circle to secure their spots for ${context?.moments_name}. Payment link: ${context?.payment_url}. Split ${members.length} ways. Matter of fact, not salesy. 2 sentences max. No em dashes.`,

        check_in: `You are Co. Write a short group iMessage following up with this circle after their experience together. One question only. Warm but brief. 1 sentence max. No em dashes.`,
      };

      const prompt = prompts[message_type] ?? prompts.circle_placement;

      // Generate Co's group message
      const { text: coMessage } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        prompt: prompt,
      });

      // Send as group message via Sendblue
      const numbers = members.map((m: any) => m.phone_number);

      let groupMessage: any = null;
      try {
        groupMessage = await sendblue.groups.sendMessage({
          numbers,
          content: coMessage,
          from_number: process.env.SENDBLUE_PHONE_NUMBER!,
        });
      } catch (smsErr: any) {
        const errMsg = smsErr?.message ?? String(smsErr);
        console.error(`Sendblue group message failed for circle ${circle_id}:`, errMsg);
        for (const member of members) {
          await pool.query(
            `INSERT INTO co_memories (user_id, memory_type, content)
             VALUES ($1, 'text_exchange', $2)`,
            [member.id, `Co failed to send message to ${member.id}: ${errMsg}`],
          );
        }
      }

      // Store in co_memories for each member
      for (const member of members) {
        await pool.query(
          `INSERT INTO co_memories (user_id, memory_type, content)
           VALUES ($1, 'text_exchange', $2)`,
          [member.id, coMessage],
        );
      }

      return res.status(200).send({
        success: true,
        message_handle: groupMessage?.message_handle ?? null,
        status: groupMessage?.status ?? "send_failed",
        member_count: members.length,
        message: coMessage,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
