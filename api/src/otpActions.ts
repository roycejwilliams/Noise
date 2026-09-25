import { Resend } from "resend";
import "dotenv/config";
import sendblue from "./services/sendblue.js";
import { CARD, HOW_IT_WORKS, NAME_EMAIL, WELCOME, pickLine } from "./services/onboardingLines.js";
import { CO_EMAIL_FROM } from "./services/emailFrom.js";

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
  // A code to confirm changing their phone number (services/phoneChange.ts).
  phoneChange?: { newNumberLast4: string };
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
}: MessageProp): Promise<{ ok: boolean; reason?: "inbound_only" | "error"; sent: string[] }> => {
  // What actually went out, so callers can log it to the conversation.
  const sent: string[] = [];
  const send = (content: string, mediaUrl?: string) => {
    if (!ALLOW_REAL_SENDS) {
      console.log(`[sendSMS stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${phone_number}: ${content}`);
      sent.push(content);
      return Promise.resolve();
    }
    return sendblue.messages
      .send({
        number: phone_number,
        content,
        ...(mediaUrl ? { media_url: mediaUrl } : {}),
        from_number: process.env.SENDBLUE_PHONE_NUMBER!,
      })
      .then((r) => {
        sent.push(content);
        return r;
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

    // Hand-written, approved lines, one picked at random (services/
    // onboardingLines.ts, 2026-09-19). These were model-written, and one went
    // out as "I need more context to write this message..." with the card.
    if (intro) await send(pickLine(HOW_IT_WORKS));

    if (save_contact) await send(pickLine(CARD), process.env.CO_VCARD_URL);

    if (intake_ask) await send(pickLine(NAME_EMAIL));

    if (register) {
      await send(`Your verification code is ${otp_code}. It expires in 5 minutes.`);
    }

    if (welcome) await send(pickLine(WELCOME));

    if (welcome_back) {
      await send(`Welcome back to Co.`);
    }
  } catch (error: any) {
    // co-test's Sendblue plan is inbound-only: Co can't text a number that
    // hasn't texted Co first. Surfaced so callers (the test site's login)
    // can tell the person what to do instead of reporting a code that
    // never arrives.
    const inboundOnly = error?.error?.error_message === "INBOUND_ONLY_PLAN" || error?.error?.error_code === 402;
    console.error("Cannot process SMS at this time", error);
    return { ok: false, reason: inboundOnly ? "inbound_only" : "error", sent };
  }
  return { ok: true, sent };
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
  phoneChange,
}: EmailProp) => {
  const resendClient = new Resend(process.env.RESEND_API_KEY);
  const resend = {
    emails: {
      send: (params: { from: string; to: string; subject: string; html: string }) => {
        if (!ALLOW_REAL_SENDS) {
          console.log(`[sendEmail stub, ${process.env.NODE_ENV ?? "no NODE_ENV"}] to ${params.to}: ${params.subject}`);
          return Promise.resolve();
        }
        // Resend reports failures in the result; surface them instead of
        // treating the send as done.
        return resendClient.emails.send(params).then((r: any) => {
          if (r?.error) throw new Error(`Resend: ${r.error.message}`);
          return r;
        });
      },
    },
  };
  try {
    if (!email) return;

    if (appsubmit) {
      await resend.emails.send({
        from: CO_EMAIL_FROM,
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
        from: CO_EMAIL_FROM,
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
        from: CO_EMAIL_FROM,
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
        from: CO_EMAIL_FROM,
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

    if (phoneChange) {
      await resend.emails.send({
        from: CO_EMAIL_FROM,
        to: email,
        subject: `Confirm your new number.`,
        html: emailTemplate(
          h1("Changing your number.") +
            p(`Text this code to Co from your current number to switch your account to the number ending in ${phoneChange.newNumberLast4}. It expires in 5 minutes.`) +
            OTP_BOX(otp_code!) +
            `<p class="muted-sm" style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#333333;margin-top:32px;">If you didn't ask for this, ignore it and email team@copatible.com.</p>`,
        ),
      });
    }

    if (login) {
      await resend.emails.send({
        from: CO_EMAIL_FROM,
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
        from: CO_EMAIL_FROM,
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
        from: CO_EMAIL_FROM,
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
