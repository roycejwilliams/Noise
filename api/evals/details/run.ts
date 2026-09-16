// Event details + search brief eval (services/eventDetails.ts, searchBrief.ts).
//
//   npx tsx evals/details/run.ts          code-only: page parsing, rendering, gaps
//   npx tsx evals/details/run.ts --live   also: real Luma pages, replies to "tell
//                                         me more" with details on file, and
//                                         search briefs shaped by feelings
//
// Hard: a detail that's on file gets "I don't have that", an invented detail,
// a brief that drops the person's actual ask. Soft: brief reflects feelings.
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { loadCases, runEval, type CaseScore, type EvalCase } from "../lib.js";
import { fitPrompt, missingEventDetails, parseLumaEventPage, renderEventDetails, fetchLumaEventDetails, type EventDetails } from "../../src/services/eventDetails.js";
import { addEventFacts, baseReplyFacts, codeChecks } from "../../src/harness/replyGrounding.js";
import { runConversationReplyAgent } from "../../src/agent/conversationReply.js";
import { MODELS } from "../../src/models.js";

type Case = EvalCase & Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");

function page(data: any): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data } } } })}</script></html>`;
}

async function run(c: Case): Promise<any> {
  switch (c.kind) {
    case "parse": {
      const d = parseLumaEventPage(page(c.data));
      return { d, lines: d ? renderEventDetails("X", d) : [], missing: missingEventDetails("X", d ?? undefined) };
    }
    case "livePage": {
      const r = await fetch("https://api.luma.com/discover/get-paginated-events?pagination_limit=6");
      const data: any = await r.json();
      const out = [];
      for (const e of data.entries.slice(0, 5)) {
        const ev = e.event ?? e;
        out.push({ name: ev.name, d: await fetchLumaEventDetails(`https://lu.ma/${ev.url}`) });
      }
      return out;
    }
    case "reply": {
      const rf = baseReplyFacts();
      addEventFacts(rf, { name: c.match.name, kind: "public_event", event_date: c.match.event_date, url: c.match.url, details: c.match.details, whyItFits: c.match.whyItFits });
      const out = await runConversationReplyAgent(
        {
          userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Sam",
          resolvedContent: c.message, isVoice: false, imageForVision: null, hasPendingOffer: true, recentOfferBurstActive: false,
          callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null,
          facts: rf, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: c.recentConversation,
          recentMemories: "", contextSummary: "", personaPrompt: null, sendCoReply: async () => {},
        },
        { dryRun: true, record: false },
      );
      return { reply: out.replyText, rf };
    }
    case "fit": {
      const { text } = await generateText({
        model: anthropic(MODELS.sonnet),
        providerOptions: { anthropic: { effort: "low" } },
        prompt: fitPrompt(c.match, c.person, c.picture),
      });
      return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    }
    case "brief": {
      // The brief prompt, with the case's inputs in place of the database.
      const { text } = await generateText({
        model: anthropic(MODELS.sonnet),
        providerOptions: { anthropic: { effort: "low" } },
        prompt: `Co is about to search for events, communities, and opportunities for someone. Write what to search for so the results fit who they are and how they're doing right now, not just the words of their ask.\n\nWhat they asked Co for: ${c.askText}\n\nWhat they've said to Co lately (oldest first):\n${c.texts.map((t: string) => `- ${t}`).join("\n")}\n\nHow they've been feeling:\n${c.feeling}\n\nLet their feelings and recent words change the search where they should: drained or overwhelmed points to smaller, lower-key things; isolated or lonely points to recurring community over one-off networking; a worry that keeps coming up (like fundraising) points to things that help with it; excitement points to things that build on it. Keep their actual ask at the center. Don't invent interests they haven't shown.\n\nReturn ONLY JSON: {"searchText": "...", "reasoning": "..."}`,
      });
      return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    }
  }
}


