// React-or-reply eval (services/conversationClose.ts + the router gate in
// routes/sendblue.ts). Royce, 2026-09-16: "Does it know when to reply back?"
//
//   npx tsx evals/closing/run.ts [--only c03]
//
// Runs the real Layer 2 router on each message, then applies the same
// condition the webhook uses: react only when the router found nothing to act
// on and the message is a closing acknowledgment. Hard failure either way —
// reacting when a reply was owed, or replying to a finished thread.
import "../lib/requireMeter.js";
import "dotenv/config";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { NO_ROUTE, decideActions, describeOpenItem, routeMessage, type OpenItemKind, type RouterOutput } from "../../src/services/messageRouter.js";
import { closingReaction, type Tapback } from "../../src/services/conversationClose.js";
import { runEval, type CaseScore, type EvalCase } from "../lib.js";

type Case = EvalCase & {
  message: string;
  recentConversation: string;
  openItems?: { kind: OpenItemKind; detail: string | null }[];
  // What Co should do: a tapback, or a real reply.
  expect: Tapback | "reply";
};

const here = dirname(fileURLToPath(import.meta.url));

async function run(c: Case): Promise<{ acted: boolean; reaction: Tapback | null; routerReason: string }> {
  const openItems = (c.openItems ?? []).map((it, i) => ({
    id: `${it.kind}:${i + 1}`,
    kind: it.kind,
    description: describeOpenItem(it.kind, it.detail),
    detail: it.detail,
    askedAt: new Date(Date.now() - 5 * 60_000),
  }));
  let out: RouterOutput = NO_ROUTE;
  try {
    out = (await routeMessage({ message: c.message, recentConversation: c.recentConversation, openItems })).output;
  } catch (err: any) {
    console.error(`router failed for ${c.id} (treated as no route):`, err?.message ?? err);
  }
  const d = decideActions(out, openItems, { message: c.message, recentConversation: c.recentConversation });
  // Same condition as routes/sendblue.ts.
  const acted = !!(d.resolve || d.placeCall || d.scheduleCall || d.cancelCall || d.wantsRecommendation || d.clarifyContext || d.clarifyAbout);
  return { acted, reaction: acted ? null : closingReaction(c.message), routerReason: out.reason ?? "" };
}

function score(c: Case, r: { acted: boolean; reaction: Tapback | null; routerReason: string }): CaseScore {
  const hard: string[] = [];
  const got = r.reaction ?? "reply";
  if (c.expect === "reply" && r.reaction) hard.push(`reacted "${r.reaction}" to a message that needed a reply (router acted: ${r.acted})`);
  if (c.expect !== "reply" && !r.reaction) hard.push(`replied instead of reacting (router acted: ${r.acted}${r.routerReason ? `, "${r.routerReason}"` : ""})`);
  const soft = [{ name: "exact reaction", ok: got === c.expect }];
  return { hard, soft };
}

// A thread Co has been carrying: it sent an accelerator link, then answered.
const thread = `Co replied: https://x.com/i/status/2097579083265929343
Co replied: 16vc is taking applications now, $200K on a SAFE, three months across SF, NY and London.`;

const cases: Case[] = [
  { id: "c01_cool_after_answer", message: "Cool", recentConversation: `${thread}\nUser said: Cool`, expect: "like" },
  { id: "c02_thanks_emoji", message: "Nice thanks 🙏🏾", recentConversation: `${thread}\nUser said: Nice thanks 🙏🏾`, expect: "like" },
  { id: "c03_perfect", message: "perfect", recentConversation: `Co replied: It's free, but the host approves requests, so it's not instant.\nUser said: perfect`, expect: "love" },
  { id: "c04_lol", message: "lol", recentConversation: `Co replied: You've now skipped two mixers in a row. I'm noticing a pattern.\nUser said: lol`, expect: "laugh" },
  { id: "c05_thumbs_only", message: "👍", recentConversation: `Co replied: I'll flag anything real when it turns up.\nUser said: 👍`, expect: "like" },
  { id: "c06_which_one", message: "Which one?", recentConversation: `${thread}\nCo replied: Did that last one look any better?\nUser said: Which one?`, expect: "reply" },
  { id: "c07_cool_plus_request", message: "Cool, can you send it again?", recentConversation: `${thread}\nUser said: Cool, can you send it again?`, expect: "reply" },
  { id: "c08_yes_to_open_question", message: "yeah", recentConversation: `Co replied: Want me to look for designers who do that elegant, minimal thing?\nUser said: yeah`, openItems: [{ kind: "call_offer", detail: null }], expect: "reply" },
  { id: "c09_thanks_then_new_topic", message: "thanks man. also I need help with the deck", recentConversation: `${thread}\nUser said: thanks man. also I need help with the deck`, expect: "reply" },
  { id: "c10_warm_close", message: "appreciate you man, this helped a lot", recentConversation: `Co replied: Run the small test first. Eight people is enough to see if the matching holds up.\nUser said: appreciate you man, this helped a lot`, expect: "reply" },
];

await runEval<Case, any>({ name: "react or reply", dir: here, cases, concurrency: 4, run, score });
