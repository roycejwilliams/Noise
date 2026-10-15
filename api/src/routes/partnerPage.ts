// The page a partner night's code opens (services/partners.ts): the link on the partner's RSVP page (the RSVP code) and what
// the door QR encodes (the night's door-only code, services/doorCodes.ts). The door page fills in the door code, which is
// what makes the text an arrival (#213), so it offers a text only during the check-in window. While the code is live it hands the guest straight to Messages with their first text to Cue filled in, so the guest
// sends the first text, which is all Sendblue allows and all Cue ever does with a non-member: it never texts first. Once the
// night is over the code is dead for good, and a late scan gets one graceful line: the partner's next live night if there is
// one, else the door to the club.
//
// Every word on it is Royce's copy (services/partnerCopy.ts). A line still waiting on him is never shown: the page then has no
// words and, on the live page, no button, so nobody can text in on terms they haven't been told.
// Served by both api/src/server.ts and co-test's server, like /i/:code. Nothing here reads or shows anything about a person.
import type { Request, Response } from "express";
import { AGENT, doorEntryText, entryState, entryText, entryUrl, isEntryCode, nextOpenNight, partnerEvent, resolveEntryCode } from "../services/partners.js";
import { eventForDoorCode, isDoorCode } from "../services/doorCodes.js";
import { copyFor } from "../services/partnerCopy.js";
import { smsInviteHref } from "../services/invites.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// title: the night's name (the partner's own words, public on their RSVP page) or nothing.
export function page(title: string | null, line: string | null, button: { href: string; label: string } | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title ?? AGENT)}</title>
<meta property="og:title" content="${esc(title ?? AGENT)}">
${line ? `<meta property="og:description" content="${esc(line)}">` : ""}
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; color: #f4f2ee;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  main { max-width: 360px; padding: 32px 24px; text-align: center; }
  .mark { font-size: 44px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 28px; }
  h1 { font-size: 22px; font-weight: 500; margin: 0 0 10px; }
  p { font-size: 16px; line-height: 1.5; color: #b9b5ae; margin: 0 0 32px; }
  a.btn { display: inline-block; padding: 14px 28px; border-radius: 999px; background: #f4f2ee; color: #0b0b0c;
    font-size: 16px; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
  <div class="mark">${esc(AGENT)}</div>
  ${title ? `<h1>${esc(title)}</h1>` : ""}
  ${line ? `<p>${esc(line)}</p>` : ""}
  ${button ? `<a class="btn" href="${esc(button.href)}">${esc(button.label)}</a>` : ""}
</main>
</body>
</html>`;
}

// What the page shows for one code, from its state (pure apart from the lookups it's handed; checked in evals/partners).
export type PageView = { status: number; title: string | null; line: string | null; button: { href: string; label: string } | null };
export async function partnerPageView(
  rawCode: string,
  o: { phone: string; now?: Date; resolve?: typeof resolveEntryCode; resolveDoor?: (code: string) => Promise<Awaited<ReturnType<typeof partnerEvent>>>; next?: typeof nextOpenNight; checkinOpen?: (e: { start_at: string; end_at?: string | null; timezone?: string | null }, now: Date) => boolean },
): Promise<PageView> {
  const now = o.now ?? new Date();
  const code = rawCode.trim().toUpperCase();
  if (!o.phone) return { status: 500, title: null, line: null, button: null };
  const door = isDoorCode(code);
  const resolveDoor = o.resolveDoor ?? (async (c: string) => {
    const hit = await eventForDoorCode(c);
    return hit ? partnerEvent(hit.eventId) : null;
  });
  const found = isEntryCode(code) ? await (o.resolve ?? resolveEntryCode)(code).catch(() => null) : door ? await resolveDoor(code).catch(() => null) : null;
  if (!found) return { status: 404, title: null, line: copyFor("page_invalid", { agent: AGENT }), button: null };
  const vars = { agent: AGENT, event: found.event.name, partner: found.partner.name, code };
  const state = entryState(found.partner, found.event, now);
  // The door page opens a text only while the door is: inside the check-in window (the door code is an arrival).
  const checkinOpen = o.checkinOpen ?? (await import("../services/eventWalkinCheckin.js")).isCheckinOpen;
  if (state === "open" && door && !checkinOpen(found.event, now)) {
    return { status: 200, title: found.event.name, line: copyFor("page_not_open", vars), button: null };
  }
  if (state === "open") {
    // The button exists only with both its terms and its text approved: no one texts in without being told what it means.
    const terms = copyFor("page_open_terms", vars);
    const text = door ? doorEntryText(found.event.name, code) : entryText(found.event.name, found.event.code);
    const label = copyFor("page_open_button", vars);
    return { status: 200, title: found.event.name, line: terms, button: terms && text && label ? { href: smsInviteHref(o.phone, text), label } : null };
  }
  if (state === "not_open") return { status: 200, title: found.event.name, line: copyFor("page_not_open", vars), button: null };
  // Over, or the partner's agreement ended: dead for good. One graceful line, and their next live night if there is one.
  const next = state === "over" ? await (o.next ?? nextOpenNight)(found.partner, found.event.api_id, now).catch(() => null) : null;
  const nextUrl = next ? entryUrl(next.code) : null;
  if (next && nextUrl) {
    const nv = { ...vars, next: next.name };
    const line = copyFor("page_over_next", nv);
    const label = copyFor("page_over_next_button", nv);
    if (line) return { status: 410, title: found.event.name, line, button: label ? { href: nextUrl, label } : null };
  }
  return { status: 410, title: found.event.name, line: copyFor("page_over", vars), button: null };
}

// GET /r/:code
export async function servePartnerPage(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const phone = process.env.SENDBLUE_PHONE_NUMBER ?? "";
  if (!phone) console.error("partner page: SENDBLUE_PHONE_NUMBER is not set, so no entry link can work");
  const v = await partnerPageView(String(req.params.code ?? ""), { phone });
  return res.status(v.status).send(page(v.title, v.line, v.button));
}
