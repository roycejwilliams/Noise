// iMessage inline replies (Royce, 2026-09-28: "I think we should do inline
// replies", after Instinct answered a text threaded under it). Two sides:
//
// Reading: when a member long-presses one of Co's texts and replies to it,
// Sendblue's webhook carries reply_to.message_handle. Co looks that message
// up, so it knows exactly which text they meant instead of guessing from the
// wording ("that one", which of three sent events).
//
// Sending: Co threads its first text under theirs when it matters, the way
// Instinct and Boardy do: they replied inline themselves, or they've texted
// again since this message and Co's answer would otherwise read as an answer
// to the newer one. Sendblue never downgrades an inline reply: a refused one
// is simply not sent, so the caller resends it as a plain text.
// Needs a V2 Sendblue line and iMessage; SMS goes plain.

export type RepliedTo = { text: string; fromCo: boolean };

const digits = (n: unknown) => String(n ?? "").replace(/\D/g, "").slice(-10);

// The message they replied to, only when it belongs to their own
// conversation with Co (never another member's thread).
export function targetFromMessage(m: any, memberPhone: string): RepliedTo | null {
  if (!m || typeof m.content !== "string" || !m.content.trim()) return null;
  const fromCo = m.is_outbound === true;
  const them = fromCo ? m.number ?? m.to_number : m.from_number ?? m.number;
  if (!digits(memberPhone) || digits(them) !== digits(memberPhone)) return null;
  return { text: m.content.trim().slice(0, 600), fromCo };
}

export async function repliedTo(handle: unknown, memberPhone: string): Promise<RepliedTo | null> {
  if (typeof handle !== "string" || !handle) return null;
  if (!process.env.SENDBLUE_API_KEY || !process.env.SENDBLUE_SECRET_KEY) return null;
  // Straight to the API: services/sendblue.ts's wrapper only carries send.
  try {
    const res = await fetch(`https://api.sendblue.co/api/v2/messages/${encodeURIComponent(handle)}`, {
      headers: { "sb-api-key-id": process.env.SENDBLUE_API_KEY, "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`inlineReply: status lookup ${res.status} (non-fatal)`);
      return null;
    }
    const j: any = await res.json();
    return targetFromMessage(j?.data ?? j, memberPhone);
  } catch (err: any) {
    console.error("inlineReply: couldn't look up the replied-to message (non-fatal):", err?.message ?? err);
    return null;
  }
}

export function repliedToFact(r: RepliedTo): string {
  return r.fromCo
    ? `They replied directly to this earlier text from Co (iMessage inline reply), so their message is about it: "${r.text}"`
    : `They replied directly to their own earlier text (iMessage inline reply), so their message is about it: "${r.text}"`;
}

// Kept with their message in the conversation record, the way a photo is.
export function inlineNote(r: RepliedTo): string {
  const t = r.text.length > 200 ? `${r.text.slice(0, 200)}…` : r.text;
  return r.fromCo ? `[Replying to Co's text: "${t}"]` : `[Replying to their own earlier text: "${t}"]`;
}

// Whether Co's first text this turn should thread under theirs.
export function threadReason(o: { theyRepliedInline: boolean; newerTextSince: boolean; isGroup?: boolean }): "mirror" | "newer_text" | null {
  if (o.isGroup) return null;
  if (o.theyRepliedInline) return "mirror";
  if (o.newerTextSince) return "newer_text";
  return null;
}
