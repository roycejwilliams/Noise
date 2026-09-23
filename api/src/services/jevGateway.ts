// Jev (TypeSafe) through Vercel's AI Gateway with zero data retention
// (Royce, 2026-09-23: "I am going thru vercel ai gateway").
//
// Why the gateway: TypeSafe's own terms set no deletion date for what we
// send, and member texts are private. Vercel's gateway lists TypeSafe as a
// zero-data-retention provider ("TypeSafe shall not retain prompts ... any
// longer than is necessary to generate Output"), and every request here sets
// zeroDataRetention: true, so a request that can't be served under ZDR fails
// instead of going out without it.
//
// Uses AI SDK 7 (installed as "ai7") only for evaluate(); the rest of Co stays
// on AI SDK 6. Needs AI_GATEWAY_API_KEY (set by Royce). Member text goes to
// Jev only on co-test unless JEV_MEMBER=on, and JEV_MEMBER=off turns it off
// anywhere. Any failure returns null and the caller uses Claude as before.
import { experimental_evaluate as evaluate } from "ai7";
import { createGateway } from "@ai-sdk/gateway";

export type JevBool = { type: "boolean"; instructions: string; criteria?: { true?: string; false?: string } };

export function gatewayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY);
}

// Member text: only with the gateway key AND JEV_MEMBER=on (2026-09-23: the
// live test had TypeSafe busy on 86 of 96 requests, so each Jev try mostly
// added a wasted round trip before Haiku; off until that improves).
export function jevForMemberText(env: NodeJS.ProcessEnv = process.env): boolean {
  return gatewayConfigured(env) && env.JEV_MEMBER === "on";
}

let provider: ReturnType<typeof createGateway> | null = null;
let injected: ((state: unknown, questions: Record<string, JevBool>) => Promise<Record<string, number> | null>) | null = null;
export function setJevGatewayForTests(fn: typeof injected): void {
  injected = fn;
}

export const JEV_GATEWAY_PROVIDER_OPTIONS = { gateway: { zeroDataRetention: true } } as const;

// Probability of yes for each question, or null on any failure.
export async function askJevZdr(state: unknown, questions: Record<string, JevBool>, timeoutMs = 3000): Promise<Record<string, number> | null> {
  if (injected) return injected(state, questions);
  if (!gatewayConfigured()) return null;
  try {
    provider ??= createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
    const result: any = await evaluate({
      model: provider.evaluationModel("typesafe-ai/jev"),
      state: state as any,
      questions: questions as any,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
      providerOptions: JEV_GATEWAY_PROVIDER_OPTIONS,
    });
    const out: Record<string, number> = {};
    for (const k of Object.keys(questions)) {
      const p = result?.answers?.[k]?.probability;
      if (typeof p !== "number") return null;
      out[k] = p;
    }
    return out;
  } catch (err: any) {
    // Class and status only; the message can echo the request.
    console.error(`jevGateway: request failed (non-fatal): ${err?.constructor?.name ?? "Error"} ${err?.statusCode ?? err?.status ?? ""}`.trim());
    return null;
  }
}

// Sure enough to decide without Claude.
export const JEV_SURE = { no: 0.2, yes: 0.8 };

// ---------------------------------------------------------------- per-text signals
// The three yes/no reads on every member text, asked in ONE request (they
// share the same state), shared by the three checks through a short-lived
// memo, so each text costs one Jev round trip, not three.
export const TEXT_SIGNAL_QUESTIONS: Record<"solving" | "issue" | "feeling", JevBool> = {
  solving: {
    type: "boolean",
    instructions: "Right now, does `latest_message` show they clearly want a real answer or help deciding something, not just to be listened to?",
    criteria: {
      true: "They're weighing options out loud, stuck on a decision, or asking what to do (even without a question mark).",
      false: "Ordinary sharing, updates, venting, reactions, logistics, or asking Co to find or do something.",
    },
  },
  issue: {
    type: "boolean",
    instructions: "Someone is testing an AI texting companion called Co. Does `latest_message` report a problem with Co itself, or say how Co should work differently?",
    criteria: {
      true: "They point out something Co did wrong or badly (sent the same thing twice, wrong or made-up info, a broken link, ignored what they said, too slow, confusing), or say how Co should behave.",
      false: "The problem is in their own life, they're just asking Co for something or changing what they want, or they're reacting normally.",
    },
  },
  feeling: {
    type: "boolean",
    instructions: "Does `latest_message` carry a real feeling Co should respond to (stressed, anxious, discouraged, lonely, frustrated, excited, proud, relieved)? Use `recent_conversation`: \"fine\" after bad news isn't fine.",
    criteria: { false: "Plain logistics, greetings, short acknowledgments, or tone you can't be confident about." },
  },
};
export type TextSignals = Record<"solving" | "issue" | "feeling", number>;

const memo = new Map<string, { at: number; p: Promise<TextSignals | null> }>();
export function readTextSignals(message: string, recentConversation: string): Promise<TextSignals | null> {
  if (!jevForMemberText()) return Promise.resolve(null);
  const convo = recentConversation.slice(-1500);
  const key = `${message}\u0000${convo}`;
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at > 60_000) memo.delete(k);
  const hit = memo.get(key);
  if (hit) return hit.p;
  const p = askJevZdr({ latest_message: message, recent_conversation: convo }, TEXT_SIGNAL_QUESTIONS) as Promise<TextSignals | null>;
  memo.set(key, { at: now, p });
  return p;
}

// Jev and Haiku start together. Jev's answer wins only when it's sure (and
// Haiku is then cancelled); otherwise Haiku's answer is used, so a check is
// never slower than Haiku alone.
export async function raceWithJev<T>(
  jevSure: Promise<{ value: T } | null>,
  runHaiku: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; from: "jev" | "haiku" }> {
  const ctrl = new AbortController();
  const haiku = runHaiku(ctrl.signal);
  const jevWin = jevSure.then((r) => (r ? r : new Promise<never>(() => {}))).catch(() => new Promise<never>(() => {}));
  const w = await Promise.race([
    haiku.then((value) => ({ value, from: "haiku" as const })),
    jevWin.then((r) => ({ value: r.value, from: "jev" as const })),
  ]);
  if (w.from === "jev") {
    ctrl.abort();
    haiku.catch(() => {});
  }
  return w;
}

