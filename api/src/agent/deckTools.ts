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
import { TASTE_INPUT, imageN } from "./artifactInputs.js";
export { TASTE_INPUT } from "./artifactInputs.js";
import { ALSO_ANSWER, withAnswer } from "./linkAnswer.js";

const line = (what: string) => z.string().describe(`${what} Plain words: no markdown, HTML, links, em dashes or exclamation points.`);
export const DECK_INPUT = z.object({
  title: line("The deck's title: their company, project or the talk's name."),
  subtitle: line("The line under it: what it is and who it's for."),
  logo: imageN("Their logo on the title slide."),
  slides: z
    .array(
      z.object({
        headline: line("The slide's one point."),
        bullets: z.array(line("A short supporting point.")).min(1).max(5),
        image: imageN("A picture for this slide (a product shot, the team, the space)."),
        notes: z.string().nullable().optional().describe("Speaker notes for this slide: what to say out loud, from what they told you, in plain words. Write them only when they asked for speaker notes, on the slides they named (all of them if they said so). On a change, leave it out to keep the slide's notes as they are; an empty string takes them off."),
      }),
    )
    .min(2)
    .max(15)
    .describe("The content slides, in order. The title slide is made from title and subtitle and is slide 1, so the first slide here is slide 2, the second is slide 3, and so on. Never repeat the title slide here."),
});

// What a deck may say (Royce, 2026-10-11: "only content the member supplied for this deck or explicitly approved goes on the slides.
// Nothing from their private knowledge appears in an artifact unprompted."). Co still knows them while writing, but the deck is
// checked (grounding.ts deckProblems: every name, number and place) only against what they said in this deck's conversation: their
// texts in the last 12 hours, plus, on an edit, what's already on the deck (approved when it went out), and pages Co read this turn. Their older texts, calls, notes and the people graph aren't in it, so none of it can land.
export const DECK_WINDOW_HOURS = 12;
async function deckSource(ctx: ConversationToolContext, read: string, deck: { id: string; lines: string } | null): Promise<{ theirs: string; read: string; words: string }> {
  const { notToTeammate } = await import("../services/teamLines.js");
  const pool = (await import("../db/db.js")).default;
  const rows = ctx.dryRun
    ? []
    : await pool
        .query(
          `SELECT content FROM co_memories WHERE user_id = $1 AND memory_type = 'text_exchange' AND content LIKE 'User said:%' AND ${notToTeammate()}
             AND created_at > NOW() - make_interval(hours => $2)
           ORDER BY created_at DESC LIMIT 60`,
          [ctx.userId, DECK_WINDOW_HOURS],
        )
        .then((r) => r.rows.map((x: any) => String(x.content).replace(/^User said:\s*/i, "")))
        .catch(() => [] as string[]);
  // words: only what they said (for the claim check, which must never take Co's own earlier lines as their word).
  const words = [ctx.resolvedContent, ctx.isVoice ? String(ctx.turn?.message ?? "") : "", ...rows].filter(Boolean).join("\n");
  const theirs = [words, deck?.lines ?? ""].filter(Boolean).join("\n");
  return { theirs, read, words };
}

// Punch is fine, invention is not (services/coPages/deckClaims.ts): every new or changed line, judged against their words for this
// deck and what Co read. An error message when a line adds a claim; null when it passes or the check couldn't run (logged).
async function inventedClaims(ctx: ConversationToolContext, data: any, source: { words: string; read: string }, before: any | null): Promise<string | null> {
  if (ctx.dryRun || ctx.stubSearch) return null;
  const C = await import("../services/coPages/deckClaims.js");
  const had = new Set(before ? C.deckClaimLines(before) : []);
  const lines = C.deckClaimLines(data).filter((l) => !had.has(l));
  const fails = await C.inventedLines(lines, [source.words, source.read].filter(Boolean).join("\n"));
  const { recordDecision } = await import("../harness/core.js");
  if (fails === null) {
    await recordDecision({ layer: 3, decision: "deck.claims", userId: ctx.userId, outcome: "skip", action: "check_unavailable", proposal: { lines: lines.length } }).catch(() => {});
    return null;
  }
  if (!fails.length) return null;
  await recordDecision({ layer: 3, decision: "deck.claims", userId: ctx.userId, outcome: "skip", action: "invented", proposal: { fails } }).catch(() => {});
  return `These lines add claims they never made: ${fails.map((f) => `"${f.line}" (${f.why})`).join(" | ")}. Sharpen what they said instead, or leave it out; if it matters, ask them. Then try once more.`;
}

