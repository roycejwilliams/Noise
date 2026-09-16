import { SendblueAPI } from "sendblue";
import { capitalizeSentences, looksLikeMetaReply } from "./textStyle.js";

const client = new SendblueAPI({
  apiKey: process.env.SENDBLUE_API_KEY!,
  apiSecret: process.env.SENDBLUE_SECRET_KEY!,
});

// Claude occasionally narrates its own self-correction into the actual
// output when told "no em dashes" — e.g. drafting a line with an em dash,
// then adding "Wait, I used an em dash. Let me redo that." followed by a
// second draft, with BOTH ending up in the text. This strips that pattern
// (keeping only the final draft) and removes any em dash that slips through
// regardless, since this has now shipped to real users twice.
// A short generated line (e.g. a call/call-confirmation text) sometimes
// comes back wrapped in quotation marks, as if the model were quoting
// itself back — plausibly triggered by prompts that themselves show a
// quoted example (e.g. "don't just say \"Calling you now.\""). Confirmed
// live: a call-confirmation text sent as literal `"Calling you rn"` with a
// curly opening quote and a straight closing one — mismatched pair, so this
// strips any bookending mix of straight/curly quotes, not just a matched set.
const WRAPPED_QUOTE = /^["“‘']([\s\S]*)["”’']$/;

export function cleanCoMessage(text: string): string {
  const selfCorrection = /wait,?\s+i\s+(?:used|made|wrote)[^.]*\.\s*let\s+me\s+redo\s+that\.?\s*/i;
  const match = text.match(selfCorrection);
  let cleaned = match ? text.slice(match.index! + match[0].length) : text;
  // Models told "no em dashes" sometimes substitute a literal double-hyphen
  // ("word -- word") instead, which reads exactly the same to the recipient
  // — confirmed live from the ask-checkin agent (Claude Sonnet) doing this
  // repeatedly despite the instruction. Same fix as the em dash itself.
  // Must strip the surrounding whitespace along with the dash itself —
  // replacing just the character on "word — word" left "word , word" (a
  // stray space before the comma), which shipped to real users repeatedly
  // before this fix (confirmed live, 2026-08-26 conversation).
  // En dash (–, U+2013) added 2026-09-01 — confirmed live from
  // notifyTesters.ts's closing-line draft ("think–would"), a different
  // dash-lookalike than the em dash the regex already covered, with no
  // surrounding whitespace this time (\s* already permits zero, so this
  // was purely a missing character, not a whitespace-matching bug).
  cleaned = cleaned.replace(/\s*[—–]\s*/g, ", ").replace(/\s+--\s+/g, ", ").trim();
  const quoteMatch = cleaned.match(WRAPPED_QUOTE);
  if (quoteMatch) cleaned = quoteMatch[1].trim();
  // Always sentence case (Royce, 2026-09-16, after a deep dive on why casing
  // was inconsistent: it was applied path by path, the reply mirrored people
  // who text in lowercase while check-ins and onboarding didn't, and several
  // senders skipped it entirely). This is the one place every message passes
  // through before it's sent and logged.
  return capitalizeSentences(cleaned);
}

// Guards against ever texting a real user raw model meta-commentary (e.g.
// "I don't have access to...") instead of an actual message — the exact
// failure jobs/postCallFollowUp.ts produced live before this existed there,
// then services/recommendationOutcome.ts copy-pasted the same check for its
// own sends. Centralized here 2026-09-03 (Royce, "how can we fix the
// mitigated piece fully") after confirming most other call sites that draft
// free text (eventAskSolicitation.ts,
// eventChangeNotification.ts, calendarFollowReachOut.ts,
// eventDiscoverySurfacing.ts) had no guard at all — this can't stop the
// model from occasionally breaking character, but living in the one choke
// point every send passes through means no call site, present or future,
// can ship without it by forgetting to copy the check.
const LEAKED_METACOMMENTARY =
  /\{\{|context_summary|\bi don'?t have (a |any )?(record|access|context|information)\b|\bi can'?t (actually )?(send|text)\b|\boutside what i can do\b|\bi can only (take|make) calls?\b/i;

// Every message send goes through this one wrapper so cleanup and the
// meta-commentary guard apply uniformly, regardless of which prompt or call
// site generated the content.
const sendblue = {
  ...client,
  messages: {
    ...client.messages,
    send: (body: Parameters<typeof client.messages.send>[0], options?: Parameters<typeof client.messages.send>[1]) => {
      const content = body.content ? cleanCoMessage(body.content) : body.content;
      if (content && (LEAKED_METACOMMENTARY.test(content) || looksLikeMetaReply(content))) {
        return Promise.reject(
          new Error(`sendblue: outbound content looked like leaked model meta-commentary, refusing to send: ${content}`),
        );
      }
      return client.messages.send({ ...body, content }, options);
    },
  },
} as unknown as typeof client;

export default sendblue;

// Read receipts (Royce, 2026-09-15): the moment a 1:1 text reaches Co, the
// sender sees it was read, even while the reply is still being worked on.
// Sendblue sends these only for iMessage/RCS, best effort; never blocks.
export async function markRead(number: string): Promise<void> {
  const from = process.env.SENDBLUE_PHONE_NUMBER;
  if (!from || !process.env.SENDBLUE_API_KEY || !process.env.SENDBLUE_SECRET_KEY) return;
  try {
    const res = await fetch("https://api.sendblue.com/api/mark-read", {
      method: "POST",
      headers: {
        "sb-api-key-id": process.env.SENDBLUE_API_KEY,
        "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ number, from_number: from }),
    });
    if (!res.ok) console.error(`markRead: ${res.status} for ${number} (non-fatal)`);
  } catch (err: any) {
    console.error("markRead failed (non-fatal):", err?.message ?? err);
  }
}

// Tapbacks (Royce, 2026-09-15: "see if Co is able to react to messages like a
// thumbs up ... or just send an emoji when it doesn't have anything to say").
// Apple only delivers these on iMessage, so the caller falls back to a plain
// emoji text when this returns false.
export async function sendReaction(messageHandle: string, reaction: string): Promise<boolean> {
  const from = process.env.SENDBLUE_PHONE_NUMBER;
  if (!from || !process.env.SENDBLUE_API_KEY || !process.env.SENDBLUE_SECRET_KEY) return false;
  try {
    const res = await fetch("https://api.sendblue.com/api/send-reaction", {
      method: "POST",
      headers: {
        "sb-api-key-id": process.env.SENDBLUE_API_KEY,
        "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from_number: from, message_handle: messageHandle, reaction }),
    });
    if (!res.ok) {
      console.error(`sendReaction: ${res.status} (non-fatal)`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("sendReaction failed (non-fatal):", err?.message ?? err);
    return false;
  }
}
