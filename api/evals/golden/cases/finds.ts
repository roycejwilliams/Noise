// Golden: a reply uses what its own search found (Royce, 2026-10-17, standing direction: "Every find Cue sends, in a reply or on its
// own, goes out as its link, then a one-line caption. Never prose that names a find without its link."). From the 10-17 SF turn: the
// search found real SF events, the reply said "Weekend's thin…", the fact check emptied it, and the member got the fallback line.
// The search returns today's real SF Luma events (fixtures/sf-events-2026-10-17.json, read from the live feed 2026-10-17, no edits);
// the reply agent, its tools and the fact check are the real ones. Case 56 cuts the first reply to nothing on purpose (a dry-run test
// hook), since a live fact check can't be made to cut every claim on demand: what the agent does after that is the real behavior.
import "../../lib/requireMeter.js";
import { readFileSync } from "node:fs";
import { goldenSnapshot } from "../snapshot.js";
import type { GoldenCase, GoldenResult } from "../types.js";
import { result } from "../types.js";
import { noteReply } from "../replies.js";
import type { Send } from "../../lib/hardRules.js";

const ZONE = "America/Los_Angeles";
const MEMBER = { userId: "00000000-0000-0000-0000-000000000000", phoneNumber: "+10000000000", firstName: "Jordan" };
const SF = JSON.parse(readFileSync(new URL("../fixtures/sf-events-2026-10-17.json", import.meta.url), "utf8")) as { events: { name: string; url: string; tier: 1 | 2; lines: string[] }[] };
const URLS = new Set(SF.events.map((e) => e.url));
const GENERIC_HOLD = /^(?:let me (?:look|check|see)|checking|one sec|on it|looking(?: now)?|give me a (?:sec|minute))\b/i;

