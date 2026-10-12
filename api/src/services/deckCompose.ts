// A deck written from a brief (Royce, 2026-10-11, PR 6: "a member can ask for and iterate on a deck during a call, same rules as
// text"). On a call, writing a whole deck as a tool's input kept the caller in silence for 30 to 40 seconds and held the model so the
// deck's own checks timed out. So on a call Co passes makeDeck a brief (or updateDeck the change), and this writes the deck from what
// they said; the result goes through the very same checks in makeDeck / updateDeck (agent/deckTools.ts): schema, grounding,
// invented-claims check, their taste, one text with the link. A refused version is written once more with the refusal in hand.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";

export type Composer = (prompt: string) => Promise<string>;
const sonnet: Composer = async (prompt) =>
  (await generateText({ model: anthropic(MODELS.sonnet), experimental_telemetry: { isEnabled: true, functionId: "deck.compose" }, prompt, abortSignal: AbortSignal.timeout(60_000) })).text;

const RULES = `Rules:
- Elaborate: a full, rich deck (6 to 10 content slides, 2 to 4 strong bullets each) beats a bare one. A pitch deck's job is rhetoric: positioning, framing, contrasts, taglines and a clear stance are yours to write, and when they ask you to work out the positioning, write it.
- Never a hard fact they didn't give: no partnership, deal, customer or user count, number, price, date, named event, award, or named person or company stated as fact. If a line leans on one, write the stance instead ("Built for live rooms", not "Partnering with X").
- Plain words: no markdown, no links, no em dashes, no exclamation points. Headline at most 90 characters, each bullet at most 160, 1 to 5 bullets a slide, 2 to 15 slides.
- Numbers they spoke as words ("fourteen", "eighty nine dollars", "six hundred K") are written as figures ("14", "$89", "$600k").`;

// Pure: the prompt for a new deck.
export function newDeckPrompt(callWords: string, request: string, look: string | null, refused: string | null): string {
  return `A member asked Co for a slide deck. Write it as JSON.

What they said (their texts, or the call):
"""
${callWords.slice(-8000)}
"""

What they asked for: ${request}
${look ? `The look they described: ${look}\n` : ""}${refused ? `\nA first version was refused for this, so fix it: ${refused}\n` : ""}
${RULES}
${look ? `- From the look, also choose: mood (one of minimal, bold, warm, dark, playful, editorial, classic), and background, text and accent as six-digit hex colors that match what they described (text must read on the background), and type (serif or sans).\n` : ""}
Return ONLY JSON: {"title": "...", "subtitle": "...", "slides": [{"headline": "...", "bullets": ["..."]}]${look ? `, "look": {"mood": "...", "background": "#......", "text": "#......", "accent": "#......", "type": "serif|sans"}` : ""}}
The title slide is made from title and subtitle; slides are the content slides only.`;
}

// Pure: the prompt for a change to a deck they have.
export function changeDeckPrompt(callWords: string, current: unknown, change: string, refused: string | null): string {
  return `A member asked for a change to a slide deck Co made them. Write the whole new version as JSON.

What they said (their texts, or the call):
"""
${callWords.slice(-8000)}
"""

The deck now (slide 1 is the title slide; "slides" starts at slide 2):
${JSON.stringify(current).slice(0, 8000)}

The change they asked for: ${change}
${refused ? `\nA first version was refused for this, so fix it: ${refused}\n` : ""}
${RULES}
- Keep every slide they didn't ask to change exactly as it is, notes included; change only what they asked.

Return ONLY JSON: {"title": "...", "subtitle": "...", "slides": [{"headline": "...", "bullets": ["..."], "notes": "... or leave out"}], "changed": "what changed, in a few words they'd recognize"}`;
}

export async function compose<T>(prompt: string, composer: Composer = sonnet): Promise<T | null> {
  try {
    return parseModelJson<T>(await composer(prompt));
  } catch {
    return null;
  }
}
