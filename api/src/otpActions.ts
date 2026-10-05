import { Resend } from "resend";
import "dotenv/config";
import sendblue from "./services/sendblue.js";
import { CARD, HOW_IT_WORKS, NAME_EMAIL, WELCOME, pickLine } from "./services/onboardingLines.js";
import { CO_EMAIL_FROM } from "./services/emailFrom.js";
import { letterpressEmail, quietEmail, spacedCode } from "./services/emailDesign.js";

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

    // Design: services/emailDesign.ts (Figma "Email Campaigns", 2026-09-24).
    // Codes and account notes use Quiet; the welcome uses Letterpress.
    const send = (subject: string, html: string) => resend.emails.send({ from: CO_EMAIL_FROM, to: email, subject, html });

    if (appsubmit) {
      const name = `${applicant?.first_name ?? ""} ${applicant?.last_name ?? ""}`.trim();
      await send(
        `New request: ${name}`,
        quietEmail({ preview: `${name} wants in.`, headline: "Someone's at the door.", lines: [`${name} wants in.`, applicant?.email ?? ""].filter(Boolean), note: "Let them in or leave them waiting.", signOff: false }),
      );
    }

    if (status === "accepted") {
      await send(
        `Welcome to Co.`,
        quietEmail({ preview: "Your access code. It expires in five minutes.", headline: "You were chosen.", code: otp_code!, lines: ["Use this code to step in. It expires in five minutes."], note: "Don't share this code." }),
      );
    }

    if (status === "rejected") {
      await send(
        `Your Co application.`,
        quietEmail({ preview: "An update on your application.", headline: "Not this time.", lines: ["Your application wasn't accepted. You're welcome to update it and ask for another look."] }),
      );
    }

    if (resent) {
      await send(
        `Your new Co code.`,
        quietEmail({ preview: `${spacedCode(otp_code!)}. It expires in five minutes.`, headline: "A new code.", code: otp_code!, lines: ["It expires in five minutes. If you didn't ask for it, ignore this and nothing changes."] }),
      );
    }

    if (phoneChange) {
      await send(
        `Confirm your new number.`,
        quietEmail({
          preview: "Text this code to Co to switch your number.",
          headline: "Changing your number.",
          code: otp_code!,
          lines: [`Text this code to Co from your current number to move your account to the number ending in ${phoneChange.newNumberLast4}. It expires in five minutes.`],
          note: "If you didn't ask for this, ignore it and email team@copatible.com.",
        }),
      );
    }

    if (login) {
      await send(
        `Your Co code.`,
        quietEmail({ preview: `${spacedCode(otp_code!)}. It expires in five minutes.`, headline: "Your code.", code: otp_code!, lines: ["It expires in five minutes. If you didn't ask for it, ignore this and nothing changes."] }),
      );
    }

    if (welcome) {
      // Co is text and calls now, so the button opens a text to Co rather
      // than an app (there's no app).
      const coNumber = process.env.SENDBLUE_PHONE_NUMBER;
      await send(
        `You're in.`,
        letterpressEmail({
          preview: "Someone vouched for you. Here's what happens next.",
          headline: "You're in.",
          lead: "Membership is by referral. Someone who knows you vouched for you, and that's the only way through the door.",
          steps: [
            "Co will text you. Answer the way you'd talk to a friend who remembers everything.",
            "Tell it what this chapter of your life is about. It listens for what you don't say, too.",
            "When there's a room worth your evening, Co will tell you who in it to meet.",
          ],
          cta: coNumber ? { label: "Text Co", href: `sms:${coNumber}` } : undefined,
        }),
      );
    }

    // Email fallback for a calendar-follow signal with no phone channel
    // (Royce, 2026-08-30): someone who followed the Co Presents calendar but
    // isn't a Co user yet only gave Luma their email, so this reaches them
    // there, in the same unhurried register as the text version.
    if (calendarFollow) {
      await send(
        `Co noticed you.`,
        quietEmail({
          preview: "Co is invite-only, not just an events page.",
          headline: firstName ? `Hello, ${firstName}.` : "Hello.",
          lines: ["You followed the Co Presents calendar. Co is invite-only, not just an events page.", "Reply with a little about what you're hoping to find, and Co will keep you in mind for what's next."],
        }),
      );
    }
  } catch (error) {
    console.error("Cannot process email at this time", error);
  }
};
