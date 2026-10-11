// What a member can do with any artifact Co made them (a page or a deck), as Co's tools (Royce, 2026-10-11):
//   keepArtifact: "keep this" makes it permanent; "renew" (the one word the expiry warning asks for) gives it 90 more days.
//   shareArtifact: a separate view-only link, only when they explicitly ask in this message. Never on Co's own. Every one is logged
//     (co_page_shares holds their words; the decision log records it). Their own link stays theirs.
//   stopSharing: ends every share link to it. Their own link keeps working; taking it down is takeDownPage.
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import type { ConversationToolContext } from "./conversationTools.js";
import { pickPage } from "./pageTools.js";

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
    keepArtifact: tool({
      description: toolUse("keepArtifact"),
      inputSchema: z.object({ which, mode: z.enum(["keep", "renew"]).describe("keep: they want it kept for good (\"keep this\", \"keep\"). renew: 90 more days (\"renew\").") }),
      execute: async ({ which: ref, mode }) => {
        const got = await pick(ref);
        if ("error" in got) return { ok: false, error: got.error };
        if (ctx.dryRun) return { ok: true, note: "Test run: nothing changed." };
        const r = await (await S()).keepCoPage(got.p.id, ctx.userId, mode);
        if (!r) return { ok: false, error: "It's already gone (taken down or expired). Offer to make it again." };
        const until = r.kept ? "for good" : r.expiresAt ? `until ${r.expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "";
        ctx.facts?.add("did_this_turn", `Kept their ${noun((got.p as any).kind)} "${got.p.title}" ${until} (same link).`);
        return { ok: true, note: `Done: it stays ${until}, same link. Say so in a few words.` };
      },
    }),
    shareArtifact: tool({
      description: toolUse("shareArtifact"),
      inputSchema: z.object({
        which,
        quote: z.string().describe("Their words in THIS message asking to share it, copied exactly. Only when they asked; never offer or make one on your own."),
        line: z.string().describe("The one line that goes with the share link (\"Here's a view-only link you can send.\"). Plain words."),
      }),
      execute: async ({ which: ref, quote, line }) => {
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
        const text = `${line.trim()}\n${made.url}`;
        if (!(await o.say(text, `Co replied: ${text}`))) {
          o.notDone("The share link was made, but it didn't send.");
          return { ok: false, error: "The share link is made but didn't send. Give it in your reply." };
        }
        ctx.facts?.add("did_this_turn", `Made a view-only share link to their ${noun((got.p as any).kind)} "${got.p.title}" because they asked, and texted it (${made.url}). They can stop it any time; their own link is unchanged.`);
        return { ok: true, note: "Sent as one text. If you reply, say in a few words it's view-only and they can text you to stop it any time." };
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
