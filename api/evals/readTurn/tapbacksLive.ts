// Live: how often and with what Co reacts, replayed on Royce's real texts of
// 2026-09-30 (12:33 PM to 10:49 PM), in order, with Co's own reactions so far
// shown to the read and the backstop applied (services/tapbacks.ts). Before
// the change Co reacted to 14 of these 22 texts, 12 of them with 👀.
// Real model, no DB, nothing sent. About $0.40.
//
//   railway run npx tsx evals/readTurn/tapbacksLive.ts
import "dotenv/config";
process.env.SENDBLUE_API_API_KEY ||= "x";
process.env.SENDBLUE_API_API_SECRET ||= "x";
const { readTurn } = await import("../../src/services/readTurn.js");
const T = await import("../../src/services/tapbacks.js");

// [their text, Co's reply that followed, minutes since the previous text]
const turns: [string, string, number][] = [
  ["We found a couple options for our event I'll send it over", "Good, send it over whenever. Glad you've got something solid to work with.", 0],
  ["https://www.peerspace.com/pages/listings/650126fd83e5ee000e685382", "", 1],
  ["https://www.peerspace.com/pages/listings/5a383a4e9f623924004ed152", "That crowd and vibe under the disco ball feels like it's got real energy. Are these all spots you're scouting for the venue itself, or references for the look and feel?", 0.3],
  ["scouting for the venue itself", "What's the holdup on those, permits or picking which block?", 6],
  ["My cofounder's decision", "Got it.", 0.5],
  ["All good", "", 48],
  ["You think the venues matches the vibe?", "The nightclub with the disco ball is the one that reads like the vibe you're after.", 1],
  ["You know we want to do grown, sexy, and professional", "Fair, that's a different read.", 2],
  ["You don't think the gallery does?", "No, it reads buttoned up, not sexy.", 1],
  ["Can you find me some people, preferably founders that would be open to letting us use their space for Oct 10th?", "Nothing came back that fits yet.", 116],
  ["For SF tech week", "Got it, that tracks with the window.", 0.5],
  ["It's called \"Anti-Networking\" the whole idea to test our product but it would be a dj set. Donated space or spaces below $1000", "Looking for bookable spaces under $1000.", 15],
  ["What's your exact search?", "Bookable event spaces near NoPa for a DJ set on Oct 10, under $1000.", 1],
  ["Generalize your search for something like that", "Still nothing that fits.", 3],
  ["Conduct the search again", "Two that fit, sending both now.", 71],
  ["What is Co? Give me a full description", "I get to know you over time...", 306],
  ["How would you describe yourself to investors or users", "To users, it's simple...", 1],
  ["Can you find me a event this weekend", "", 8],
  ["Well a couple", "Came up empty for this weekend specifically.", 0.2],
  ["Nothing on Friday?", "I sent that one over already.", 1],
  ["You didn't find anything else?", "Let me run the weekend search again?", 34],
  ["Go ahead", "Still nothing real for this weekend in SF.", 1],
];

const ctx: any = { asks: [{ text: "Bookable space for an Oct 10 DJ event in SF under $1000", kind: "find" }], threads: [], offersThisWeek: 3, sent: [] };
let clock = new Date("2026-09-30T19:33:00Z");
let recent = "";
const history: { emoji: string; at: Date }[] = [];
let textsSinceLast: number | null = null;
let reacted = 0;
const used: Record<string, number> = {};
for (const [msg, reply, gap] of turns) {
  clock = new Date(clock.getTime() + gap * 60_000);
  const h = { recent: [...history].reverse().slice(0, 6), textsSinceLast };
  const r: any = await readTurn({ message: msg, recentConversation: recent, openItems: [] }, ctx, null, { reactions: T.describeTapbacks(h, clock) });
  let shown = "—";
  if (r.ack) {
    const ok = T.ackAllowed(r.ack, h, clock);
    if (ok.ok) {
      history.push({ emoji: r.ack, at: clock });
      textsSinceLast = 0;
      reacted++;
      used[r.ack] = (used[r.ack] ?? 0) + 1;
      shown = r.ack;
    } else {
      shown = `(${r.ack} held back: ${ok.why})`;
      if (textsSinceLast !== null) textsSinceLast++;
    }
  } else if (textsSinceLast !== null) textsSinceLast++;
  console.log(`${shown.padEnd(4)} ${msg.slice(0, 70)}`);
  recent += `\nUser said: ${msg}${reply ? `\nCo replied: ${reply}` : ""}`;
}
console.log(`\nreacted to ${reacted}/${turns.length} (before: 14/22, 12 of them 👀); used ${JSON.stringify(used)}`);
