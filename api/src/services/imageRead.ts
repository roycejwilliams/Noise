// What a photo someone texts Co actually shows, written down once (Royce,
// 2026-09-22: "I sent a screenshot to Co and it couldn't read it").
//
// The reply agent sees the image itself, but nothing else did: the reply's
// fact check only reads text, so every detail Co took from a screenshot ("the
// 30-day notice is the hard blocker") was flagged as unsupported and
// rewritten away, and the conversation record kept only their words, so two
// turns later Co said "no screenshot came through". This description goes
// into the record and into the reply's facts, so both know what was in it.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";

// The model's own per-image limit is 5MB; stay under it.
const MAX_BYTES = 4_800_000;

// The image's format from its first bytes, when it's one the model reads;
// null otherwise (HEIC, a broken file, something that isn't an image).
export function imageTypeOf(b: Buffer): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// HEIC (the iPhone default) by its own bytes: "ftyp" then heic/heix/mif1/msf1/heif.
export function isHeic(b: Buffer): boolean {
  return b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|heif)$/.test(b.toString("ascii", 8, 12));
}

// A photo in a form the model reads: as is when it already is, HEIC converted
// to JPEG (2026-10-01: an iPhone screenshot arrived as HEIC and neither the
// description nor the reply could open it), null when it can't be read at all.
export async function readableImage(b: Buffer): Promise<{ data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null> {
  const type = imageTypeOf(b);
  if (type) return { data: b, mediaType: type };
  if (!isHeic(b)) return null;
  try {
    const { default: convert } = await import("heic-convert");
    const out = Buffer.from(await convert({ buffer: b, format: "JPEG", quality: 0.85 }));
    return imageTypeOf(out) === "image/jpeg" ? { data: out, mediaType: "image/jpeg" } : null;
  } catch (err: any) {
    console.error("imageRead: HEIC conversion failed (non-fatal):", err?.message ?? err);
    return null;
  }
}

export async function describeImage(data: Buffer, mediaType: string): Promise<string | null> {
  if (data.length > MAX_BYTES) return null;
  try {
    const { text } = await generateText({
      model: anthropic(MODELS.sonnet),
      providerOptions: { anthropic: { effort: "low" } },
      experimental_telemetry: { isEnabled: true, functionId: "sendblue.describeImage" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: data, mediaType },
            {
              type: "text",
              text: `Someone texted this image to Cue. Write down what it shows so it can be referred to later without the image: if it's a screenshot of text (a message, an email, a document, a website), copy the important text itself, including names, dates, numbers and requirements; if it's a map, name the neighborhood and the streets around any pin or highlighted spot; otherwise describe what's in it. Plain words, no guesses beyond what's visible, at most 120 words. Return only the description.`,
            },
          ],
        },
      ],
    });
    const out = text.trim();
    return out ? out.slice(0, 1200) : null;
  } catch (err: any) {
    console.error("describeImage failed (non-fatal):", err?.message ?? err);
    return null;
  }
}
