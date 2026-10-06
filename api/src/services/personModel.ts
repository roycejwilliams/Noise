// One running model of the person (Royce, 2026-10-01: "The story is the
// database. Every loop reads and writes the running model of the person…
// Goals fall out of that."). The pieces already exist; this is the one place
// they're put together, so the reply, the background task, the sweep and the
// call all read the same story:
//   who they are     harness/personSnapshot.ts (rewritten as they talk)
//   what's going on  harness/memberThreads.ts (their open threads)
//   what Co did      services/coFacts.ts (Co's action record)
//   what Co carries  services/openLoops.ts (open loops and where each stands)
// Everything that writes to those (the snapshot refresh, threads, recorded
// tool actions, loop sync and updateLoop) is writing to this model.
import pool from "../db/db.js";
import { getPersonSnapshot, renderSnapshot } from "../harness/personSnapshot.js";
import { listThreads, renderThreads } from "../harness/memberThreads.js";
import { ledgerFacts } from "./coFacts.js";
import { describeLoops, type LoopRow } from "./openLoops.js";

export type PersonModelParts = { who: string; threads: string; did: string[]; loops: string | null };

// Pure: the parts as one block. Each section is left out when empty.
export function renderPersonModel(p: PersonModelParts, opts: { maxDid?: number } = {}): string {
  return [
    p.who ? `Who they are:\n${p.who}` : null,
    p.threads ? `What's going on in their life (open threads):\n${p.threads}` : null,
    p.did.length ? `What you've done for them lately:\n${p.did.slice(0, opts.maxDid ?? 8).map((l) => `- ${l}`).join("\n")}` : null,
    p.loops,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function personModelParts(userId: string): Promise<PersonModelParts> {
  const [snap, threads, ledger, loops] = await Promise.all([
    getPersonSnapshot(userId).catch(() => null),
    listThreads(userId).catch(() => []),
    ledgerFacts(userId, "").catch(() => ({ lines: [] as string[], named: [] as string[] })),
    pool
      .query(`SELECT title, status, detail, due_date, source, last_confirmed_at, decay_asked_at FROM open_loops WHERE user_id = $1 AND closed_at IS NULL ORDER BY due_date NULLS LAST, changed_at DESC LIMIT 8`, [userId])
      .then((r) => r.rows.map((x: any) => ({ title: x.title, status: x.status, detail: x.detail, source: x.source, lastConfirmedAt: x.last_confirmed_at ? new Date(x.last_confirmed_at) : null, decayAskedAt: x.decay_asked_at ? new Date(x.decay_asked_at) : null, closedAt: null, closedReason: null, dueDate: x.due_date ? String(x.due_date instanceof Date ? x.due_date.toISOString() : x.due_date).slice(0, 10) : null }) as Pick<LoopRow, "title" | "status" | "detail" | "dueDate" | "source" | "lastConfirmedAt" | "decayAskedAt" | "closedAt" | "closedReason">))
      .catch(() => []),
  ]);
  return { who: renderSnapshot(snap), threads: renderThreads(threads.slice(0, 6)), did: ledger.lines, loops: describeLoops(loops, { draftOnly: true }) };
}

// Background prompts (the sweep, which writes member-facing offers, and Co's
// tasks) read this directly, so another member's details are stripped here,
// the same way as the reply's memories and the call context
// (services/memberSafeMemories.ts, #49 follow-up).
export async function personModel(userId: string, opts: { maxDid?: number } = {}): Promise<string> {
  const text = renderPersonModel(await personModelParts(userId), opts);
  if (!text) return text;
  const { memberSafe } = await import("./memberSafeMemories.js");
  return (await memberSafe(userId, [{ content: text, memory_type: "person_model" }]))[0] ?? "";
}
