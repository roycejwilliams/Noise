// The page a member's invite link opens (services/invites.ts). It hands the
// friend straight to Messages with a first text to Co filled in ("Hi Co,
// Royce invited me. Code: …"), so the friend sends the first text, which is
// all Sendblue allows. The link preview in iMessage reads the og: tags.
// Served by both api/src/server.ts and co-test's server, like /co.vcf.
import type { Request, Response } from "express";
import pool from "../db/db.js";
import { normalizeInviteCode } from "../services/inviteCodes.js";
import { inviteGreeting, smsInviteHref } from "../services/invites.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, line: string, button: { href: string; label: string } | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(line)}">
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
  <div class="mark">Co</div>
  <h1>${esc(title)}</h1>
  <p>${esc(line)}</p>
  ${button ? `<a class="btn" href="${esc(button.href)}">${esc(button.label)}</a>` : ""}
</main>
</body>
</html>`;
}

// GET /i/:code
export async function serveInvitePage(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const code = normalizeInviteCode(String(req.params.code ?? ""));
  const coPhone = process.env.SENDBLUE_PHONE_NUMBER ?? "";
  const row = /^[A-Z0-9]{8}$/.test(code)
    ? (
        await pool
          .query(
            `SELECT ic.used_by, u.first_name FROM invite_codes ic LEFT JOIN users u ON u.id = ic.created_by WHERE ic.code = $1`,
            [code],
          )
          .catch(() => ({ rows: [] as any[] }))
      ).rows[0]
    : null;
  if (!coPhone) {
    // Config, not the code: don't send them back for a replacement that would
    // fail the same way (2026-09-20 code review).
    console.error("invite page: SENDBLUE_PHONE_NUMBER is not set, so no invite link can work");
    return res.status(500).send(page("Something's off on our end.", "Not your invite. Try again in a bit.", null));
  }
  if (!row) {
    return res.status(404).send(page("This invite isn't valid.", "Ask whoever sent it for a new one.", null));
  }
  if (row.used_by) {
    return res.status(410).send(page("This invite has been used.", "Ask whoever sent it for a new one.", null));
  }
  const inviter: string | null = row.first_name?.trim() || null;
  const title = inviter ? `${inviter} invited you to Co.` : "You're invited to Co.";
  const href = smsInviteHref(coPhone, inviteGreeting(inviter, code));
  return res.status(200).send(page(title, "Tap below to text Co. Your invite code is already filled in.", { href, label: "Text Co" }));
}
