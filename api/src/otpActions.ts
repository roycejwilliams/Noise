import { Resend } from "resend";
import "dotenv/config";
import sendblue from "./services/sendblue.js";

// Real sends are on by default in production, and everywhere else only
// with an explicit opt-in — co-test sets ALLOW_REAL_SMS=true because its
// whole point is testing against real phones/inboxes. Any other
// non-production deployment stubs to a console log instead of silently
// sending real messages to whatever's in its data.
const ALLOW_REAL_SENDS = process.env.NODE_ENV === "production" || process.env.ALLOW_REAL_SMS === "true";

interface EmailProp {
  status?: "accepted" | "rejected";
  email: string;
  otp_code?: string;
  resent?: boolean;
  login?: boolean;
  invite_type?: "received" | "accepted" | "rejected";
  invite_target?: "circle" | "moment";
  transfer_ticket?: boolean;
  moment_recap?: { moments_name: string; recap: string };
  photo_uploaded?: { moments_name: string; uploader_username: string };
  check_in?: { moments_name: string; attendee_username: string };
  checked_in_self?: { moments_name: string };
  moment_reminder?: {
    moments_name: string;
    location_name: string;
    time: string;
  };
  circle_invite_reminder?: { circle_name: string };
  moment_invite_reminder?: { moments_name: string; time: string };
  appsubmit?: boolean;
  applicant?: ApplicationProp;
  external_invite?: { inviter_name: string; invite_type: "circle" | "moment"; target_name?: string };
  knock_received?: { moments_name: string; requester_name: string };
  knock_decided?: { moments_name: string; approved: boolean };
  welcome?: boolean;
  action_url?: string;
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
  invite_type?: "received" | "accepted" | "rejected";
  invite_target?: "circle" | "moment";
  transfer_ticket?: boolean;
  moment_recap?: { moments_name: string };
  photo_uploaded?: { moments_name: string; uploader_username: string };
  check_in?: { moments_name: string; attendee_username: string };
  checked_in_self?: { moments_name: string };
  moment_reminder?: {
    moments_name: string;
    location_name: string;
    time: string;
  };
  circle_invite_reminder?: { circle_name: string };
  moment_invite_reminder?: { moments_name: string; time: string };
  appsubmit?: boolean;
  external_invite?: { inviter_name: string; invite_type: "circle" | "moment"; target_name?: string };
  knock_received?: { moments_name: string; requester_name: string };
  knock_decided?: { moments_name: string; approved: boolean };
  welcome?: boolean;
  welcome_back?: boolean;
  action_url?: string;
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
  invite_type,
  invite_target,
  login,
  register,
  intro,
  save_contact,
  intake_ask,
  first_name,
  transfer_ticket,
  moment_recap,
  photo_uploaded,
  check_in,
  checked_in_self,
  moment_reminder,
  circle_invite_reminder,
  moment_invite_reminder,
  external_invite,
  knock_received,
  knock_decided,
  welcome,
  welcome_back,
  action_url,
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
      await send(
        `Co is invite-only. You're getting early access. She's learning and listening for now. More comes later.`,
      );
    }

    if (save_contact) {
      await send(`Save my contact so we can keep talking.`, process.env.CO_VCARD_URL);
    }

    if (intake_ask) {
      await send(`Let's start with the basics. What's your full name and email?`);
    }

    if (register) {
      await send(`Your verification code is ${otp_code}. It expires in 5 minutes.`);
    }

    const link = (url?: string) => (url ? `\n${url}` : "");

    if (invite_type === "received" && invite_target === "circle") {
      await send(`You've been invited to join a circle on Co. Open the app to accept or decline.${link(action_url)}`);
    } else if (invite_type === "received" && invite_target === "moment") {
      await send(`You've been invited to a moment on Co. Open the app to see the details.${link(action_url)}`);
    } else if (invite_type === "accepted") {
      await send(`Your invite was accepted. They're in.`);
    } else if (invite_type === "rejected") {
      await send(`Your invite was declined.`);
    }

    if (transfer_ticket) {
      await send(`A Co ticket was transferred to you. Open the app to view the moment details and your entry code.${link(action_url)}`);
    }

    if (moment_recap) {
      await send(`${moment_recap.moments_name} is over. Your recap is ready — open Co to relive the night.${link(action_url)}`);
    }

    if (photo_uploaded) {
      await send(`${photo_uploaded.uploader_username} added a photo to ${photo_uploaded.moments_name}. Open Co to see the recap.${link(action_url)}`);
    }

    if (check_in) {
      await send(`${check_in.attendee_username} just checked in to ${check_in.moments_name}.${link(action_url)}`);
    }

    if (checked_in_self) {
      await send(`You're officially checked in to ${checked_in_self.moments_name}. Enjoy the night.${link(action_url)}`);
    }

    if (moment_reminder) {
      await send(`Reminder: ${moment_reminder.moments_name} starts at ${moment_reminder.time}. ${moment_reminder.location_name}. Don't miss it.${link(action_url)}`);
    }

    if (circle_invite_reminder) {
      await send(`You still have a pending circle invite on Co — ${circle_invite_reminder.circle_name}. Open the app to respond.${link(action_url)}`);
    }

    if (moment_invite_reminder) {
      await send(`You still haven't responded to your invite for ${moment_invite_reminder.moments_name} — it starts at ${moment_invite_reminder.time}. Open Co to respond.${link(action_url)}`);
    }

    if (external_invite) {
      const context = external_invite.target_name
        ? ` to ${external_invite.invite_type === "moment" ? `a moment called "${external_invite.target_name}"` : `a circle called "${external_invite.target_name}"`}`
        : "";
      await send(`${external_invite.inviter_name} invited you${context} on Co. Visit app.copatible.com to request access.`);
    }

    if (knock_received) {
      await send(`${knock_received.requester_name} is knocking to get into ${knock_received.moments_name}. Open Co to let them in or pass.${link(action_url)}`);
    }

    if (knock_decided) {
      await send(
        knock_decided.approved
          ? `You're in. Your knock was approved for ${knock_decided.moments_name}. Open Co for details.${link(action_url)}`
          : `Not this time. Your knock for ${knock_decided.moments_name} wasn't approved.`,
      );
    }

    if (welcome) {
      await send(first_name ? `Hey ${first_name}, welcome to Co.` : `Hey, welcome to Co.`);
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
  invite_type,
  invite_target,
  login,
  transfer_ticket,
  moment_recap,
  photo_uploaded,
  check_in,
  checked_in_self,
  moment_reminder,
  circle_invite_reminder,
  moment_invite_reminder,
  applicant,
  appsubmit,
  external_invite,
  knock_received,
  knock_decided,
  welcome,
  action_url,
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
  const cta = (label: string, fallback: string) =>
    ctaButton(label, action_url ?? fallback);
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

    if (invite_type === "received" && invite_target === "circle") {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `You've been invited.`,
        html: emailTemplate(
          h1("You're wanted in a circle.") +
            p(
              "Someone added you to their circle on Co. Open the app to accept or decline.",
            ) +
            cta("Respond to Invite", "https://app.copatible.com"),
        ),
      });
    } else if (invite_type === "received" && invite_target === "moment") {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `You've been invited to a moment.`,
        html: emailTemplate(
          h1("Something's happening.") +
            p(
              "You've been invited to a moment on Co. Open the app to see the details and respond.",
            ) +
            cta("Respond to Invite", "https://app.copatible.com"),
        ),
      });
    } else if (invite_type === "accepted") {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Your invite was accepted.`,
        html: emailTemplate(
          h1("They're in.") +
            p(
              "Your invite was accepted. Your circle just got a little more intentional.",
            ),
        ),
      });
    } else if (invite_type === "rejected") {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Your invite was declined.`,
        html: emailTemplate(
          h1("Not this time.") +
            p(
              "Your invite was declined. Circles are built on intention — not everyone is a fit.",
            ),
        ),
      });
    }

    if (transfer_ticket) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `Your ticket has been transferred.`,
        html: emailTemplate(
          h1("You're in.") +
            p(
              "A ticket was transferred to you. Open Co to view the moment details and your entry code.",
            ) +
            cta("View My Ticket", "https://app.copatible.com"),
        ),
      });
    }

    if (moment_recap) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `${moment_recap.moments_name} — the recap is ready.`,
        html: emailTemplate(
          h1("Rewind the night.") +
            p(moment_recap.recap) +
            p("Open Co to see the full recap, photos, and attendees.") +
            cta("View Recap", "https://app.copatible.com"),
        ),
      });
    }

    if (photo_uploaded) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `New photo added to ${photo_uploaded.moments_name}.`,
        html: emailTemplate(
          h1("The story grows.") +
            p(
              `${photo_uploaded.uploader_username} added a photo to ${photo_uploaded.moments_name}. Open Co to see the recap.`,
            ) +
            cta("View Photo", "https://app.copatible.com"),
        ),
      });
    }

    if (check_in) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `${check_in.attendee_username} checked in.`,
        html: emailTemplate(
          h1("They made it.") +
            p(
              `${check_in.attendee_username} just checked in to ${check_in.moments_name}. The night is taking shape.`,
            ) +
            cta("View Moment", "https://app.copatible.com"),
        ),
      });
    }

    if (checked_in_self) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `You're checked in to ${checked_in_self.moments_name}.`,
        html: emailTemplate(
          h1("You're in.") +
            p(`You've officially checked in to ${checked_in_self.moments_name}. Enjoy the night.`) +
            cta("View Moment", "https://app.copatible.com"),
        ),
      });
    }

    if (moment_reminder) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `${moment_reminder.moments_name} is coming up.`,
        html: emailTemplate(
          h1("Don't miss it.") +
            p(
              `${moment_reminder.moments_name} starts at ${moment_reminder.time}.`,
            ) +
            p(`${moment_reminder.location_name}. Open Co for details and directions.`) +
            cta("View Moment", "https://app.copatible.com"),
        ),
      });
    }

    if (circle_invite_reminder) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `You have a pending circle invite.`,
        html: emailTemplate(
          h1("Still waiting on you.") +
            p(
              `You have a pending invite to join ${circle_invite_reminder.circle_name} on Co. Open the app to accept or decline.`,
            ) +
            cta("Respond to Invite", "https://app.copatible.com"),
        ),
      });
    }

    if (moment_invite_reminder) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `You haven't responded to your invite.`,
        html: emailTemplate(
          h1("They're waiting on you.") +
            p(
              `You still haven't responded to your invite for ${moment_invite_reminder.moments_name} — it starts at ${moment_invite_reminder.time}.`,
            ) +
            p("Open Co to accept or decline before the moment fills up.") +
            cta("Respond to Invite", "https://app.copatible.com"),
        ),
      });
    }

    if (external_invite) {
      const contextLine = external_invite.target_name
        ? external_invite.invite_type === "moment"
          ? `You've been invited to a moment called "${external_invite.target_name}" on Co.`
          : `You've been invited to join a circle called "${external_invite.target_name}" on Co.`
        : `You've been invited to join Co by ${external_invite.inviter_name}.`;
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `${external_invite.inviter_name} invited you to Co.`,
        html: emailTemplate(
          h1("You've been chosen.") +
            p(`${external_invite.inviter_name} thought of you.`) +
            p(contextLine) +
            p("Co is invite-only. Request access to join the moment.") +
            ctaButton("Request Access", "https://app.copatible.com"),
        ),
      });
    }

    if (knock_received) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: `${knock_received.requester_name} wants into ${knock_received.moments_name}.`,
        html: emailTemplate(
          h1("Someone's knocking.") +
            p(`${knock_received.requester_name} is requesting access to ${knock_received.moments_name}. Open Co to let them in or pass.`) +
            cta("Review Knock", action_url ?? "https://app.copatible.com"),
        ),
      });
    }

    if (knock_decided) {
      await resend.emails.send({
        from: "Co <hello@copatible.com>",
        to: email,
        subject: knock_decided.approved
          ? `You're in — ${knock_decided.moments_name}.`
          : `Your knock wasn't approved.`,
        html: knock_decided.approved
          ? emailTemplate(
              h1("You're in.") +
                p(`Your knock was approved for ${knock_decided.moments_name}. Open Co for the details.`) +
                cta("View Moment", action_url ?? "https://app.copatible.com"),
            )
          : emailTemplate(
              h1("Not this time.") +
                p(`Your knock for ${knock_decided.moments_name} wasn't approved. Circles are built on intention.`),
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
            p("Co is invite-only. You're getting early access. She's learning and listening for now.") +
            p("More comes later.") +
            ctaButton("Open Co", "https://app.copatible.com"),
        ),
      });
    }
  } catch (error) {
    console.error("Cannot process email at this time", error);
  }
};
