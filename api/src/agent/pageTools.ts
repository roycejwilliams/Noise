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
import { ALSO_ANSWER, withAnswer } from "./linkAnswer.js";
import { TASTE_INPUT, imageN } from "./artifactInputs.js";

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
  sections: z.array(z.object({ heading: line("The section's heading."), blocks: z.array(BLOCK).min(1), picture: imageN("A picture of theirs for this section (their space, their product). On a change, 0 takes this section's picture off; leave it out to keep it.") })).min(1),
  sources: z.array(z.object({ label: line("What the source is."), url: z.string() })).optional().describe("Pages you read that back what's on the page."),
  logo: imageN("Their logo, on the cover. On a change, 0 takes it off; leave it out to keep it."),
});
export type PageInput = z.infer<typeof PAGE_INPUT>;

// Pure: the tool's input as the page's data (images are filled in by code, once, from the page's own entities).
// extras (2026-10-11, PR 2): their look and their images, resolved by the tool (their taste, their own image ids). Without them, Co's
// own design, as before.
// was: the page as it is now, on an edit: its logo and each section's picture (by heading) stay unless this version names new ones
// (review of PR 2: an edit that didn't repeat the logo dropped it).
export function pageDataFrom(input: PageInput, extras?: { style: unknown | null; assets: Map<number, string>; was?: any | null }): Record<string, unknown> {
  const norm = (b: any) => {
    if (b.type === "bullets") return { type: "bullets", items: b.items.map((i: any) => ({ text: i.text, lead: i.lead ?? null })) };
    if (b.type === "comparison") return { type: "comparison", options: b.options.map((o: any) => ({ name: o.name, facts: o.facts, note: o.note ?? null, url: o.url ?? null })) };
    if (b.type === "links") return { type: "links", items: b.items.map((i: any) => ({ name: i.name, note: i.note ?? null, url: i.url ?? null, group: i.group ?? null })) };
    return { type: "text", text: b.text };
  };
  const at = (n: number | null | undefined) => (typeof n === "number" ? extras?.assets.get(n) ?? null : null);
  const was = extras?.was ?? null;
  const keptPicture = (heading: string) => (was?.sections ?? []).find((x: any) => x.heading === heading && x.asset)?.asset ?? null;
  const sections = input.sections.map((s) => {
    const asset = s.picture === 0 ? null : typeof s.picture === "number" ? at(s.picture) : keptPicture(s.heading);
    return { heading: s.heading, blocks: s.blocks.map(norm), image: null, ...(asset ? { asset } : {}) };
  });
  const logo = input.logo === 0 ? null : typeof input.logo === "number" ? at(input.logo) : (was?.logo ?? null);
  return { title: input.title, context: input.context, cover: null, sections, sources: input.sources ?? [], ...(extras?.style ? { style: extras.style } : {}), ...(logo ? { logo } : {}) };
}

// Words about the page, not its title (review of #148: "take that page down" named no title and missed their only page).
const PAGE_REF_WORDS = new Set(["page", "pages", "that", "this", "link", "take", "down", "delete", "remove", "kill", "stop", "sharing", "share", "please", "change", "update", "edit", "swap"]);
// Pure: which of their pages they mean, by title words; the newest when they have just one or say "the page". Null: none fits.
export function pickPage<T extends { id: string; title: string }>(pages: T[], ref: string): T | null | "ambiguous" {
  if (!pages.length) return null;
  const words = String(ref ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !PAGE_REF_WORDS.has(w));
  // No title word: their only page, or ask which (review of #148: "delete it" with two pages must never wipe the newest).
  if (!words.length) return pages.length === 1 ? pages[0] : "ambiguous";
  const scored = pages.map((p) => ({ p, n: words.filter((w) => p.title.toLowerCase().includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].n === scored[1].n) return "ambiguous";
  return scored[0].p;
}

// Images from the page's own entities, inside one hard deadline (review of #148: the per-entity budget let a slow page hold the text
// 16 to 32s). Past it, the page goes without them. keep: images the page already had, kept where that section still links their source.
export const IMAGE_DEADLINE_MS = 9_000;
export async function withImages(data: any, keep: any | null = null, deadlineMs = IMAGE_DEADLINE_MS, attach?: (d: any) => Promise<{ data: any }>): Promise<any> {
  const { sectionEntities } = await import("../services/coPages/schema.js");
  const kept = {
    ...data,
    cover: data.cover ?? keep?.cover ?? null,
    sections: data.sections.map((sec: any) => {
      if (sec.image) return sec;
      const was = (keep?.sections ?? []).map((x: any) => x.image).find((img: any) => img && sectionEntities(sec).some((e: any) => e.url === img.sourceUrl));
      return was ? { ...sec, image: was } : sec;
    }),
  };
  const run = attach ?? (async (d: any) => (await import("../services/coPages/ogImage.js")).attachImages(d));
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), deadlineMs));
  const got = await Promise.race([run(kept).then((r) => r.data).catch(() => null), timeout]);
  return got ?? kept;
}

