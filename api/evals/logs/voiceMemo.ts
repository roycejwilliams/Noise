// Railway logs never get a voice memo's words or a phone number
// (routes/sendblue.ts voiceMemoText, 2026-10-18: the log line was
// `Transcribed voice memo from +1…: "<the whole transcript>"`). Zero tokens:
// the audio download and OpenAI's transcription are answered by a local fake fetch (the CAF memo's conversion by a fake converter).
//
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/logs/voiceMemo.ts
import { readFileSync } from "fs";

let failed = 0;
let total = 0;
const check = (label: string, ok: boolean) => {
  total++;
  if (!ok) {
    failed++;
    console.info(`FAIL ${label}`);
  }
};

const SECRET = "I think I'm leaving Marcus and moving to Lisbon in March";
const PHONE = "+15035550147";
const USER = "00000000-0000-4000-8000-00000000beef";
const AUDIO_URL = "https://storage.sendblue.test/voice/abc123.caf";

// Every console line the code writes, by level.
const logged: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
const capture = () => {
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x))).join(" "));
};
const release = () => Object.assign(console, orig);
const digits = PHONE.replace(/\D/g, "");
const leaks = (lines: string[]) => lines.some((l) => l.includes(SECRET) || l.includes("Lisbon") || l.replace(/\D/g, "").includes(digits.slice(1)));

const { voiceMemoText, phoneTail } = await import("../../src/routes/sendblue.js");
// No ffmpeg in layer 1: the CAF memo's conversion to mp3 is answered locally.
(await import("../../src/services/openaiAudio.js")).setConverterForTests(async () => Buffer.from([0x49, 0x44, 0x33]));

