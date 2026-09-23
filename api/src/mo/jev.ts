// Jev (TypeSafe's System One model) as Mo's fast first pass (Royce,
// 2026-09-23: "it would be better for Mo... lets implement it"). Jev answers
// short yes/no questions with a probability in about a tenth of a second, so
// it takes the two narrow judgments Mo makes at volume:
//   1. screening posts: is the author doing something themselves, or is this
//      promotion, a job ad, or a company account? Clear no's are dropped
//      before Claude reads anything; everything else still goes to Claude,
//      which writes the reason and the drafts.
//   2. reading a prospect's DM reply: yes, no, or a question. A clear stop in
//      code always wins first; anything Jev isn't sure of goes to Claude.
// Only strangers' public posts and their DMs to Co are sent, never member
// text. Off without a key (TYPESAFE_API_KEY, or jev_co, set by Royce). Any
// failure or timeout returns null and Claude decides, as before.
//
// Thresholds are starting points (TypeSafe's docs: evaluate on your own data);
// every decision is logged with its probabilities so they can be tuned from
// the approvers' yes/no answers.
import { recordDecision } from "../harness/core.js";
import { askJevZdr, gatewayConfigured } from "../services/jevGateway.js";

type Noul = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
type Answer = { type: "noul"; noul: number } | { type: string; [k: string]: unknown };
export type JevClientLike = {
  systemOne(
    req: { state: unknown; questions: Record<string, Noul> },
    opts?: { timeout?: number; retry?: { maxRetries: number } },
  ): Promise<{ answers: Record<string, Answer> }>;
};

export function jevKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TYPESAFE_API_KEY || env.jev_co || undefined;
}
// MO_JEV=off turns it off even with a key.
export function moJevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (Boolean(jevKey(env)) || Boolean(env.AI_GATEWAY_API_KEY)) && env.MO_JEV !== "off";
}

let injected: JevClientLike | null = null;
export function setJevClientForTests(c: JevClientLike | null): void {
  injected = c;
}
let cached: JevClientLike | null = null;
let loadFailed = false;
async function client(): Promise<JevClientLike | null> {
  if (injected) return injected;
  if (!moJevEnabled() || !jevKey()) return null;
  if (cached) return cached;
  if (loadFailed) return null;
  try {
    const mod: any = await import("@typesafe-ai/sdk");
    // logLevel "error": at debug the SDK logs request bodies.
    cached = new mod.TypeSafeClient({ apiKey: jevKey(), timeout: 4000, retry: { maxRetries: 0 }, logLevel: "error" }) as JevClientLike;
    return cached;
  } catch (err: any) {
    loadFailed = true;
    console.error("mo/jev: SDK unavailable, Claude decides (non-fatal):", err?.message ?? err);
    return null;
  }
}

async function ask(state: unknown, questions: Record<string, Noul>): Promise<Record<string, number> | null> {
  // Through Vercel's gateway with zero data retention when it's set up
  // (services/jevGateway.ts); the direct TypeSafe key otherwise (public posts
  // and strangers' replies only).
  if (!injected && gatewayConfigured() && process.env.MO_JEV !== "off") {
    const asBool = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "boolean" as const, instructions: q.instructions, criteria: q.criteria }]));
    const r = await askJevZdr(state, asBool, 4000);
    if (r) return r;
  }
  const c = await client();
  if (!c) return null;
  try {
    const res = await c.systemOne({ state, questions }, { timeout: 4000, retry: { maxRetries: 0 } });
    const out: Record<string, number> = {};
    for (const k of Object.keys(questions)) {
      const a = res.answers?.[k] as any;
      if (!a || a.type !== "noul" || typeof a.noul !== "number") return null;
      out[k] = a.noul;
    }
    return out;
  } catch (err: any) {
    // Class and status only; the message can echo the request.
    console.error(`mo/jev: request failed (non-fatal): ${err?.constructor?.name ?? "Error"} ${err?.status ?? ""}`.trim());
    return null;
  }
}

// ---------------------------------------------------------------- 1. screening posts

// One condition per question, combined in code (TypeSafe's guidance).
export const SCREEN_QUESTIONS: Record<"doing" | "promo" | "org", Noul> = {
  doing: {
    type: "noul",
    instructions: "In `post.text`, does the author say they are personally doing something specific right now: building a product or company, hosting or organizing a gathering, or looking for people to build with?",
    criteria: {
      true: "They describe their own current project, event they're hosting, or the collaborator they're looking for.",
      false: "Opinions, advice, news, jokes, reposted ideas, or anything that isn't about something they themselves are doing.",
    },
  },
  promo: {
    type: "noul",
    instructions: "Is `post.text` mainly marketing: selling something, a job ad or recruiting, engagement bait (like, repost, comment to get), a giveaway, or a generic advice thread?",
    criteria: {
      true: "It sells, advertises, recruits for a company or for others, asks for likes or reposts, or gives generic advice to everyone.",
      false: "A person talking about their own work, their own gathering, or looking for their own cofounder or collaborators (that is not recruiting), or anything that isn't marketing.",
    },
  },
  org: {
    type: "noul",
    instructions: "Judging by `author.name` and `author.bio`, is this account a company, brand, publication, or organization rather than one person?",
  },
};

