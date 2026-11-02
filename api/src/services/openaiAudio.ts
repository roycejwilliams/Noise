import "dotenv/config";
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import OpenAI, { toFile } from "openai";
import { classifyModelFailure, noteModelFailure } from "./modelKeyAlert.js";

// Cue's voice memos and voice notes through OpenAI (2026-11-02), on the same OPENAI_API_KEY as GPT-Live calls and embeddings, so
// ElevenLabs can be cancelled. Calls already speak with GPT-Live's voice (services/gptLive.ts gptLiveVoice, "marin"); a voice
// note uses that same voice, so Cue sounds like one voice on a call and in a note.
//
// Models, from OpenAI's docs as of 2026-11-02:
//   - gpt-transcribe: OpenAI's recommended model for recorded speech (whisper-1 and gpt-4o-*-transcribe shut down 2027-02-26).
//     It detects the language itself, so no language hint is sent (Scribe was also left to detect it).
//   - gpt-4o-mini-tts: the model behind /v1/audio/speech that speaks with marin. OpenAI has deprecated it (shutdown 2027-01-06);
//     its named replacement, gpt-realtime-2.1-mini, is a Realtime session model, not a speech endpoint, so moving voice notes
//     there is a separate change that must land before that date.
export const OPENAI_AUDIO = {
  transcribeModel: "gpt-transcribe",
  speechModel: "gpt-4o-mini-tts",
  // OpenAI's own mp3 (24 kHz): served as audio/mpeg at /audio/:id, the format Sendblue already took from ElevenLabs' mp3.
  speechFormat: "mp3",
  // The formats OpenAI's transcription endpoint takes. Anything else (an iMessage voice memo is audio/x-caf) is converted first.
  acceptedTypes: new Set(["audio/mpeg", "audio/mp3", "audio/mpga", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm"]),
  // OpenAI's upload limit for a transcription.
  maxBytes: 25 * 1024 * 1024,
  convertTimeoutMs: 20_000,
} as const;

const EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/x-caf": "caf",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};
export const extensionFor = (contentType: string): string => EXTENSIONS[contentType] ?? "bin";

// The parts of the OpenAI client used here. Tests swap in their own; nothing else should.
export type AudioClient = Pick<OpenAI, "audio">;
// fetch is looked up on each request, not captured when the client is made, so a fetch installed later (a test's fake) is the one
// used.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, fetch: (input, init) => globalThis.fetch(input, init) });
let client: AudioClient = openai;
export function setAudioClientForTests(c: AudioClient | null): void {
  client = c ?? openai;
}

// Audio OpenAI doesn't take, made into mono mp3 with ffmpeg (installed in the Dockerfiles). The memo goes through a temp file,
// not a pipe, because a CAF file can keep its packet table after the audio, which needs a seekable input. The temp folder is
// removed whatever happens.
export type Converter = (audio: Buffer, extension: string) => Promise<Buffer>;
export const ffmpegToMp3: Converter = async (audio, extension) => {
  const dir = await mkdtemp(join(tmpdir(), "memo-"));
  try {
    const input = join(dir, `in.${extension}`);
    const output = join(dir, "out.mp3");
    await writeFile(input, audio);
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", output], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err = (err + d).slice(-300)));
      const timer = setTimeout(() => p.kill("SIGKILL"), OPENAI_AUDIO.convertTimeoutMs);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`ffmpeg unavailable: ${e.message}`));
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg could not convert the ${extension} memo (exit ${code}): ${(err.trim().split("\n").pop() ?? "").split(dir).join("")}`));
      });
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

// Tests swap in their own converter (no ffmpeg on a laptop or in layer 1); nothing else should.
let converter: Converter = ffmpegToMp3;
export function setConverterForTests(c: Converter | null): void {
  converter = c ?? ffmpegToMp3;
}

// A voice memo's words. Audio in a format OpenAI takes goes as it is; anything else is converted first. Throws on any failure
// (the caller, routes/sendblue.ts voiceMemoText, falls back to "[voice memo]"). A refused key raises the team alert.
export async function transcribeAudio(audio: Buffer, contentType: string): Promise<string> {
  let bytes = audio;
  let type = contentType;
  if (!OPENAI_AUDIO.acceptedTypes.has(contentType)) {
    bytes = await converter(audio, extensionFor(contentType));
    type = "audio/mpeg";
  }
  if (bytes.length > OPENAI_AUDIO.maxBytes) throw new Error(`voice memo too large to transcribe (${bytes.length} bytes)`);
  try {
    const file = await toFile(bytes, `voice_memo.${extensionFor(type)}`, { type });
    const result = await client.audio.transcriptions.create({ model: OPENAI_AUDIO.transcribeModel, file });
    return (result as { text?: string }).text ?? "";
  } catch (err) {
    noteModelFailure("openai", classifyModelFailure(err));
    throw err;
  }
}

// Cue's words spoken, as mp3 bytes. Throws on any failure (callers send the words as a text instead). A refused key raises the
// team alert.
export async function speak(text: string, voice: string): Promise<Buffer> {
  try {
    const res = await client.audio.speech.create({ model: OPENAI_AUDIO.speechModel, voice, input: text, response_format: OPENAI_AUDIO.speechFormat });
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    noteModelFailure("openai", classifyModelFailure(err));
    throw err;
  }
}
