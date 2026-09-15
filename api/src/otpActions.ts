import { Resend } from "resend";
import "dotenv/config";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import sendblue from "./services/sendblue.js";
import { CO_VOICE, CO_TEXT_CHANNEL } from "./services/coVoice.js";
import { MODELS } from "./models.js";

// One-line intro drafts with a strict fallback: narrow work, Haiku.
const INTRO_LINE_MODEL = MODELS.haiku;

// A fixed line every time reads as a canned system message, not someone
// actually greeting you — same reasoning as webhooks.ts's variedConfirmation/
// voicemailLine. Generates a short varied version of `fallback` and always
// falls back to the exact original text on any failure, so the first thing a
// new user hears from Co is never silently broken by a generation hiccup.
async function varied(instruction: string, fallback: string, maxChars: number): Promise<string> {
  try {
    const { text } = await generateText({
      model: anthropic(INTRO_LINE_MODEL),
      experimental_telemetry: { isEnabled: true, functionId: "otpActions.introLine" },
      prompt: `${CO_VOICE}\n\n${CO_TEXT_CHANNEL} ${instruction} Vary how you say it call to call — don't just repeat the same phrasing every time. Tone: calm, unhurried, like a private members club. No exclamation points, no em dashes. Under ${maxChars} characters. Return ONLY the single message you would actually send, nothing else — never multiple options, a numbered or lettered list, headers, or any markdown formatting.`,
    });
    const trimmed = text.trim();
    // Confirmed live: Haiku sometimes ignores "return only one" and returns
    // a menu of options instead ("# Option 1 ... # Option 2 ..."). Rather
    // than guess which option was meant, fall all the way back — this is
    // the first thing a new user ever hears from Co, worth being strict.
    const looksLikeMultipleOptions = /\n|^#|\*\*|option\s*\d|^\d+[.)]/im.test(trimmed);
    if (!trimmed || looksLikeMultipleOptions) return fallback;
    return trimmed.length > maxChars + 20 ? trimmed.slice(0, maxChars + 19) + "…" : trimmed;
  } catch (err: any) {
    console.error("otpActions: varied intro-line generation failed (non-fatal, using default):", err?.message ?? err);
    return fallback;
  }
}

// Real sends are on by default in production, and everywhere else only
// with an explicit opt-in — co-test sets ALLOW_REAL_SMS=true because its
// whole point is testing against real phones/inboxes. Any other
// non-production deployment stubs to a console log instead of silently
// sending real messages to whatever's in its data.
export const ALLOW_REAL_SENDS = process.env.NODE_ENV === "production" || process.env.ALLOW_REAL_SMS === "true";

interface EmailProp {
  status?: "accepted" | "rejected";
  email: string;
  otp_code?: string;
  resent?: boolean;
  login?: boolean;
  appsubmit?: boolean;
  applicant?: ApplicationProp;
  welcome?: boolean;
  calendarFollow?: boolean;
  firstName?: string;
}

interface MessageProp {
  status?: "accepted" | "rejected";
  phone_number: string;
  otp_code?: string;
  resent?: boolean;
  login?: boolean;
  register?: boolean;
  intro?: boolean;
  save_contact?: boolean;
  intake_ask?: boolean;
  first_name?: string;
  appsubmit?: boolean;
  welcome?: boolean;
  welcome_back?: boolean;
}

const EMAIL_STYLES = `
  body,.body-bg{background:#000000!important;}
  .wrapper{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:48px 32px;background:#000000;}
  .brand{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#444444;margin:0 0 48px 0;}
  .h1{font-size:28px;font-weight:600;letter-spacing:-0.5px;margin:0 0 16px 0;color:#ffffff;}
  .p{font-size:15px;color:#666666;line-height:1.6;margin:0 0 24px 0;}
  .otp-box{border:1px solid #222222;border-radius:4px;padding:28px;text-align:center;letter-spacing:12px;font-size:28px;font-weight:700;color:#ffffff;margin:0 0 24px 0;}
  .footer-text{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;}
  .muted-sm{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;}
  .cta-btn{display:inline-block;padding:14px 32px;background:#ffffff;color:#000000;text-decoration:none;font-size:14px;font-weight:600;letter-spacing:-0.1px;border-radius:6px;margin:0 auto;}
  .cta-wrap{text-align:center;margin:8px 0 24px 0;}
  @media(prefers-color-scheme:light){
    body,.body-bg{background:#f2f2f2!important;}
    .wrapper{background:#ffffff!important;}
    .brand{color:#aaaaaa!important;}
    .h1{color:#0a0a0a!important;}
    .p{color:#555555!important;}
    .otp-box{border-color:#e0e0e0!important;color:#0a0a0a!important;}
    .footer-text{color:#aaaaaa!important;}
    .muted-sm{color:#aaaaaa!important;}
    .cta-btn{background:#0a0a0a!important;color:#ffffff!important;}
  }
`;

