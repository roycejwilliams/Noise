// Co's one Google tool (services/capabilities.ts "google"): send the connect
// link, disconnect, or say what's connected. Co chooses it; code guards: the
// link goes only to this member, as its own text, and a disconnect revokes
// with Google and deletes everything Co had.
import { tool } from "ai";
import { z } from "zod";
import { toolUse } from "./capabilities.js";
import { createConnectLink, disconnectGoogle, googleConfigured, isConnected } from "./googleAuth.js";

type Ctx = {
  userId: string;
  phoneNumber: string;
  dryRun: boolean;
  sendCoReply: (p: { phone: string; message: string; asVoice: boolean }) => Promise<boolean | void>;
  facts?: { add: (kind: "did_this_turn" | "known" | "ongoing" | "not_done", text: string) => void };
};

export function googleTools(ctx: Ctx, notDone: (text: string) => void) {
  return {
    googleConnection: tool({
      description: toolUse("googleConnection"),
      inputSchema: z.object({ action: z.enum(["connect", "disconnect", "status"]) }),
      execute: async ({ action }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would ${action} Google for ${ctx.userId}`);
          return { ok: true };
        }
        if (action === "status") {
          const c = await isConnected(ctx.userId);
          ctx.facts?.add("known", c.connected ? "Their Google is connected (read-only: calendar busy times, and which sent emails await a reply)." : "Their Google isn't connected.");
          return { ok: true, connected: c.connected };
        }
        if (action === "disconnect") {
          const done = await disconnectGoogle(ctx.userId).catch(() => false);
          ctx.facts?.add(done ? "did_this_turn" : "known", done ? "Disconnected their Google: revoked with Google and deleted everything Co had from it." : "Their Google wasn't connected, so there was nothing to disconnect.");
          return { ok: true, disconnected: done };
        }
        if (!googleConfigured()) {
          notDone("No Google link was sent: Google connection isn't set up on Co yet.");
          return { ok: false, error: "Google connection isn't set up yet. Say it isn't available yet; don't promise when." };
        }
        const link = await createConnectLink(ctx.userId).catch(() => null);
        if (!link) {
          notDone("The Google connect link couldn't be made.");
          return { ok: false, error: "Couldn't make the link. Say it didn't work." };
        }
        const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: link, asVoice: false });
        if (sent === false) {
          notDone("The Google connect link didn't send.");
          return { ok: false, error: "The link didn't go through." };
        }
        ctx.facts?.add("did_this_turn", "Sent them a one-time link (good for 15 minutes) to connect Google: read-only calendar busy times and which sent emails await a reply. Co never sends email or changes their calendar.");
        return { ok: true, note: "Sent the link as its own text. Tell them what Co will and won't see, in a sentence." };
      },
    }),
  };
}