// Their image numbers to asset ids (services/memberAssets.ts): only their own saved images, and only ones sent for this deck (in its
// window), already on it, or that they named by number. An older photo is never placed on Co's own. A number that doesn't fit is
// an error naming what they do have, never a guess.
async function assetIds(userId: string, input: z.infer<typeof DECK_INPUT>, dryRun: boolean, o: { words: string; onDeck: string[] }): Promise<{ map: Map<number, string> } | { error: string }> {
  return assetIdsFor(userId, [input.logo, ...input.slides.map((s) => s.image)], dryRun, { ...o, what: "deck" });
}
// The same rule for any artifact (a page too, 2026-10-11 PR 2): wanted = the image numbers it places.
export async function assetIdsFor(userId: string, numbers: (number | null | undefined)[], dryRun: boolean, o: { words: string; onDeck: string[]; what: "deck" | "page" }): Promise<{ map: Map<number, string> } | { error: string }> {
  const wanted = numbers.filter((n): n is number => typeof n === "number" && n > 0);
  if (!wanted.length) return { map: new Map() };
  const list = dryRun ? [] : await (await import("../services/memberAssets.js")).listAssets(userId).catch(() => []);
  const since = Date.now() - DECK_WINDOW_HOURS * 3600_000;
  const named = (n: number) => new RegExp(`(#|\\b(image|photo|picture|pic|logo)\\s*#?\\s*)${n}\\b`, "i").test(o.words);
  const usable = list.filter((a) => a.at.getTime() > since || o.onDeck.includes(a.id) || named(a.n));
  const map = new Map(usable.map((a) => [a.n, a.id]));
  const missing = wanted.filter((n) => !map.has(n));
  if (missing.length) {
    const have = usable.slice(0, 8).map((a) => `#${a.n}${a.description ? ` (${a.description.slice(0, 60)})` : ""}`).join("; ");
    return { error: `Image ${missing.map((n) => `#${n}`).join(", ")} isn't one they sent for this ${o.what}. ${have ? `Images you can use: ${have}.` : "They haven't sent any images for it."} Use only those, ask them, or leave images out.` };
  }
  return { map };
}

// Pure: the tool's input and a taste as the deck's data.
export async function deckDataFrom(
  input: z.infer<typeof DECK_INPUT>,
  taste: { mood?: string; colors?: { background?: string | null; text?: string | null; accent?: string | null }; type?: string | null } | null,
  assets: Map<number, string> = new Map(),
  was: { slides?: { headline: string; bullets?: string[]; notes?: string }[] } | null = null,
): Promise<Record<string, unknown>> {
  const { styleFrom } = await import("../services/coPages/deck.js");
  const style = styleFrom(taste?.mood ?? "minimal", taste?.colors ?? {}, taste?.type ?? undefined);
  const at = (n: number | null | undefined) => (typeof n === "number" ? assets.get(n) ?? null : null);
  // A slide's notes on an edit (review of PR 3): written now, or kept from the slide with the same headline (else the same place)
  // when this version leaves them out; an empty string takes them off. An unrelated edit never drops their notes.
  // By place only when it's the same slide reworded (it still shares a bullet): a replaced slide never inherits notes about content
  // that's gone (review of PR 3).
  const keptNotes = (s: { headline: string; bullets: string[] }, i: number) => {
    const same = was?.slides?.find((x) => x.headline === s.headline);
    if (same) return same.notes;
    const there: any = was?.slides?.[i];
    return there && (there.bullets ?? []).some((b: string) => s.bullets.includes(b)) ? there.notes : undefined;
  };
  const notesFor = (s: { headline: string; bullets: string[]; notes?: string | null }, i: number) => (typeof s.notes === "string" ? s.notes.trim() : keptNotes(s, i)) || null;
  return { kind: "deck", title: input.title, subtitle: input.subtitle, logo: at(input.logo), slides: input.slides.map((s, i) => ({ headline: s.headline, bullets: s.bullets, image: at(s.image), ...(notesFor(s, i) ? { notes: notesFor(s, i) } : {}) })), style };
}

// Their taste, with no asking: what they said about the look now (their exact words, checked, then saved as member knowledge), else
// what's saved, else null. Decks add the one ask on top (tasteFor); pages never ask and use Co's own design without a taste.
export async function knownTaste(ctx: ConversationToolContext, said: z.infer<typeof TASTE_INPUT>, theirs: () => Promise<string>): Promise<{ taste: any } | { error: string }> {
  const D = await import("../services/designTaste.js");
  if (said) {
    const { wordsAreTheirs } = await import("../services/coTasks.js");
    if (!wordsAreTheirs(said.quote, `${ctx.resolvedContent}\n${ctx.isVoice ? String(ctx.turn?.message ?? "") : ""}\n${await theirs()}`)) {
      return { error: "The taste quote must be copied exactly from what they wrote. Leave taste out if they said nothing about the look." };
    }
    const t = {
      // What they describe always wins; a preset they picked is the fallback when they'd rather not describe it (PR 3).
      mood: said.dontCare ? "minimal" : (said.mood ?? said.preset ?? "minimal"),
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
  return { taste: saved?.taste ?? null };
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
    const known = await knownTaste(ctx, said, () => o.source().then((s) => s.theirs).catch(() => ""));
    if ("error" in known) return known;
    if (known.taste) return { taste: known.taste };
    const asked = ctx.dryRun ? false : await D.tasteAskedRecently(ctx.userId).catch(() => true);
    if (!asked) return { ask: true };
    return { taste: null };
  };

  return {
    // A public Pinterest board they sent, read for the look (services/pinterestTaste.ts, PR 5): its name, pins and the colors its pins
    // are made of. Public boards only: a board that needs a login (or is gone) is said plainly, never guessed at.
    readInspo: tool({
      description: toolUse("readInspo"),
      inputSchema: z.object({ url: z.string().describe("The Pinterest board link exactly as they sent it.") }),
      execute: async ({ url }) => {
        if (!(ctx.resolvedContent ?? "").includes(url.trim()) && !String(ctx.turn?.message ?? "").includes(url.trim())) {
          const recent = await o.source().then((s) => s.theirs).catch(() => "");
          if (!recent.includes(url.trim())) return { ok: false, error: "Only a board link they sent you." };
        }
        const P = await import("../services/pinterestTaste.js");
        const r = await P.readBoard(url);
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 3, decision: "inspo.pinterest", userId: ctx.userId, outcome: r.readable ? "act" : "skip", action: r.readable ? "read" : r.why, proposal: { url: url.slice(0, 200) } }).catch(() => {});
        if (!r.readable) {
          const why =
            r.why === "not_a_board"
              ? "That link isn't a Pinterest board (a single pin or a search isn't one)."
              : r.why === "needs_login_or_gone"
                ? "That board can't be opened without signing in to Pinterest: it's secret or private, or it's been removed."
                : "Pinterest didn't answer just now.";
          ctx.facts?.add("known", `Co couldn't read their Pinterest board: ${why}`);
          return { ok: false, readable: false, error: `${why} Say so plainly and ask them to describe the look in a line or pick one of Co's looks by name; never guess what's on it.` };
        }
        ctx.facts?.add("known", `Their Pinterest board "${r.board}"${r.description ? ` (${r.description})` : ""}: pins like ${r.pins.slice(0, 8).map((p) => `"${p}"`).join(", ")}; its colors ${r.colors.map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`).join(", ") || "unknown"}; overall ${r.tone ?? "unknown"}.`);
        return {
          ok: true,
          board: r.board,
          description: r.description,
          pins: r.pins,
          colors: r.colors,
          tone: r.tone,
          note: "Choose the look from this board: a mood its pins point to, and background, text and accent from its colors (text must read on the background). Pass it as taste with quote = their words that sent the link and inspo = their Pinterest board by name. Tell them nothing about the board beyond a few words on the look you took from it.",
        };
      },
    }),
    makeDeck: tool({
      description: toolUse("makeDeck"),
      inputSchema: DECK_INPUT.extend({
        taste: TASTE_INPUT,
        line: line("The one line that goes with the link, saying what you made (\"Here's the pitch deck for Northlight.\")."),
        alsoAnswer: ALSO_ANSWER,
      }),
      execute: async (input) => {
        const t = await tasteFor(input.taste);
        if ("error" in t) return { ok: false, error: t.error };
        if (t.ask) {
          if (!ctx.dryRun) await (await T()).recordTasteAsked(ctx.userId).catch(() => {});
          ctx.facts?.add("known", "Co hasn't built the deck yet: it is asking one question first, about their taste and anything missing for the content.");
          // The question names things the fact check would otherwise cut as unsourced (live run, PR 3: the looks and Pinterest were
          // cut, and only "fine if you don't care" went): they're Co's own offer.
          ctx.facts?.add("known", "For the look of a deck, Co can follow a Pinterest board, sites or brands they love, colors or a vibe they describe, or one of Co's looks by name: Minimal, Editorial, Bold, Warm, Dark, Playful or Classic.");
          return {
            ok: false,
            ask: true,
            error:
              "Not built yet. Ask ONE question, in one text: the look they like (a Pinterest board, sites or brands they love, colors, the vibe), or, if they'd rather not describe it, one of these looks by name: Minimal, Editorial, Bold, Warm, Dark, Playful or Classic; fine if they don't mind. Add, only if you need it, the one thing missing about what the deck should say. Then build it from their answer. You won't ask again: if they skip the taste part, it's built clean and minimal.",
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
        const invented = await inventedClaims(ctx, checked.data, source, null);
        if (invented) {
          o.notDone("No deck made: some lines added claims they never made.");
          return { ok: false, error: `Not made. ${invented}` };
        }
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was stored or sent.", style: (checked.data as any).style };
        const made = await store.createCoPage(checked.data, { ownerUserId: ctx.userId, source }).catch((err: any) => ({ ok: false as const, problems: [String(err?.message ?? err).slice(0, 160)] }));
        if (!made.ok) {
          o.notDone("The deck wasn't made.");
          return { ok: false, error: `Not made (${made.problems.slice(0, 2).join("; ")}). Give them the points in a text and say plainly the deck isn't there.` };
        }
        const { text, confirm } = await withAnswer(ctx, `${input.line.trim()}\n${made.url}`, input.alsoAnswer);
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone(`The deck "${input.title}" was made, but its link didn't send.`);
          return { ok: false, error: "The deck is made, but the link didn't send. Tell them plainly and give the link again in your reply." };
        }
        ctx.onLinkDelivered?.();
        confirm();
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
        alsoAnswer: ALSO_ANSWER,
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
        const lines = was ? [was.title, was.subtitle, ...was.slides.flatMap((x: any) => [x.headline, ...x.bullets, ...(x.notes ? [x.notes] : [])])].join("\n") : "";
        const source = await deckSource(ctx, (await o.source()).read, { id: pick.id, lines });
        const onDeck = was ? [was.logo, ...was.slides.map((x: any) => x.image)].filter(Boolean) : [];
        const ids = await assetIds(ctx.userId, input, !!ctx.dryRun, { words: source.theirs, onDeck });
        if ("error" in ids) return { ok: false, error: ids.error };
        const next = await deckDataFrom(input, taste, ids.map, was);
        const invented = await inventedClaims(ctx, next, source, was);
        if (invented) {
          o.notDone("The deck wasn't changed: some lines added claims they never made.");
          return { ok: false, error: `Not changed. ${invented}` };
        }
        const r = await store.updateCoPage(pick.id, ctx.userId, next, source);
        if (!r) return { ok: false, error: "That deck is gone (taken down or expired). Make a new one if they want it." };
        if (!r.ok) {
          o.notDone(`The deck wasn't changed: ${r.problems.slice(0, 2).join("; ")}.`);
          return { ok: false, error: `Not changed: ${r.problems.slice(0, 5).join(" | ")}. Fix these and try once more, or tell them plainly it isn't changed yet.` };
        }
        const { text, confirm } = await withAnswer(ctx, `Updated the deck: ${input.changed.trim().replace(/[.\s]+$/, "")}.`, input.alsoAnswer);
        if (!(await o.say(text, `Co replied: ${text}`))) {
          ctx.facts?.add("did_this_turn", `Updated their deck "${pick.title}" (version ${r.version}, same link), but the text saying so didn't send.`);
          return { ok: true, note: "The deck is updated (same link), but the line saying so didn't send: say in your reply, in a few words, what changed." };
        }
        ctx.onLinkDelivered?.();
        confirm();
        ctx.facts?.add("did_this_turn", `Updated their deck "${pick.title}" (version ${r.version}, same link) and told them what changed.`);
        return { ok: true, note: "Same deck, same link; the text said what changed. Send nothing more about it." };
      },
    }),
  };
}
