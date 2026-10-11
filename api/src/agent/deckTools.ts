// Decks, as Co's tools (Royce, 2026-10-11): "make me a pitch deck about my startup" gets back a link to a hosted deck. A deck is an
// artifact on the Co page pipeline (services/coPages/deck.ts): same store, same /d/ link, same grounding and rules as a page
// (agent/pageTools.ts). Delivery follows the document rules: ONE text, a line plus the link (rule 2); changes by conversation keep the
// link and say what changed (rules 3, 5); a deck that can't be made is said plainly (rule 6).
//
// Its look is the member's taste (services/designTaste.ts). Co asks one question at most before building, taste and content in the
// same text, and only when it has neither their saved taste nor anything they said about it. Asked once, never again: an answer
// with nothing on taste builds clean and minimal. Taste they state is saved, so the next deck, page or doc doesn't ask.
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import type { ConversationToolContext } from "./conversationTools.js";
import { pickPage } from "./pageTools.js";

const line = (what: string) => z.string().describe(`${what} Plain words: no markdown, HTML, links, em dashes or exclamation points.`);
const hex = z.string().nullable().optional().describe("A six-digit hex color like #1F3A5F, from a color they named. Leave it out if they named none.");
export const TASTE_INPUT = z
  .object({
    quote: z.string().describe("Their own words about the look they want, or that they don't mind, copied exactly from what they wrote."),
    dontCare: z.boolean().optional().describe("True when they said they don't mind how it looks."),
    mood: z.enum(["minimal", "bold", "warm", "dark", "playful", "editorial", "classic"]).optional().describe("The feel their words point to."),
    background: hex,
    text: hex,
    accent: hex,
    type: z.enum(["serif", "sans"]).nullable().optional().describe("Serif or sans, only if their words or inspiration point to one."),
    inspo: line("What they pointed to for inspiration (a Pinterest board, sites, brands), as they said it.").nullable().optional(),
  })
  .optional()
  .describe("Only when they said something about the look in this conversation. Leave it out otherwise: their saved taste, if any, is used.");
const imageN = (what: string) => z.number().int().positive().nullable().optional().describe(`${what} The number of one of their saved images ("their image #3" in what they sent), only where it belongs. Leave it out otherwise.`);
export const DECK_INPUT = z.object({
  title: line("The deck's title: their company, project or the talk's name."),
  subtitle: line("The line under it: what it is and who it's for."),
  logo: imageN("Their logo on the title slide."),
  slides: z
    .array(z.object({ headline: line("The slide's one point."), bullets: z.array(line("A short supporting point.")).min(1).max(5), image: imageN("A picture for this slide (a product shot, the team, the space).") }))
    .min(2)
    .max(15),
});

// What a deck may say (Royce, 2026-10-11: "only content the member supplied for this deck or explicitly approved goes on the slides.
// Nothing from their private knowledge appears in an artifact unprompted."). Co still knows them while writing, but the deck is
// checked (grounding.ts deckProblems: every name, number and place) only against what they said in this deck's conversation: their
// texts in the last 12 hours, or since the deck was made when it's an edit, plus what's already on the deck (approved when it went
// out) and pages Co read this turn. Their older texts, calls, notes and the people graph aren't in it, so none of it can land.
export const DECK_WINDOW_HOURS = 12;
async function deckSource(ctx: ConversationToolContext, read: string, deck: { id: string; lines: string } | null): Promise<{ theirs: string; read: string }> {
  const { notToTeammate } = await import("../services/teamLines.js");
  const pool = (await import("../db/db.js")).default;
  const rows = ctx.dryRun
    ? []
    : await pool
        .query(
          `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}
             AND created_at > LEAST(NOW() - make_interval(hours => $2), COALESCE((SELECT created_at FROM co_pages WHERE id = $3 AND owner_user_id = $1), NOW()))
             AND created_at > NOW() - INTERVAL '30 days'
           ORDER BY created_at DESC LIMIT 60`,
          [ctx.userId, DECK_WINDOW_HOURS, deck?.id ?? ""],
        )
        .then((r) => r.rows.map((x: any) => String(x.content).replace(/^User said:\s*/i, "")))
        .catch(() => [] as string[]);
  const theirs = [ctx.resolvedContent, ctx.isVoice ? String(ctx.turn?.message ?? "") : "", ...rows, deck?.lines ?? ""].filter(Boolean).join("\n");
  return { theirs, read };
}