export type ScreenVerdict = "drop" | "keep";
export type ScreenProbs = { doing: number; promo: number; org: number };

// Jev only ever DROPS a clear no. Anything else goes on to Claude, so a Jev
// mistake can cost a good person, never add a bad one.
// A promotion read alone never drops someone Jev is sure is doing something
// themselves (2026-09-23 live test: "looking for a technical cofounder" read
// as recruiting at 0.91 with doing at 0.98); Claude decides those.
export const SCREEN = { dropIfDoingBelow: 0.15, dropIfPromoAbove: 0.85, dropIfOrgAbove: 0.85, promoNeedsDoingBelow: 0.85 };
export function screenVerdict(p: ScreenProbs): ScreenVerdict {
  if (p.doing < SCREEN.dropIfDoingBelow) return "drop";
  if (p.promo > SCREEN.dropIfPromoAbove && p.doing < SCREEN.promoNeedsDoingBelow) return "drop";
  if (p.org > SCREEN.dropIfOrgAbove) return "drop";
  return "keep";
}

export type ScreenInput = { id: string; text: string; author: { username: string; name: string; description: string | null } };

// Every post screened in parallel. Returns the posts to keep; without Jev,
// all of them.
export async function screenPosts<T extends ScreenInput>(posts: T[]): Promise<{ keep: T[]; dropped: { post: T; p: ScreenProbs }[]; jevUsed: boolean; ms: number }> {
  const started = Date.now();
  if (!injected && !moJevEnabled()) return { keep: posts, dropped: [], jevUsed: false, ms: 0 };
  const results = await Promise.all(
    posts.map(async (p) => {
      const probs = await ask(
        { post: { text: p.text.slice(0, 600) }, author: { name: p.author.name, bio: (p.author.description ?? "").slice(0, 200) } },
        SCREEN_QUESTIONS,
      );
      return { p, probs: probs as ScreenProbs | null };
    }),
  );
  const keep: T[] = [];
  const dropped: { post: T; p: ScreenProbs }[] = [];
  let answered = 0;
  for (const r of results) {
    if (!r.probs) {
      keep.push(r.p); // no answer: Claude decides
      continue;
    }
    answered++;
    if (screenVerdict(r.probs) === "drop") dropped.push({ post: r.p, p: r.probs });
    else keep.push(r.p);
  }
  const ms = Date.now() - started;
  await recordDecision({
    layer: 5,
    decision: "mo.jev.screen",
    userId: null,
    outcome: "act",
    action: `kept ${keep.length}, dropped ${dropped.length}, Jev answered ${answered} of ${posts.length}`,
    proposal: {
      ms,
      thresholds: SCREEN,
      dropped: dropped.map((d) => ({ handle: d.post.author.username, post: d.post.text.slice(0, 200), p: d.p })),
    },
  });
  return { keep, dropped, jevUsed: answered > 0, ms };
}

// ---------------------------------------------------------------- 2. reading a DM reply

export const REPLY_QUESTIONS: Record<"wants" | "declines" | "asks", Noul> = {
  wants: {
    type: "noul",
    instructions: "Co asked this person over DM whether they'd like an invite to a small invite-only club. Does `reply` say yes, they want the invite?",
  },
  declines: {
    type: "noul",
    instructions: "Co asked this person over DM whether they'd like an invite to a small invite-only club. Does `reply` say no, or ask Co to stop messaging them?",
  },
  asks: {
    type: "noul",
    instructions: "Does `reply` ask Co a question (what it is, what it costs, who's in it, anything else)?",
  },
};

export type ReplyProbs = { wants: number; declines: number; asks: number };
export const REPLY = { sure: 0.8, clearlyNot: 0.2 };

// null = not sure, Claude reads it. A no only needs to be likely; a yes has
// to be clear, not a question, and not also a no.
export function replyVerdict(p: ReplyProbs): "yes" | "no" | "question" | null {
  if (p.declines >= REPLY.sure) return "no";
  if (p.asks >= REPLY.sure) return "question";
  if (p.wants >= REPLY.sure && p.declines <= REPLY.clearlyNot && p.asks <= 0.5) return "yes";
  return null;
}

export async function readReplyWithJev(text: string): Promise<{ verdict: "yes" | "no" | "question" | null; p: ReplyProbs | null }> {
  const p = (await ask({ reply: text.slice(0, 500) }, REPLY_QUESTIONS)) as ReplyProbs | null;
  return { verdict: p ? replyVerdict(p) : null, p };
}
