// Where Co's internal email goes (Royce, 2026-09-30: "the emails you send to
// the team email need to stop. It should only go to my email"). One address for
// the morning report and every alert: REPORT_EMAIL, else royce@copatible.com.
// Never the shared team inbox.
import { Resend } from "resend";
import { ALLOW_REAL_SENDS } from "../otpActions.js";
import { CO_EMAIL_FROM } from "./emailFrom.js";

export const DEFAULT_REPORT_EMAIL = "royce@copatible.com";

export function reportRecipient(env: NodeJS.ProcessEnv = process.env): string {
  const to = (env.REPORT_EMAIL ?? "").trim();
  return to && /@/.test(to) && !/^team@/i.test(to) ? to : DEFAULT_REPORT_EMAIL;
}

// Resend reports failures in the result instead of throwing.
export async function sendReportEmail(subject: string, html: string, text?: string): Promise<{ sent: boolean; to: string }> {
  const to = reportRecipient();
  if (!ALLOW_REAL_SENDS || !process.env.RESEND_API_KEY) {
    console.log(`[report email, not sent] to ${to}: ${subject}\n${text ?? html.replace(/<[^>]+>/g, " ")}`);
    return { sent: false, to };
  }
  const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: CO_EMAIL_FROM, to: [to], subject, html, ...(text ? { text } : {}) });
  if (error) throw new Error(`Resend: ${error.message}`);
  return { sent: true, to };
}
