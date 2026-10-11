// Inputs every artifact tool shares (decks, pages): what they said about the look, and their images by number. Its own module so pageTools and deckTools can both
// use it without importing each other at load.
import { z } from "zod";

const line = (what: string) => z.string().describe(`${what} Plain words: no markdown, HTML, links, em dashes or exclamation points.`);
const hex = z.string().nullable().optional().describe("A six-digit hex color like #1F3A5F, from a color they named. Leave it out if they named none.");
export const TASTE_INPUT = z
  .object({
    quote: z.string().describe("Their own words about the look they want, or that they don't mind, copied exactly from what they wrote."),
    dontCare: z.boolean().optional().describe("True when they said they don't mind how it looks."),
    mood: z.enum(["minimal", "bold", "warm", "dark", "playful", "editorial", "classic"]).optional().describe("The feel their own description points to. Leave it out when they only picked a look by name."),
    preset: z.enum(["minimal", "bold", "warm", "dark", "playful", "editorial", "classic"]).optional().describe("A look they picked by name (Minimal, Editorial, Bold, Warm, Dark, Playful, Classic) instead of describing one. Anything they described (colors, type, vibe) wins over it."),
    background: hex,
    text: hex,
    accent: hex,
    type: z.enum(["serif", "sans"]).nullable().optional().describe("Serif or sans, only if their words or inspiration point to one."),
    inspo: line("What they pointed to for inspiration (a Pinterest board, sites, brands), as they said it.").nullable().optional(),
  })
  .optional()
  .describe("Only when they said something about the look in this conversation. Leave it out otherwise: their saved taste, if any, is used.");
// One of their saved images by its number ("their image #3"), for a deck slide, a page section or a logo.
export const imageN = (what: string) => z.number().int().nonnegative().nullable().optional().describe(`${what} The number of one of their saved images ("their image #3" in what they sent), only where it belongs. Leave it out otherwise.`);
