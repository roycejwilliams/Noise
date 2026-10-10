// makeEventPage: Co makes a hosted event page (services/eventPages) and texts its link. Co gives fields, never prose or HTML:
// each one is checked by parseEventPageData, the store keeps only checked data, and the template alone renders it. Team only and
// on their yes (services/capabilities.ts event_page), so a page exists only when someone on the team asked Co for one.
import { z } from "zod";
import { tool } from "ai";
import { toolUse } from "../services/capabilities.js";
import { recordDecision } from "../harness/core.js";
import { parseEventPageData } from "../services/eventPages/schema.js";
import type { ConversationToolContext } from "./conversationTools.js";

const line = (what: string) => z.string().describe(`${what} One plain line: no markdown, HTML, links, em dashes or exclamation points.`);

export const EVENT_PAGE_INPUT = z.object({
  title: line("The event's name, as the page's headline."),
  startsAt: z.string().describe("When it starts: ISO date and time with the offset for its city, like 2026-10-24T19:30:00-07:00."),
  endsAt: z.string().nullable().optional().describe("When it ends, same format, or leave it out."),
  timezone: z.string().describe("The event's IANA time zone, like America/Los_Angeles."),
  venueName: line("The venue's name."),
  address: line("The street address, or leave it out.").nullable().optional(),
  schedule: z
    .array(z.object({ time: line("A clock time, like 7:30 PM."), label: line("What happens then."), detail: line("A short detail, or leave it out.").nullable().optional() }))
    .optional()
    .describe("The run of the event, in order. Leave it out when there isn't one."),
  whatToBring: z.array(line("One thing to bring.")).optional(),
  notes: z.array(line("One thing worth knowing (dress, parking, arrival).")).optional(),
  hostLine: line("Who's hosting, like Hosted by Co. Leave it out unless it was given.").nullable().optional(),
  imageUrl: z.string().nullable().optional().describe("Only an https image link they gave you or you read this turn, for the link preview. Leave it out otherwise."),
});

// The fields only; what the guard adds (why, theirYes) never reaches the page.
export function eventPageFields(input: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(EVENT_PAGE_INPUT.shape);
  return Object.fromEntries(Object.entries(input).filter(([k]) => keys.includes(k)));
}

export function eventPageTools(ctx: ConversationToolContext, o: { notDone: (what: string) => void; deliverLink: (url: string) => Promise<boolean> }) {
  return {
    makeEventPage: tool({
      description: toolUse("makeEventPage"),
      inputSchema: EVENT_PAGE_INPUT,
      execute: async (input: z.infer<typeof EVENT_PAGE_INPUT>) => {
        if (!ctx.isTeam) return { ok: false, error: "Not available." };
        const parsed = parseEventPageData(eventPageFields(input as Record<string, unknown>));
        if (!parsed.ok) {
          o.notDone(`No event page made: ${parsed.problems.slice(0, 3).join("; ")}.`);
          return { ok: false, error: `Not made: ${parsed.problems.slice(0, 6).join(" | ")}. Fix these and try once more, or ask them for what's missing.` };
        }
        const data = parsed.data;
        if (ctx.dryRun) {
          ctx.facts?.add("did_this_turn", `Made an event page for "${data.title}" and texted its link (test run: nothing was stored).`);
          return { ok: true, url: "https://example.com/e/DRYRUN-DRYRUN-DRYRUN-0", note: "Test run: nothing was stored or sent." };
        }
        const { createEventPage } = await import("../services/eventPages/store.js");
        let made: { id: string; url: string };
        try {
          made = await createEventPage(data, { ownerUserId: ctx.userId });
        } catch (err: any) {
          o.notDone("The event page wasn't made.");
          return { ok: false, error: `${String(err?.message ?? "it couldn't be saved").slice(0, 160)}. Tell them plainly it isn't made yet.` };
        }
        await recordDecision({ layer: 3, decision: "eventPage.create", userId: ctx.userId, outcome: "act", action: "created", proposal: { id: made.id.slice(0, 4), title: data.title } }).catch(() => {});
        const sent = await o.deliverLink(made.url);
        if (!sent) {
          o.notDone(`The event page for "${data.title}" was made, but its link didn't send.`);
          return { ok: false, url: made.url, error: "The page is made, but the link didn't send. Tell them plainly." };
        }
        ctx.facts?.add("did_this_turn", `Made an event page for "${data.title}" and texted its link (${made.url}) as its own message. Anyone with the link can view it; it isn't listed anywhere.`);
        return { ok: true, url: made.url, note: "The link went as its own text and previews with the title and date. Say a short line about it, nothing more." };
      },
    }),
  };
}
