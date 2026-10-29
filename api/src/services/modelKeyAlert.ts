// A dead model key is an outage, not a quiet day (efficiency audit, 2026-10-29). From 10-23 to 10-27 the Anthropic key was rejected
// ("invalid x-api-key"): the sweeps, goal plans and every background read failed for five days, each failure was logged as a $0
// cost row, and nobody heard. Now:
//   - every failed model request's cost row says it failed (services/llmUsage.ts `error`: the kind and status, never the message,
//     which can echo the request), so a $0 day can be told apart from a quiet one;
//   - a request the provider refused for its key (401/403, "invalid x-api-key", authentication_error) raises one team alert text
//     through the same path as the inbound outage alert (harness/failureCount.ts sendAlertText, TEAM_ALERT_PHONE), at most once an
//     hour per provider while it lasts. Royce's rule (2026-10-11): no routine alert emails, only what a person must act on; a key
//     that stops Cue working is that. A text, never an email.
// State is in this process's memory, like the outage alert: the alert must work when everything else is failing. The lines carry no
// member data: fixed strings per provider.
export type FailureKind = "auth" | "rate_limit" | "overloaded" | "timeout" | "error";
export type ModelFailure = { kind: FailureKind; status: number | null };
export type Provider = "anthropic" | "openai" | "jev";

// The words a provider uses when it refuses the key itself (Anthropic: 401 authentication_error "invalid x-api-key"; 403
// permission_error; OpenAI: "Incorrect API key provided"; the AI gateway: "Invalid API key").
const AUTH_WORDS = /authentication_error|permission_error|invalid x-api-key|\b(invalid|incorrect|revoked|expired|disabled) (x-)?api[ _-]?key\b|\bapi[ _-]?key\b[^.]{0,40}\b(is )?(invalid|not valid|no longer valid|revoked|expired|disabled)\b|\bunauthori[sz]ed\b/i;

const statusOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : null;
};

// Pure: what kind of failure an error is, from its status code when it has one, else its words. The message is read here and
// never stored.
export function classifyModelFailure(err: unknown): ModelFailure {
  const e: any = err ?? {};
  const message = typeof err === "string" ? err : String(e?.message ?? "");
  const status = statusOf(e?.statusCode) ?? statusOf(e?.status) ?? statusOf(/\b(?:anthropic|status|error)\s*:?\s*(\d{3})\b/i.exec(message)?.[1]);
  if (status === 401 || status === 403 || AUTH_WORDS.test(message)) return { kind: "auth", status };
  if (status === 429 || /rate[_ ]limit/i.test(message)) return { kind: "rate_limit", status };
  if (status === 529 || /overloaded/i.test(message)) return { kind: "overloaded", status };
  if (/timeout|timed out|aborted|AbortError/i.test(`${message} ${e?.name ?? ""}`)) return { kind: "timeout", status };
  return { kind: "error", status };
}

// Pure: the failure as the cost row stores it ("auth (401)", "rate_limit (429)", "error").
export const failureLabel = (f: ModelFailure): string => `${f.kind}${f.status ? ` (${f.status})` : ""}`;

// Pure: the provider behind a model id or an AI SDK provider name ("anthropic.messages", "claude-sonnet-5", "openai.embedding").
export function providerOf(id: string | null | undefined): Provider | null {
  const s = String(id ?? "").toLowerCase();
  if (s.startsWith("anthropic") || s.startsWith("claude")) return "anthropic";
  if (s.startsWith("openai") || /^text-embedding|^gpt-|^o\d/.test(s)) return "openai";
  if (s.startsWith("gateway") || s.includes("typesafe-ai/jev")) return "jev";
  return null;
}

// COPY: awaiting Royce's OK (PR "Copy" section). Team-only lines, to TEAM_ALERT_PHONE; never to a member.
export const KEY_DEAD_TEXT: Record<Provider, string> = {
  anthropic: "Cue alert: Anthropic is rejecting Cue's API key (ANTHROPIC_API_KEY). Replies, calls and background work fail until the key is replaced on Railway.",
  openai: "Cue alert: OpenAI is rejecting Cue's API key (OPENAI_API_KEY). Memory search fails until the key is replaced on Railway.",
  jev: "Cue alert: the AI gateway is rejecting Cue's key (AI_GATEWAY_API_KEY). Jev reads fail until the key is replaced on Railway.",
};

export const KEY_ALERT_EVERY_MS = 60 * 60_000;

export type KeyAlertDeps = {
  send: (text: string) => Promise<boolean>;
  // Best effort: the decision log may be down too.
  record?: (provider: Provider, f: ModelFailure) => Promise<void>;
  now?: () => number;
};

export function createKeyAlert(deps: KeyAlertDeps) {
  const now = deps.now ?? Date.now;
  const lastAt = new Map<Provider, number>();
  // The decision row has its own hour: written once an hour per provider whether or not the text went (no TEAM_ALERT_PHONE, or
  // sends off), so a refused key never writes a row per request.
  const recordedAt = new Map<Provider, number>();
  return {
    // One refused request. Returns true when this one started the hour's alert.
    note(provider: Provider, f: ModelFailure): boolean {
      if (f.kind !== "auth") return false;
      const t = now();
      const rec = recordedAt.get(provider);
      if (rec === undefined || t - rec >= KEY_ALERT_EVERY_MS) {
        recordedAt.set(provider, t);
        deps.record?.(provider, f).catch(() => {});
      }
      const before = lastAt.get(provider);
      if (before !== undefined && t - before < KEY_ALERT_EVERY_MS) return false;
      lastAt.set(provider, t);
      // A text that didn't go doesn't use up the hour: the next refused request tries again.
      const giveBack = () => {
        if (lastAt.get(provider) !== t) return;
        if (before === undefined) lastAt.delete(provider);
        else lastAt.set(provider, before);
      };
      deps
        .send(KEY_DEAD_TEXT[provider])
        .then((went) => {
          if (!went) giveBack();
        })
        .catch((err: any) => {
          console.error(`model key alert: the team text failed (${err?.status ?? err?.code ?? "error"})`);
          giveBack();
        });
      return true;
    },
  };
}
export type KeyAlert = ReturnType<typeof createKeyAlert>;

const realKeyAlert = (): KeyAlert =>
  createKeyAlert({
    send: async (text) => (await import("../harness/failureCount.js")).sendAlertText(text),
    record: async (provider, f) => {
      const { recordDecision } = await import("../harness/core.js");
      await recordDecision({ layer: 3, decision: "model.key_dead", userId: null, outcome: "act", action: provider, reason: `${provider} refused the key: ${failureLabel(f)}` });
    },
  });
let keyAlert: KeyAlert | null = null;
export function setKeyAlertForTests(a: KeyAlert | null): void {
  keyAlert = a;
}

// The one entry point: a model request failed. Only a refused key alerts; every other kind is the cost row's to record.
export function noteModelFailure(provider: Provider | null, f: ModelFailure): void {
  if (!provider || f.kind !== "auth") return;
  try {
    (keyAlert ??= realKeyAlert()).note(provider, f);
  } catch (err: any) {
    console.error("model key alert failed (non-fatal):", err?.message ?? err);
  }
}
