// Which of a member's open asks are about PEOPLE (2026-10-12 intelligence audit: room scoring read only the newest ask, so an
// errand, "a budget-friendly place with gospel music and seafood for my mom's visit", zeroed a member against the whole room,
// and duplicate asks were scored as if they were two).
//
// An ask is people-shaped when someone in a room could meet it: a person to meet, hire, work with, learn from, back or be
// backed by, or something the member can give a person. An errand (a place, a product, a booking, a plan, a recommendation)
// says nothing about who to meet. Co decides which is which (one Haiku read per ask text, kept for the process); code only
// de-duplicates. A failed read is "unknown": room scoring then keeps every ask (as before), and the pre-event sharing question
// offers none (it waits for the next run).
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { MODELS } from "../models.js";
import { parseModelJson } from "./modelJson.js";
import { cosineSimilarity, SAME_ASK_HIGH } from "../harness/profileWrite.js";

export type AskLike = { id?: string; text?: string | null; type?: string | null; embedding?: number[] | null };
export type PeopleRead = { people: boolean; personal: boolean };

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Pure: one ask per meaning and direction, newest kept. The same words (or one containing the other), or embeddings at the
// "same ask restated" bar (harness/profileWrite.ts SAME_ASK_HIGH), within the same type, are one ask.
export function dedupeAsks<T extends AskLike>(asks: T[]): T[] {
  const out: T[] = [];
  for (const a of [...asks].reverse()) {
    const t = norm(a.text);
    if (!t) continue;
    const type = a.type === "offering" ? "offering" : "seeking";
    const dup = out.some((b) => {
      if ((b.type === "offering" ? "offering" : "seeking") !== type) return false;
      const u = norm(b.text);
      if (u === t || (Math.min(u.length, t.length) >= 12 && (u.includes(t) || t.includes(u)))) return true;
      return Boolean(a.embedding?.length && b.embedding?.length && cosineSimilarity(a.embedding, b.embedding) >= SAME_ASK_HIGH);
    });
    if (!dup) out.push(a);
  }
  return out.reverse();
}

// An ask as the read sees it: its direction and its words ("can offer: ..." reads differently from "looking for: ...").
export const askLine = (a: AskLike) => `${a.type === "offering" ? "can offer" : "looking for"}: ${String(a.text ?? "").slice(0, 300)}`;

export function peopleAskPrompt(texts: string[]): string {
  return `A member of a private club has these open asks with Cue, one per line:
${texts.map((t, i) => `${i}. "${t}"`).join("\n")}

For each, two judgments.
people: true when another member they could meet in a room could meet it: a person or kind of person to meet, hire, work with, learn from, invest in, be helped by, befriend, or something the member offers people (their work, their skills, a check, a job), including the clients, customers, bookings or hires they want from people. false for an errand or a thing: a place, a restaurant, a product, a booking, tickets, a plan, a recommendation, research, something for Cue to do.
personal: true when it's about their health, money troubles, legal matters, family or relationship matters, or anything a stranger shouldn't hear about.

Return ONLY JSON: {"asks": [{"index": 0, "people": true, "personal": false}, ...]}`;
}

// Pure: the reads, by index, from the model's answer. Anything missing or malformed is null (unknown).
export function parsePeopleReads(raw: string, n: number): (PeopleRead | null)[] {
  const out: (PeopleRead | null)[] = Array.from({ length: n }, () => null);
  try {
    const j = parseModelJson<any>(raw);
    for (const r of Array.isArray(j?.asks) ? j.asks : []) {
      if (!Number.isInteger(r?.index) || r.index < 0 || r.index >= n || typeof r.people !== "boolean") continue;
      out[r.index] = { people: r.people, personal: r.personal === true };
    }
  } catch {
    /* unknown */
  }
  return out;
}

const cache = new Map<string, PeopleRead>();
const CACHE_MAX = 5000;

// A test seam: the model call, replaced in pure checks.
let reader: ((prompt: string) => Promise<string>) | null = null;
export function setPeopleReaderForTests(fn: typeof reader): void {
  reader = fn;
}

// Co's read of each ask text (cached by text). null for an ask it couldn't read.
export async function readPeopleAsks(texts: string[]): Promise<(PeopleRead | null)[]> {
  const keys = texts.map(norm);
  const todo = [...new Set(keys.filter((k) => k && !cache.has(k)))];
  if (todo.length) {
    const originals = todo.map((k) => texts[keys.indexOf(k)]);
    try {
      const prompt = peopleAskPrompt(originals);
      const raw = reader
        ? await reader(prompt)
        : (
            await Promise.race([
              generateText({ model: anthropic(MODELS.haiku), experimental_telemetry: { isEnabled: true, functionId: "peopleAsks.read" }, prompt }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
            ])
          ).text;
      const reads = parsePeopleReads(raw, todo.length);
      reads.forEach((r, i) => {
        if (!r) return;
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(todo[i], r);
      });
    } catch (err: any) {
      console.error("peopleAsks: read failed (non-fatal, asks left unknown):", err?.message ?? err);
    }
  }
  return keys.map((k) => cache.get(k) ?? null);
}

// The asks a room is scored on: open asks (the caller passes only what matching may read), de-duplicated, errands left out.
// Unknown reads keep the ask (fail open: scoring falls back to what it did before, the scorer is also told errands don't count).
export async function peopleAsksOf<T extends AskLike>(asks: T[]): Promise<T[]> {
  const unique = dedupeAsks(asks);
  if (!unique.length) return [];
  const reads = await readPeopleAsks(unique.map(askLine));
  return unique.filter((_, i) => reads[i]?.people !== false);
}

// The asks Co may offer in the sharing question: only those it read as people-shaped and not personal (fail closed: an
// unknown read offers nothing).
export async function shareableCandidates<T extends AskLike>(asks: T[]): Promise<T[]> {
  const unique = dedupeAsks(asks);
  if (!unique.length) return [];
  const reads = await readPeopleAsks(unique.map(askLine));
  return unique.filter((_, i) => reads[i]?.people === true && reads[i]?.personal === false);
}
