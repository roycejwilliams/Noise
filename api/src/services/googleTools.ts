// Co's Google tools (services/capabilities.ts calendar, docs): send a connect
// link, disconnect, or say what's connected. Co chooses it; code guards: the
// link goes only to this member, as its own text, and a disconnect revokes
// with Google and deletes everything Co had.
import { tool } from "ai";
import { z } from "zod";
import { toolUse } from "./capabilities.js";
import { calendarConfigured, calendarConnected, createCalendarLink, createDocsLink, disconnectCalendar, disconnectDocs, docsConfigured, docsConnected } from "./cueGrants.js";
import { docsMomentReached } from "./documentDelivery.js";

type Ctx = {
  userId: string;
  phoneNumber: string;
  dryRun: boolean;
  sendCoReply: (p: { phone: string; message: string; asVoice: boolean }) => Promise<boolean | void>;
  facts?: { add: (kind: "did_this_turn" | "known" | "ongoing" | "not_done", text: string) => void };
};

// deps: stand-ins for tests (who's on the team, whether the Docs or calendar moment has come).
export function googleTools(ctx: Ctx, notDone: (text: string) => void, deps: { docsMoment?: (userId: string) => Promise<boolean>; calendarMoment?: (userId: string) => Promise<boolean> } = {}) {
  return {
    // The calendar grant (services/cueGrants.ts, the bounce): free/busy only, its own link and consent, never the combined Google
    // grant. The link shows a plain screen first (what Cue sees and never sees), and its page has a one-tap disconnect.
    calendarConnection: tool({
      description: toolUse("calendarConnection"),
      inputSchema: z.object({ action: z.enum(["connect", "disconnect", "status"]) }),
      execute: async ({ action }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would ${action} the calendar for ${ctx.userId}`);
          return { ok: true };
        }
        if (action === "status") {
          const c = await calendarConnected(ctx.userId).catch(() => null);
          ctx.facts?.add("known", c ? `Their calendar is connected for free/busy only (since ${c.since}).` : "Their calendar isn't connected.");
          return { ok: true, connected: !!c };
        }
        if (action === "disconnect") {
          const done = await disconnectCalendar(ctx.userId).catch(() => false);
          ctx.facts?.add(done ? "did_this_turn" : "known", done ? "Disconnected their calendar: revoked with Google and deleted." : "Their calendar wasn't connected, so there was nothing to disconnect.");
          return { ok: true, disconnected: done };
        }
        // The moment (Royce, 2026-10-15): the ask only fires when a plan actually needs their calendar (services/bounce.ts
        // calendarMomentReached), never before, whatever is said.
        if (!(await (deps.calendarMoment ?? (async (u: string) => (await import("./bounce.js")).calendarMomentReached(u)))(ctx.userId).catch(() => false))) {
          notDone("No calendar link was sent: no plan needs their calendar yet.");
          return { ok: false, error: "Not yet: their calendar is asked for only when a plan needs it. Don't send a link or offer it now; a time they tell you they're free works meanwhile." };
        }
        if (!calendarConfigured()) {
          notDone("No calendar link was sent: calendar connection isn't set up yet.");
          return { ok: false, error: "Calendar connection isn't set up yet. Say it isn't available yet; don't promise when." };
        }
        const link = await createCalendarLink(ctx.userId).catch(() => null);
        if (!link) {
          notDone("The calendar link couldn't be made.");
          return { ok: false, error: "Couldn't make the link. Say it didn't work." };
        }
        const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: link, asVoice: false });
        if (sent === false) {
          notDone("The calendar link didn't send.");
          return { ok: false, error: "The link didn't go through." };
        }
        ctx.facts?.add("did_this_turn", "Sent them a one-time link (good for 15 minutes) to connect their calendar for free/busy only: Cue sees when they're busy or free, never what, where or with whom; it's never shared; it never changes their calendar; they can disconnect any time.");
        return { ok: true, note: "Sent the link as its own text. Say in a sentence what Cue will and won't see." };
      },
    }),
    // The Docs grant (services/cueGrants.ts, Royce 2026-10-15): Drive files only, its own link and consent on Cue's published project,
    // never the combined Google grant. Same pattern as the calendar: a plain screen first, a one-tap disconnect after.
    docsConnection: tool({
      description: toolUse("docsConnection"),
      inputSchema: z.object({ action: z.enum(["connect", "disconnect", "status"]) }),
      execute: async ({ action }) => {
        if (ctx.dryRun) {
          console.log(`[conversationReply dryRun] would ${action} Google Docs for ${ctx.userId}`);
          return { ok: true };
        }
        if (action === "status") {
          const c = await docsConnected(ctx.userId).catch(() => null);
          ctx.facts?.add("known", c ? `Their Google Docs is connected (since ${c.since}): Cue saves documents it makes for them to their Drive and sees only those.` : "Their Google Docs isn't connected.");
          return { ok: true, connected: !!c };
        }
        if (action === "disconnect") {
          const done = await disconnectDocs(ctx.userId).catch(() => false);
          ctx.facts?.add(done ? "did_this_turn" : "known", done ? "Disconnected their Google Docs: revoked with Google and deleted. Docs Cue already made stay in their Drive, theirs." : "Their Google Docs wasn't connected, so there was nothing to disconnect.");
          return { ok: true, disconnected: done };
        }
        // The moment (Royce, 2026-10-15): the consent screen appears the first time a member actually makes a doc, never before. A
        // document that could be a Google Doc must already have been made for them (services/documentDelivery.ts docsMomentReached).
        if (!(await (deps.docsMoment ?? docsMomentReached)(ctx.userId).catch(() => false))) {
          notDone("No Google Docs link was sent: no document has been made for them yet.");
          return { ok: false, error: "Not yet: Google Docs is offered only once a document is being made for them. Don't send a link or offer it now." };
        }
        if (!docsConfigured()) {
          notDone("No Google Docs link was sent: Google Docs isn't set up yet.");
          return { ok: false, error: "Google Docs isn't set up yet. Say it isn't available yet; don't promise when." };
        }
        const link = await createDocsLink(ctx.userId).catch(() => null);
        if (!link) {
          notDone("The Google Docs link couldn't be made.");
          return { ok: false, error: "Couldn't make the link. Say it didn't work." };
        }
        const sent = await ctx.sendCoReply({ phone: ctx.phoneNumber, message: link, asVoice: false });
        if (sent === false) {
          notDone("The Google Docs link didn't send.");
          return { ok: false, error: "The link didn't go through." };
        }
        ctx.facts?.add("did_this_turn", "Sent them a one-time link (good for 15 minutes) to connect Google Docs: Cue saves documents it makes for them to their Drive and sees only those, never anything else there; it never shares a Doc; they can disconnect any time.");
        return { ok: true, note: "Sent the link as its own text. Say in a sentence what Cue will and won't see." };
      },
    }),
  };
}
