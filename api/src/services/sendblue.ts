import { isTestHandle, isTestNumber, testHandle } from "./testNumbers.js";
import { stripCues } from "./voiceCues.js";
import { sendLimiter } from "./sendLimiter.js";
import { claimReaction, confirmReaction, releaseReaction } from "./tapbacks.js";
import { createHash, timingSafeEqual } from "crypto";
import { SendblueAPI } from "sendblue";
import { capitalizeSentences, looksLikeMetaReply, paragraphize } from "./textStyle.js";
import { sentinelRule, SENTINEL_REFUSAL } from "./sentinelBody.js";

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
  // A voice cue ("[softly]") is for calls only: never in a text, even one
  // drafted from a call transcript (services/voiceCues.ts).
  cleaned = stripCues(cleaned, "known").trim();
  return paragraphize(capitalizeSentences(cleaned));
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
//
// Narrowed 2026-09-17 (code review): the old pattern also matched honest
// lines Co is told to send ("I don't have any information on the start
// time", "I can't send the ticket for you", "booking is outside what I can
// do"). Each refused send was swallowed by sendCoReply, so the person got
// nothing while every caller logged "Co replied". Only phrasings that are
// about Co's own prompt, memory, or channel are blocked now.
const LEAKED_METACOMMENTARY =
  /\{\{|context_summary|\bsystem prompt\b|\bi don'?t have (any )?(access to|a record of|any record of|context (on|about|for)|information (on|about)) (the |this |our |your |my |any )?(context|conversation history|chat history|message history|previous (conversations?|messages?|chats?)|prior (conversations?|messages?|chats?)|past (conversations?|messages?|chats?)|earlier (conversations?|messages?)|this (person|user|conversation)|the user|who (this|they) (is|are)|memory|memories|tools?|instructions)\b|\bi can'?t (actually )?(send|text) (you )?(a |any )?(texts?|text messages?|sms|imessages?|messages)\b|\bas an ai\b[^.?!]{0,30}\b(can'?t|cannot|don'?t|do not|am unable|'?m unable)\b|\b(a|an) (ai )?language model\b|\bi can only (take|make) calls?\b/i;

// Co narrating its own sending instead of texting (2026-10-01 next-live run:
// "(already sent the reply above)" came back as a reply). A whole message in
// brackets or parentheses is a stage direction, never a text.
const SENDING_NARRATION = /\b(already )?sent (the|my|a|that) (reply|message|response|answer|text)s? (above|earlier|already)\b|\b(the|my) (reply|message|response) above\b|^\s*[([][^()[\]]{0,120}[)\]]\s*$/i;

export function isLeakedMetaCommentary(content: string): boolean {
  return LEAKED_METACOMMENTARY.test(content) || looksLikeMetaReply(content) || SENDING_NARRATION.test(content);
}

// Sendblue's webhook secret (dashboard: Webhooks, secret; sent back verbatim
// in the sb-signing-secret header). Compared as fixed-length digests so the
// comparison takes the same time whatever the input (2026-09-17 code review:
// the webhook accepted a fake inbound text from anyone with the URL).
export function webhookSecretMatches(expected: string | undefined | null, provided: unknown): boolean {
  if (!expected || typeof provided !== "string" || !provided) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

// Alerts once when the send breaker trips (services/sendLimiter.ts): the
// console for the logs, a harness decision so the morning review sees it,
// an email to the team right away (2026-09-24: Royce sat through 32 silent
// minutes and nobody knew), and a note on the member so Co can say what
// happened instead of inventing a reason ("No rate limit, just me actually
// searching"). Loaded lazily to keep this file free of harness imports.
export function sendHeldNote(fromMs: number, untilMs: number): string {
  const t = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  return `Cue's texts to them were paused from ${t(fromMs)} to ${t(untilMs)} Pacific by Cue's own limit on how many texts it sends one person. Anything Cue tried to send them then never arrived, and anything they asked then may still be unanswered.`;
}

function reportSendBreaker(number: string, count: number, resumesAt: number, reason: string): void {
  const last4 = number.slice(-4);
  const why = reason === "unprompted" ? `${count} texts in a row with no reply from them` : `${count} texts in 10 minutes`;
  console.error(`sendblue: send breaker tripped for ...${last4}: ${why}, holding sends until ${new Date(resumesAt).toISOString()}`);
  import("../harness/core.js")
    .then(({ recordDecision }) =>
      recordDecision({ layer: 7, decision: "send.breaker", userId: null, outcome: "skip", action: "tripped", reason: `${why} to ...${last4}`, proposal: { last4, count, reason, resumesAt: new Date(resumesAt).toISOString() } }),
    )
    .catch(() => {});
  import("../db/db.js")
    .then(async ({ default: pool }) => {
      const { rows } = await pool.query(`SELECT id, first_name FROM users WHERE phone_number = $1 LIMIT 1`, [number]);
      const user = rows[0];
      if (user) {
        await pool.query(`INSERT INTO co_memories (user_id, memory_type, content) VALUES ($1, 'send_held', $2)`, [user.id, sendHeldNote(Date.now(), resumesAt)]);
      }
      const { alertTeamNow } = await import("../harness/monitor.js");
      await alertTeamNow(
        `send_breaker:${last4}`,
        `Cue alert: texts to ${user?.first_name ?? "a number"} paused`,
        `Cue stopped texting ${user?.first_name ?? "an unknown number"} (...${last4}) after ${why}. Nothing goes to them until ${new Date(resumesAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })} Pacific. If this was a real conversation, the limit is wrong; if it was a loop, it worked.`,
      );
    })
    .catch((err: any) => console.error("sendblue: breaker follow-up failed (non-fatal):", err?.message ?? err));
}

// Every send is Co's (outbound_messages.sender keeps its default, "co").
function recordOutbound(handle: string, number: string, content: string): void {
  import("../db/db.js")
    .then(({ default: pool }) =>
      pool.query(
        `INSERT INTO outbound_messages (message_handle, user_id, content)
         SELECT $1, (SELECT id FROM users WHERE right(regexp_replace(phone_number, '\\D', '', 'g'), 10) = right(regexp_replace($2, '\\D', '', 'g'), 10) LIMIT 1), $3
         ON CONFLICT (message_handle) DO NOTHING`,
        [handle, number, content.slice(0, 2000)],
      ),
    )
    .catch((err: any) => console.error("sendblue: outbound handle not recorded (non-fatal):", err?.message ?? err));
}

// Pure: a number Co may send to: "+" then 10 to 15 digits, nothing else (E.164); a US/Canada number (+1) is exactly 11 digits.
export function sendableNumber(number: unknown): boolean {
  if (typeof number !== "string") return false;
  const n = number.trim();
  return /^\+\d{10,15}$/.test(n) && (!n.startsWith("+1") || n.length === 12);
}

// Pure: whether this send error is the wrapper's own refusal (a placeholder body by its code; the breaker and the meta-commentary
// guard by their message, as before), which a retry of the same text can't get past. Not a refusal by Sendblue itself.
export function refusedBySendLayer(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === SENTINEL_REFUSAL || /send breaker|meta-commentary/.test(String(e?.message ?? ""));
}

// Every message send goes through this one wrapper so cleanup and the
// meta-commentary guard apply uniformly, regardless of which prompt or call
// site generated the content.
const sendblue = {
  ...client,
  messages: {
    ...client.messages,
    send: (body: Parameters<typeof client.messages.send>[0], options?: Parameters<typeof client.messages.send>[1]) => {
      const content = body.content ? cleanCoMessage(body.content) : body.content;
      // Never a placeholder (services/sentinelBody.ts): an empty or "SKIP" body is refused, whatever path it came from. A media-only
      // send (a voice note, a card) may have no words.
      const placeholder = sentinelRule(content ?? "");
      if (placeholder && !(placeholder === "empty" && (body as { media_url?: string }).media_url)) {
        return Promise.reject(Object.assign(new Error(`sendblue: outbound content is ${placeholder}, not a text, refusing to send`), { code: SENTINEL_REFUSAL }));
      }
      if (content && isLeakedMetaCommentary(content)) {
        return Promise.reject(
          new Error(`sendblue: outbound content looked like leaked model meta-commentary, refusing to send: ${content}`),
        );
      }
      const to = (body as { number?: string }).number;
      // Only a real phone number is ever sent to (2026-10-13: archived test members' numbers, rewritten as "+15035550130#a8" by a
      // test script, reached Sendblue as "+150355501308" and were declined 27 times). An archive placeholder, a marker or a number
      // of the wrong length is refused here, before anything leaves.
      if (!sendableNumber(to)) {
        return Promise.reject(new Error(`sendblue: not a phone number (…${String(to ?? "").replace(/\D/g, "").slice(-4)}), refusing to send`));
      }
      const limit = sendLimiter.check(to);
      if (!limit.ok) {
        if (limit.tripped) reportSendBreaker(to ?? "", limit.count, limit.resumesAt, limit.reason);
        return Promise.reject(
          new Error(`sendblue: send breaker open for ...${String(to ?? "").slice(-4)}, refusing to send (${limit.reason === "unprompted" ? `${limit.count} texts with no reply` : `${limit.count} texts in 10 minutes`})`),
        );
      }
      // A test member (services/testNumbers.ts): logged like a real send, never sent.
      const sent: Promise<any> = isTestNumber(to)
        ? Promise.resolve({ message_handle: testHandle(), status: "SENT", test: true })
        : client.messages.send({ ...body, content }, options);
      return sent.then((res: any) => {
        // Every message Co sends, kept by its handle so a later reply can
        // thread under it (services/inlineReply.ts sentMessageHandle).
        if (res?.message_handle) recordOutbound(String(res.message_handle), to ?? "", content ?? "");
        // Every link Co sends is read once, in the background (services/linkReader.ts).
        if (content && /https?:\/\//.test(content)) import("./linkReader.js").then((l) => l.readLinksLater(content)).catch(() => {});
        return res;
      }).catch((err: any) => {
        // Rejected outright (4xx): nothing reached them, so it isn't counted.
        if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) sendLimiter.release(to);
        throw err;
      });
    },
  },
} as unknown as typeof client;

export default sendblue;

// Read receipts (Royce, 2026-09-15): the moment a 1:1 text reaches Co, the
// sender sees it was read, even while the reply is still being worked on.
// Sendblue sends these only for iMessage/RCS, best effort; never blocks.
export async function markRead(number: string): Promise<void> {
  if (isTestNumber(number)) return;
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
    if (!res.ok) console.error(`markRead: ${res.status} (non-fatal)`);
  } catch (err: any) {
    console.error("markRead failed (non-fatal):", err?.message ?? err);
  }
}

// Tapbacks (Royce, 2026-09-15: "see if Co is able to react to messages like a
// thumbs up ... or just send an emoji when it doesn't have anything to say").
// Apple only delivers these on iMessage, so the caller falls back to a plain
// emoji text when this returns false.
export async function sendReaction(messageHandle: string, reaction: string): Promise<boolean> {
  // A message gets one reaction from Co, whichever path asks (services/tapbacks.ts).
  // The message already has one, so there's nothing more to send.
  if (!claimReaction(messageHandle)) {
    console.warn(`sendReaction: already reacted to message …${messageHandle.slice(-8)}; not sending ${reaction}`);
    return true;
  }
  // A test member's message: the tapback counts as given, nothing is sent.
  if (isTestHandle(messageHandle)) {
    confirmReaction(messageHandle);
    return true;
  }
  const from = process.env.SENDBLUE_PHONE_NUMBER;
  if (!from || !process.env.SENDBLUE_API_KEY || !process.env.SENDBLUE_SECRET_KEY) {
    releaseReaction(messageHandle);
    return false;
  }
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
      releaseReaction(messageHandle);
      return false;
    }
    confirmReaction(messageHandle);
    return true;
  } catch (err: any) {
    console.error("sendReaction failed (non-fatal):", err?.message ?? err);
    releaseReaction(messageHandle);
    return false;
  }
}

// Blocks a number in Sendblue so its texts stop reaching Co (2026-09-24,
// used for automated senders at the invite gate). Account-wide, so it covers
// prod too. The SDK has no call for it; POST /api/v2/block takes "handle"
// (confirmed live: "number" is rejected with "Invalid handle"). Never throws.
export async function blockSender(handle: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.sendblue.co/api/v2/block", {
      method: "POST",
      headers: {
        "sb-api-key-id": process.env.SENDBLUE_API_KEY ?? "",
        "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle, from_number: process.env.SENDBLUE_PHONE_NUMBER }),
    });
    if (!res.ok) console.error(`blockSender: Sendblue refused (${res.status}) (non-fatal)`);
    return res.ok;
  } catch (err: any) {
    console.error("blockSender failed (non-fatal):", err?.message ?? err);
    return false;
  }
}
