// Voice memos and voice notes go through OpenAI, never ElevenLabs (2026-11-02: ElevenLabs is being cancelled). Zero tokens: the
// memo download, OpenAI and Sendblue are answered locally, and every outside fetch is recorded, so a stray ElevenLabs call shows.
//   - a voice memo: the download, then OpenAI's transcription (gpt-transcribe, the file as it came for a format OpenAI takes, an
//     iMessage CAF memo converted to mp3 first), and the words go to the reply unchanged
//   - a voice note: OpenAI's speech (gpt-4o-mini-tts, the calls' voice, mp3), cached and served at /audio/:id as before
//   - failures fall back as before: a memo becomes "[voice memo]", a voice note goes as a text
//   - no ElevenLabs fetch on either path, and nothing reachable imports the ElevenLabs client
//
//   npx tsx --import ./evals/lib/modelGuard.mjs evals/voice/openaiAudio.ts
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

const USER = "00000000-0000-4000-8000-00000000cafe";
const WORDS = "I'm moving to Lisbon in March and want to meet people there";
const CAF_URL = "https://storage.sendblue.test/voice/memo.caf";
const M4A_URL = "https://storage.sendblue.test/voice/memo.m4a";
const CAF_BYTES = new Uint8Array([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0, 9, 9]);
const M4A_BYTES = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 7, 7]);
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3]);
const SPOKEN = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 5, 6, 7, 8]);

