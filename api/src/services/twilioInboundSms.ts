// A text to Cue's calling line (2026-11-02). Cue calls from a Twilio number and texts from a Sendblue one; the contact card lists
// both ("Texts", "Calls"), and texting the calling line got Twilio's demo auto-reply. Now Twilio posts the text to
// /co/incoming-sms (routes/co.ts). Once its Twilio signature checks out, it is shaped like a Sendblue inbound and handed to the same
// inbound handler (routes/sendblue.ts deliverInboundText). The same turn runs: a member is answered as if they'd texted the texting
// number, and Cue answers from it. An unknown number gets exactly what an unknown number texting Sendblue gets. The Twilio number
// itself never answers: the response is always an empty <Response/>, never a <Message>.
//
// Once per MessageSid: its handle is "twilio:<MessageSid>", and the handler's one-text-once check (inbound_webhook_handles, unique
// on handle) refuses a redelivery.
import type { Request, Response } from "express";

// The only body Twilio ever gets back: no message, no redirect.
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
export const TWILIO_HANDLE_PREFIX = "twilio:";

// Pure: Twilio's form fields as the Sendblue inbound body the handler reads. Null when it isn't a text from someone (no sender, no
// MessageSid).
export function payloadFromTwilio(body: Record<string, unknown> | null | undefined, now: Date = new Date()): Record<string, unknown> | null {
  const from = typeof body?.From === "string" ? body.From.trim() : "";
  const sid = typeof body?.MessageSid === "string" ? body.MessageSid.trim() : typeof body?.SmsMessageSid === "string" ? body.SmsMessageSid.trim() : "";
  if (!from || !sid) return null;
  const media = Number(body?.NumMedia ?? 0) > 0 && typeof body?.MediaUrl0 === "string" ? body.MediaUrl0 : null;
  return {
    number: from,
    content: typeof body?.Body === "string" ? body.Body : "",
    ...(media ? { media_url: media } : {}),
    message_handle: `${TWILIO_HANDLE_PREFIX}${sid}`,
    is_outbound: false,
    message_type: "message",
    date_sent: now.toISOString(),
  };
}

export type TwilioSmsDeps = {
  // The Twilio signature check (routes/co.ts validateTwilioSignature).
  validate: (req: Request) => boolean;
  // The inbound handler (routes/sendblue.ts deliverInboundText). Not awaited: Twilio gets its answer at once, the turn runs on.
  deliver: (payload: Record<string, unknown>) => Promise<unknown>;
  log?: (line: string) => void;
};

export function twilioSmsHandler(d: TwilioSmsDeps) {
  return (req: Request, res: Response) => {
    if (!d.validate(req)) return res.status(401).send("Invalid Twilio signature.");
    const payload = payloadFromTwilio(req.body);
    if (payload) {
      d.deliver(payload).catch((err: any) => (d.log ?? console.error)(`twilio sms: handing the text in failed: ${err?.message ?? err}`));
    }
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(EMPTY_TWIML);
  };
}
