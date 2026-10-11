// Co pages, as Co's tools (Royce, 2026-10-11 document rules). A page is for anything plan-worthy: several parts, options to compare,
// a set of places with their links. Co picks the format itself, never asks (rule 1). Made: ONE text, a line saying what it made and
// the link; no summary in the chat (rule 2). Changed by conversation: the same page and link, and "Updated the page: <what changed>"
// (rule 3). Taken down when they ask: the link answers 404 and the content is wiped. Can't be made or changed: said plainly, with the
// content in a text (rule 6). Every page passes the schema and the grounding (services/coPages/store.ts checkPage): only their own
// words and what Co read for them, never another member.
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import type { ConversationToolContext } from "./conversationTools.js";

const line = (what: string) => z.string().describe(`${what} Plain words: no markdown, HTML, links, em dashes or exclamation points.`);
const url = z.string().nullable().optional().describe("Its own https link, only one you read or they gave you. Leave it out otherwise.");
const BLOCK = z.union([
  z.object({ type: z.literal("text"), text: line("A short paragraph.") }),
  z.object({ type: z.literal("bullets"), items: z.array(z.object({ text: line("One point."), lead: line("A short lead, like a time (7:00 PM) or a label.").nullable().optional() })).min(1) }),
  z.object({
    type: z.literal("comparison"),
    options: z.array(z.object({ name: line("The option's name."), facts: z.array(z.object({ label: line("The fact's label, the same for every option, in the same order."), value: line("Its value.") })), note: line("One line on it.").nullable().optional(), url })).min(2).max(4),
  }),
  z.object({ type: z.literal("links"), items: z.array(z.object({ name: line("The place or thing."), note: line("One line on it.").nullable().optional(), url, group: line("A group label, or leave it out.").nullable().optional() })).min(1) }),
]);
export const PAGE_INPUT = z.object({
  title: line("The page's headline."),
  context: line("The line under it: when, where, for whom."),
  sections: z.array(z.object({ heading: line("The section's heading."), blocks: z.array(BLOCK).min(1) })).min(1),
  sources: z.array(z.object({ label: line("What the source is."), url: z.string() })).optional().describe("Pages you read that back what's on the page."),
});
export type PageInput = z.infer<typeof PAGE_INPUT>;

// Pure: the tool's input as the page's data (images are filled in by code, once, from the page's own entities).
export function pageDataFrom(input: PageInput): Record<string, unknown> {
  const norm = (b: any) => {
    if (b.type === "bullets") return { type: "bullets", items: b.items.map((i: any) => ({ text: i.text, lead: i.lead ?? null })) };
    if (b.type === "comparison") return { type: "comparison", options: b.options.map((o: any) => ({ name: o.name, facts: o.facts, note: o.note ?? null, url: o.url ?? null })) };
    if (b.type === "links") return { type: "links", items: b.items.map((i: any) => ({ name: i.name, note: i.note ?? null, url: i.url ?? null, group: i.group ?? null })) };
    return { type: "text", text: b.text };
  };
  return { title: input.title, context: input.context, cover: null, sections: input.sections.map((s) => ({ heading: s.heading, blocks: s.blocks.map(norm), image: null })), sources: input.sources ?? [] };
}