type Seen = { url: string; method: string; form: Record<string, string | { name: string; type: string; bytes: number[] }>; json: any };
const seen: Seen[] = [];
let openaiAnswer: "ok" | "400" | "401" = "ok";
const guardFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  // The OpenAI SDK's one-time FormData check fetches "data:,"; answered here so the guard doesn't log it as an outside call.
  if (url.startsWith("data:")) return new Response("");
  const s: Seen = { url, method: init?.method ?? "GET", form: {}, json: null };
  if (init?.body instanceof FormData) {
    for (const [k, v] of init.body.entries()) s.form[k] = typeof v === "string" ? v : { name: (v as File).name, type: (v as File).type, bytes: [...new Uint8Array(await (v as File).arrayBuffer())] };
  } else if (typeof init?.body === "string") {
    try {
      s.json = JSON.parse(init.body);
    } catch {}
  }
  seen.push(s);
  if (url === CAF_URL) return new Response(CAF_BYTES, { status: 200, headers: { "content-type": "audio/x-caf" } });
  if (url === M4A_URL) return new Response(M4A_BYTES, { status: 200, headers: { "content-type": "audio/mp4" } });
  if (/api\.openai\.com/.test(url)) {
    if (openaiAnswer !== "ok") return new Response(JSON.stringify({ error: { message: "refused", type: "invalid_request_error" } }), { status: Number(openaiAnswer), headers: { "content-type": "application/json" } });
    if (/\/audio\/transcriptions$/.test(url)) return new Response(JSON.stringify({ text: WORDS, languages: [{ code: "en" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (/\/audio\/speech$/.test(url)) return new Response(SPOKEN, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }
  return guardFetch(input, init);
}) as typeof fetch;
const elevenLabsFetches = () => seen.filter((s) => /elevenlabs/i.test(s.url));

// No team alert texts from a refused key in this test.
const { setKeyAlertForTests, createKeyAlert } = await import("../../src/services/modelKeyAlert.js");
const alerts: string[] = [];
setKeyAlertForTests(createKeyAlert({ send: async (t) => (alerts.push(t), true) }));

const A = await import("../../src/services/openaiAudio.js");
const converted: { bytes: number[]; extension: string }[] = [];
A.setConverterForTests(async (audio, extension) => {
  converted.push({ bytes: [...audio], extension });
  return MP3_BYTES;
});
const { voiceMemoText, sendCoReply } = await import("../../src/routes/sendblue.js");
const { generateVoiceNote, getAudioEntry } = await import("../../src/services/voiceNote.js");
const { gptLiveVoice } = await import("../../src/services/gptLive.js");

// ---------------------------------------------------------------- an iMessage memo (CAF): converted, then transcribed
seen.length = 0;
const caf = await voiceMemoText(CAF_URL, USER);
const cafCall = seen.find((s) => /\/v1\/audio\/transcriptions$/.test(s.url));
check("CAF memo: the words come back for the reply, unchanged", caf === WORDS);
check("CAF memo: downloaded first", seen[0]?.url === CAF_URL);
check("CAF memo: converted once, from the downloaded bytes, as caf", converted.length === 1 && converted[0].extension === "caf" && JSON.stringify(converted[0].bytes) === JSON.stringify([...CAF_BYTES]));
check("CAF memo: OpenAI transcription called once, POST", seen.filter((s) => /\/v1\/audio\/transcriptions$/.test(s.url)).length === 1 && cafCall?.method === "POST");
check("CAF memo: model gpt-transcribe", cafCall?.form.model === "gpt-transcribe");
const cafFile = cafCall?.form.file as { name: string; type: string; bytes: number[] } | undefined;
check("CAF memo: the converted mp3 is the file sent", !!cafFile && cafFile.type === "audio/mpeg" && cafFile.name.endsWith(".mp3") && JSON.stringify(cafFile.bytes) === JSON.stringify([...MP3_BYTES]));
check("CAF memo: no language forced (OpenAI detects it, as Scribe did)", !!cafCall && !("language" in cafCall.form) && !("languages" in cafCall.form) && !("languages[]" in cafCall.form));
check("CAF memo: no ElevenLabs fetch", elevenLabsFetches().length === 0);

// ---------------------------------------------------------------- a format OpenAI takes goes as it came
seen.length = 0;
converted.length = 0;
const m4a = await voiceMemoText(M4A_URL, USER);
const m4aCall = seen.find((s) => /\/v1\/audio\/transcriptions$/.test(s.url));
const m4aFile = m4aCall?.form.file as { name: string; type: string; bytes: number[] } | undefined;
check("m4a memo: transcribed", m4a === WORDS);
check("m4a memo: not converted", converted.length === 0);
check("m4a memo: the original bytes and type are sent", !!m4aFile && m4aFile.type === "audio/mp4" && m4aFile.name.endsWith(".m4a") && JSON.stringify(m4aFile.bytes) === JSON.stringify([...M4A_BYTES]));
check("m4a memo: no ElevenLabs fetch", elevenLabsFetches().length === 0);

// ---------------------------------------------------------------- failures fall back the same way as before
seen.length = 0;
openaiAnswer = "400";
check("OpenAI refusing the memo: falls back to [voice memo]", (await voiceMemoText(M4A_URL, USER)) === "[voice memo]");
check("OpenAI refusing the memo: no ElevenLabs fetch", elevenLabsFetches().length === 0);
openaiAnswer = "401";
check("a refused key: falls back to [voice memo]", (await voiceMemoText(M4A_URL, USER)) === "[voice memo]");
check("a refused key: the team key alert fires once", alerts.length === 1);
openaiAnswer = "ok";
A.setConverterForTests(async () => {
  throw new Error("ffmpeg unavailable: spawn ffmpeg ENOENT");
});
seen.length = 0;
check("a CAF memo that can't be converted: falls back to [voice memo]", (await voiceMemoText(CAF_URL, USER)) === "[voice memo]");
check("a CAF memo that can't be converted: nothing sent to OpenAI", !seen.some((s) => /openai/.test(s.url)));
A.setConverterForTests(null);

// ---------------------------------------------------------------- a voice note: OpenAI speech, the calls' voice, mp3
seen.length = 0;
const NOTE = "Lisbon in March sounds right. I'll keep an eye out for people there.";
const url = await generateVoiceNote(NOTE);
const speech = seen.filter((s) => /\/v1\/audio\/speech$/.test(s.url));
check("voice note: OpenAI speech called once, POST", speech.length === 1 && speech[0].method === "POST");
check("voice note: model gpt-4o-mini-tts", speech[0]?.json?.model === "gpt-4o-mini-tts");
check("voice note: marin, the calls' voice", speech[0]?.json?.voice === "marin" && gptLiveVoice({}) === "marin");
check("voice note: the words as given", speech[0]?.json?.input === NOTE);
check("voice note: mp3 (served as audio/mpeg, as before)", speech[0]?.json?.response_format === "mp3");
const id = url.split("/audio/")[1];
check("voice note: served from /audio/:id with OpenAI's bytes", /\/audio\/[0-9a-f-]{36}$/.test(url) && Buffer.compare(getAudioEntry(id)?.buffer ?? Buffer.alloc(0), SPOKEN) === 0);
check("voice note: no ElevenLabs fetch", elevenLabsFetches().length === 0);
{
  const prev = process.env.GPT_LIVE_VOICE;
  process.env.GPT_LIVE_VOICE = "cedar";
  seen.length = 0;
  await generateVoiceNote("Same voice as the calls.");
  check("voice note: follows the calls' voice setting (GPT_LIVE_VOICE)", seen.find((s) => /\/v1\/audio\/speech$/.test(s.url))?.json?.voice === "cedar");
  if (prev === undefined) delete process.env.GPT_LIVE_VOICE;
  else process.env.GPT_LIVE_VOICE = prev;
}

// ---------------------------------------------------------------- the reply path: voice in, voice out; a failed note goes as text
{
  const { default: sendblue } = await import("../../src/services/sendblue.js");
  const realSend = sendblue.messages.send;
  const sent: any[] = [];
  (sendblue.messages as any).send = async (b: any) => {
    sent.push(b);
    return {};
  };
  seen.length = 0;
  check("sendCoReply as voice: sent", (await sendCoReply({ phone: "+15035550123", message: NOTE, asVoice: true })) === true);
  check("sendCoReply as voice: a media url, no text", sent.length === 1 && /\/audio\//.test(sent[0].media_url ?? "") && sent[0].content === "");
  check("sendCoReply as voice: through OpenAI speech, no ElevenLabs fetch", seen.some((s) => /\/v1\/audio\/speech$/.test(s.url)) && elevenLabsFetches().length === 0);
  sent.length = 0;
  openaiAnswer = "400";
  check("sendCoReply, speech refused: still sent", (await sendCoReply({ phone: "+15035550123", message: NOTE, asVoice: true })) === true);
  check("sendCoReply, speech refused: falls back to the words as a text", sent.length === 1 && sent[0].content === NOTE && !sent[0].media_url);
  openaiAnswer = "ok";
  (sendblue.messages as any).send = realSend;
}

// ---------------------------------------------------------------- nothing reachable here uses the ElevenLabs client
const src = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
for (const f of ["routes/sendblue.ts", "services/voiceNote.ts", "services/openaiAudio.ts", "routes/co.ts"]) {
  check(`${f} doesn't import the ElevenLabs client`, !/from ["'][./]+(services\/)?elevenlabs(\.js)?["']|@elevenlabs\/elevenlabs-js/.test(src(f)));
}
// The ElevenLabs forget queue stays (old October conversations): it needs only its key, never the call agent.
{
  const forget = src("services/elevenLabsForget.ts");
  check("forget queue: no agent client, no agent id (only the key and the off switch)", !/from ["']\.\/(elevenLabsCalls|elevenlabs)(\.js)?["']|ELEVENLABS_AGENT_ID|ELEVENLABS_VOICE_ID/.test(forget));
  check("forget queue: the 30-minute pass still runs it", /runDeletionPass\(\)/.test(src("jobs/index.ts")));
}
check("the voice branch still goes through voiceMemoText", /if \(isVoice\) \{\s*resolvedContent = await voiceMemoText\(media_url, user\.id\);/.test(src("routes/sendblue.ts")));

globalThis.fetch = guardFetch;
setKeyAlertForTests(null);
console.info(`\nvoice through OpenAI: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