export function pageTools(
  ctx: ConversationToolContext,
  o: { say: (text: string, record: string) => Promise<boolean>; notDone: (what: string) => void; source: () => Promise<{ theirs: string; read: string }> },
) {
  const S = () => import("../services/coPages/store.js");
  // Their look and their images for a page (2026-10-11, PR 2), the same way a deck takes them: taste they describe now (their words,
  // saved) or their saved taste, else Co's own design (a page never asks); images only theirs, sent for it, already on it, or named.
  const lookFor = async (input: any, was: any | null, theirs: string): Promise<{ style: unknown | null; assets: Map<number, string>; was: any | null } | { error: string }> => {
    const D = await import("./deckTools.js");
    const t = await D.knownTaste(ctx, input.taste, async () => theirs);
    if ("error" in t) return t;
    const { styleFrom } = await import("../services/coPages/style.js");
    // "Don't mind" keeps Co's own page design (review of PR 2): only a taste they described or picked restyles a page.
    let style: unknown = t.taste && !t.taste.dontCare ? styleFrom(t.taste.mood, t.taste.colors ?? {}, t.taste.type ?? undefined) : t.taste?.dontCare ? null : (was?.style ?? null);
    // Their design system (services/designSystem.ts) fills the rest: their fonts, a gradient, density. Only when they have one and
    // didn't say they don't mind; otherwise the page keeps Co's own design, as before.
    if (style && !ctx.dryRun) {
      const DS = await import("../services/designSystem.js");
      const ds = await DS.loadDesignSystem(ctx.userId, "personal").catch(() => null);
      if (ds && ds.answered.size && !ds.dontCare) style = DS.fillDesign(ds, {}).style;
    }
    const onPage = was ? [was.logo, ...(was.sections ?? []).map((x: any) => x.asset)].filter(Boolean) : [];
    const placed = (n: unknown) => (typeof n === "number" && n > 0 ? n : null);
    const ids = await D.assetIdsFor(ctx.userId, [placed(input.logo), ...input.sections.map((x: any) => placed(x.picture))], !!ctx.dryRun, { words: theirs, onDeck: onPage, what: "page" });
    if ("error" in ids) return ids;
    return { style, assets: ids.map, was };
  };
  const pages = async () => (ctx.dryRun ? [] : (await S()).livePagesFor(ctx.userId).catch(() => []));
  return {
    makePage: tool({
      description: toolUse("makePage"),
      inputSchema: PAGE_INPUT.extend({ line: line("The one line that goes with the link, saying what you made (\"Here's Saturday in the Mission, dinner then a drink.\")."), alsoAnswer: ALSO_ANSWER, taste: TASTE_INPUT }),
      execute: async (input) => {
        const store = await S();
        const source = await o.source();
        const look = await lookFor(input, null, source.theirs);
        if ("error" in look) return { ok: false, error: look.error };
        const checked = store.checkPage(pageDataFrom(input, look), source);
        if (!checked.ok) {
          o.notDone(`No page made: ${checked.problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not made: ${checked.problems.slice(0, 6).join(" | ")}. Fix these and try once more, or give them the points in a text and say the page isn't there yet.` };
        }
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was stored or sent." };
        const imaged = await withImages(checked.data);
        // Design QA before it goes (services/designQa.ts): measured at laptop width, findings logged with the page.
        const Q = await import("../services/designQa.js");
        const { renderCoPage } = await import("../services/coPages/template.js");
        const qa = await Q.runQa(renderCoPage({ id: "q".repeat(24), data: imaged, version: 1, updatedAt: new Date() }, { url: null, ogImageUrl: null }), "page", imaged, { screenshot: false }).catch(() => null);
        const made = await store.createCoPage(imaged, { ownerUserId: ctx.userId, source }).catch((err: any) => ({ ok: false as const, problems: [String(err?.message ?? err).slice(0, 160)] }));
        if (!made.ok) {
          o.notDone("The page wasn't made.");
          return { ok: false, error: `Not made (${made.problems.slice(0, 2).join("; ")}). Give them the points in a text and say plainly the page isn't there.` };
        }
        await (await import("../services/designSystem.js")).logArtifactDesign({ ownerUserId: ctx.userId, pageId: made.id, medium: "page", event: "made", layout: (imaged as any).style ? "cover-band" : "co", tokens: (imaged as any).style ?? null, qa: qa ? { ran: qa.ran, findings: qa.findings } : { ran: false } }).catch(() => {});
        const { text, confirm } = await withAnswer(ctx, `${input.line.trim()}\n${made.url}`, input.alsoAnswer);
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone(`The page "${input.title}" was made, but its link didn't send.`);
          return { ok: false, made: `the page "${input.title}" (${made.url})`, url: made.url, error: `The page is made, but the link didn't send. Tell them plainly and give the link in your reply: ${made.url}` };
        }
        ctx.onLinkDelivered?.();
        confirm();
        ctx.facts?.add("did_this_turn", `Made them a page, "${input.title}", and texted it with one line (${made.url}). Anyone with the link can view it; it isn't listed anywhere.`);
        return { ok: true, url: made.url, ...(qa ? { qa: Q.qaSummary(qa) } : {}), note: "The line and the link went as one text, and that's the whole delivery: send nothing more about it, no summary, no second text. Nothing more goes out this turn, so don't call sendReply." };
      },
    }),
    updatePage: tool({
      description: toolUse("updatePage"),
      inputSchema: PAGE_INPUT.extend({
        page: z.string().describe("Which of their pages: its title, or a word from it."),
        changed: line("What changed, in a few words they'd recognize (\"swapped Friday dinner for Saturday at Mesa Verde\")."),
        alsoAnswer: ALSO_ANSWER,
        taste: TASTE_INPUT,
      }),
      execute: async (input) => {
        const store = await S();
        // Pages only: a deck is changed with updateDeck (agent/deckTools.ts).
        const pick = pickPage((await pages()).filter((p: any) => p.kind !== "deck"), input.page);
        if (pick === "ambiguous") return { ok: false, error: "More than one of their pages fits. Ask which one by its title." };
        if (!pick) return { ok: false, error: "They have no live page by that name. Make a new one (makePage) if that's what they want; a deck is changed with updateDeck." };
        const source = await o.source();
        // The page as it is now (theirs: listed from their own pages), so its images carry over (review of #148).
        const before = await store.loadCoPage(pick.id).catch(() => null);
        const was: any = before && before.ownerUserId === ctx.userId ? before.data : null;
        const look = await lookFor(input, was, source.theirs);
        if ("error" in look) return { ok: false, error: look.error };
        const next = await withImages(pageDataFrom(input, look), was);
        const r = await store.updateCoPage(pick.id, ctx.userId, next, source, { expectVersion: was ? before?.version : null });
        if (!r) return { ok: false, error: "That page is gone (taken down or expired). Make a new one if they want it." };
        // Another change landed after this one read the page (concurrency audit, 2026-10-12): never written over.
        if (!r.ok && r.conflict) {
          o.notDone("The page wasn't changed: another change to it landed just now.");
          return { ok: false, error: "Not changed: another change to this page landed after you read it. Open it again and make this change on the newest version, or tell them plainly it isn't changed yet." };
        }
        if (!r.ok) {
          o.notDone(`The page wasn't changed: ${r.problems.slice(0, 2).join("; ")}.`);
          return { ok: false, error: `Not changed: ${r.problems.slice(0, 5).join(" | ")}. Fix these and try once more, or tell them plainly it isn't changed yet.` };
        }
        if (!ctx.dryRun) await (await import("../services/designSystem.js")).logArtifactDesign({ ownerUserId: ctx.userId, pageId: r.moved?.id ?? pick.id, medium: "page", event: "revised" }).catch(() => {});
        const { text, confirm } = await withAnswer(ctx, `Updated the page: ${input.changed.trim().replace(/[.\s]+$/, "")}.${r.moved ? ` Its link was just reset, so this is the new one:\n${r.moved.url}` : ""}`, input.alsoAnswer);
        if (!(await o.say(text, `Co replied: ${text}`))) {
          ctx.facts?.add("did_this_turn", `Updated their page "${pick.title}" (version ${r.version}, ${r.moved ? `its link was just reset, now ${r.moved.url}` : "same link"}), but the text saying so didn't send.`);
          return { ok: true, note: "The page is updated (same link), but the line saying so didn't send: say in your reply, in a few words, what changed." };
        }
        ctx.onLinkDelivered?.();
        confirm();
        ctx.facts?.add("did_this_turn", `Updated their page "${pick.title}" (version ${r.version}, ${r.moved ? `its link was just reset, now ${r.moved.url}` : "same link"}) and told them what changed.`);
        return { ok: true, note: "Same page, same link; the text said what changed. Nothing more goes out this turn, so don't call sendReply." };
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
