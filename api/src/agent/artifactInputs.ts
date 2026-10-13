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
    displayFont: z.string().nullable().optional().describe("A font they named for headlines, as they wrote it (\"Canela\", \"Playfair\"). Licensed fonts are swapped for the closest open one in code."),
    bodyFont: z.string().nullable().optional().describe("A font they named for body text, as they wrote it."),
    accent2: hex,
    gradient: z.boolean().optional().describe("True when they want the accent to run as a gradient into accent2."),
    density: z.enum(["airy", "balanced", "dense"]).optional().describe("How much air they want: airy (lots of space), balanced, or dense (full)."),
    correction: z.boolean().optional().describe("True when this corrects a look Co made or read for them (\"less gold\", \"airier\", \"not that green\"). A correction outweighs what they said before."),
  })
  .optional()
  .describe("Only when they said something about the look in this conversation. Leave it out otherwise: their saved taste, if any, is used.");
// One of their saved images by its number ("their image #3"), for a deck slide, a page section or a logo.
export const imageN = (what: string) => z.number().int().nonnegative().nullable().optional().describe(`${what} The number of one of their saved images ("their image #3" in what they sent), only where it belongs. Leave it out otherwise.`);

// Art direction (services/coPages/art.ts): Co's own judgment, from who they are and what it's about. Recorded on the artifact's style
// and said in Co's one line of choices.
const GRAMMAR_GUIDE =
  "catalog (art, objects, a show, a studio, a collection: a gallery catalog of large captioned plates and asymmetric spreads), fieldguide (a trip, a weekend, a route, anything moving between places: map, timeline, photo strips), menu (food, a dinner, a chef, a tasting, a bar: courses on a centered column), editorial (a pitch, a story, ideas and arguments: a magazine's headline-led spreads), poster (a launch, a party, one loud idea: oversized type and full-bleed pictures)";
export const ART_DIRECTION = z
  .enum(["catalog", "fieldguide", "menu", "editorial", "poster"])
  .optional()
  .describe(`The art direction you choose for this one, from their taste and what it's about: ${GRAMMAR_GUIDE}. Choose it every time; a change keeps it unless they ask for another.`);
export const PLACE = z
  .string()
  .nullable()
  .optional()
  .describe("The real place this is about, only one they named or you read, with its city (\"Heath Ceramics, San Francisco\"): its own photos (credited) and a map come in by code. Leave it out when it isn't about a place.");
export const COVER_MOOD = z
  .string()
  .nullable()
  .optional()
  .describe("A few plain words for a mood photo for the cover when no real place's photo fits (\"ceramics studio at night\"); it's labelled as a mood image, never as their place.");