function score(c: Case, r: any): CaseScore {
  const hard: string[] = [];
  const soft: { name: string; ok: boolean }[] = [];
  if (c.kind === "parse") {
    for (const s of c.expectLines ?? []) if (!r.lines.some((l: string) => l.includes(s))) hard.push(`missing "${s}" in ${JSON.stringify(r.lines)}`);
    for (const s of c.expectNotLines ?? []) if (r.lines.some((l: string) => l.includes(s))) hard.push(`should not show "${s}"`);
    if (c.expectMissing !== undefined) soft.push({ name: "gaps", ok: (r.missing ?? "").includes(c.expectMissing) });
  }
  if (c.kind === "livePage") {
    const withTime = r.filter((x: any) => x.d?.startAt).length;
    if (withTime < 3) hard.push(`only ${withTime}/5 real pages parsed a start time`);
    soft.push({ name: "hosts parsed", ok: r.filter((x: any) => x.d?.hosts.length).length >= 3 });
  }
  if (c.kind === "reply") {
    if (/\b(don'?t|do not) have (that|the|those)|not sure (what time|where)|no details\b/i.test(r.reply)) hard.push(`said it doesn't have details that are on file: ${r.reply}`);
    for (const s of c.mustMention ?? []) soft.push({ name: `mentions ${s}`, ok: new RegExp(s, "i").test(r.reply) });
    for (const chk of codeChecks(r.reply, r.rf, { message: c.message, recentConversation: c.recentConversation })) if (!chk.pass) hard.push(`${chk.name}: ${r.reply}`);
  }
  if (c.kind === "fit") {
    if (r.fits !== c.expectFits) hard.push(`fits=${r.fits}, expected ${c.expectFits}: ${r.why}`);
    if (c.whyMustNot && new RegExp(c.whyMustNot, "i").test(r.why ?? "")) soft.push({ name: "why avoids stage mismatch", ok: false });
  }
  if (c.kind === "brief") {
    if (!r.searchText) hard.push("no brief");
    else {
      if (!new RegExp(c.askMustInclude, "i").test(r.searchText)) hard.push(`dropped their ask: ${r.searchText}`);
      soft.push({ name: "shaped by feeling", ok: new RegExp(c.feelingShouldShow, "i").test(r.searchText) });
    }
  }
  return { hard, soft };
}

const details: EventDetails = {
  startAt: "2026-09-24T01:00:00.000Z", endAt: "2026-09-24T04:00:00.000Z", timezone: "America/Los_Angeles", online: false,
  venue: "Heavybit", address: "325 Ninth St, San Francisco, CA 94103, USA", city: "San Francisco", hosts: ["Climate Founders Collective"],
  price: "free", spotsRemaining: 12, requiresApproval: true, soldOut: false, guestCount: 48,
  description: "An evening for early-stage climate hardware founders. Short founder talks, then open conversation. Investors from Lowercarbon and Congruent will attend.",
};
const syntheticCases: Case[] = [
  { id: "p01_full", kind: "parse", data: { event: { start_at: "2026-09-24T01:00:00.000Z", end_at: "2026-09-24T04:00:00.000Z", timezone: "America/Los_Angeles", location_type: "offline", geo_address_visibility: "public", geo_address_info: { address: "Heavybit", full_address: "Heavybit, 325 Ninth St, San Francisco", city: "San Francisco" } }, hosts: [{ name: "Climate Founders Collective" }], ticket_info: { is_free: true, spots_remaining: 12, require_approval: true }, guest_count: 48, description_mirror: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Founder talks, then open conversation." }] }] } }, expectLines: ["Wednesday, September 23 at 6:00 PM", "Heavybit, 325 Ninth St", "Climate Founders Collective", "free", "12 spots left", "host approval", "48 people", "Founder talks"], expectNotLines: ["Heavybit, Heavybit"] },
  { id: "p02_hidden_address", kind: "parse", data: { event: { start_at: "2026-09-24T01:00:00.000Z", timezone: "America/New_York", location_type: "offline", geo_address_visibility: "guests-only", geo_address_info: { address: "Secret Loft", full_address: "1 Main St", city: "Brooklyn" } }, hosts: [], ticket_info: {} }, expectLines: ["in Brooklyn; the exact address is only shown to registered guests"], expectNotLines: ["Secret Loft", "1 Main St"], expectMissing: "host" },
  { id: "p03_online_paid", kind: "parse", data: { event: { start_at: "2026-10-01T16:00:00.000Z", timezone: "UTC", location_type: "online" }, hosts: [{ name: "Ana" }], ticket_info: { is_free: false, price: { cents: 2500, currency: "usd" } }, sold_out: true, guest_count: 0 }, expectLines: ["is online", "25 USD", "sold out"], expectNotLines: ["0 people"] },
  { id: "r01_what_time", kind: "reply", message: "what time does it start and where is it?", recentConversation: "Co replied: https://lu.ma/cfm\nCo replied: The Climate Founders Mixer next Wednesday feels made for you, it's all early climate hardware founders.\nUser said: what time does it start and where is it?", match: { name: "Climate Founders Mixer", event_date: "2026-09-23", url: "https://lu.ma/cfm", details }, mustMention: ["6", "Heavybit|Ninth"] },
  { id: "r02_who_goes", kind: "reply", message: "who's going to be there? is it worth it for me", recentConversation: "User said: who's going to be there? is it worth it for me", match: { name: "Climate Founders Mixer", event_date: "2026-09-23", url: "https://lu.ma/cfm", details, whyItFits: "Sam said they want to meet climate investors before raising; Lowercarbon and Congruent investors will be there." }, mustMention: ["Lowercarbon|Congruent|investor"] },
  { id: "r03_cost_signup", kind: "reply", message: "does it cost anything? how do I get in", recentConversation: "User said: does it cost anything? how do I get in", match: { name: "Climate Founders Mixer", event_date: "2026-09-23", url: "https://lu.ma/cfm", details }, mustMention: ["free", "approv"] },
];
const briefCases: Case[] = [
  { id: "b01_isolated", kind: "brief", askText: "meet other founders in SF", texts: ["honestly I don't really know anyone here yet", "most events feel like everyone's pitching", "I just want a few people I actually see regularly"], feeling: "Keeps coming up: lonely, isolated about not having friends in SF (3 times in two weeks).", askMustInclude: "founder", feelingShouldShow: "small|recurring|regular|intimate|community|dinner" },
  { id: "b02_fundraising_worry", kind: "brief", askText: "meet other founders", texts: ["another investor passed today", "I keep second guessing the pitch"], feeling: "Right now: medium discouraged about investor rejections.\nKeeps coming up: anxious about raising pre-seed (4 times in two weeks).", askMustInclude: "founder", feelingShouldShow: "fundrais|investor|pitch|raise|pre-seed" },
  { id: "b03_drained", kind: "brief", askText: "find climate tech events", texts: ["this week has been insane", "barely sleeping"], feeling: "Right now: high overwhelmed about work.\nThey've been struggling in the last day.", askMustInclude: "climate", feelingShouldShow: "small|low-key|casual|relaxed|intimate|quiet|short" },
];

// Fit judged against the current ask (2026-09-15, Royce's thread).
const seriesA = "Work: Series A founder building AI infra for B2B, team of 8, just closed a $35M deal\nWants right now: a designer for logo and branding";
const accelerator = { name: "16vc accelerator", kind: "opportunity", url: "https://x.com/i/status/2097579083265929343", reason: "", opportunity: { postText: "Applications open: 20-25 pre-seed and seed companies across SF, NY and London. $200K on a SAFE, three months." } };
const fitCases: Case[] = [
  { id: "f01_new_direction", kind: "fit", match: accelerator, picture: seriesA, person: { firstName: "Royce", askText: "Wasn't feeling it man. Have you seen any vcs or come across any accelerators that could help me if I decide to build something else?" }, expectFits: true, whyMustNot: "series a|mismatch|not quite where" },
  { id: "f02_current_company", kind: "fit", match: accelerator, picture: seriesA, person: { firstName: "Royce", askText: "Know any investors who lead Series B for our company?" }, expectFits: false },
  { id: "f04_outside_time_frame", kind: "fit", match: { name: "SFTechWeek", kind: "opportunity", url: "https://x.com/i/status/2100208577356931426", reason: "", opportunity: { postText: "SF Tech Week Oct 5-11: Oktoberfest night with people building AI, data centers and infrastructure." } }, picture: seriesA, person: { firstName: "Royce", askText: "Anything tech happening Thursday?", timeFrame: "thursday (Thursday, September 17)" }, expectFits: false },
  { id: "f03_event_fits", kind: "fit", match: { name: "Climate Founders Mixer", kind: "public_event", event_date: "2026-09-23", url: "https://lu.ma/cfm", reason: "", details }, picture: "", person: { firstName: "Sam", askText: "I want to meet climate investors before we raise" }, expectFits: true },
];

const cases = [...loadCases<Case>(here), ...syntheticCases, ...briefCases, ...fitCases, { id: "live_pages", kind: "livePage" } as Case].filter((c) =>
  live ? ["reply", "brief", "livePage", "fit"].includes(c.kind) : c.kind === "parse",
);
await runEval<Case, any>({
  name: live ? "details (live)" : "details (code)",
  dir: here,
  cases,
  concurrency: 4,
  run,
  score,
});