// Pure: which of their pages they mean, by title words; the newest when they have just one or say "the page". Null: none fits.
export function pickPage<T extends { id: string; title: string }>(pages: T[], ref: string): T | null | "ambiguous" {
  if (!pages.length) return null;
  const words = String(ref ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !["page", "that", "this", "link"].includes(w));
  if (!words.length) return pages.length === 1 ? pages[0] : pages[0];
  const scored = pages.map((p) => ({ p, n: words.filter((w) => p.title.toLowerCase().includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].n === scored[1].n) return "ambiguous";
  return scored[0].p;
}

export function pageTools(
  ctx: ConversationToolContext,
  o: { say: (text: string, record: string) => Promise<boolean>; notDone: (what: string) => void; source: () => Promise<{ theirs: string; read: string }> },
) {
  const S = () => import("../services/coPages/store.js");
  const pages = async () => (ctx.dryRun ? [] : (await S()).livePagesFor(ctx.userId).catch(() => []));
  return {
    makePage: tool({
      description: toolUse("makePage"),
      inputSchema: PAGE_INPUT.extend({ line: line("The one line that goes with the link, saying what you made (\"Here's Saturday in the Mission, dinner then a drink.\").") }),
      execute: async (input) => {
        const store = await S();
        const source = await o.source();
        const checked = store.checkPage(pageDataFrom(input), source);
        if (!checked.ok) {
          o.notDone(`No page made: ${checked.problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not made: ${checked.problems.slice(0, 6).join(" | ")}. Fix these and try once more, or give them the points in a text and say the page isn't there yet.` };
        }
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was stored or sent." };
        const { attachImages } = await import("../services/coPages/ogImage.js");
        const withImages = await attachImages(checked.data).then((r) => r.data).catch(() => checked.data);
        const made = await store.createCoPage(withImages, { ownerUserId: ctx.userId, source }).catch((err: any) => ({ ok: false as const, problems: [String(err?.message ?? err).slice(0, 160)] }));
        if (!made.ok) {
          o.notDone("The page wasn't made.");
          return { ok: false, error: `Not made (${made.problems.slice(0, 2).join("; ")}). Give them the points in a text and say plainly the page isn't there.` };
        }
        const text = `${input.line.trim()}\n${made.url}`;
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone(`The page "${input.title}" was made, but its link didn't send.`);
          return { ok: false, error: "The page is made, but the link didn't send. Tell them plainly and give the link again in your reply." };
        }
        ctx.facts?.add("did_this_turn", `Made them a page, "${input.title}", and texted it with one line (${made.url}). Anyone with the link can view it; it isn't listed anywhere.`);
        return { ok: true, url: made.url, note: "The line and the link went as one text. Add nothing about the page's contents; the page holds them." };
      },
    }),
    updatePage: tool({
      description: toolUse("updatePage"),
      inputSchema: PAGE_INPUT.extend({
        page: z.string().describe("Which of their pages: its title, or a word from it."),
        changed: line("What changed, in a few words they'd recognize (\"swapped Friday dinner for Saturday at Mesa Verde\")."),
      }),
      execute: async (input) => {
        const store = await S();
        const pick = pickPage(await pages(), input.page);
        if (pick === "ambiguous") return { ok: false, error: "More than one of their pages fits. Ask which one by its title." };
        if (!pick) return { ok: false, error: "They have no live page by that name. Make a new one (makePage) if that's what they want." };
        const source = await o.source();
        const r = await store.updateCoPage(pick.id, ctx.userId, pageDataFrom(input), source);
        if (!r) return { ok: false, error: "That page is gone (taken down or expired). Make a new one if they want it." };
        if (!r.ok) {
          o.notDone(`The page wasn't changed: ${r.problems.slice(0, 2).join("; ")}.`);
          return { ok: false, error: `Not changed: ${r.problems.slice(0, 5).join(" | ")}. Fix these and try once more, or tell them plainly it isn't changed yet.` };
        }
        const text = `Updated the page: ${input.changed.trim().replace(/[.\s]+$/, "")}.`;
        await o.say(text, `Co replied: ${text}`);
        ctx.facts?.add("did_this_turn", `Updated their page "${pick.title}" (version ${r.version}, same link) and told them what changed.`);
        return { ok: true, note: "Same page, same link; the text said what changed. Add nothing else about it." };
      },
    }),
    takeDownPage: tool({
      description: toolUse("takeDownPage"),
      inputSchema: z.object({ page: z.string().describe("Which of their pages: its title, or a word from it.") }),
      execute: async ({ page }) => {
        const pick = pickPage(await pages(), page);
        if (pick === "ambiguous") return { ok: false, error: "More than one of their pages fits. Ask which one by its title." };
        if (!pick) return { ok: false, error: "They have no live page by that name." };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was taken down." };
        const ok = await (await S()).takeDownCoPage(pick.id, ctx.userId);
        if (!ok) return { ok: false, error: "It was already down." };
        ctx.facts?.add("did_this_turn", `Took down their page "${pick.title}": its link no longer opens anything, and what was on it is deleted.`);
        return { ok: true, note: "Tell them in a few words it's down and the link no longer opens." };
      },
    }),
  };
}
