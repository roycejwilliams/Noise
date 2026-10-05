// Sends the plan sheet by email (Royce, 2026-10-05; services/planSheet.ts): the
// one-page PDF and, when anything has a time, a calendar file, to the member's
// own email and nobody else's. The address comes from their account, never from
// the model, and the email never names more than the sheet does.
import { Resend } from "resend";
import { buildIcs, hasTimedSteps, planEmail, planHtml, type Plan } from "./planSheet.js";
import { renderPdf } from "./browserRead.js";
import { CO_EMAIL_FROM } from "./emailFrom.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "plan";

export type PlanSend = { ok: true; hasCalendar: boolean } | { ok: false; why: string };

// The files and the email, ready to send. Null for the sheet means Chrome wasn't available.
export async function buildPlanFiles(plan: Plan, o: { firstName: string; seed: string; now?: Date }) {
  const pdf = await renderPdf(planHtml(plan, o.firstName));
  if (!pdf) return null;
  const calendar = hasTimedSteps(plan);
  const ics = calendar ? Buffer.from(buildIcs(plan, { seed: o.seed, now: o.now ?? new Date() }), "utf8") : null;
  const mail = planEmail(plan, { firstName: o.firstName, calendar });
  return { pdf, ics, mail, calendar, base: slug(plan.title) };
}

export type PlanFiles = NonNullable<Awaited<ReturnType<typeof buildPlanFiles>>>;

export async function sendPlanEmail(o: { to: string; files: PlanFiles }): Promise<PlanSend> {
  if (!process.env.RESEND_API_KEY) return { ok: false, why: "email isn't set up here" };
  const { files } = o;
  const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
    from: CO_EMAIL_FROM,
    to: [o.to],
    subject: files.mail.subject,
    html: files.mail.html,
    text: files.mail.text,
    attachments: [
      { filename: `${files.base}.pdf`, content: files.pdf, contentType: "application/pdf" },
      ...(files.ics ? [{ filename: `${files.base}.ics`, content: files.ics, contentType: "text/calendar" }] : []),
    ],
  });
  return error ? { ok: false, why: String((error as any).message ?? error).slice(0, 120) } : { ok: true, hasCalendar: files.calendar };
}