// ---------------------------------------------------------------- the real transcription path
// The audio download and OpenAI's transcription answered locally, so the code runs as it does live.
const guardFetch = globalThis.fetch;
const sawUrls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  // The OpenAI SDK's one-time FormData check fetches "data:,"; answered here so the guard doesn't log it as an outside call.
  if (url.startsWith("data:")) return new Response("");
  sawUrls.push(url);
  if (url === AUDIO_URL) return new Response(new Uint8Array([0x63, 0x61, 0x66, 0x66, 1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/x-caf" } });
  if (/api\.openai\.com\/v1\/audio\/transcriptions$/.test(url)) return new Response(JSON.stringify({ text: SECRET, languages: [{ code: "en" }] }), { status: 200, headers: { "content-type": "application/json" } });
  return guardFetch(input, init);
}) as typeof fetch;

logged.length = 0;
capture();
const real = await voiceMemoText(AUDIO_URL, USER);
release();
check("the real path reached OpenAI (not the failure fallback), never ElevenLabs", sawUrls.some((u) => /api\.openai\.com/.test(u)) && !sawUrls.some((u) => /elevenlabs/.test(u)) && real === SECRET);
check("real path: the transcript is returned for the reply", real === SECRET);
check("real path: a log line says a memo was transcribed", logged.some((l) => /voice memo transcribed/.test(l)));
check("real path: the log names the user id and the length", logged.some((l) => l.includes(USER) && l.includes(`${SECRET.length} chars`)));
check("real path: no transcript words in any log line", !leaks(logged));

// ---------------------------------------------------------------- an injected transcriber (phone in the url, as Sendblue can)
logged.length = 0;
capture();
const out = await voiceMemoText(`https://storage.sendblue.test/${digits}/memo.caf`, USER, async () => `${SECRET}, call me at ${PHONE}`);
release();
check("the words still go to the reply", out.includes(SECRET));
check("no transcript or phone in any log line", !leaks(logged));

// ---------------------------------------------------------------- a failed transcription
logged.length = 0;
capture();
const failedOut = await voiceMemoText(AUDIO_URL, USER, async () => {
  throw new Error("Audio fetch failed: 403");
});
release();
check("a failed transcription falls back to the placeholder", failedOut === "[voice memo]");
check("the failure is logged with the user id and the reason", logged.some((l) => /transcription failed/.test(l) && l.includes(USER) && /403/.test(l)));
check("the failure log has no phone", !leaks(logged));

globalThis.fetch = guardFetch;

// ---------------------------------------------------------------- a failed reply never logs the number (sendCoReply)
{
  const { withoutPhones, sendCoReply } = await import("../../src/routes/sendblue.js");
  check("withoutPhones: +1 number", withoutPhones(`invalid number ${PHONE}`) === "invalid number …0147");
  check("withoutPhones: formatted numbers", !/5550147|555-0147/.test(withoutPhones("call (503) 555-0147 or 503.555.0147 or +1 503 555 0147")));
  check("withoutPhones: dates, statuses and short numbers stay", withoutPhones("2026-10-18 status 400 code 10002") === "2026-10-18 status 400 code 10002");
  const { default: sendblue } = await import("../../src/services/sendblue.js");
  const realSend = sendblue.messages.send;
  const run = async (errs: Error[], replyTo: string | null, phone: string) => {
    let i = 0;
    (sendblue.messages as any).send = async () => {
      throw errs[Math.min(i++, errs.length - 1)];
    };
    logged.length = 0;
    capture();
    const ok = await sendCoReply({ phone, message: "See you Thursday.", asVoice: false, replyTo });
    release();
    return ok;
  };
  // Sendblue's error can echo the number it was sending to.
  const echo = new Error(`Sendblue 400: ${PHONE} is not a valid iMessage recipient`);
  check("a failed plain reply returns false", (await run([echo], null, PHONE)) === false);
  check("a failed plain reply logs no full number (from the phone or from Sendblue's error)", logged.length > 0 && !leaks(logged) && logged.some((l) => l.includes("…0147")));
  const other = "+15035550188";
  await run([echo, echo], "handle-1", other);
  check("an inline reply refused, then the plain send failing: no full number in either line", logged.length >= 2 && !logged.some((l) => l.replace(/\D/g, "").includes("5035550188") || l.replace(/\D/g, "").includes("5035550147")));
  await run([new Error(`send breaker open for ${PHONE}`)], "handle-2", "+15035550199");
  check("the send-breaker line logs no full number", logged.length > 0 && !logged.some((l) => /5035550199|5035550147/.test(l.replace(/\D/g, ""))));
  (sendblue.messages as any).send = realSend;
}

// ---------------------------------------------------------------- the webhook handler's own log lines
check("a phone shows as its last four digits", phoneTail(PHONE) === "…0147" && phoneTail(null) === "…");
const src = readFileSync(new URL("../../src/routes/sendblue.ts", import.meta.url), "utf8");
const start = src.indexOf("const handleWebhook = async");
const end = src.indexOf('router.post("/webhook"', start);
check("found the webhook handler", start > 0 && end > start);
const handler = src.slice(start, end);
const calls: string[] = [];
for (const m of handler.matchAll(/console\.(log|error|warn|info|debug)\(/g)) {
  let i = m.index! + m[0].length;
  let depth = 1;
  let q: string | null = null;
  while (i < handler.length && depth > 0) {
    const c = handler[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  calls.push(handler.slice(m.index!, i));
}
check("the handler has log lines to check", calls.length > 20);
const leaky = calls.filter((c) => /\$\{\s*(number|phone|phone_number|user\.phone_number|resolvedContent|content|transcript|text)\s*\}|,\s*(number|resolvedContent|content|transcript)\s*\)\s*$/.test(c));
check(`no handler log line prints the number or the member's words${leaky.length ? `: ${leaky.map((c) => c.slice(0, 90)).join(" || ")}` : ""}`, leaky.length === 0);
// Every log line in the whole file, not just the handler: none prints a number, a phone or the member's words.
{
  const all: string[] = [];
  for (const m of src.matchAll(/console\.(log|error|warn|info|debug)\(/g)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    let q: string | null = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (q) {
        if (c === "\\") i++;
        else if (c === q) q = null;
      } else if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    all.push(src.slice(m.index!, i));
  }
  const bad = all.filter((c) => /\$\{\s*(number|phone|phone_number|user\.phone_number|resolvedContent|content|transcript|text)\s*\}|,\s*(number|phone|resolvedContent|content|transcript)\s*\)\s*$/.test(c));
  check(`no log line in routes/sendblue.ts prints the number or the member's words${bad.length ? `: ${bad.map((c) => c.slice(0, 90)).join(" || ")}` : ""}`, bad.length === 0);
  // Error text that can echo the number goes through withoutPhones.
  check("Sendblue's delivery error_message is logged through withoutPhones", /failed: \$\{error_code\} — \$\{withoutPhones\(error_message\)\}/.test(src));
}
check("the voice branch goes through voiceMemoText", /if \(isVoice\) \{\s*resolvedContent = await voiceMemoText\(media_url, user\.id\);/.test(handler));
check("the old transcript line is gone", !/Transcribed voice memo from/.test(src));

console.info(`\nvoice memo log: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
