// Structured outputs for Cue's busiest judges (Royce, 2026-10-27): the match scorer (the room and the network), the people-asks read
// behind the room frame, the morning picker and the fact check's claim read. The answer's shape is fixed at the API by a JSON schema
// (output_config.format), so a malformed answer can't come back as text that only looks like JSON.
//
// The installed @ai-sdk/anthropic (3.x) doesn't know our model ids, and for an unknown model its "auto" mode falls back to a forced
// "json" tool (which the newest models refuse). structuredOutputMode "outputFormat" sends output_config.format for every model.
//
// The schema fixes the shape, never the meaning: every caller keeps its own checks of the values (scores clamped, labels and ids
// checked against what the prompt showed, citations checked in code), and still parses the JSON text with the parser it had, so
// what's stored (the picker's raw answer for the morning review) is unchanged in kind.
import { generateText, Output } from "ai";
import { z } from "zod";

// The match scorer (services/matching.ts runAskScoring): the same shape all three scoring prompts ask for.
export const SCORE_SCHEMA = z.object({
  results: z.array(
    z.object({
      index: z.number().int(),
      score: z.number(),
      reason: z.string(),
      share_ask: z.string(),
      hidden_only: z.boolean(),
      mutual: z.boolean(),
      // The want labels (W1...) the fit rests on, in a room frame; [] on a single ask (services/wantCriteria.ts).
      fits: z.array(z.string()),
      // Each listed condition of the asker's want: does it hold for this candidate on what's listed (services/wantCriteria.ts).
      conditions: z.array(z.object({ label: z.string(), holds: z.enum(["yes", "no", "unknown"]) })),
    }),
  ),
});

// The people-asks read (services/peopleAsks.ts peopleAskPrompt).
export const PEOPLE_ASKS_SCHEMA = z.object({
  asks: z.array(z.object({ index: z.number().int(), people: z.boolean(), personal: z.boolean() })),
});

// The morning picker (services/sweepSelect.ts SELECT_SYSTEM): one flat verdict, its kind's fields set and the rest null.
export const SELECT_SCHEMA = z.object({
  set: z.string().nullable(),
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["send", "hold", "reject"]),
      rank: z.number().nullable(),
      forThem: z.string().nullable(),
      whyMember: z.string().nullable(),
      cites: z.array(z.string()).nullable(),
      whyNow: z.string().nullable(),
      wow: z.boolean().nullable(),
      lastDay: z.string().nullable(),
      taste: z.string().nullable(),
      why: z.string().nullable(),
      until: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

// The fact check's claim read (harness/replyGrounding.ts extractClaims).
export const CLAIMS_SCHEMA = z.object({
  claims: z.array(
    z.object({
      text: z.string(),
      type: z.string(),
      supported: z.boolean(),
      factId: z.string().nullable(),
      quote: z.string().nullable(),
    }),
  ),
});

type GenArgs = Omit<Parameters<typeof generateText>[0], "output">;

// One judge call with its answer held to the schema. text is the answer as JSON (what the callers' parsers read). Throws when no
// valid object came back, the same as any failed call: each caller's existing fallback handles it.
export async function judgeJson<S extends z.ZodType>(schema: S, args: GenArgs): Promise<{ output: z.infer<S>; text: string; usage: unknown }> {
  const given = (args as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions ?? {};
  const r = await generateText({
    ...(args as Parameters<typeof generateText>[0]),
    output: Output.object({ schema }),
    providerOptions: { ...given, anthropic: { ...(given.anthropic ?? {}), structuredOutputMode: "outputFormat" } },
  } as Parameters<typeof generateText>[0]);
  // .output throws when the answer was cut off or isn't the shape. The answer's own text and usage ride on the error, so a caller's
  // failure record (the picker's raw for the morning review, its token count) isn't lost (review of #276).
  let output: z.infer<S>;
  try {
    output = (r as unknown as { output: z.infer<S> }).output;
  } catch (err: any) {
    if (err && typeof err === "object") {
      err.text ??= r.text;
      err.usage ??= r.usage;
    }
    throw err;
  }
  return { output, text: JSON.stringify(output), usage: r.usage };
}
