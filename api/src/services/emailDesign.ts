// Co's email design (Royce, 2026-09-24; Figma "Email Campaigns" page,
// node 271:6). White and centered, Fraunces for headlines and Co's lines,
// Satoshi for the rest, with Georgia and system sans as the fallbacks most
// inboxes will actually show. Three layouts from the approved set:
//   quietEmail        5 · Quiet: codes and account notes
//   letterpressEmail  2 · Letterpress: the welcome
//   galleryEmail      1 · Gallery: introductions
// Tables and inline styles only, so Gmail and Outlook render them too.
// Body text is 14px (Royce, 2026-09-25: "make sure the body font for all
// emails aren't too big").

export const EMAIL_COLORS = {
  white: "#FFFFFF",
  ink: "#261318",
  body: "#3A2C30",
  muted: "#8A7A70",
  soft: "#6F6058",
  line: "#E4DED3",
  cream: "#EFECE6",
  gold: "#C2A885",
  maroon: "#A23C59",
} as const;
const C = EMAIL_COLORS;

const SERIF = "'Fraunces', Georgia, 'Times New Roman', serif";
const SANS = "'Satoshi', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";

export function escapeHtml(s: string): string {
  // Anything outside ASCII becomes a numeric entity, so a curly quote or a
  // name with an accent survives an inbox that guesses the wrong encoding.
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/[^\x00-\x7F]/gu, (ch) => `&#${ch.codePointAt(0)};`);
}

// "481206" reads as "481 206", the way the design sets it.
export function spacedCode(code: string): string {
  const c = String(code).replace(/\s+/g, "");
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

const block = (html: string, gap = 28) => `<tr><td align="center" style="padding:0 0 ${gap}px 0;">${html}</td></tr>`;

const brand = () => block(`<div style="font-family:${SERIF};font-size:30px;line-height:1;color:${C.ink};">Cue.</div>`);

const eyebrow = (text: string) =>
  block(`<div style="font-family:${SANS};font-size:11px;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};">${escapeHtml(text)}</div>`, 18);

const headline = (text: string, size = 38) =>
  block(`<h1 style="margin:0;font-family:${SERIF};font-weight:300;font-size:${size}px;line-height:1.15;color:${C.ink};">${escapeHtml(text)}</h1>`);

const para = (text: string, o: { size?: number; color?: string } = {}) =>
  block(`<p style="margin:0;font-family:${SANS};font-size:${o.size ?? 14}px;line-height:1.65;color:${o.color ?? C.body};">${escapeHtml(text)}</p>`);

const italic = (text: string, size = 16) =>
  block(`<p style="margin:0;font-family:${SERIF};font-style:italic;font-size:${size}px;line-height:1.5;color:${C.ink};">${escapeHtml(text)}</p>`);

const button = (label: string, href: string, outline = false) =>
  block(
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 30px;border:1px solid ${C.ink};background:${outline ? "transparent" : C.ink};color:${outline ? C.ink : C.white};font-family:${SANS};font-size:13px;font-weight:500;letter-spacing:0.8px;text-transform:uppercase;text-decoration:none;border-radius:2px;">${escapeHtml(label)}</a>`,
  );

const codeBox = (code: string) =>
  block(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:10px 28px;font-family:${SERIF};font-weight:300;font-size:52px;line-height:1;letter-spacing:6px;color:${C.maroon};">${escapeHtml(spacedCode(code))}</td></tr></table>`,
  );

const footer = () =>
  `<tr><td style="padding:8px 0 0 0;border-top:1px solid ${C.line};"></td></tr>` +
  block(`<div style="padding-top:12px;font-family:${SANS};font-size:11px;font-weight:500;letter-spacing:1px;text-transform:uppercase;color:${C.muted};">Noise &nbsp;&middot;&nbsp; Private, by referral</div>`, 0);

function shell(rows: string, preview: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;1,400&display=swap" rel="stylesheet"><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500&display=swap" rel="stylesheet">
<style>body{margin:0;padding:0;background:${C.white};}@media (max-width:620px){.co-pad{padding:40px 24px!important;}}</style></head>
<body style="margin:0;padding:0;background:${C.white};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.white}" style="background:${C.white};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;text-align:center;"><tr><td class="co-pad" style="padding:56px 56px 48px 56px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align:center;">${rows}</table>
</td></tr></table></td></tr></table></body></html>`;
}

// 5 · Quiet: one headline, an optional code, a line or two, nothing to skim past.
export function quietEmail(o: { preview: string; headline: string; lines?: string[]; code?: string; note?: string; signOff?: boolean }): string {
  const rows =
    brand() +
    headline(o.headline, 40) +
    (o.code ? codeBox(o.code) : "") +
    (o.lines ?? []).map((l) => para(l)).join("") +
    (o.note ? para(o.note, { size: 12, color: C.muted }) : "") +
    (o.signOff === false ? "" : italic("Cue", 16)) +
    footer();
  return shell(rows, o.preview);
}

// 2 · Letterpress: a thin gold border, a centered serif, numbered next steps.
export function letterpressEmail(o: { preview: string; headline: string; lead: string; steps: string[]; cta?: { label: string; href: string } }): string {
  const steps = o.steps
    .map(
      (s, i) =>
        block(`<div style="font-family:${SERIF};font-size:15px;color:${C.gold};padding-bottom:6px;">${String(i + 1).padStart(2, "0")}</div><p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.body};">${escapeHtml(s)}</p>`, 22),
    )
    .join("");
  const inner =
    brand() +
    block(`<div style="width:40px;height:1px;line-height:1px;font-size:1px;background:${C.gold};">&nbsp;</div>`) +
    headline(o.headline, 48) +
    italic(o.lead, 16) +
    steps +
    (o.cta ? button(o.cta.label, o.cta.href, true) : "") +
    italic("Cue", 16);
  const rows =
    `<tr><td style="padding:0 0 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.gold};text-align:center;"><tr><td style="padding:48px 40px 20px 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align:center;">${inner}</table></td></tr></table></td></tr>` +
    footer();
  return shell(rows, o.preview);
}

// 1 · Gallery: white space, one headline, Co's reason, and a quiet close.
export function galleryEmail(o: { preview: string; eyebrow: string; headline: string; body: string[]; close: string; cta?: { label: string; href: string } }): string {
  const rows =
    brand() +
    eyebrow(o.eyebrow) +
    headline(o.headline, 36) +
    o.body.map((b) => para(b)).join("") +
    italic(o.close) +
    (o.cta ? button(o.cta.label, o.cta.href) : "") +
    footer();
  return shell(rows, o.preview);
}
