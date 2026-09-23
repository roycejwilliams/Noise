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
              text: `Someone texted this image to Co. Write down what it shows so it can be referred to later without the image: if it's a screenshot of text (a message, an email, a document, a website), copy the important text itself, including names, dates, numbers and requirements; otherwise describe what's in it. Plain words, no guesses beyond what's visible, at most 120 words. Return only the description.`,
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
