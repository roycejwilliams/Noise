// What a member can do with any artifact Co made them (a page or a deck), as Co's tools (Royce, 2026-10-11):
//   keepArtifact: "keep this" makes it permanent; "renew" (the one word the expiry warning asks for) gives it 90 more days.
//   shareArtifact: a separate view-only link, only when they explicitly ask in this message. Never on Co's own. Every one is logged
//     (co_page_shares holds their words; the decision log records it). Their own link stays theirs.
//   stopSharing: ends every share link to it. Their own link keeps working; taking it down is takeDownPage.
//   resetLink: their own link was forwarded somewhere they regret: a fresh link, the old one and every share link off.
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import type { ConversationToolContext } from "./conversationTools.js";
import { pickPage } from "./pageTools.js";
import { ALSO_ANSWER, withAnswer } from "./linkAnswer.js";

export function artifactTools(ctx: ConversationToolContext, o: { say: (text: string, record: string) => Promise<boolean>; notDone: (what: string) => void }) {
  const S = () => import("../services/coPages/store.js");
  const theirs = async () => (ctx.dryRun ? [] : (await S()).livePagesFor(ctx.userId).catch(() => []));
  const which = z.string().describe("Which of their pages or decks: its title, or a word from it.");
  const pick = async (ref: string) => {
    const p = pickPage(await theirs(), ref);
    if (p === "ambiguous") return { error: "More than one of their pages or decks fits. Ask which one by its title." };
    if (!p) return { error: "They have no live page or deck by that name." };
    return { p };
  };
  const noun = (k: string) => (k === "deck" ? "deck" : "page");
  return {
    // What's on one of their pages or decks now, so an edit asked days later ("tighten the traction slide") is made from the real
    // content, never from memory (live run, PR 3: Co asked the member to paste the slide). Theirs only; their image numbers are
    // given back as numbers so an edit keeps them.
    openArtifact: tool({
      description: toolUse("openArtifact"),
      inputSchema: z.object({ which }),
      execute: async ({ which: ref }) => {
        const got = await pick(ref);
        if ("error" in got) return { ok: false, error: got.error };
        const page = await (await S()).loadCoPage(got.p.id).catch(() => null);
        if (!page || page.ownerUserId !== ctx.userId) return { ok: false, error: "It's gone (taken down or expired)." };
        const assets = await (await import("../services/memberAssets.js")).listAssets(ctx.userId).catch(() => []);
        const num = (id: string | null | undefined) => (id ? assets.find((a) => a.id === id)?.n ?? null : null);
        const d: any = page.data;
        if (d.kind === "deck") {
          return {
            ok: true,
            kind: "deck",
            title: d.title,
            subtitle: d.subtitle,
            logo: num(d.logo),
            slides: d.slides.map((s: any, i: number) => ({ slide: i + 2, headline: s.headline, bullets: s.bullets, image: num(s.image), notes: s.notes ?? null })),
            note: "Slide 1 is the title slide (title and subtitle). To change it, call updateDeck with the whole new version: unchanged slides as they are here.",
          };
        }
        return {
          ok: true,
          kind: "page",
          title: d.title,
          context: d.context,
          logo: num(d.logo),
          sections: d.sections.map((s: any) => ({ heading: s.heading, blocks: s.blocks, picture: num(s.asset) })),
          sources: d.sources,
          note: "To change it, call updatePage with the whole new version: unchanged sections as they are here.",
        };
      },
    }),
    keepArtifact: tool({
      description: toolUse("keepArtifact"),
      inputSchema: z.object({ which, mode: z.enum(["keep", "renew"]).describe("keep: they want it kept for good (\"keep this\", \"keep\"). renew: 90 more days (\"renew\").") }),
      execute: async ({ which: ref, mode }) => {
        const got = await pick(ref);
        if ("error" in got) return { ok: false, error: got.error };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing changed." };
        const r = await (await S()).keepCoPage(got.p.id, ctx.userId, mode);
        if (!r) return { ok: false, error: "It's already gone (taken down or expired). Offer to make it again." };
        const zone = await (await import("../services/memberTime.js")).memberZone(ctx.userId).catch(() => null);
        const day = (d: Date) => { try { return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone ?? "America/Los_Angeles" }); } catch { return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }); } };
        const until = r.kept ? "for good" : r.expiresAt ? `until ${day(r.expiresAt)}` : "";
        // A reset that landed first moved it to a fresh link; the keep followed it there (store.ts keepCoPage).
        const link = r.moved ? `its new link, ${r.moved.url}, since the link was just reset` : "same link";
        ctx.facts?.add("did_this_turn", `Kept their ${noun((got.p as any).kind)} "${got.p.title}" ${until} (${link}).`);
        return { ok: true, note: `Done: it stays ${until}, ${link}. Say so in a few words${r.moved ? ", with the new link" : ""}.` };
      },
    }),
    shareArtifact: tool({
      description: toolUse("shareArtifact"),
      inputSchema: z.object({
        which,
        quote: z.string().describe("Their words in THIS message asking to share it, copied exactly. Only when they asked; never offer or make one on your own."),
        line: z.string().describe("The one line that goes with the share link (\"Here's a view-only link you can send.\"). Plain words."),
        alsoAnswer: ALSO_ANSWER,
      }),
      execute: async ({ which: ref, quote, line, alsoAnswer }) => {
        const { wordsAreTheirs } = await import("../services/coTasks.js");
        // Explicitly asked, now: the quote must be in this message (or, on a call, what they said on it). Never from history.
        if (!wordsAreTheirs(quote, `${ctx.resolvedContent}\n${ctx.isVoice ? String(ctx.turn?.message ?? "") : ""}`)) {
          return { ok: false, error: "No share link: they didn't ask to share it in this message. Don't offer one; their own link stays private." };
        }
        const got = await pick(ref);
        if ("error" in got) return { ok: false, error: got.error };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing was made." };
        const made = await (await S()).createShareLink(got.p.id, ctx.userId, quote).catch(() => null);
        if (!made) {
          o.notDone("The share link wasn't made.");
          return { ok: false, error: "The share link wasn't made. Say so plainly." };
        }
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 3, decision: "artifact.share", userId: ctx.userId, outcome: "act", action: "share_link_created", proposal: { page: got.p.id.slice(0, 4), share: made.shareId.slice(0, 4), theirWords: quote.slice(0, 200) } }).catch(() => {});
        const { text, confirm } = await withAnswer(ctx, `${line.trim()}\n${made.url}`, alsoAnswer);
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone("The share link was made, but it didn't send.");
          return { ok: false, error: "The share link is made but didn't send. Give it in your reply." };
        }
        ctx.onLinkDelivered?.();
        confirm();
        ctx.facts?.add("did_this_turn", `Made a view-only share link to their ${noun((got.p as any).kind)} "${got.p.title}" because they asked, and texted it (${made.url}). They can stop it any time; their own link is unchanged.`);
        return { ok: true, note: "Sent as one text. If you reply, say in a few words it's view-only and they can text you to stop it any time." };
      },
    }),
    // "Delete the photos I sent you" (services/memberAssets.ts): their images' bytes, gone now; a page or deck that placed one shows
    // it no more (review of the decks PR: every texted photo is kept, so they must be able to remove them).
    deleteImages: tool({
      description: toolUse("deleteImages"),
      inputSchema: z.object({ numbers: z.array(z.number().int().positive()).optional().describe("Their image numbers (#N) to delete; leave it out for all of them.") }),
      execute: async ({ numbers }) => {
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing deleted." };
        const n = await (await import("../services/memberAssets.js")).deleteAssets(ctx.userId, numbers?.length ? numbers : null);
        ctx.facts?.add("did_this_turn", n ? `Deleted ${n} of the images they'd sent${numbers?.length ? ` (${numbers.map((x) => `#${x}`).join(", ")})` : ""}; any page or deck that showed one no longer does.` : "They had no saved images to delete (by those numbers).");
        return { ok: true, deleted: n, note: n ? "Say in a few words they're deleted; if one was on a deck, it's gone from there too." : "Say plainly there was nothing to delete." };
      },
    }),
    resetLink: tool({
      description: toolUse("resetLink"),
      inputSchema: z.object({ which, line: z.string().describe("The one line that goes with the new link (\"Here's your new link; the old one no longer opens.\"). Plain words."), alsoAnswer: ALSO_ANSWER }),
      execute: async ({ which: ref, line, alsoAnswer }) => {
        const got = await pick(ref);
        if ("error" in got) return { ok: false, error: got.error };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing changed." };
        const r = await (await S()).resetCoPageLink(got.p.id, ctx.userId).catch(() => null);
        if (!r) return { ok: false, error: "It's already gone (taken down or expired)." };
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 3, decision: "artifact.share", userId: ctx.userId, outcome: "act", action: "own_link_reset", proposal: { from: got.p.id.slice(0, 4), to: r.id.slice(0, 4) } }).catch(() => {});
        const { text, confirm } = await withAnswer(ctx, `${line.trim()}\n${r.url}`, alsoAnswer);
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone("The link was reset, but the new one didn't send.");
          return { ok: false, error: "The old link is off and a new one is made, but it didn't send. Give it in your reply." };
        }
        ctx.onLinkDelivered?.();
        confirm();
        ctx.facts?.add("did_this_turn", `Gave their ${noun((got.p as any).kind)} "${got.p.title}" a fresh link (${r.url}) because they asked: the old link and any share links no longer open.`);
        return { ok: true, note: "Sent as one text. That's the whole delivery." };
      },
    }),
    stopSharing: tool({
      description: toolUse("stopSharing"),
      inputSchema: z.object({ which }),
      execute: async ({ which: ref }) => {
        const got = await pick(ref);
        if ("error" in got) return { ok: false, error: got.error };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing changed." };
        const n = await (await S()).revokeShareLinks(got.p.id, ctx.userId);
        if (!n) return { ok: false, error: "It had no share links. Their own link is theirs only unless they forwarded it; if they want it gone, that's taking it down." };
        const { recordDecision } = await import("../harness/core.js");
        await recordDecision({ layer: 3, decision: "artifact.share", userId: ctx.userId, outcome: "act", action: "share_links_revoked", proposal: { page: got.p.id.slice(0, 4), count: n } }).catch(() => {});
        ctx.facts?.add("did_this_turn", `Stopped sharing their ${noun((got.p as any).kind)} "${got.p.title}": ${n} share link(s) no longer open. Their own link still works.`);
        return { ok: true, note: "Tell them in a few words the shared link no longer opens and theirs still does." };
      },
    }),
  };
}
