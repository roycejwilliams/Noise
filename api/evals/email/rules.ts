// Model-free checks for Co's email design (services/emailDesign.ts, the
// Figma "Email Campaigns" page approved 2026-09-24). No network.
//
//   npx tsx evals/email/rules.ts
import { readFileSync } from "fs";
import { escapeHtml, galleryEmail, letterpressEmail, quietEmail, spacedCode } from "../../src/services/emailDesign.js";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}`);
  }
};
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const quiet = quietEmail({ preview: "481 206. It expires in five minutes.", headline: "Your code.", code: "481206", lines: ["It expires in five minutes."] });
const welcome = letterpressEmail({ preview: "p", headline: "You're in.", lead: "Lead.", steps: ["One.", "Two.", "Three."], cta: { label: "Text Cue", href: "sms:+10000000000" } });
const intro = galleryEmail({ preview: "p", eyebrow: "An introduction", headline: "Jordan, meet Ellis.", body: ["Reason <b>with</b> “quotes” & José."], close: "You both said yes. Take it from here." });

for (const [name, html] of [["quiet", quiet], ["letterpress", welcome], ["gallery", intro]] as const) {
  check(`${name}: loads Fraunces from Google Fonts`, html.includes("https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;1,400"));
  check(`${name}: loads Satoshi from Fontshare`, html.includes("https://api.fontshare.com/v2/css?f[]=satoshi@400,500"));
  check(`${name}: Fraunces falls back to Georgia`, html.includes("'Fraunces', Georgia"));
  check(`${name}: Satoshi falls back to system sans`, html.includes("'Satoshi', -apple-system"));
  check(`${name}: white background, light only`, /background:#FFFFFF/.test(html) && html.includes('content="light only"'));
  check(`${name}: centered`, html.includes("text-align:center"));
  check(`${name}: plain ASCII (encoding-proof)`, !/[^\x00-\x7F]/.test(html));
  check(`${name}: no em dashes`, !html.includes("&#8212;") && !html.includes("—"));
  check(`${name}: footer line`, html.includes("Private, by referral"));
  check(`${name}: hidden preview text`, html.includes("display:none;max-height:0"));
}
check("the code is set as two groups of three", quiet.includes("481 206") && spacedCode("123456") === "123 456" && spacedCode("12345") === "12345");
// Royce, 2026-09-24: no panel behind the code, just the maroon digits.
check("the code is maroon with no background panel", quiet.includes("color:#A23C59") && !quiet.includes("#EFECE6"));
check("welcome has the gold border and numbered steps", welcome.includes("border:1px solid #C2A885") && welcome.includes(">01<") && welcome.includes(">03<"));
check("welcome button texts Cue", welcome.includes('href="sms:+10000000000"') && welcome.includes("Text Cue"));
check("names and reasons are escaped, not injected", intro.includes("&lt;b&gt;with&lt;/b&gt;") && !intro.includes("<b>with</b>"));
check("accents and curly quotes survive as entities", intro.includes("Jos&#233;") && intro.includes("&#8220;quotes&#8221;"));
check("escapeHtml handles quotes", escapeHtml(`a"b'c`) === "a&quot;b&#39;c");

const otp = src("src/otpActions.ts");
check("the old black template is gone", !/EMAIL_STYLES|emailTemplate\(|OTP_BOX|background:#000000/.test(otp));
check("every code email uses the Quiet layout", (otp.match(/quietEmail\(\{/g) ?? []).length === 7);
check("the welcome uses Letterpress", /letterpressEmail\(\{/.test(otp));
check("the welcome no longer points at an app", !otp.includes("app.copatible.com"));
check("the welcome button only shows when Cue's number is set", /cta: coNumber \? \{ label: "Text Cue", href: `sms:\$\{coNumber\}` \} : undefined/.test(otp));
for (const f of ["src/services/networkIntroNudge.ts", "src/services/eventGuestMatchHandoff.ts"]) {
  const s = src(f);
  check(`${f}: introductions use the Gallery layout`, /galleryEmail\(\{/.test(s) && !s.includes("<p>Hi both,</p>"));
}

console.log(`email design rules: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
