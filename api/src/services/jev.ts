// TypeSafe's Jev (a "System One" model) as a second opinion on Co's yes/no and
// pick-one classifiers. Royce, 2026-09-20: "I want to see if [it works] across
// wherever you think it can work."
//
// Jev returns typed answers with probabilities and writes no text, so it only
// fits the classifier half of Co's model calls. Nothing here changes what a
// member sees:
//   - SHADOW mode (co-test only): the current classifier's answer is used as
//     before; Jev is asked the same question beside it and both answers are
//     logged as `jev.shadow` decisions, so the morning review can compare them
//     on real messages.
//   - The evals (evals/router/run.ts --model jev, evals/jev/rules.ts) measure it
//     against labelled cases.
// Off unless a key is set and, for shadow, JEV_SHADOW=true on the dev service.
// Fails open: any error or timeout returns null and the caller carries on.
//
// Their docs list what it is weak at (docs.typesafe.ai/model-jaggedness): it
// reads questions literally, gets worse as unrelated state grows, doesn't
// treat state as hostile, and is not a calculator. So the state given to each
// question is trimmed to what the decision needs.

export type JevNoul = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export type JevChoice = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type JevScore = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = JevNoul | JevChoice | JevScore;

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export type JevResult = {
  answers: Record<string, JevAnswer>;
  ms: number;
  inputTokens: number;
  outputTokens: number;
};

// A minimal shape of the SDK client, so tests can hand in a fake.
export type JevClientLike = {
  systemOne(
    req: { state: unknown; questions: Record<string, JevQuestion>; model?: string },
    opts?: { timeout?: number; retry?: { maxRetries: number } },
  ): Promise<{ answers: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } }>;
};

// The key is stored in Railway under its TypeSafe console name, "jev_co"
// (Royce, 2026-09-21); TYPESAFE_API_KEY is the SDK's own name for it.
export function jevKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TYPESAFE_API_KEY || env.jev_co || undefined;
}

// Dev service only, opted in by Royce, with a key present. Never production.
// JEV_SHADOW names the classifiers allowed to send text to TypeSafe, comma
// separated ("relevance", "router", "issue", "callOffer", "sameAsk",
// "consent"), or "all". Scoped per classifier because each one sends different
// text: relevance sends public event text plus one ask sentence, while the
// router sends a member's message and recent conversation. A bare "true"
// enables nothing.
export function jevShadowEnabled(env: NodeJS.ProcessEnv = process.env, classifier?: string): boolean {
  if (env.RAILWAY_ENVIRONMENT_NAME !== "dev" || env.RAILWAY_SERVICE_NAME !== "co-test" || !jevKey(env)) return false;
  const allowed = (env.JEV_SHADOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes("all")) return true;
  return !!classifier && allowed.includes(classifier.toLowerCase());
}

// For the evals, which run locally with the key in api/.env.
export function jevAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!jevKey(env);
}

let injected: JevClientLike | null = null;
export function setJevClientForTests(client: JevClientLike | null): void {
  injected = client;
}

let cached: JevClientLike | null = null;
async function getClient(): Promise<JevClientLike | null> {
  if (injected) return injected;
  if (cached) return cached;
  const apiKey = jevKey();
  if (!apiKey) return null;
  try {
    // Variable specifier: nothing resolves the package unless a key is set.
    const spec = "@typesafe-ai/sdk";
    const mod: any = await import(spec);
    // logLevel "error": at "debug" the SDK logs request bodies, which hold member text.
    cached = new mod.TypeSafeClient({ apiKey, timeout: 4000, retry: { maxRetries: 0 }, logLevel: "error" }) as JevClientLike;
    return cached;
  } catch (err: any) {
    console.error("jev: client unavailable (non-fatal):", err?.message ?? err);
    return null;
  }
}

export const jevStats = { calls: 0, failures: 0 };

// One request, many independent questions over the same state (they run in
// parallel and can't see each other's answers). Returns null on any failure.
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<JevResult | null> {
  const client = await getClient();
  if (!client) return null;
  const started = Date.now();
  jevStats.calls++;
  try {
    const res = await client.systemOne(
      { state, questions },
      { timeout: opts.timeoutMs ?? 4000, retry: { maxRetries: opts.retries ?? 0 } },
    );
    return {
      answers: res.answers,
      ms: Date.now() - started,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    };
  } catch (err: any) {
    jevStats.failures++;
    // Class and status only. The message can echo the request.
    console.error(`jev: request failed (non-fatal): ${err?.constructor?.name ?? "Error"} ${err?.status ?? ""}`.trim());
    return null;
  }
}

export const noulP = (a: JevAnswer | undefined): number | null => (a && a.type === "noul" ? a.noul : null);
export const choiceOf = (a: JevAnswer | undefined): { choice: string; confidence: number } | null =>
  a && a.type === "choice" ? { choice: a.choice, confidence: a.confidence } : null;

// How sure Jev has to be. These are starting points to be measured on Co's own
// cases (their docs say cookbook thresholds are examples, not rules), so they
// are parameters, not constants buried in the adapters.
export type JevThresholds = { yes: number; high: number; medium: number };
export const DEFAULT_THRESHOLDS: JevThresholds = { yes: 0.5, high: 0.85, medium: 0.6 };

export const confidenceLabel = (p: number, t: JevThresholds = DEFAULT_THRESHOLDS): "high" | "medium" | "low" =>
  p >= t.high ? "high" : p >= t.medium ? "medium" : "low";