// Their image numbers to asset ids (services/memberAssets.ts): only their own saved images, and only ones sent for this deck (in its
// window), already on it, or that they named by number. An older photo is never placed on Co's own. A number that doesn't fit is
// an error naming what they do have, never a guess.
async function assetIds(userId: string, input: z.infer<typeof DECK_INPUT>, dryRun: boolean, o: { words: string; onDeck: string[] }): Promise<{ map: Map<number, string> } | { error: string }> {
  const wanted = [input.logo, ...input.slides.map((s) => s.image)].filter((n): n is number => typeof n === "number");
  if (!wanted.length) return { map: new Map() };
  const list = dryRun ? [] : await (await import("../services/memberAssets.js")).listAssets(userId).catch(() => []);
  const since = Date.now() - DECK_WINDOW_HOURS * 3600_000;
  const named = (n: number) => new RegExp(`(#|\\b(image|photo|picture|pic|logo)\\s*#?\\s*)${n}\\b`, "i").test(o.words);
  const usable = list.filter((a) => a.at.getTime() > since || o.onDeck.includes(a.id) || named(a.n));
  const map = new Map(usable.map((a) => [a.n, a.id]));
  const missing = wanted.filter((n) => !map.has(n));
  if (missing.length) {
    const have = usable.slice(0, 8).map((a) => `#${a.n}${a.description ? ` (${a.description.slice(0, 60)})` : ""}`).join("; ");
    return { error: `Image ${missing.map((n) => `#${n}`).join(", ")} isn't one they sent for this deck. ${have ? `Images you can use: ${have}.` : "They haven't sent any images for it."} Use only those, ask them, or leave images out.` };
  }
  return { map };
}

// Pure: the tool's input and a taste as the deck's data.
export async function deckDataFrom(
  input: z.infer<typeof DECK_INPUT>,
  taste: { mood?: string; colors?: { background?: string | null; text?: string | null; accent?: string | null }; type?: string | null } | null,
  assets: Map<number, string> = new Map(),
): Promise<Record<string, unknown>> {
  const { styleFrom } = await import("../services/coPages/deck.js");
  const style = styleFrom(taste?.mood ?? "minimal", taste?.colors ?? {}, taste?.type ?? undefined);
  const at = (n: number | null | undefined) => (typeof n === "number" ? assets.get(n) ?? null : null);
  return { kind: "deck", title: input.title, subtitle: input.subtitle, logo: at(input.logo), slides: input.slides.map((s) => ({ headline: s.headline, bullets: s.bullets, image: at(s.image) })), style };
}

export function deckTools(
  ctx: ConversationToolContext,
  o: { say: (text: string, record: string) => Promise<boolean>; notDone: (what: string) => void; source: () => Promise<{ theirs: string; read: string }> },
) {
  const S = () => import("../services/coPages/store.js");
  const T = () => import("../services/designTaste.js");
  const decks = async () => (ctx.dryRun ? [] : ((await (await S()).livePagesFor(ctx.userId).catch(() => [])) as { id: string; title: string; kind: string }[]).filter((p) => p.kind === "deck"));

  // Their taste for this deck: what they just said (checked against their words and saved), else what's saved. "ask" when Co has
  // neither and hasn't asked yet; after the one ask, minimal.
  const tasteFor = async (said: z.infer<typeof TASTE_INPUT>): Promise<{ taste: any; ask?: false } | { ask: true } | { error: string }> => {
    const D = await T();
    if (said) {
      const { wordsAreTheirs } = await import("../services/coTasks.js");
      if (!wordsAreTheirs(said.quote, `${ctx.resolvedContent}\n${ctx.isVoice ? String(ctx.turn?.message ?? "") : ""}\n${await o.source().then((s) => s.theirs).catch(() => "")}`)) {
        return { error: "The taste quote must be copied exactly from what they wrote. Leave taste out if they said nothing about the look." };
      }
      const t = {
        mood: said.dontCare ? "minimal" : (said.mood ?? "minimal"),
        colors: { background: said.background ?? null, text: said.text ?? null, accent: said.accent ?? null },
        type: said.type ?? null,
        inspo: said.inspo ?? null,
        dontCare: said.dontCare === true,
        quote: said.quote,
      };
      const parsed = D.parseDesignTaste(JSON.stringify(t));
      if (parsed && !ctx.dryRun) await D.recordDesignTaste(ctx.userId, parsed).catch(() => {});
      return { taste: parsed ?? t };
    }
    const saved = ctx.dryRun ? null : await D.loadDesignTaste(ctx.userId).catch(() => null);
    if (saved) return { taste: saved.taste };
    const asked = ctx.dryRun ? false : await D.tasteAskedRecently(ctx.userId).catch(() => true);
    if (!asked) return { ask: true };
    return { taste: null };
  };

  return {
    makeDeck: tool({
      description: toolUse("makeDeck"),
      inputSchema: DECK_INPUT.extend({
        taste: TASTE_INPUT,
        line: line("The one line that goes with the link, saying what you made (\"Here's the pitch deck for Northlight.\")."),
      }),
      execute: async (input) => {
        const t = await tasteFor(input.taste);
        if ("error" in t) return { ok: false, error: t.error };
        if (t.ask) {
          if (!ctx.dryRun) await (await T()).recordTasteAsked(ctx.userId).catch(() => {});
          ctx.facts?.add("known", "Co hasn't built the deck yet: it is asking one question first, about their taste and anything missing for the content.");
          return {
            ok: false,
            ask: true,
            error:
              "Not built yet. Ask ONE question, in one text: the look they like (a Pinterest board, sites or brands they love, colors, the vibe; fine if they don't mind) and, only if you need it, the one thing missing about what the deck should say. Then build it from their answer. You won't ask again: if they skip the taste part, it's built clean and minimal.",
          };
        }
        const source = await deckSource(ctx, (await o.source()).read, null);
        const ids = await assetIds(ctx.userId, input, !!ctx.dryRun, { words: source.theirs, onDeck: [] });
        if ("error" in ids) return { ok: false, error: ids.error };
        const store = await S();
        const data = await deckDataFrom(input, t.taste, ids.map);
        const checked = store.checkPage(data, source);
        if (!checked.ok) {
          o.notDone(`No deck made: ${checked.problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not made: ${checked.problems.slice(0, 6).join(" | ")}. Fix these (only what they told you or you read) and try once more, or give them the points in a text and say the deck isn't there yet.` };
        }
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was stored or sent.", style: (checked.data as any).style };
        const made = await store.createCoPage(checked.data, { ownerUserId: ctx.userId, source }).catch((err: any) => ({ ok: false as const, problems: [String(err?.message ?? err).slice(0, 160)] }));
        if (!made.ok) {
          o.notDone("The deck wasn't made.");
          return { ok: false, error: `Not made (${made.problems.slice(0, 2).join("; ")}). Give them the points in a text and say plainly the deck isn't there.` };
        }
        const text = `${input.line.trim()}\n${made.url}`;
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone(`The deck "${input.title}" was made, but its link didn't send.`);
          return { ok: false, error: "The deck is made, but the link didn't send. Tell them plainly and give the link again in your reply." };
        }
        ctx.facts?.add("did_this_turn", `Made them a deck, "${input.title}", ${input.slides.length + 1} slides, and texted it with one line (${made.url}). Anyone with the link can view it; it isn't listed anywhere.`);
        return { ok: true, url: made.url, note: "The line and the link went as one text, and that's the whole delivery. Don't call sendReply about the deck at all: not the logo, the colors, the slides or what's in it. If their message asked nothing else, you're done; end the turn here." };
      },
    }),
    updateDeck: tool({
      description: toolUse("updateDeck"),
      inputSchema: DECK_INPUT.extend({
        deck: z.string().describe("Which of their decks: its title, or a word from it."),
        taste: TASTE_INPUT,
        changed: line("What changed, in a few words they'd recognize (\"slide 3 now leads with the waitlist numbers\")."),
      }),
      execute: async (input) => {
        const store = await S();
        const pick = pickPage(await decks(), input.deck);
        if (pick === "ambiguous") return { ok: false, error: "More than one of their decks fits. Ask which one by its title." };
        if (!pick) return { ok: false, error: "They have no live deck by that name. Make a new one (makeDeck) if that's what they want." };
        // The look stays unless they said something new about it.
        const before = await store.loadCoPage(pick.id).catch(() => null);
        const kept = before && before.ownerUserId === ctx.userId && (before.data as any).kind === "deck" ? (before.data as any).style : null;
        let taste: any = kept ? { mood: kept.mood, colors: { background: kept.background, text: kept.text, accent: kept.accent }, type: kept.type } : null;
        if (input.taste) {
          const t = await tasteFor(input.taste);
          if ("error" in t) return { ok: false, error: t.error };
          if ("taste" in t && t.taste) taste = t.taste;
        }
        // What's on the deck now went out to them and stands; the edit may also use what they said since it was made.
        const was: any = before && before.ownerUserId === ctx.userId && (before.data as any).kind === "deck" ? before.data : null;
        const lines = was ? [was.title, was.subtitle, ...was.slides.flatMap((x: any) => [x.headline, ...x.bullets])].join("\n") : "";
        const source = await deckSource(ctx, (await o.source()).read, { id: pick.id, lines });
        const onDeck = was ? [was.logo, ...was.slides.map((x: any) => x.image)].filter(Boolean) : [];
        const ids = await assetIds(ctx.userId, input, !!ctx.dryRun, { words: source.theirs, onDeck });
        if ("error" in ids) return { ok: false, error: ids.error };
        const r = await store.updateCoPage(pick.id, ctx.userId, await deckDataFrom(input, taste, ids.map), source);
        if (!r) return { ok: false, error: "That deck is gone (taken down or expired). Make a new one if they want it." };
        if (!r.ok) {
          o.notDone(`The deck wasn't changed: ${r.problems.slice(0, 2).join("; ")}.`);
          return { ok: false, error: `Not changed: ${r.problems.slice(0, 5).join(" | ")}. Fix these and try once more, or tell them plainly it isn't changed yet.` };
        }
        const text = `Updated the deck: ${input.changed.trim().replace(/[.\s]+$/, "")}.`;
        if (!(await o.say(text, `Co replied: ${text}`))) {
          ctx.facts?.add("did_this_turn", `Updated their deck "${pick.title}" (version ${r.version}, same link), but the text saying so didn't send.`);
          return { ok: true, note: "The deck is updated (same link), but the line saying so didn't send: say in your reply, in a few words, what changed." };
        }
        ctx.facts?.add("did_this_turn", `Updated their deck "${pick.title}" (version ${r.version}, same link) and told them what changed.`);
        return { ok: true, note: "Same deck, same link; the text said what changed. Send nothing more about it." };
      },
    }),
  };
}