const BRAND = `<p class="brand" style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#444444;margin:0 0 48px 0;">Co</p>`;
const FOOTER = `<p class="footer-text" style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;">Co is intentional. So is this.</p>`;
const OTP_BOX = (code: string) =>
  `<div class="otp-box" style="border:1px solid #222222;border-radius:4px;padding:28px;text-align:center;letter-spacing:12px;font-size:28px;font-weight:700;color:#ffffff;margin:0 0 24px 0;">${code}</div>`;

const emailTemplate = (body: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>${EMAIL_STYLES}</style></head><body class="body-bg" style="margin:0;padding:0;background:#000000;"><div class="wrapper" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:48px 32px;background:#000000;">${BRAND}${body}${FOOTER}</div></body></html>`;

const h1 = (text: string) =>
  `<h1 class="h1" style="font-size:28px;font-weight:600;letter-spacing:-0.5px;margin:0 0 16px 0;color:#ffffff;">${text}</h1>`;

const p = (text: string) =>
  `<p class="p" style="font-size:15px;color:#666666;line-height:1.6;margin:0 0 24px 0;">${text}</p>`;

const ctaButton = (label: string, href: string) =>
  `<div class="cta-wrap" style="text-align:center;margin:8px 0 24px 0;"><a href="${href}" class="cta-btn" style="display:inline-block;padding:14px 32px;background:#ffffff;color:#000000;text-decoration:none;font-size:14px;font-weight:600;letter-spacing:-0.1px;border-radius:6px;">${label}</a></div>`;

export const sendSMS = async ({
  phone_number,
  otp_code,
  status,
  resent,
  login,
  register,
  intro,
  save_contact,
  intake_ask,
  first_name,
  welcome,
  welcome_back,
}: MessageProp) => {
  const send = (content: string, mediaUrl?: string) => {
    if (!ALLOW_REAL_SENDS) {
      console.log(`[sendSMS stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${phone_number}: ${content}`);
      return Promise.resolve();
    }
    return sendblue.messages.send({
      number: phone_number,
      content,
      ...(mediaUrl ? { media_url: mediaUrl } : {}),
      from_number: process.env.SENDBLUE_PHONE_NUMBER!,
    });
  };

  try {
    if (status === "accepted") {
      await send(`You're in. You were chosen to join Co. Use the code below to get started.\n${otp_code}`);
    } else if (status === "rejected") {
      await send(`Your Co application wasn't accepted. You're welcome to update and resubmit.`);
    }

    if (resent) {
      await send(`Here's your new Co verification code.\n${otp_code}`);
    }

    if (login) {
      await send(`Your Co login code is below. It expires in 5 minutes.\n${otp_code}`);
    }

    if (intro) {
      // Always preceded by its own separate "welcome" send (routes/sendblue.ts)
      // — confirmed live this produced two back-to-back "Welcome to Co"
      // openers, since each varied() call has no idea what the other one
      // said. Explicitly told not to re-greet here.
      await send(
        await varied(
          "You already greeted them warmly in a separate message just before this one — do not say \"welcome\" or greet them again here. Continuing on, let them know, in your own words: Co is invite-only and they're getting early access, you're still learning and listening for now, and more is coming later. Also mention, briefly and factually, that they can just call this number any time they'd rather talk than text — not a suggestion to do it now, just letting them know it's always an option.",
          `Co is invite-only. You're getting early access. Co is still getting to know people, and more comes later. You can also just call this number any time you'd rather talk than text.`,
          220,
        ),
      );
    }

    if (save_contact) {
      await send(
        await varied(
          "Ask them, briefly, to save your contact so you two can keep talking.",
          `Save my contact so we can keep talking.`,
          80,
        ),
        process.env.CO_VCARD_URL,
      );
    }

    if (intake_ask) {
      await send(
        await varied(
          "Ask them for both their full name and their email, so you can get started — keep it brief and clearly ask for both.",
          `Let's start with the basics. What's your full name and email?`,
          100,
        ),
      );
    }

    if (register) {
      await send(`Your verification code is ${otp_code}. It expires in 5 minutes.`);
    }

    if (welcome) {
      await send(
        await varied(
          `Greet them warmly, welcoming them to Co for the first time.${first_name ? ` Their name is ${first_name} — use it.` : ""}`,
          first_name ? `Hey ${first_name}, welcome to Co.` : `Hey, welcome to Co.`,
          60,
        ),
      );
    }

    if (welcome_back) {
      await send(`Welcome back to Co.`);
    }
  } catch (error) {
    console.error("Cannot process SMS at this time", error);
  }
};

export const sendEmail = async ({
  email,
  otp_code,
  status,
  resent,
  login,
  applicant,
  appsubmit,
  welcome,
  calendarFollow,
  firstName,
}: EmailProp) => {
  const resendClient = new Resend(process.env.RESEND_API_KEY);
  const resend = {
    emails: {
      send: (params: { from: string; to: string; subject: string; html: string }) => {
        if (!ALLOW_REAL_SENDS) {
          console.log(`[sendEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${params.to}: ${params.subject}`);
          return Promise.resolve();
        }
        return resendClient.emails.send(params);
      },
    },
  };
  try {
    if (!email) return;

    if (appsubmit) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `New Request — ${applicant?.first_name} ${applicant?.last_name}`,
        html: emailTemplate(
          h1("Someone's at the door.") +
            p(`${applicant?.first_name} ${applicant?.last_name} wants in.`) +
            p(`${applicant?.email}`) +
            `<p class="muted-sm" style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;">Let them in or leave them waiting.</p>`,
        ),
      });
    }

    if (status === "accepted") {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Welcome to Co.`,
        html: emailTemplate(
          h1("You were chosen.") +
            p(
              "Your access code is waiting. Use it to step in — it expires in 5 minutes.",
            ) +
            OTP_BOX(otp_code!) +
            `<p class="muted-sm" style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;">Do not share this code.</p>`,
        ),
      });
    }

    if (status === "rejected") {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Your Co application.`,
        html: emailTemplate(
          h1("Not this time.") +
            p(
              "Your application wasn't accepted. You're welcome to update and resubmit for another review.",
            ),
        ),
      });
    }

    if (resent) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Your new Co verification code.`,
        html: emailTemplate(
          h1("New code. Same you.") +
            p(
              "You requested a new verification code. Use it below to get into Co.",
            ) +
            OTP_BOX(otp_code!) +
            `<p class="muted-sm" style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;">This code expires in 5 minutes.</p>`,
        ),
      });
    }

    if (login) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Your Co login code.`,
        html: emailTemplate(
          h1("Welcome back.") +
            p("Use the code below to sign in. It expires in 5 minutes.") +
            OTP_BOX(otp_code!) +
            `<p class="muted-sm" style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;">Do not share this code.</p>`,
        ),
      });
    }

    if (welcome) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Welcome to Co.`,
        html: emailTemplate(
          h1("You're in.") +
            p("Co is invite-only. You're getting early access. Co is still getting to know people.") +
            p("More comes later.") +
            ctaButton("Open Co", "https://app.copatible.com"),
        ),
      });
    }

    // Email fallback for a calendar-follow signal with no phone channel
    // (Royce, 2026-08-30) — routes/luma.ts's calendar.person_subscribed
    // handler only reaches runCalendarFollowReachOutAgent (an SMS) when the
    // follower's email already matches an existing Co user. Someone who
    // followed the calendar but was never a match at all still gave Luma
    // their email (that's the join key the webhook provides) — this reaches
    // them there instead of silently doing nothing, same warm/not-pushy
    // register as the SMS version.
    if (calendarFollow) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Co noticed you.`,
        html: emailTemplate(
          h1(firstName ? `Hey ${firstName}.` : "Hey there.") +
            p("Co noticed you followed the Co Presents calendar — Co is invite-only, not just an events page.") +
            p("Reply and tell Co a little about what you're hoping to find, and it'll keep you in mind for what's next."),
        ),
      });
    }
  } catch (error) {
    console.error("Cannot process email at this time", error);
  }
};