type Run = { sends: string[]; reply: string; tools: string[]; grounding: string[] };
async function reply(message: string, opts: { cutFirstReply?: boolean } = {}): Promise<Run> {
  const { runConversationReplyAgent } = await import("../../../src/agent/conversationReply.js");
  const G = await import("../../../src/harness/replyGrounding.js");
  const R = await import("../../../src/services/readTurn.js");
  const { LOOP_GUIDE } = await import("../../../src/agent/loop.js");
  const snapshot = await goldenSnapshot({ ...MEMBER, city: "San Francisco", zone: ZONE });
  const facts = G.baseReplyFacts(undefined, snapshot);
  G.addFact(facts, "known", G.todayFact(ZONE));
  const read: any = await R.readTurn({ message, recentConversation: "", openItems: [] }, null, null).catch(() => null);
  if (read?.router?.wantsRecommendation) G.addInstruction(facts, LOOP_GUIDE);
  // In a dry run every send is printed, not sent: that's the transcript.
  const sends: string[] = [];
  const log = console.log;
  console.log = (...a: any[]) => {
    const s = a.map(String).join(" ");
    const m = s.match(/^\[conversationReply dryRun\] (?:would send to [^:]+: |fallback would send to [^:]+: |would reply to [^:]+: ")([\s\S]*?)"?$/);
    if (m) sends.push(m[1]);
    else log(...a);
  };
  try {
    const r: any = await runConversationReplyAgent(
      { ackSent: null, ...MEMBER, resolvedContent: message, isVoice: false, imageForVision: null, hasPendingOffer: false, recentOfferBurstActive: false, callAction: "none", isThinProfileFirstMessage: false, isFirstContact: false, missingTopic: null, missingTopicDescription: null, facts, toneContext: "", seekingModeContext: "", styleHint: "", recentConversation: "", snapshot, personaPrompt: null, sendCoReply: async () => true },
      { dryRun: true, record: false, stubSearch: true, stubEvents: SF.events, cutFirstReply: opts.cutFirstReply },
    );
    // The hard rules read every send: a bare find link is a find, the fallback is the fallback, the rest is Cue's reply.
    const typed: Send[] = sends.map((text) => ({ kind: URLS.has(text.trim()) ? "find" : /got tangled up|taking me longer|couldn't get that one|didn't come through/i.test(text) ? "fallback" : "reply", text }));
    const tools: string[] = r.toolsCalled ?? [];
    noteReply({ text: String(r.replyText ?? ""), sends: typed, tools, kind: "find", facts: `${G.renderReplyFacts(facts)}\n${SF.events.map((e) => `${e.name} ${e.url} ${e.lines.join(" ")}`).join("\n")}`, theirLines: [message], coLines: [], firstName: MEMBER.firstName, findUrls: [...URLS], message, recent: "" });
    return { sends, reply: String(r.replyText ?? ""), tools, grounding: (r.grounding ?? []).map((g: any) => g.outcome) };
  } catch (e: any) {
    return { sends: [...sends, `ERROR ${String(e?.stack ?? e?.message).slice(0, 400)}`], reply: `ERROR ${e?.message}`, tools: [], grounding: [] };
  } finally {
    console.log = log;
  }
}

// Each link sent is followed by its own caption (a line that isn't a link).
function linkThenCaption(sends: string[]): { links: number; uncaptioned: string[] } {
  const links = sends.filter((s) => URLS.has(s.trim()));
  const uncaptioned = sends.flatMap((s, i) => (URLS.has(s.trim()) && (!sends[i + 1] || /^https?:\/\//.test(sends[i + 1].trim())) ? [s] : []));
  return { links: links.length, uncaptioned };
}
const observed = (r: Run) => `${r.sends.map((s) => `> ${s}`).join("\n")}\n  [tools ${r.tools.join(",")}] [fact check ${r.grounding.join(",")}]`;
// GOLDEN_FULL=1 prints the whole transcript (the run's own line is shortened).
const done = (misses: string[], r: Run): GoldenResult => {
  if (process.env.GOLDEN_FULL) console.error(`TRANSCRIPT ${JSON.stringify(r.sends)}`);
  return result(misses, observed(r));
};

export const CASES: GoldenCase[] = [
  {
    n: 55,
    id: "sf-finds-link-then-caption",
    title: "\"Anything you have for me in SF?\" with real SF events found: each goes out as its link then a caption, never \"it's thin\"",
    status: { live: true },
    from: "Royce, 2026-10-17: the 10-17 SF turn said \"Weekend's thin\" after finding real events, then named one in prose with no link",
    run: async () => {
      const r = await reply("Anything you have for me in SF?");
      const FG = await import("../../../src/agent/findGuards.js");
      const misses: string[] = [];
      const lc = linkThenCaption(r.sends);
      if (!r.tools.includes("shareFinds")) misses.push("didn't send finds with shareFinds");
      if (lc.links === 0) misses.push("no find went out as a link");
      if (lc.uncaptioned.length) misses.push(`a link with no caption after it: ${lc.uncaptioned.join(", ")}`);
      const words = r.sends.filter((s) => !/^https?:\/\//.test(s.trim()));
      if (words.some((s) => FG.NOTHING_SAID.test(s))) misses.push("says it's thin or there's nothing, with finds in hand");
      const shared = r.sends.filter((s) => URLS.has(s.trim())).map((s) => s.trim());
      const found = SF.events.map((e) => ({ ...e, facts: "", match: {} as any, blocked: null }));
      const last = words[words.length - 1] ?? "";
      if (FG.unlinkedFinds(last, found, shared).length) misses.push(`the closing line names a find that wasn't sent with its link`);
      if (r.sends[0] && !URLS.has(r.sends[0].trim()) && GENERIC_HOLD.test(r.sends[0].trim())) misses.push(`a generic holding line: "${r.sends[0]}"`);
      if (r.sends.some((s) => /got tangled up|taking me longer|couldn't get that one/i.test(s))) misses.push("the fallback line went out");
      return done(misses, r);
    },
  },
  {
    n: 56,
    id: "cut-everything-redrafts",
    title: "The fact check cuts the whole first reply: what goes out next is a real answer (its finds, or a redraft), never the fallback",
    status: { live: true },
    from: "Royce, 2026-10-17: \"the member never sees the fallback line when a redraft can do the job\"",
    run: async () => {
      const r = await reply("Anything you have for me in SF?", { cutFirstReply: true });
      const misses: string[] = [];
      if (r.sends.some((s) => /got tangled up|taking me longer|couldn't get that one|didn't come through/i.test(s))) misses.push("the fallback line went out");
      const lc = linkThenCaption(r.sends);
      const words = r.sends.filter((s) => !/^https?:\/\//.test(s.trim()) && !GENERIC_HOLD.test(s.trim()));
      if (lc.links === 0 && words.length < 2) misses.push("nothing real went out after the cut (no finds, no redraft)");
      if (lc.uncaptioned.length) misses.push(`a link with no caption after it: ${lc.uncaptioned.join(", ")}`);
      if (!r.grounding.includes("stripped")) misses.push("the first reply wasn't cut (the test hook didn't run)");
      return done(misses, r);
    },
  },
];
