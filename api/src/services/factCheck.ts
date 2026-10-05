// A second reader for web facts (Royce, 2026-09-30: "How can we keep the agent
// from providing misinfo? Should we use jev?"). The code checks in taskWeb.ts
// prove the words are on the page and next to the thing's name; this asks
// whether the page actually SAYS that about that thing (a price that belongs
// to the room next door, "hosts DJ nights" read from a list of past events).
//
// Jev (TypeSafe) through the zero-retention gateway (services/jevGateway.ts),
// all of a search's facts in one or two requests; when Jev is busy or off,
// Haiku reads the same batch. SEARCH_FACT_CHECK: "on" (default) drops a "no";
// "shadow" records verdicts without dropping; "off" skips it.
// Measured 2026-09-30 (evals/search/factCheck.ts, 102 labeled facts from
// Peerspace cards, The Bash cards and a single listing): Jev caught 52/52 false
// facts (the next card's price or area, claims the page never makes) and
// dropped 0/50 true ones, ~0.5s. Haiku, the fallback, also dropped 0 true ones
// but leaves most claims "unclear"; the caption check in code covers those.
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { askJevZdr, gatewayConfigured, JEV_SURE, type JevBool } from "./jevGateway.js";
import { parseModelJson } from "./modelJson.js";

export type FactItem = { thing: string; fact: string; passage: string };
export type Verdict = "yes" | "no" | "unclear";
export type FactCheckMode = "off" | "shadow" | "on";

export function factCheckMode(env: NodeJS.ProcessEnv = process.env): FactCheckMode {
  const v = env.SEARCH_FACT_CHECK;
  return v === "shadow" || v === "off" ? v : "on";
}

export const FACT_BATCH = 12;

export function verdictFrom(p: number): Verdict {
  return p >= JEV_SURE.yes ? "yes" : p <= JEV_SURE.no ? "no" : "unclear";
}

export function jevQuestions(n: number): Record<string, JevBool> {
  const q: Record<string, JevBool> = {};
  for (let i = 0; i < n; i++) {
    q[`f${i}`] = {
      type: "boolean",
      instructions: `Does \`items[${i}].passage\` state \`items[${i}].fact\` about \`items[${i}].thing\` itself?`,
      criteria: {
        true: "The passage says this, and it's about that thing.",
        false: "The passage doesn't say it, says something different, or it's about another listing, room or item on the same page.",
      },
    };
  }
  return q;
}

export function haikuPrompt(items: FactItem[]): string {
  return `For each item, does the passage from a web page state the fact about that specific thing? Answer "no" if the passage doesn't say it, says something different, or it's about a different listing, room or item on the same page. "unclear" if you can't tell.

${items.map((it, i) => `[${i}] thing: ${it.thing}\nfact: ${it.fact}\npassage: ${it.passage.slice(0, 1200)}`).join("\n\n")}

Return ONLY JSON: {"verdicts": ["yes" | "no" | "unclear", ...]} with one entry per item, in order.`;
}

async function checkBatch(items: FactItem[], deps: { jev: typeof askJevZdr; haiku: (prompt: string) => Promise<string> }): Promise<{ verdicts: Verdict[]; by: "jev" | "haiku" | "none" }> {
  const state = { items: items.map((it) => ({ thing: it.thing, fact: it.fact, passage: it.passage.slice(0, 1200) })) };
  const jev = gatewayConfigured() || deps.jev !== askJevZdr ? await deps.jev(state, jevQuestions(items.length), 8000) : null;
  if (jev) return { verdicts: items.map((_, i) => verdictFrom(jev[`f${i}`])), by: "jev" };
  try {
    const raw = await deps.haiku(haikuPrompt(items));
    const v = parseModelJson<{ verdicts: string[] }>(raw).verdicts;
    if (Array.isArray(v) && v.length === items.length) return { verdicts: v.map((x) => (x === "yes" || x === "no" ? x : "unclear")), by: "haiku" };
  } catch {}
  return { verdicts: items.map(() => "unclear" as Verdict), by: "none" };
}

const haikuDefault = async (prompt: string) =>
  (await generateText({ model: anthropic(MODELS.haiku), maxOutputTokens: 400, experimental_telemetry: { isEnabled: true, functionId: "search.factCheck" }, prompt })).text;

export async function checkFacts(
  items: FactItem[],
  deps: { jev?: typeof askJevZdr; haiku?: (prompt: string) => Promise<string> } = {},
): Promise<{ verdicts: Verdict[]; by: string[] }> {
  const batches: FactItem[][] = [];
  for (let i = 0; i < items.length; i += FACT_BATCH) batches.push(items.slice(i, i + FACT_BATCH));
  const out = await Promise.all(batches.map((b) => checkBatch(b, { jev: deps.jev ?? askJevZdr, haiku: deps.haiku ?? haikuDefault })));
  return { verdicts: out.flatMap((o) => o.verdicts), by: out.map((o) => o.by) };
}

// Verified web results with each fact read against its passage; a "no" drops
// the fact when the check is on, and a result left with no facts is dropped
// (shared by Co's reply loop and the sweep: agent/loopTools.ts, sweepFind.ts).
export async function checkVerified<T extends { name: string; facts: string[]; excerpts?: string[] }>(
  kept: T[],
  deps: { check?: typeof checkFacts } = {},
): Promise<{ kept: T[]; droppedFacts: string[] }> {
  const mode = factCheckMode();
  const items = kept.flatMap((r) => r.facts.map((fact, j) => ({ r, fact, passage: r.excerpts?.[j] ?? "" }))).filter((x) => x.passage);
  if (mode === "off" || !items.length) return { kept, droppedFacts: [] };
  const { verdicts } = await (deps.check ?? checkFacts)(items.map((x) => ({ thing: x.r.name, fact: x.fact, passage: x.passage })));
  const no = items.filter((_, i) => verdicts[i] === "no");
  const droppedFacts = no.map((x) => `${x.r.name}: "${x.fact}" isn't what its page says`);
  if (mode !== "on") return { kept, droppedFacts: [] };
  const out = kept
    .map((r) => {
      const bad = new Set(no.filter((x) => x.r === r).map((x) => x.fact));
      const keep = r.facts.map((f, j) => ({ f, e: r.excerpts?.[j] })).filter((x) => !bad.has(x.f));
      return { ...r, facts: keep.map((x) => x.f), excerpts: keep.map((x) => x.e ?? "") };
    })
    .filter((r) => r.facts.length);
  return { kept: out, droppedFacts };
}
